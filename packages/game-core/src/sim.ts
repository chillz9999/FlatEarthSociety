import { DEFAULT_CONFIG, type GameConfig } from './config';
import { clamp } from './detmath';
import { difficultyAt, stageIndexAt, type DifficultyParams } from './difficulty';
import { StateHasher } from './hash';
import { hullPoints, moveShip, steerShip, whirlpoolDrift } from './physics';
import { Rng } from './rng';
import type { DeathCause, Evidence, Obstacle, ObstacleKind, RunResult, RunStats, ShipState, SimEvent, Steer, Whirlpool } from './types';

/** Ticks between checkpoint hashes (used to pinpoint client/server divergence). */
export const CHECKPOINT_TICKS = 600;
const NEAR_MISS_CLEARANCE = 8;
/** Hazards and evidence this far behind the ship are discarded (they are behind the camera). */
const PRUNE_BEHIND = 500;
/** Minimum open water between the back of one row and the front of the next. */
const MIN_WINDOW = 90;
/**
 * The main gap keeps at least this far from the Edge: a way through that hugs the lip asks the helm to stop dead
 * beside a fall, and a moment's overshoot is the end of the voyage.
 */
const PASSAGE_EDGE_MARGIN = 80;
/** Whirlpools pull the ship sideways, so passages next to (and after) them move less. */
const WHIRLPOOL_REACH_FACTOR = 0.6;
/** Resolution of the fairness sweep across the channel, and along it. */
const CELL = 4;
const SWEEP_STEP = 6;
/** Openings narrower than this (for the ship's centre) do not count as a way through. */
const MIN_OPENING = 8;
/** Openings hugging the Edge of the World do not count as a fair way through. */
const EDGE_PAD = 36;
/** Sideways berth around a whirlpool's core that does not count as an opening. */
const WHIRLPOOL_BERTH = 40;
/** Collision radius as a share of the drawn half-width, per kind of hazard. */
const ROCK_RATIO = 0.82;
const DEBRIS_RATIO = 0.75;
const ISLAND_RATIO = 0.84;
const ICE_RATIO = 0.8;
const TENTACLE_RATIO = 0.8;
const WRECK_RATIO = 0.82;
const PILLAR_RATIO = 0.85;
/** Collision radius of a sea gate's pillars, and of the Colossus's legs. */
const PILLAR_R = 24;
const COLOSSUS_LEG_R = 28;
const LEVIATHAN_RATIO = 0.8;
/** An ice shelf is a row of overlapping circles of this radius. */
const SHELF_R = 38;

/**
 * Stretches where the ship's centre can sail straight through a row, keeping
 * `EDGE_PAD` clear of the Edge of the World.
 */
export function straightOpenings(hw: number, blocked: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...blocked].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  const end = hw - EDGE_PAD;
  let cursor = -end;
  for (const [a, b] of sorted) {
    if (Math.min(a, end) - cursor >= MIN_OPENING) out.push([cursor, Math.min(a, end)]);
    if (b > cursor) cursor = b;
    if (cursor >= end) break;
  }
  if (end - cursor >= MIN_OPENING) out.push([cursor, end]);
  return out;
}

/** Sideways distance from x to the nearest opening (0 when inside one). */
export function distanceToOpening(x: number, openings: ReadonlyArray<readonly [number, number]>): number {
  let best = Number.POSITIVE_INFINITY;
  for (const [a, b] of openings) {
    const lo = a + MIN_OPENING / 2;
    const hi = b - MIN_OPENING / 2;
    const dd = x < lo ? lo - x : x > hi ? x - hi : 0;
    if (dd < best) best = dd;
  }
  return best;
}

/** The greatest distance to the nearest opening from any x in [lo, hi] (exact). */
export function furthestFromOpening(lo: number, hi: number, openings: ReadonlyArray<readonly [number, number]>): number {
  // Distance to the nearest opening is piecewise linear: its maximum lies at an end or midway between openings.
  let worst = Math.max(distanceToOpening(lo, openings), distanceToOpening(hi, openings));
  for (let i = 1; i < openings.length; i++) {
    const mid = (openings[i - 1][1] + openings[i][0]) / 2;
    if (mid > lo && mid < hi) worst = Math.max(worst, distanceToOpening(mid, openings));
  }
  return worst;
}

/** x folded back inside [lo, hi] at whichever limit it crossed (the limits themselves stay hard). */
function reflect(x: number, lo: number, hi: number): number {
  if (x > hi) return hi - (x - hi);
  if (x < lo) return lo + (lo - x);
  return x;
}

function blockCells(cells: Uint8Array, x0: number, x1: number, hw: number): void {
  const a = Math.max(0, Math.ceil((x0 + hw) / CELL));
  const b = Math.min(cells.length - 1, Math.floor((x1 + hw) / CELL));
  for (let i = a; i <= b; i++) cells[i] = 0;
}

export type RowPattern =
  | 'empty'
  | 'rocks'
  | 'wall'
  | 'gate'
  | 'colossus'
  | 'slalom'
  | 'debris'
  | 'wreck'
  | 'island'
  | 'ice'
  | 'shelf'
  | 'kraken'
  | 'leviathan'
  | 'whirlpool';

/** The fairness record of one row of hazards (kept for tests and diagnostics). */
export interface RowRecord {
  index: number;
  pattern: RowPattern;
  z: number;
  /** Centre and width of the guaranteed open passage. */
  passage: number;
  gap: number;
  /** How far the row's hazards reach before / after `z`. */
  front: number;
  back: number;
  /** Open water before the row (ship-centre travel between the two rows' hazards). */
  window: number;
  /** Furthest any position the ship could have left the previous row from is from an opening here… */
  need: number;
  /** …and the sideways distance the ship is guaranteed to manage (with margin) across `window`. */
  reach: number;
  /** Extent of positions the ship could occupy once past this row. */
  hullLo: number;
  hullHi: number;
}

