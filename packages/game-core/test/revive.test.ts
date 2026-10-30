import { describe, expect, it } from 'vitest';
import { LookaheadBot } from '../src/bots';
import { DEFAULT_CONFIG, GAME_VERSION } from '../src/config';
import { decodeInputs, encodeInputs, InputRecorder, REVIVE, runReplay, validateInputs, type InputEvent } from '../src/replay';
import { Simulation } from '../src/sim';
import type { SimEvent, Steer } from '../src/types';
import { verifyRun } from '../src/verify';

const SEED = '0b0b5ea5c0ffee5ea5c0ffee5ea5c0ff';
const TICK_RATE = DEFAULT_CONFIG.tickRate;

/** Sail with a fallible navigator until the ship is lost (twice, when `revive` is set). */
function voyage(seed: string, revive: boolean) {
  const sim = new Simulation(seed);
  const bot = new LookaheadBot({ seed, reactionTicks: 24, replanTicks: 15, horizonTicks: 54, margin: 0, viewRadius: 520, blunderRate: 0.06 });
  const rec = new InputRecorder();
  const events: SimEvent[] = [];
  let firstLoss = -1;
  for (;;) {
    while (!sim.over && sim.tick < 60 * 60 * 10) {
      const s = bot.decide(sim);
      rec.record(sim.tick + 1, s);
      sim.step(s);
      events.push(...sim.events);
    }
    if (!revive || sim.revived || !sim.canRevive) break;
    firstLoss = sim.tick;
    sim.revive();
    rec.revive(sim.tick);
  }
  return { sim, inputs: rec.events, events, firstLoss };
}

describe('the bonus life', () => {
  it('puts a lost ship back on the water, once, and the voyage carries on', () => {
    const { sim, inputs, events, firstLoss } = voyage(SEED, true);
    expect(firstLoss).toBeGreaterThan(0);
    expect(sim.revived).toBe(true);
    expect(sim.reviveTick).toBe(firstLoss);
    expect(sim.over).toBe(true);
    expect(sim.tick).toBeGreaterThan(firstLoss);
    expect(sim.canRevive).toBe(false);
    expect(() => sim.revive()).toThrow();
    expect(inputs.filter((e) => e[1] === REVIVE)).toEqual([[firstLoss, REVIVE]]);
    expect(events.filter((e) => e.type === 'death')).toHaveLength(2);
    expect(sim.result().revived).toBe(true);
  });

  it('shields the revived ship from hazards for a while, then lifts once the hull is clear', () => {
    const sim = new Simulation(SEED);
    // Hold course down the middle until something sinks the ship.
    while (!sim.over) sim.step(0);
    expect(sim.death).not.toBe('edge');
    const lostAt = sim.tick;
    sim.revive();
    expect(sim.protectedNow).toBe(true);
    let lifted = -1;
    while (!sim.over && sim.tick < lostAt + DEFAULT_CONFIG.revive.maxShieldSeconds * TICK_RATE + 2) {
      sim.step(0);
      if (sim.events.some((e) => e.type === 'protectionEnd')) lifted = sim.tick;
      if (sim.tick < lostAt + DEFAULT_CONFIG.revive.shieldSeconds * TICK_RATE) expect(sim.over).toBe(false);
    }
    expect(lifted).toBeGreaterThan(0);
    expect(lifted - lostAt).toBeGreaterThanOrEqual(DEFAULT_CONFIG.revive.shieldSeconds * TICK_RATE);
    expect(lifted - lostAt).toBeLessThanOrEqual(DEFAULT_CONFIG.revive.maxShieldSeconds * TICK_RATE);
  });

  it('brings a ship lost over the Edge back inside it, at rest', () => {
    const sim = new Simulation(SEED);
    while (!sim.over) sim.step(-1);
    expect(sim.death).toBe('edge');
    sim.revive();
    expect(sim.ship.x).toBe(-(DEFAULT_CONFIG.channelHalfWidth - DEFAULT_CONFIG.revive.edgeInset));
    expect(sim.ship.vx).toBe(0);
    // Holding the same course still loses it over the Edge: the shield never covers the Edge.
    while (!sim.over) sim.step(-1);
    expect(sim.death).toBe('edge');
    expect(sim.canRevive).toBe(false);
  });

  it('is not given once the examination’s time is up', () => {
    const cfg = { ...DEFAULT_CONFIG, maxTicks: 30 };
    const sim = new Simulation(SEED, cfg);
    while (!sim.over) sim.step(0);
    expect(sim.death).toBe('timeout');
    expect(sim.canRevive).toBe(false);
  });

  it('replays exactly from the input log', () => {
    const { sim, inputs } = voyage(SEED, true);
    const replay = runReplay(SEED, decodeInputs(encodeInputs(inputs))!, sim.tick);
    expect(replay.revived).toBe(true);
    expect(replay.tick).toBe(sim.tick);
    expect(replay.score).toBe(sim.score);
    expect(replay.stateHash()).toBe(sim.stateHash());
    expect(replay.checkpointHashes).toEqual(sim.checkpointHashes);
  });

  it('is verified by the server like any other voyage', () => {
    const { sim, inputs } = voyage(SEED, true);
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
    expect(out.result.revived).toBe(true);
    expect(out.result.score).toBe(sim.score);
    expect(out.flags.map((f) => f.code)).not.toContain('revive_unused');
  });

  it('is ignored, and flagged, when the ship was not lost at the logged tick', () => {
    const { sim, inputs } = voyage(SEED, false);
    // Claim a bonus life part-way through a voyage that never needed one.
    const at = Math.floor(sim.tick / 2);
    const forged: InputEvent[] = [...inputs.filter((e) => e[0] <= at), [at, REVIVE], ...inputs.filter((e) => e[0] > at)];
    expect(validateInputs(forged, DEFAULT_CONFIG.maxTicks)).toEqual({ ok: true });
    const out = verifyRun({ seed: SEED, version: GAME_VERSION, inputs: forged, claimedEndTick: sim.tick, mode: 'final' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.revived).toBe(false);
    expect(out.result.score).toBe(sim.score);
    expect(out.flags.map((f) => f.code)).toContain('revive_unused');
  });
});

describe('bonus life in the input log', () => {
  it('may share a tick with the step that lost the ship, but nothing after it may', () => {
    const steer = (t: number, s: Steer): InputEvent => [t, s];
    expect(validateInputs([steer(5, 1), [5, REVIVE], steer(9, 0)], 100)).toEqual({ ok: true });
    expect(validateInputs([steer(5, 1), [5, REVIVE], steer(5, 0)], 100)).toEqual({ ok: false, reason: 'ticks_not_increasing' });
    expect(validateInputs([steer(5, 1), [4, REVIVE]], 100)).toEqual({ ok: false, reason: 'ticks_not_increasing' });
    expect(validateInputs([[5, REVIVE], [7, REVIVE]], 100)).toEqual({ ok: false, reason: 'second_revive' });
    // A bonus life is not a steering change: the next change is judged against the steering before it.
    expect(validateInputs([steer(5, 1), [6, REVIVE], steer(9, 1)], 100)).toEqual({ ok: false, reason: 'redundant_event' });
  });

  it('round-trips through the wire format, including a zero gap', () => {
    const log: InputEvent[] = [[3, 1], [8, -1], [8, REVIVE], [12, 0]];
    expect(decodeInputs(encodeInputs(log))).toEqual(log);
    expect(decodeInputs([0, -1])).toBeNull();
  });
});
