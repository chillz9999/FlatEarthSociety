import { describe, expect, it } from 'vitest';
import { LookaheadBot } from '../src/bots';
import { GAME_VERSION } from '../src/config';
import { decodeInputs, encodeInputs, InputRecorder, validateInputs, type InputEvent } from '../src/replay';
import { Simulation } from '../src/sim';
import { verifyRun } from '../src/verify';

const SEED = '5ea5c0ffee5ea5c0ffee5ea5c0ffee00';

function honestRun(seed = SEED, maxTicks = 60 * 60 * 30) {
  const sim = new Simulation(seed);
  // A fallible navigator, so the run ends in a loss like a real one.
  const bot = new LookaheadBot({ seed, reactionTicks: 24, replanTicks: 15, horizonTicks: 54, margin: 0, viewRadius: 520, blunderRate: 0.06 });
  const rec = new InputRecorder();
  while (!sim.over && sim.tick < maxTicks) {
    const s = bot.decide(sim);
    rec.record(sim.tick + 1, s);
    sim.step(s);
  }
  return { sim, inputs: rec.events };
}

describe('input logs', () => {
  it('round-trip through the compact wire format', () => {
    const { inputs } = honestRun(SEED, 60 * 40);
    expect(decodeInputs(encodeInputs(inputs))).toEqual(inputs);
  });

  it('reject malformed or impossible logs', () => {
    expect(validateInputs('x', 100)).toEqual({ ok: false, reason: 'inputs_not_array' });
    expect(validateInputs([[0, 1]], 100)).toEqual({ ok: false, reason: 'bad_tick' });
    expect(validateInputs([[5, 1], [5, 0]], 100)).toEqual({ ok: false, reason: 'ticks_not_increasing' });
    expect(validateInputs([[5, 1], [9, 1]], 100)).toEqual({ ok: false, reason: 'redundant_event' });
    expect(validateInputs([[5, 3]], 100)).toEqual({ ok: false, reason: 'bad_steer' });
    expect(validateInputs([[500, 1]], 100)).toEqual({ ok: false, reason: 'tick_out_of_range' });
    const burst: InputEvent[] = [];
    for (let t = 1; t <= 40; t++) burst.push([t, t % 2 === 1 ? 1 : 0]);
    expect(validateInputs(burst, 1000)).toEqual({ ok: false, reason: 'input_rate_exceeded' });
    expect(decodeInputs([0, 1])).toBeNull();
    expect(decodeInputs([3, 7])).toBeNull();
  });
});

describe('server-side verification', () => {
  it('accepts an honest run and computes the same score', () => {
    const { sim, inputs } = honestRun();
    const out = verifyRun({
      seed: SEED,
      version: GAME_VERSION,
      inputs,
      claimedEndTick: sim.tick,
      claimedScore: sim.score,
      claimedHash: sim.stateHash(),
      claimedCheckpoints: sim.checkpointHashes,
      mode: 'final',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.score).toBe(sim.score);
    expect(out.completed).toBe(true);
    expect(out.divergedAtCheckpoint).toBe(-1);
    expect(out.flags.filter((f) => f.severity === 'review')).toEqual([]);
  });

  it('ignores an inflated claimed score (and flags it)', () => {
    const { sim, inputs } = honestRun();
    const out = verifyRun({ seed: SEED, version: GAME_VERSION, inputs, claimedEndTick: sim.tick, claimedScore: sim.score * 10, mode: 'final' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.score).toBe(sim.score);
    expect(out.flags.map((f) => f.code)).toContain('score_mismatch');
  });

  it('rejects a run that claims to have lasted longer than the inputs allow', () => {
    const { sim, inputs } = honestRun();
    const out = verifyRun({ seed: SEED, version: GAME_VERSION, inputs, claimedEndTick: sim.tick + 6000, mode: 'final' });
    // The ship sinks at the honest tick; the claim of surviving longer is false.
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.ticks).toBe(sim.tick);
      expect(out.flags.map((f) => f.code)).toContain('end_tick_mismatch');
    }
  });

  it('rejects fabricated inputs that do not end in a loss at the claimed tick', () => {
    const { sim, inputs } = honestRun();
    const truncated = inputs.slice(0, Math.floor(inputs.length / 3));
    const end = truncated.length ? truncated[truncated.length - 1][0] + 1 : 10;
    const out = verifyRun({ seed: SEED, version: GAME_VERSION, inputs: truncated, claimedEndTick: Math.min(end, sim.tick - 1), mode: 'final' });
    expect(out.ok).toBe(false);
  });

  it('replaying inputs against a different seed does not reproduce the score', () => {
    const { sim, inputs } = honestRun();
    const other = '0123456789abcdef0123456789abcdef';
    const out = verifyRun({ seed: other, version: GAME_VERSION, inputs, claimedEndTick: sim.tick, claimedScore: sim.score, mode: 'final' });
    if (out.ok) expect(out.result.score === sim.score && out.result.ticks === sim.tick).toBe(false);
  });

  it('scores an interrupted run at its last checkpoint (attempt-restoration policy)', () => {
    const { sim, inputs } = honestRun();
    const cut = Math.floor(sim.tick / 2);
    const partial = inputs.filter(([t]) => t <= cut);
    const out = verifyRun({ seed: SEED, version: GAME_VERSION, inputs: partial, claimedEndTick: cut, mode: 'partial' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.completed).toBe(false);
    expect(out.result.ticks).toBe(cut);
  });

  it('rejects bad seeds, versions and inputs after the end', () => {
    expect(verifyRun({ seed: 'zz', version: GAME_VERSION, inputs: [], claimedEndTick: 10, mode: 'final' })).toMatchObject({ ok: false, reason: 'bad_seed' });
    expect(verifyRun({ seed: SEED, version: '0.0.1', inputs: [], claimedEndTick: 10, mode: 'final' })).toMatchObject({ ok: false, reason: 'unsupported_version' });
    expect(verifyRun({ seed: SEED, version: GAME_VERSION, inputs: [[50, 1]], claimedEndTick: 10, mode: 'final' })).toMatchObject({ ok: false, reason: 'inputs_after_end' });
  });

  it('flags robotic single-frame tapping for review', () => {
    // A tapping pattern no person produces: 1-frame pulses at a perfectly regular rhythm.
    const inputs: InputEvent[] = [];
    for (let t = 10; t < 60 * 60; t += 9) {
      inputs.push([t, t % 18 === 10 ? 1 : -1]);
      inputs.push([t + 1, 0]);
    }
    const tap = (seed: string) => {
      const sim = new Simulation(seed);
      let i = 0;
      let steer: -1 | 0 | 1 = 0;
      while (!sim.over && sim.tick < 60 * 60) {
        while (i < inputs.length && inputs[i][0] <= sim.tick + 1) steer = inputs[i++][1] as -1 | 0 | 1;
        sim.step(steer);
      }
      return sim;
    };
    // The tapping ship barely moves, so it needs a sea that leaves the middle open for a while: take the
    // first such seed from a fixed list (the heuristic needs a few dozen presses to judge).
    let seed = SEED;
    let sim = tap(seed);
    for (let k = 0; sim.tick < 60 * 8 && k < 200; k++) {
      seed = (0xbeef + k * 7919).toString(16).padStart(32, '7');
      sim = tap(seed);
    }
    expect(sim.tick).toBeGreaterThanOrEqual(60 * 8);
    const used = inputs.filter(([t]) => t <= sim.tick);
    const out = verifyRun({ seed, version: GAME_VERSION, inputs: used, claimedEndTick: sim.tick, mode: sim.over ? 'final' : 'partial' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['robotic_taps']));
  });
});