/**
 * The Society Test: an endless voyage down a charted channel towards the Edge
 * of the World. The ship sails straight ahead on its own, faster and faster;
 * the player only moves it from side to side. One instance = one run. Fully
 * deterministic — the same seed and per-tick steering always produce the same
 * outcome. The course itself depends only on the seed (never on the steering).
 */
export class Simulation {
  readonly config: GameConfig;
  readonly seed: string;
  readonly dt: number;

  tick = 0;
  readonly ship: ShipState;
  obstacles: Obstacle[] = [];
  whirlpools: Whirlpool[] = [];
  evidence: Evidence[] = [];
  /** Events produced by the most recent step (consumed by the renderer). */
  events: SimEvent[] = [];
  over = false;
  death: DeathCause | null = null;
  deathObstacleId: number | null = null;
  /** The bonus life has been used, and the tick at which it was (-1 until then). */
  revived = false;
  reviveTick = -1;
  difficulty: DifficultyParams;
  stageIndex = 0;
  /** Pieces collected, super coins included. */
  evidenceCollected = 0;
  superCollected = 0;
  readonly checkpointHashes: string[] = [];
  readonly stats: RunStats = { evidence: 0, nearMisses: 0, closestClearance: Number.POSITIVE_INFINITY, inputChanges: 0, rows: 0 };
  /** Recent rows (diagnostics; trimmed as they fall behind unless `keepRowHistory`). */
  readonly rows: RowRecord[] = [];
  keepRowHistory = false;

  private readonly rng: Rng;
  private nextId = 0;
  private nextFieldId = 1;
  private nextRowZ: number;
  private prevRow: { z: number; back: number; passage: number; pattern: RowPattern; hullLo: number; hullHi: number };
  /** How far the hull's collision circles reach ahead of / behind the ship's centre. */
  private readonly hullFore: number;
  private readonly hullAft: number;
  /** A slalom in progress: rows still to lay, the side the next wall hangs from, and what it is built of. */
  private slalom = { left: 0, side: 1 as 1 | -1, kind: 'rock' as ObstacleKind };
  private lastSteer: Steer = 0;
  private inNearMiss = false;
  private readonly hull: number[] = [];
  private readonly protectionTicks: number;
  private readonly shieldTicks: number;
  private readonly maxShieldTicks: number;
  /** A revived ship cannot be sunk by hazards while this holds. */
  private shielded = false;

  constructor(seed: string, config: GameConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.seed = seed;
    this.dt = 1 / config.tickRate;
    this.protectionTicks = Math.round(config.spawnProtectionSeconds * config.tickRate);
    this.shieldTicks = Math.round(config.revive.shieldSeconds * config.tickRate);
    this.maxShieldTicks = Math.round(config.revive.maxShieldSeconds * config.tickRate);
    this.rng = Rng.fromSeed(seed, 'course');
    this.difficulty = difficultyAt(0, config);
    this.ship = { x: 0, z: 0, vx: 0, speed: this.difficulty.speed, lateralSpeed: this.difficulty.lateralSpeed, distance: 0 };
    this.hullFore = Math.max(...config.ship.hitOffsets) + config.ship.hitRadius;
    this.hullAft = config.ship.hitRadius - Math.min(...config.ship.hitOffsets);
    this.nextRowZ = config.track.firstRowDistance;
    this.prevRow = { z: 0, back: -this.hullAft, passage: 0, pattern: 'empty', hullLo: 0, hullHi: 0 };
    // Two pieces of evidence on the opening stretch teach collection.
    this.addEvidence(0, 360, false);
    this.addEvidence(this.rng.chance(0.5) ? 120 : -120, 600, false);
    this.layCourse();
  }

  // ---------------------------------------------------------------- scoring

  get distanceScore(): number {
    return Math.floor(this.ship.distance / this.config.unitsPerPoint);
  }

  get evidenceScore(): number {
    const e = this.config.evidence;
    return (this.evidenceCollected - this.superCollected) * e.points + this.superCollected * e.superPoints;
  }

  /** Final Score = Distance Travelled + Evidence Bonus. */
  get score(): number {
    return this.distanceScore + this.evidenceScore;
  }

  get timeSeconds(): number {
    return this.tick / this.config.tickRate;
  }

  get protectedNow(): boolean {
    return this.tick < this.protectionTicks || this.shielded;
  }

  /** A lost ship can take its one bonus life (not once the examination's time is up). */
  get canRevive(): boolean {
    return this.over && !this.revived && this.death !== null && this.death !== 'timeout';
  }

  /**
   * The bonus life: the lost ship is put back on the water where it went down, at rest across the channel
   * and inside the Edge, and is shielded from hazards until it has sailed clear of them. The voyage then
   * carries on from the same tick, so the replay stays exact.
   */
  revive(): void {
    if (!this.canRevive) throw new Error('No ship to revive');
    const ship = this.ship;
    const limit = this.config.channelHalfWidth - this.config.revive.edgeInset;
    ship.x = Math.max(-limit, Math.min(limit, ship.x));
    ship.vx = 0;
    this.over = false;
    this.death = null;
    this.deathObstacleId = null;
    this.revived = true;
    this.reviveTick = this.tick;
    this.shielded = true;
    this.inNearMiss = false;
    this.events = [];
  }

