import { steerShip, whirlpoolDrift } from './physics';
import { Rng } from './rng';
import { distanceToOpening, straightOpenings, type Simulation } from './sim';
import type { Obstacle, ShipState, Steer, Whirlpool } from './types';

/**
 * Automated navigators. Used for (1) balancing and fairness tests — a planner
 * that looks ahead only as far as a player can see must be able to survive
 * long runs, proving the course never demands the impossible — and (2) the
 * attract-mode ship sailing behind the website hero.
 */
export interface BotOptions {
  /** How far ahead (ticks) each candidate manoeuvre is simulated. */
  horizonTicks?: number;
  /** Ticks between decisions (a person re-evaluates a few times a second). */
  replanTicks?: number;
  /** Delay (ticks) between a decision and the helm responding — models reaction time. */
  reactionTicks?: number;
  /** Extra clearance the bot insists on. */
  margin?: number;
  /** Only hazards this far ahead are considered (the mist hides the rest). */
  viewRadius?: number;
  /** Chance per decision of a random (possibly bad) choice. */
  blunderRate?: number;
  /** Prefer collecting evidence. */
  greed?: number;
  seed?: string;
}

/** The planning horizon is split into segments of roughly these shares; each segment holds one steer. */
const SEGMENTS = [0.1, 0.18, 0.3, 0.42];
const STEERS: readonly Steer[] = [0, -1, 1];
const DEATH_COST = 1e6;
/** A plan already being followed is kept unless a new one is better by more than this. */
const HYSTERESIS = 6;

interface Probe {
  x: number;
  z: number;
  vx: number;
}

interface Plan {
  /** First tick the plan steers (decision tick + reaction delay). */
  start: number;
  /** [length in ticks, steer] per segment. */
  segments: Array<[number, Steer]>;
}

function steerAt(plan: Plan, tick: number): Steer {
  let t = plan.start;
  for (const [len, steer] of plan.segments) {
    if (tick < t + len) return steer;
    t += len;
  }
  return 0;
}

/**
 * Plans by depth-first search over steering sequences, simulating the ship
 * with the real physics. Segment boundaries sit on the decision grid, so any
 * plan it finds can actually be carried out — and it keeps following a plan
 * it already has unless a clearly better one turns up.
 */
export class LookaheadBot {
  private readonly o: Required<BotOptions>;
  private readonly rng: Rng;
  private readonly step: number;
  private readonly segLens: number[] = [];
  private committed: Steer = 0;
  private nextDecision = 0;
  /** Decisions waiting out the reaction delay: [tick it takes effect, steer]. */
  private readonly pending: Array<[number, Steer]> = [];
  private helm: Steer = 0;
  private current: Plan | null = null;
  private readonly ship: ShipState = { x: 0, z: 0, vx: 0, speed: 0, lateralSpeed: 0, distance: 0 };
  private sim!: Simulation;
  private visible: Obstacle[] = [];
  private whirls: Whirlpool[] = [];
  private rows: Array<{ z0: number; z1: number; openings: Array<[number, number]> }> = [];
  // Search state.
  private minClear = 60;
  private reward = 0;
  private readonly path: Steer[] = [];
  private bestValue = Number.NEGATIVE_INFINITY;
  private bestPath: Steer[] = [];

  constructor(opts: BotOptions = {}) {
    this.o = {
      horizonTicks: opts.horizonTicks ?? 96,
      replanTicks: opts.replanTicks ?? 6,
      reactionTicks: opts.reactionTicks ?? 0,
      margin: opts.margin ?? 6,
      viewRadius: opts.viewRadius ?? 2200,
      blunderRate: opts.blunderRate ?? 0,
      greed: opts.greed ?? 1,
      seed: opts.seed ?? '0b07',
    };
    this.rng = Rng.fromSeed(this.o.seed, 'bot');
    const r = Math.max(1, Math.round(this.o.replanTicks));
    this.step = r % 2 === 0 && this.o.reactionTicks % 2 === 0 ? 2 : 1;
    for (const share of SEGMENTS) this.segLens.push(Math.max(r, Math.round((share * this.o.horizonTicks) / r) * r));
  }

