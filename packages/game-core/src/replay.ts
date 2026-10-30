import { DEFAULT_CONFIG, type GameConfig } from './config';
import { Simulation } from './sim';
import type { Steer } from './types';

/**
 * In an input log, marks the bonus life: the ship lost at step `tick` is put
 * back on the water before the next step. It is not a steering change.
 */
export const REVIVE = 2;

/**
 * One steering change: from simulation step `tick` onward, `steer` is applied
 * (until the next change). Step `tick` is the step that advances the
 * simulation from tick-1 to tick, so the first possible change is tick 1.
 * At most one event may be a `REVIVE` instead.
 */
export type InputEvent = [tick: number, steer: Steer | typeof REVIVE];

/** The tick at which the log takes its bonus life, or null. */
export function reviveTickOf(inputs: readonly InputEvent[]): number | null {
  for (const e of inputs) if (e[1] === REVIVE) return e[0];
  return null;
}

/** Hard limits — anything beyond these is not a human with a keyboard. */
export const MAX_CHANGES_PER_SECOND = 30;

/** Records only changes of steering, which keeps replays tiny (a few hundred bytes a minute). */
export class InputRecorder {
  readonly events: InputEvent[] = [];
  private current: Steer = 0;

  /** Call immediately before `sim.step(steer)` with the tick that step will produce. */
  record(tick: number, steer: Steer): void {
    if (steer === this.current) return;
    this.current = steer;
    this.events.push([tick, steer]);
  }

  /** Call after `sim.revive()`, with the tick at which the ship was lost. */
  revive(tick: number): void {
    this.events.push([tick, REVIVE]);
  }

  /** Events with tick <= `tick` (e.g. for a checkpoint). */
  upTo(tick: number): InputEvent[] {
    const out: InputEvent[] = [];
    for (const e of this.events) if (e[0] <= tick) out.push(e);
    return out;
  }
}

/** Plays back an input log tick by tick. */
export class InputPlayer {
  private idx = 0;
  private current: Steer = 0;
  constructor(private readonly events: readonly InputEvent[]) {}

  steerFor(tick: number): Steer {
    while (this.idx < this.events.length && this.events[this.idx][0] <= tick) {
      const steer = this.events[this.idx][1];
      if (steer !== REVIVE) this.current = steer;
      this.idx++;
    }
    return this.current;
  }
}

export type InputValidation = { ok: true } | { ok: false; reason: string };

/** Structural validation of an untrusted input log. */
export function validateInputs(inputs: unknown, maxTick: number): InputValidation {
  if (!Array.isArray(inputs)) return { ok: false, reason: 'inputs_not_array' };
  let prevTick = 0;
  let prevSteer: number = 0;
  let revived = false;
  const windowTicks = 60;
  const windowStart: number[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const e = inputs[i];
    if (!Array.isArray(e) || e.length !== 2) return { ok: false, reason: 'malformed_event' };
    const [tick, steer] = e as [unknown, unknown];
    if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 1) return { ok: false, reason: 'bad_tick' };
    if (tick > maxTick) return { ok: false, reason: 'tick_out_of_range' };
    if (steer === REVIVE) {
      // Taken after the step that lost the ship, so it may share a tick with that step's steering change.
      if (tick < prevTick) return { ok: false, reason: 'ticks_not_increasing' };
      if (revived) return { ok: false, reason: 'second_revive' };
      revived = true;
      prevTick = tick;
      continue;
    }
    if (tick <= prevTick) return { ok: false, reason: 'ticks_not_increasing' };
    if (steer !== -1 && steer !== 0 && steer !== 1) return { ok: false, reason: 'bad_steer' };
    if (steer === prevSteer) return { ok: false, reason: 'redundant_event' };
    // Burst limit: no more than MAX_CHANGES_PER_SECOND changes inside any one-second window.
    windowStart.push(tick);
    while (windowStart.length > 0 && windowStart[0] <= tick - windowTicks) windowStart.shift();
    if (windowStart.length > MAX_CHANGES_PER_SECOND) return { ok: false, reason: 'input_rate_exceeded' };
    prevTick = tick;
    prevSteer = steer;
  }
  return { ok: true };
}

/** Compact wire format: flat [tick, steer, tick, steer, ...] with delta-coded ticks. */
export function encodeInputs(events: readonly InputEvent[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const [tick, steer] of events) {
    out.push(tick - prev, steer);
    prev = tick;
  }
  return out;
}

export function decodeInputs(flat: unknown): InputEvent[] | null {
  if (!Array.isArray(flat) || flat.length % 2 !== 0) return null;
  const out: InputEvent[] = [];
  let tick = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const d = flat[i];
    const s = flat[i + 1];
    if (s !== -1 && s !== 0 && s !== 1 && s !== REVIVE) return null;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < (s === REVIVE ? 0 : 1)) return null;
    tick += d;
    out.push([tick, s]);
  }
  return out;
}

/**
 * Re-run a game from its seed and inputs, stopping at death or at `untilTick`. The log's bonus life is
 * taken only if the ship really was lost at exactly that tick; otherwise it is ignored.
 */
export function runReplay(
  seed: string,
  inputs: readonly InputEvent[],
  untilTick: number,
  config: GameConfig = DEFAULT_CONFIG,
): Simulation {
  const sim = new Simulation(seed, config);
  const player = new InputPlayer(inputs);
  const reviveAt = reviveTickOf(inputs);
  const limit = Math.min(untilTick, config.maxTicks);
  for (;;) {
    if (sim.over) {
      if (sim.tick !== reviveAt || !sim.canRevive) break;
      sim.revive();
    }
    if (sim.tick >= limit) break;
    sim.step(player.steerFor(sim.tick + 1));
  }
  return sim;
}