  // -------------------------------------------------------------- main loop

  step(steer: Steer): void {
    if (this.over) return;
    this.events = [];
    if (steer !== this.lastSteer) {
      this.stats.inputChanges++;
      this.lastSteer = steer;
    }
    this.tick++;
    const cfg = this.config;

    this.difficulty = difficultyAt(this.tick, cfg);
    const stage = stageIndexAt(this.timeSeconds);
    if (stage !== this.stageIndex) {
      this.stageIndex = stage;
      this.events.push({ type: 'stage', stage });
    }
    if (this.tick === this.protectionTicks) this.events.push({ type: 'protectionEnd' });

    const ship = this.ship;
    ship.speed = this.difficulty.speed;
    ship.lateralSpeed = this.difficulty.lateralSpeed;
    steerShip(ship, steer, cfg, this.dt);
    moveShip(ship, whirlpoolDrift(ship.x, ship.z, ship.lateralSpeed, this.whirlpools, cfg), this.dt);

    this.layCourse();
    this.prune();
    this.collectEvidence();
    this.checkCollisions();
    if (this.tick % CHECKPOINT_TICKS === 0) this.checkpointHashes.push(this.stateHash());
    if (!this.over && this.tick >= cfg.maxTicks) this.end('timeout');
  }

  private end(cause: DeathCause, obstacleId?: number, whirlpoolId?: number): void {
    this.over = true;
    this.death = cause;
    this.deathObstacleId = obstacleId ?? null;
    this.events.push({ type: 'death', cause, x: this.ship.x, z: this.ship.z, obstacleId, whirlpoolId });
  }

  // ------------------------------------------------------------ the course

  /** Lay rows of hazards until the course is charted `spawnAhead` beyond the ship. */
  private layCourse(): void {
    const horizon = this.ship.z + this.config.track.spawnAhead;
    while (this.nextRowZ < horizon) this.layRow();
  }

  private choosePattern(d: DifficultyParams): RowPattern {
    if (this.slalom.left > 0) return 'slalom';
    const r = this.rng.next();
    const table: Array<[RowPattern, number]> = [
      ['empty', d.emptyChance],
      ['wall', d.wallChance],
      ['gate', d.gateChance],
      ['colossus', d.colossusChance],
      ['slalom', d.slalomChance],
      ['debris', d.debrisChance],
      ['wreck', d.wreckChance],
      ['whirlpool', d.whirlpoolChance],
      ['island', d.islandChance],
      ['ice', d.icebergChance],
      ['shelf', d.shelfChance],
      ['kraken', d.krakenChance],
      ['leviathan', d.leviathanChance],
    ];
    let acc = 0;
    for (const [pattern, chance] of table) {
      acc += chance;
      if (r < acc) {
        if (pattern === 'slalom') {
          this.slalom.left = 3 + Math.floor(this.rng.next() * 3);
          this.slalom.side = this.rng.chance(0.5) ? 1 : -1;
          this.slalom.kind = this.rng.chance(0.5) ? 'iceberg' : 'rock';
        }
        return pattern;
      }
    }
    return 'rocks';
  }