  decide(sim: Simulation): Steer {
    if (sim.tick >= this.nextDecision) {
      this.nextDecision = sim.tick + this.o.replanTicks;
      if (this.o.blunderRate > 0 && this.rng.chance(this.o.blunderRate)) {
        this.committed = this.rng.pick([-1, 0, 1] as const);
        this.current = null;
      } else {
        this.committed = this.plan(sim);
      }
      if (this.o.reactionTicks > 0) this.pending.push([sim.tick + this.o.reactionTicks, this.committed]);
      else this.helm = this.committed;
    }
    while (this.pending.length && this.pending[0][0] <= sim.tick) this.helm = this.pending.shift()![1];
    return this.helm;
  }

  private plan(sim: Simulation): Steer {
    const ship = sim.ship;
    const zMax = ship.z + this.o.viewRadius;
    this.sim = sim;
    this.visible = sim.obstacles.filter((o) => o.z + o.r > ship.z - 60 && o.z - o.r < zMax);
    this.whirls = sim.whirlpools.filter((w) => w.z + w.pullRadius > ship.z && w.z - w.pullRadius < zMax);
    this.groupRows(sim);
    Object.assign(this.ship, ship);

    // Until the reaction delay runs out, the helm follows the orders already given.
    const p = this.ship;
    let helm = this.helm;
    let qi = 0;
    for (let t = this.step; t <= this.o.reactionTicks; t += this.step) {
      while (qi < this.pending.length && this.pending[qi][0] - sim.tick < t) helm = this.pending[qi++][1];
      this.advance(helm);
    }
    const start: Probe = { x: p.x, z: p.z, vx: p.vx };
    const planStart = sim.tick + this.o.reactionTicks;
    const total = this.segLens.reduce((a, b) => a + b, 0);

    // The plan already being followed, carried on.
    let keepValue = Number.NEGATIVE_INFINITY;
    const prev = this.current;
    if (prev) {
      this.reset(start);
      const deadAt = this.span(0, total, (t) => steerAt(prev, planStart + t));
      keepValue = (deadAt >= 0 ? this.deathValue(deadAt) : this.leafValue(total)) + HYSTERESIS;
    }

    this.bestValue = Number.NEGATIVE_INFINITY;
    this.bestPath = [];
    for (const s of STEERS) this.search(start, 0, 0, s, 60, 0, (s === 0 ? 5 : 0) + (s === this.committed ? 3 : 0));

    if (prev && keepValue >= this.bestValue) return steerAt(prev, planStart);
    this.current = { start: planStart, segments: this.segLens.map((len, i) => [len, this.bestPath[i] ?? 0] as [number, Steer]) };
    return this.bestPath[0] ?? 0;
  }

  private reset(start: Probe): void {
    const p = this.ship;
    p.x = start.x;
    p.z = start.z;
    p.vx = start.vx;
    this.minClear = 60;
    this.reward = 0;
  }

  private search(start: Probe, depth: number, t0: number, steer: Steer, clear: number, reward: number, bonus: number): void {
    this.path[depth] = steer;
    const p = this.ship;
    p.x = start.x;
    p.z = start.z;
    p.vx = start.vx;
    this.minClear = clear;
    this.reward = reward;
    const t1 = t0 + this.segLens[depth];
    const deadAt = this.span(t0, t1, () => steer);
    if (deadAt >= 0) return this.consider(this.deathValue(deadAt) + bonus, depth);
    if (depth + 1 === this.segLens.length) return this.consider(this.leafValue(t1) + bonus, depth);
    const here: Probe = { x: p.x, z: p.z, vx: p.vx };
    const c = this.minClear;
    const r = this.reward;
    for (const s of STEERS) this.search(here, depth + 1, t1, s, c, r, bonus + (s === steer ? 1 : 0));
  }

  private consider(value: number, depth: number): void {
    if (value <= this.bestValue) return;
    this.bestValue = value;
    this.bestPath = this.path.slice(0, depth + 1);
  }

  /** Any plan that survives the horizon beats every plan that does not; among those, later is better. */
  private deathValue(tick: number): number {
    return tick * 100 + Math.min(this.minClear, 60) * 2 - DEATH_COST;
  }

  private leafValue(tick: number): number {
    // Beyond the horizon: stay away from the Edge, and head for the next gap in sight.
    const hw = this.sim.config.channelHalfWidth;
    const edgeCost = Math.max(0, Math.abs(this.ship.x) - hw * 0.55) * 0.4;
    return tick * 100 + this.minClear * 2 - edgeCost - this.gapCost(this.ship) + this.reward * 90 * this.o.greed;
  }

