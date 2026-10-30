/** Steering input for one tick: -1 = port (left), 0 = hold course, 1 = starboard (right). */
export type Steer = -1 | 0 | 1;

/**
 * Rocks, islands and icebergs; wreckage and wrecked ships; kraken tentacles and
 * the leviathan itself; the pillars of a sea gate and the legs of the Colossus.
 */
export type ObstacleKind = 'rock' | 'island' | 'debris' | 'iceberg' | 'tentacle' | 'leviathan' | 'wreck' | 'pillar' | 'colossus';

/**
 * World coordinates: `x` runs across the channel (0 = centre, negative = port),
 * `z` runs forward along the voyage. Hazards are circles in the x/z plane.
 */
export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  z: number;
  /** Collision radius (always smaller than the drawn shape). */
  r: number;
  /** Drawn half-width. */
  vr: number;
  /** Seed for the renderer's procedural shape. Never used by the simulation. */
  shape: number;
  /** Pieces of the same wreck or creature, and the two pillars of a gate or legs of the Colossus, share a field id (0 = none). */
  fieldId: number;
  /**
   * Collision-only piece of a hazard too big for one circle (an ice shelf): its
   * group's first piece is drawn for all of them. Never drawn itself.
   */
  hidden?: boolean;
  /** Renderer hint for a hazard's form (e.g. a flat-topped ice shelf). Never used by the simulation. */
  form?: 'shelf';
}

export interface Whirlpool {
  id: number;
  x: number;
  z: number;
  pullRadius: number;
  coreRadius: number;
  /** 1 = clockwise seen from above, -1 = counter-clockwise (renderer only). */
  spin: 1 | -1;
}

export interface Evidence {
  id: number;
  x: number;
  z: number;
  /** Placed close to a hazard (optional risk for reward). */
  risky: boolean;
  /** A super coin: rare and worth far more. */
  superCoin: boolean;
}

export interface ShipState {
  /** Position across the channel. */
  x: number;
  /** Distance along the voyage. */
  z: number;
  /** Sideways velocity, units/second. */
  vx: number;
  /** Forward speed, units/second (rises over time). */
  speed: number;
  /** Current maximum sideways speed. */
  lateralSpeed: number;
  /** Total distance sailed. */
  distance: number;
}

export type DeathCause = ObstacleKind | 'whirlpool' | 'edge' | 'timeout';

export type SimEvent =
  | { type: 'evidence'; id: number; x: number; z: number; superCoin: boolean }
  | { type: 'stage'; stage: number }
  | { type: 'protectionEnd' }
  /** The hull just cleared a hazard by a hair (feedback only: it scores nothing). */
  | { type: 'nearMiss'; x: number; z: number }
  | { type: 'death'; cause: DeathCause; x: number; z: number; obstacleId?: number; whirlpoolId?: number };

export interface RunStats {
  evidence: number;
  nearMisses: number;
  closestClearance: number;
  inputChanges: number;
  rows: number;
}

export interface RunResult {
  score: number;
  distanceScore: number;
  evidenceScore: number;
  /** Pieces collected, super coins included. */
  evidence: number;
  superCoins: number;
  ticks: number;
  survivalMs: number;
  death: DeathCause | null;
  /** The bonus life was used. */
  revived: boolean;
  finalHash: string;
  checkpointHashes: string[];
  stats: RunStats;
}