  /**
   * One row of hazards across the channel.
   *
   * The fairness guarantee: wherever the ship could possibly have left the
   * previous row, some straight-through opening of this row is within sideways
   * reach — with a generous safety margin, allowing for the time the helm takes
   * to answer — in the open water between the two rows. Nothing is ever placed
   * in that open water, and every row also keeps its main passage `gap` wide.
   * When an opening would be too far away, the row is moved further down the
   * course until it is not. Rows are sized for the difficulty at the moment the
   * ship will reach them.
   */
  private layRow(): void {
    const cfg = this.config;
    const rng = this.rng;
    const hw = cfg.channelHalfWidth;
    const prev = this.prevRow;

    // The ship's speed rises while it sails here; judge the row by the (harder) difficulty on arrival.
    const ahead = (this.nextRowZ - this.ship.z) / this.difficulty.speed;
    const d = difficultyAt(this.tick + Math.ceil(ahead * cfg.tickRate), cfg);
    const gap = d.gap;
    const pc = clamp((d.intensity - 0.18) / 0.82, 0, 1);
    const pattern = this.choosePattern(d);
    const index = this.stats.rows++;
    let margin = cfg.track.reachMargin;
    if (pattern === 'whirlpool' || prev.pattern === 'whirlpool') margin *= WHIRLPOOL_REACH_FACTOR;
    const accelLoss = (cfg.ship.lateralAccelTime + cfg.ship.lateralDecelTime) / 2;
    /** Sideways distance the ship is guaranteed to manage across `window` units of open water (with margin). */
    const reachFor = (window: number) => margin * d.lateralSpeed * Math.max(0, window / d.speed - accelLoss);

    if (pattern === 'empty') {
      // Open water: a breather. The next row is judged against the last real one.
      // (Its open water is scattered with evidence along with the rest of the next row's run-up.)
      const z = this.nextRowZ;
      this.rows.push({ index, pattern, z, passage: prev.passage, gap, front: 0, back: 0, window: 0, need: 0, reach: 0, hullLo: prev.hullLo, hullHi: prev.hullHi });
      this.trimRows();
      this.nextRowZ = z + d.speed * d.rowInterval;
      return;
    }

    // Sizes first, so the row's reach along the course is known before its passage is chosen.
    let front = 0;
    let bigVr = 0;
    let pull = 0;
    switch (pattern) {
      case 'rocks':
        front = 46 * ROCK_RATIO + 30;
        break;
      case 'ice':
        front = 56 * ICE_RATIO + 30;
        break;
      case 'kraken':
        front = 21 * TENTACLE_RATIO + 28;
        break;
      case 'wall':
      case 'gate':
      case 'colossus':
      case 'slalom':
        front = 32 + 4;
        break;
      case 'shelf':
        front = SHELF_R + 4;
        break;
      case 'leviathan':
        bigVr = rng.range(46, 58) / LEVIATHAN_RATIO;
        front = bigVr * LEVIATHAN_RATIO + 60;
        break;
      case 'debris':
        front = 24 * DEBRIS_RATIO + 8;
        break;
      case 'island':
        bigVr = rng.range(130, 200);
        front = Math.max(bigVr * ISLAND_RATIO, 40 * ROCK_RATIO + 20);
        break;
      case 'wreck':
        bigVr = rng.range(90, 130);
        front = bigVr * WRECK_RATIO + 16;
        break;
      default:
        pull = rng.range(cfg.whirlpool.pullRadiusMin, cfg.whirlpool.pullRadiusMax);
        front = cfg.whirlpool.coreRadius;
    }

    let openWater = prev.z + prev.back + this.hullAft + front + this.hullFore;
    let z = Math.max(this.nextRowZ, openWater + MIN_WINDOW);
    const lo = -hw + gap / 2 + PASSAGE_EDGE_MARGIN;
    const hi = hw - gap / 2 - PASSAGE_EDGE_MARGIN;
    const drift = reachFor(z - openWater);
    // The passage wanders across the channel, bouncing off its limits rather than gathering against them.
    let passage = clamp(reflect(prev.passage + rng.range(-drift, drift), lo, hi), lo, hi);
    // The Colossus needs room for a leg on either side of the gap.
    if (pattern === 'colossus') passage = clamp(passage, lo + 2 * COLOSSUS_LEG_R + 20, hi - 2 * COLOSSUS_LEG_R - 20);
    // A slalom wall hangs from one side and reaches past the middle; the way through is on the other side.
    let slalomEdge = 0;
    if (pattern === 'slalom') {
      const side = this.slalom.side;
      slalomEdge = side * -rng.range(0.05, 0.3) * hw;
      passage = clamp((slalomEdge - side * hw) / 2, lo, hi);
    }
    const free0 = passage - gap / 2;
    const free1 = passage + gap / 2;

    let back = 0;
    const placed: Obstacle[] = [];
    let whirl: Whirlpool | null = null;
    const tryPlace = (kind: ObstacleKind, x: number, oz: number, vr: number, ratio: number, fieldId = 0): boolean => {
      const r = vr * ratio;
      if (x + r > free0 && x - r < free1) return false;
      // Every hazard lies wholly inside the channel's lines.
      if (x - r < -hw || x + r > hw) return false;
      for (const o of placed) {
        const dx = o.x - x;
        const dz = o.z - oz;
        const min = o.r + r + (kind === 'debris' && o.kind === 'debris' ? 2 : 6);
        if (dx * dx + dz * dz < min * min) return false;
      }
      placed.push({ id: this.nextId++, kind, x, z: oz, r, vr, shape: rng.nextU32(), fieldId });
      back = Math.max(back, oz - z + r);
      return true;
    };
    /** Hazards shoulder to shoulder from a to b: no half-gaps that look passable but are not. */
    const fillWall = (a: number, b: number, kind: ObstacleKind, ratio: number) => {
      const length = b - a;
      if (length < 24) return;
      const n = Math.ceil(length / 64);
      const spacing = length / n;
      const r = spacing / 2;
      for (let i = 0; i < n; i++) {
        const o: Obstacle = { id: this.nextId++, kind, x: a + (i + 0.5) * spacing, z: z + rng.range(-4, 4), r, vr: r / ratio, shape: rng.nextU32(), fieldId: 0 };
        placed.push(o);
        back = Math.max(back, o.z - z + r);
      }
    };
    /** A scatter across the row: the fuller the row, the fewer ways through. */
    const scatter = (kind: ObstacleKind, vrMin: number, vrMax: number, ratio: number, iceShare = 0, greatShare = 0) => {
      const avg = (vrMin + vrMax) * ratio;
      const count = Math.max(1, Math.round((d.fill * (2 * hw - gap)) / avg));
      for (let i = 0, tries = 0; i < count && tries < count * 8; tries++) {
        const ice = iceShare > 0 && rng.chance(iceShare);
        // Now and then a great stack, half as big again, towers over the rest.
        const great = greatShare > 0 && rng.chance(greatShare);
        const vr = great ? rng.range(56, 72) : rng.range(vrMin, vrMax);
        if (tryPlace(ice ? 'iceberg' : kind, rng.range(-hw, hw), z + rng.range(-30, 30), vr, ice ? ICE_RATIO : ratio)) i++;
      }
    };
    /** A hazard too big for one circle: overlapping circles along x, the first drawn for them all. */
    const placeGroup = (kind: ObstacleKind, x0: number, x1: number, r: number, form?: 'shelf') => {
      const fieldId = this.nextFieldId++;
      const n = Math.max(1, Math.ceil((x1 - x0 - 2 * r) / (r * 1.4))) + 1;
      const step = n > 1 ? (x1 - x0 - 2 * r) / (n - 1) : 0;
      const oz = z + rng.range(-6, 6);
      placed.push({ id: this.nextId++, kind, x: (x0 + x1) / 2, z: oz, r, vr: (x1 - x0) / 2, shape: rng.nextU32(), fieldId, form });
      for (let i = 0; i < n; i++) placed.push({ id: this.nextId++, kind, x: x0 + r + i * step, z: oz, r, vr: 0, shape: 0, fieldId, hidden: true });
      back = Math.max(back, oz - z + r);
    };
    /** Which side of the passage has more room, and how much. */
    const widerSide = free0 + hw > hw - free1 ? -1 : 1;
    const room = widerSide < 0 ? free0 + hw : hw - free1;
    /** A centre for a hazard of radius r on the wider side: `offset` clear of the passage, inside the lines. */
    const besidePassage = (r: number, offset: number) =>
      widerSide < 0 ? clamp(free0 - r - offset, -hw + r, free0 - r - 8) : clamp(free1 + r + offset, free1 + r + 8, hw - r);

    switch (pattern) {
      case 'rocks':
        // Mostly rock, with more and more ice drifting in from the Edge.
        scatter('rock', 28, 46, ROCK_RATIO, 0.15 + 0.25 * pc, 0.12);
        break;
      case 'ice':
        // Bergs calved from the ice wall that rings the world: fewer, and bigger.
        scatter('iceberg', 32, 56, ICE_RATIO);
        break;
      case 'kraken': {
        // Tentacles break the surface in knots of three to five.
        const knots = 1 + Math.min(2, Math.floor(d.fill * 3 + rng.next()));
        for (let k = 0; k < knots; k++) {
          const cx = rng.range(-hw + 40, hw - 40);
          const n = 3 + Math.floor(rng.next() * 3);
          for (let i = 0; i < n; i++) tryPlace('tentacle', cx + rng.range(-46, 46), z + rng.range(-28, 28), rng.range(15, 21), TENTACLE_RATIO);
        }
        break;
      }
      case 'wall':
        fillWall(-hw, free0, 'rock', ROCK_RATIO);
        fillWall(free1, hw, 'rock', ROCK_RATIO);
        break;
      case 'gate': {
        // A wall of rock with the Society's gate at the passage: two pillars, an arch between them.
        const fieldId = this.nextFieldId++;
        const left = free0 - PILLAR_R;
        const right = free1 + PILLAR_R;
        const leftFits = left - PILLAR_R >= -hw;
        const rightFits = right + PILLAR_R <= hw;
        const pillar = (x: number) => {
          placed.push({ id: this.nextId++, kind: 'pillar', x, z, r: PILLAR_R, vr: PILLAR_R / PILLAR_RATIO, shape: rng.nextU32(), fieldId: leftFits && rightFits ? fieldId : 0 });
          back = Math.max(back, PILLAR_R);
        };
        if (leftFits) pillar(left);
        if (rightFits) pillar(right);
        fillWall(-hw, leftFits ? left - PILLAR_R : free0, 'rock', ROCK_RATIO);
        fillWall(rightFits ? right + PILLAR_R : free1, hw, 'rock', ROCK_RATIO);
        break;
      }
      case 'colossus': {
        // The Colossus of the Society stands astride the gap, one foot either side; rock walls the rest.
        const fieldId = this.nextFieldId++;
        const left = free0 - COLOSSUS_LEG_R;
        const right = free1 + COLOSSUS_LEG_R;
        for (const x of [left, right]) {
          placed.push({ id: this.nextId++, kind: 'colossus', x, z, r: COLOSSUS_LEG_R, vr: COLOSSUS_LEG_R / PILLAR_RATIO, shape: rng.nextU32(), fieldId });
        }
        back = Math.max(back, COLOSSUS_LEG_R);
        fillWall(-hw, left - COLOSSUS_LEG_R, 'rock', ROCK_RATIO);
        fillWall(right + COLOSSUS_LEG_R, hw, 'rock', ROCK_RATIO);
        break;
      }
      case 'shelf': {
        // A wide, flat-topped shelf of ice on the wider side of the gap, a berg or two on the other.
        const clear = rng.range(8, 50);
        const span = Math.min(rng.range(220, 360), room - clear);
        if (widerSide < 0) {
          const inner = free0 - clear;
          placeGroup('iceberg', inner - span, inner, SHELF_R, 'shelf');
        } else {
          const inner = free1 + clear;
          placeGroup('iceberg', inner, inner + span, SHELF_R, 'shelf');
        }
        for (let i = 0; i < 2; i++) {
          const x = widerSide < 0 ? rng.range(free1, hw) : rng.range(-hw, free0);
          tryPlace('iceberg', x, z + rng.range(-24, 24), rng.range(30, 44), ICE_RATIO);
        }
        break;
      }
      case 'leviathan': {
        // The leviathan surfaces on the wider side of the gap; its tentacles break the water around it.
        const fieldId = this.nextFieldId++;
        const r = bigVr * LEVIATHAN_RATIO;
        const hx = besidePassage(r, rng.range(50, 130));
        if (tryPlace('leviathan', hx, z, bigVr, LEVIATHAN_RATIO, fieldId)) {
          const n = 5 + Math.floor(rng.next() * 3);
          for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
            if (tryPlace('tentacle', hx + rng.range(-r - 110, r + 110), z + rng.range(-r - 40, r * 0.5), rng.range(17, 23), TENTACLE_RATIO, fieldId)) i++;
          }
        }
        break;
      }
      case 'slalom': {
        const side = this.slalom.side;
        const ratio = this.slalom.kind === 'iceberg' ? ICE_RATIO : ROCK_RATIO;
        if (side < 0) fillWall(-hw, slalomEdge, this.slalom.kind, ratio);
        else fillWall(slalomEdge, hw, this.slalom.kind, ratio);
        this.slalom.left--;
        this.slalom.side = side < 0 ? 1 : -1;
        break;
      }
      case 'debris': {
        // The wreckage of a less careful expedition, strewn from one side; the passage runs through it.
        const fieldId = this.nextFieldId++;
        const span = rng.range(0.55, 0.95) * 2 * hw;
        const start = rng.chance(0.5) ? -hw : hw - span;
        let x = start;
        while (x < start + span) {
          const vr = rng.range(18, 24);
          const cx = x + vr * DEBRIS_RATIO;
          tryPlace('debris', cx, z + rng.range(-8, 8), vr, DEBRIS_RATIO, fieldId);
          x = cx + vr * DEBRIS_RATIO + rng.range(2, 12);
        }
        break;
      }
      case 'wreck': {
        // A wrecked galleon on the wider side of the passage, its wreckage strewn around it.
        const fieldId = this.nextFieldId++;
        const r = Math.min(bigVr * WRECK_RATIO, (room - 20) / 2);
        const x = besidePassage(r, rng.range(10, 60));
        if (tryPlace('wreck', x, z, r / WRECK_RATIO, WRECK_RATIO, fieldId)) {
          for (let i = 0; i < 5; i++) {
            const a = rng.range(-r - 50, r + 50);
            tryPlace('debris', x + a, z + rng.range(-r * 0.6, r * 0.6), rng.range(16, 22), DEBRIS_RATIO, fieldId);
          }
        }
        break;
      }
      case 'island': {
        // An island on the wider side of the passage, a rock or two on the other.
        const r = Math.min(bigVr * ISLAND_RATIO, (room - 24) / 2);
        const x = besidePassage(r, rng.range(20, 70));
        tryPlace('island', x, z, r / ISLAND_RATIO, ISLAND_RATIO);
        for (let i = 0; i < 2; i++) {
          const rx = widerSide < 0 ? rng.range(free1, hw) : rng.range(-hw, free0);
          tryPlace('rock', rx, z + rng.range(-20, 20), rng.range(28, 40), ROCK_RATIO);
        }
        break;
      }
      default: {
        // A lone whirlpool well clear of the passage; its pull is always weaker than the helm.
        const core = cfg.whirlpool.coreRadius;
        const clearance = gap / 2 + Math.max(pull * 0.5, core + 40);
        const sides: number[] = [];
        if (passage - clearance > -hw + core) sides.push(-1);
        if (passage + clearance < hw - core) sides.push(1);
        if (sides.length) {
          const side = sides.length === 2 ? (rng.chance(0.5) ? -1 : 1) : sides[0];
          const wx = side < 0 ? rng.range(-hw + core, passage - clearance) : rng.range(passage + clearance, hw - core);
          whirl = { id: this.nextId++, x: wx, z, pullRadius: pull, coreRadius: core, spin: rng.chance(0.5) ? 1 : -1 };
          back = core;
        }
      }
    }