  /** Sail the probe from tick t0 to t1 (relative to the plan start). Returns the tick it is lost at, or -1. */
  private span(t0: number, t1: number, steerFn: (t: number) => Steer): number {
    const cfg = this.sim.config;
    const hw = cfg.channelHalfWidth;
    const hitPad = cfg.ship.hitRadius + this.o.margin;
    const offs = cfg.ship.hitOffsets;
    const reachZ = Math.max(...offs) + hitPad + 8;
    const pick2 = cfg.evidence.pickupRadius * cfg.evidence.pickupRadius;
    const p = this.ship;
    for (let t = t0 + this.step; t <= t1; t += this.step) {
      this.advance(steerFn(t - this.step));
      if (p.x > hw - 6 - this.o.margin || p.x < -hw + 6 + this.o.margin) return t;
      for (let i = 0; i < this.whirls.length; i++) {
        const w = this.whirls[i];
        const dx = w.x - p.x;
        const dz = w.z - p.z;
        const lim = w.coreRadius + 20 + this.o.margin;
        if (dx * dx + dz * dz < lim * lim) return t;
      }
      for (let i = 0; i < this.visible.length; i++) {
        const o = this.visible[i];
        if (o.z + o.r < p.z - reachZ || o.z - o.r > p.z + reachZ) continue;
        for (let h = 0; h < offs.length; h++) {
          const dx = o.x - p.x;
          const dz = o.z - (p.z + offs[h]);
          const lim = o.r + hitPad;
          const d2 = dx * dx + dz * dz;
          if (d2 < lim * lim) return t;
          const c = Math.sqrt(d2) - lim;
          if (c < this.minClear) this.minClear = c;
        }
      }
      for (const e of this.sim.evidence) {
        const dx = e.x - p.x;
        const dz = e.z - p.z;
        if (dx * dx + dz * dz < pick2) this.reward = Math.max(this.reward, e.superCoin ? 3 : 1);
      }
    }
    return -1;
  }

  /**
   * Group the hazards in sight into rows (clusters along the course) and work
   * out each row's straight-through openings — what a person sees at a glance.
   */
  private groupRows(sim: Simulation): void {
    const cfg = sim.config;
    const hw = cfg.channelHalfWidth;
    const hr = cfg.ship.hitRadius + this.o.margin;
    const items: Array<{ z0: number; z1: number; a: number; b: number }> = [];
    for (const o of this.visible) items.push({ z0: o.z - o.r, z1: o.z + o.r, a: o.x - o.r - hr, b: o.x + o.r + hr });
    for (const w of this.whirls) {
      const berth = w.coreRadius + 30 + this.o.margin;
      items.push({ z0: w.z - w.coreRadius, z1: w.z + w.coreRadius, a: w.x - berth, b: w.x + berth });
    }
    items.sort((u, v) => u.z0 - v.z0);
    this.rows = [];
    let current: { z0: number; z1: number; blocked: Array<[number, number]> } | null = null;
    const flush = () => {
      if (current) this.rows.push({ z0: current.z0, z1: current.z1, openings: straightOpenings(hw, current.blocked) });
    };
    for (const it of items) {
      if (!current || it.z0 > current.z1 + 40) {
        flush();
        current = { z0: it.z0, z1: it.z1, blocked: [] };
      }
      current.z1 = Math.max(current.z1, it.z1);
      current.blocked.push([it.a, it.b]);
    }
    flush();
  }

  /**
   * Cost of ending a plan at `p`, judged by the next row beyond it: how far is
   * the nearest gap, and can the ship still get there in time?
   */
  private gapCost(p: ShipState): number {
    const cfg = this.sim.config;
    const fore = Math.max(...cfg.ship.hitOffsets) + cfg.ship.hitRadius;
    for (const row of this.rows) {
      if (row.z0 <= p.z + fore) continue;
      const d = distanceToOpening(p.x, row.openings);
      const time = (row.z0 - p.z - fore) / p.speed;
      const need = d / p.lateralSpeed + cfg.ship.lateralAccelTime;
      return d * 0.5 + Math.min(1, Math.max(0, need - time)) * 6000;
    }
    return 0;
  }

  /** Move the probe ship one step under `steer`. */
  private advance(steer: Steer): void {
    const cfg = this.sim.config;
    const dt = this.step / cfg.tickRate;
    const p = this.ship;
    steerShip(p, steer, cfg, dt);
    p.x += (p.vx + whirlpoolDrift(p.x, p.z, p.lateralSpeed, this.whirls, cfg)) * dt;
    p.z += p.speed * dt;
  }
}