    // The row may reach further forward than its estimate (scatters, strewn wreckage): measure it, and
    // keep at least the minimum open water before it.
    for (const o of placed) front = Math.max(front, z - (o.z - o.r));
    openWater = prev.z + prev.back + this.hullAft + front + this.hullFore;
    if (z < openWater + MIN_WINDOW) {
      const shift = openWater + MIN_WINDOW - z;
      z += shift;
      for (const o of placed) o.z += shift;
      if (whirl) whirl.z += shift;
    }

    // Fairness: from anywhere the ship could have left the previous row, an opening must be in reach.
    const hr = cfg.ship.hitRadius;
    const blocked: Array<[number, number]> = placed.map((o) => [o.x - o.r - hr - 1, o.x + o.r + hr + 1]);
    // Hugging a whirlpool's core is no fair way through: its pull is strongest there.
    if (whirl) blocked.push([whirl.x - whirl.coreRadius - WHIRLPOOL_BERTH, whirl.x + whirl.coreRadius + WHIRLPOOL_BERTH]);
    const openings = straightOpenings(hw, blocked);
    const need = furthestFromOpening(prev.hullLo, prev.hullHi, openings);
    let window = z - openWater;
    if (reachFor(window) < need) {
      const longer = (need / (margin * d.lateralSpeed) + accelLoss) * d.speed + 1;
      const shift = longer - window;
      z += shift;
      window = longer;
      for (const o of placed) o.z += shift;
      if (whirl) whirl.z += shift;
    }
    for (const o of placed) this.obstacles.push(o);
    if (whirl) this.whirlpools.push(whirl);

    // Where could the ship be once past this row? (Used to judge the next row.)
    const fullReach = (d.lateralSpeed * (1 + cfg.whirlpool.pullFactor) * window) / d.speed;
    const [hullLo, hullHi] = this.exitHull(
      Math.max(-hw, prev.hullLo - fullReach),
      Math.min(hw, prev.hullHi + fullReach),
      z,
      front,
      back,
      placed,
      whirl,
      (d.lateralSpeed * (1 + cfg.whirlpool.pullFactor)) / d.speed,
      passage,
    );

    // Evidence scattered over the open water before this row — single pieces, short lines and little
    // clusters, anywhere in the channel, not only along the way through. Never where picking it up would
    // leave no way through the row ahead: from every piece, an opening stays within reach (with room to spare).
    const er = cfg.evidence.radius;
    const rowFront = z - front - this.hullFore;
    const from = prev.z + prev.back + this.hullAft + 30;
    const to = rowFront - 30;
    const fair = (x: number, ez: number) => Math.abs(x) <= hw - er - 20 && distanceToOpening(x, openings) <= 0.8 * reachFor(rowFront - ez);
    if (to - from > 90 && rng.chance(cfg.evidence.scatterChance)) {
      const groups = 1 + Math.floor(rng.next() * 2);
      for (let g = 0; g < groups; g++) {
        const style = rng.next();
        const line = style < 0.75;
        const n = style < 0.35 ? 1 : line ? 3 + Math.floor(rng.next() * 3) : 4;
        const x = rng.range(-hw + 60, hw - 60);
        const z0 = rng.range(from, Math.max(from, to - (n - 1) * 55));
        const slant = rng.range(-45, 45);
        for (let i = 0; i < n; i++) {
          // Lines run down the course, straight or slanting; a cluster is a small diamond.
          const cx = line ? x + slant * i : x + (i === 1 ? -36 : i === 2 ? 36 : 0);
          const cz = line ? z0 + i * 55 : z0 + (i === 0 ? 0 : i === 3 ? 72 : 36);
          if (cz <= to && fair(cx, cz)) this.addEvidence(cx, cz, false);
        }
      }
    }

    // Evidence in the row itself: in the main gap, in one of its other openings, or tucked beside a hazard
    // for those who dare. Now and then the piece away from the main gap is a super coin.
    if (rng.chance(cfg.evidence.chance)) {
      const roll = rng.next();
      const risky = placed.length > 0 && roll < cfg.evidence.riskyShare;
      let ex = passage + rng.range(-gap / 4, gap / 4);
      let ez = z;
      let superCoin = false;
      if (risky) {
        const o = rng.pick(placed);
        ex = o.x + (rng.chance(0.5) ? 1 : -1) * (o.r + er + rng.range(14, 26));
        ez = o.z;
        superCoin = rng.chance(cfg.evidence.superBesideHazard);
      } else if (roll < cfg.evidence.riskyShare + 0.3 && openings.length > 1) {
        const [a, b] = rng.pick(openings);
        ex = rng.range(a, b);
        // Only off the main line: the opening picked may be the main gap itself.
        superCoin = rng.chance(cfg.evidence.superInSideOpening) && (passage < a || passage > b);
      }
      let clear = ex > -hw + er + 20 && ex < hw - er - 20;
      for (let i = 0; i < placed.length && clear; i++) {
        const dx = placed[i].x - ex;
        const dz = placed[i].z - ez;
        const min = placed[i].r + er + 8;
        if (dx * dx + dz * dz < min * min) clear = false;
      }
      if (whirl && clear) {
        const dx = whirl.x - ex;
        const dz = whirl.z - ez;
        if (dx * dx + dz * dz < (whirl.coreRadius + er + 30) * (whirl.coreRadius + er + 30)) clear = false;
      }
      if (clear) this.addEvidence(ex, ez, risky, superCoin);
    }

    this.rows.push({ index, pattern, z, passage, gap, front, back, window, need, reach: reachFor(window), hullLo, hullHi });
    this.trimRows();
    this.prevRow = { z, back, passage, pattern, hullLo, hullHi };
    this.nextRowZ = z + back + d.speed * d.rowInterval;
  }

  private trimRows(): void {
    if (!this.keepRowHistory && this.rows.length > 48) this.rows.shift();
  }

  /**
   * Sweep the ship through a row slice by slice: starting anywhere in
   * [entryLo, entryHi], which sideways positions could it occupy as it leaves?
   * Returns their extent (conservatively: every position it might reach).
   */
  private exitHull(
    entryLo: number,
    entryHi: number,
    z: number,
    front: number,
    back: number,
    placed: readonly Obstacle[],
    whirl: Whirlpool | null,
    sidewaysPerUnit: number,
    passage: number,
  ): [number, number] {
    const hw = this.config.channelHalfWidth;
    const hr = this.config.ship.hitRadius;
    const offs = this.config.ship.hitOffsets;
    const n = Math.floor((2 * hw) / CELL) + 1;
    let cells = new Uint8Array(n);
    let next = new Uint8Array(n);
    const dist = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = -hw + i * CELL;
      cells[i] = x >= entryLo - CELL && x <= entryHi + CELL ? 1 : 0;
    }
    const z0 = z - front - this.hullFore;
    const z1 = z + back + this.hullAft;
    const k = Math.ceil((sidewaysPerUnit * SWEEP_STEP) / CELL);
    for (let zc = z0; zc <= z1 + SWEEP_STEP; zc += SWEEP_STEP) {
      // Spread by how far the ship could slide sideways during this slice…
      let last = -1e9;
      for (let i = 0; i < n; i++) {
        if (cells[i]) last = i;
        dist[i] = i - last;
      }
      last = 1e9;
      for (let i = n - 1; i >= 0; i--) {
        if (cells[i]) last = i;
        next[i] = Math.min(dist[i], last - i) <= k ? 1 : 0;
      }
      // …then remove every position where the hull would touch a hazard.
      for (const o of placed) {
        for (let h = 0; h < offs.length; h++) {
          const dz = o.z - (zc + offs[h]);
          const rr = o.r + hr;
          if (dz >= rr || dz <= -rr) continue;
          const half = Math.sqrt(rr * rr - dz * dz);
          blockCells(next, o.x - half, o.x + half, hw);
        }
      }
      if (whirl) {
        const dz = whirl.z - zc;
        const rc = whirl.coreRadius;
        if (dz < rc && dz > -rc) {
          const half = Math.sqrt(rc * rc - dz * dz);
          blockCells(next, whirl.x - half, whirl.x + half, hw);
        }
      }
      const t = cells;
      cells = next;
      next = t;
    }
    let first = -1;
    let lastCell = -1;
    for (let i = 0; i < n; i++) {
      if (!cells[i]) continue;
      if (first < 0) first = i;
      lastCell = i;
    }
    if (first < 0) return [passage, passage];
    return [Math.max(-hw, -hw + (first - 1) * CELL), Math.min(hw, -hw + (lastCell + 1) * CELL)];
  }

  private addEvidence(x: number, z: number, risky: boolean, superCoin = false): void {
    this.evidence.push({ id: this.nextId++, x, z, risky, superCoin });
  }

  private prune(): void {
    const limit = this.ship.z - PRUNE_BEHIND;
    if (this.obstacles.length && this.obstacles[0].z + this.obstacles[0].r < limit) {
      this.obstacles = this.obstacles.filter((o) => o.z + o.r >= limit);
    }
    if (this.whirlpools.length && this.whirlpools[0].z + this.whirlpools[0].pullRadius < limit) {
      this.whirlpools = this.whirlpools.filter((w) => w.z + w.pullRadius >= limit);
    }
    if (this.evidence.length && this.evidence[0].z < limit) {
      this.evidence = this.evidence.filter((e) => e.z >= limit);
    }
  }

  // --------------------------------------------------------------- evidence

  private collectEvidence(): void {
    const ship = this.ship;
    const pick = this.config.evidence.pickupRadius;
    let write = 0;
    for (let i = 0; i < this.evidence.length; i++) {
      const e = this.evidence[i];
      const dx = e.x - ship.x;
      const dz = e.z - ship.z;
      if (dx * dx + dz * dz < pick * pick) {
        this.evidenceCollected++;
        if (e.superCoin) this.superCollected++;
        this.stats.evidence++;
        this.events.push({ type: 'evidence', id: e.id, x: e.x, z: e.z, superCoin: e.superCoin });
        continue;
      }
      this.evidence[write++] = e;
    }
    this.evidence.length = write;
  }

  // ------------------------------------------------------------- collisions

  private checkCollisions(): void {
    const ship = this.ship;
    const cfg = this.config;

    // The Edge of the World lies on either side of the channel.
    if (ship.x > cfg.channelHalfWidth || ship.x < -cfg.channelHalfWidth) {
      this.end('edge');
      return;
    }
    if (this.shielded) {
      const t = this.tick - this.reviveTick;
      if (t >= this.shieldTicks && (t >= this.maxShieldTicks || !this.touching(cfg.revive.clearance))) {
        this.shielded = false;
        this.events.push({ type: 'protectionEnd' });
      }
    }
    if (this.protectedNow) return;

    for (const w of this.whirlpools) {
      const dx = w.x - ship.x;
      const dz = w.z - ship.z;
      if (dx * dx + dz * dz < w.coreRadius * w.coreRadius) {
        this.end('whirlpool', undefined, w.id);
        return;
      }
    }

    const hull = hullPoints(ship, cfg, this.hull);
    const hr = cfg.ship.hitRadius;
    let minClear = Number.POSITIVE_INFINITY;
    for (const o of this.obstacles) {
      if (o.z + o.r < ship.z - 60 || o.z - o.r > ship.z + 60) continue;
      for (let i = 0; i < hull.length; i += 2) {
        const dx = o.x - hull[i];
        const dz = o.z - hull[i + 1];
        const min = o.r + hr;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min) {
          this.end(o.kind, o.id);
          return;
        }
        const clear = Math.sqrt(d2) - min;
        if (clear < minClear) minClear = clear;
      }
    }
    if (minClear < this.stats.closestClearance) this.stats.closestClearance = minClear;
    const near = minClear < NEAR_MISS_CLEARANCE;
    if (near && !this.inNearMiss) this.stats.nearMisses++;
    // Announced as the hull draws clear, never as it closes in (it may yet hit).
    if (!near && this.inNearMiss) this.events.push({ type: 'nearMiss', x: ship.x, z: ship.z });
    this.inNearMiss = near;
  }

  /** Whether the hull is within `margin` of any hazard, or inside a whirlpool's core. */
  private touching(margin: number): boolean {
    const ship = this.ship;
    for (const w of this.whirlpools) {
      const dx = w.x - ship.x;
      const dz = w.z - ship.z;
      if (dx * dx + dz * dz < w.coreRadius * w.coreRadius) return true;
    }
    const hull = hullPoints(ship, this.config, this.hull);
    const hr = this.config.ship.hitRadius + margin;
    for (const o of this.obstacles) {
      if (o.z + o.r < ship.z - 60 - margin || o.z - o.r > ship.z + 60 + margin) continue;
      for (let i = 0; i < hull.length; i += 2) {
        const dx = o.x - hull[i];
        const dz = o.z - hull[i + 1];
        const min = o.r + hr;
        if (dx * dx + dz * dz < min * min) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ hashing

  stateHash(): string {
    const h = new StateHasher();
    const s = this.ship;
    h.u32(this.tick).f64(s.x).f64(s.z).f64(s.vx).f64(s.distance);
    h.u32(this.nextId).u32(this.stats.rows).u32(this.evidenceCollected).u32(this.superCollected);
    return h.digest();
  }

  result(): RunResult {
    return {
      score: this.score,
      distanceScore: this.distanceScore,
      evidenceScore: this.evidenceScore,
      evidence: this.evidenceCollected,
      superCoins: this.superCollected,
      ticks: this.tick,
      survivalMs: Math.round((this.tick * 1000) / this.config.tickRate),
      death: this.death,
      revived: this.revived,
      finalHash: this.stateHash(),
      checkpointHashes: [...this.checkpointHashes],
      stats: { ...this.stats },
    };
  }
}
