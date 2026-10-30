/**
 * Game version. Every ranked attempt stores the version it was played with;
 * the server replays with the matching rules. Bump whenever any value below,
 * or any simulation code, changes in a way that affects outcomes.
 */
export const GAME_VERSION = '2.8.0';

export interface GameConfig {
  version: string;
  /** Simulation ticks per second (fixed timestep). */
  tickRate: number;
  /** Hard cap on run length, in ticks (the Society concludes the examination). */
  maxTicks: number;
  /** Seconds after launch during which hazards cannot sink the ship (the Edge still can). */
  spawnProtectionSeconds: number;
  /** The bonus life: a lost ship put back on the water (once per voyage). */
  revive: {
    /** Seconds the revived ship cannot be sunk by hazards (the Edge still counts)… */
    shieldSeconds: number;
    /** …and past that for as long as its hull still touches one, up to this many seconds. */
    maxShieldSeconds: number;
    /** How far the hull must be from every hazard before the shield lifts. */
    clearance: number;
    /** A ship lost over the Edge (or about to be) is put back at least this far inside it. */
    edgeInset: number;
  };
  /** Units sailed per point of distance score. */
  unitsPerPoint: number;
  /** Half the width of the charted channel; beyond it the sea pours off the Edge. */
  channelHalfWidth: number;
  ship: {
    /** Forward speed at launch, units/second. */
    baseSpeed: number;
    /** Forward-speed multiplier gained between 18 % and 100 % intensity. */
    speedGain: number;
    maxSpeed: number;
    /** Sideways speed at launch, units/second. */
    baseLateral: number;
    lateralGain: number;
    /** Seconds to reach full sideways speed from rest, and to come to rest again (smooth, never sluggish). */
    lateralAccelTime: number;
    lateralDecelTime: number;
    /** Collision circles along the hull: offsets ahead (+) / astern (−) of the centre. */
    hitOffsets: readonly number[];
    /** Radius of each hull collision circle (smaller than the drawn ship). */
    hitRadius: number;
    /** Drawn size — renderer only. */
    length: number;
    beam: number;
  };
  evidence: {
    points: number;
    /** A super coin is worth this much (it is rare, and usually tucked beside a hazard). */
    superPoints: number;
    radius: number;
    pickupRadius: number;
    /** Chance that a row carries a piece of evidence. */
    chance: number;
    /** Share of evidence placed close to a hazard (risk for reward). */
    riskyShare: number;
    /** Chance that the open water before a row is scattered with evidence (singles, short lines, small clusters). */
    scatterChance: number;
    /** Chance that a row's piece is a super coin: when tucked beside a hazard, and when in one of the row's side openings. */
    superBesideHazard: number;
    superInSideOpening: number;
  };
  track: {
    /** Open water before the first row of hazards. */
    firstRowDistance: number;
    /** Hazards are laid this far ahead of the ship (they emerge from the mist at the horizon). */
    spawnAhead: number;
    /** Time between rows of hazards at the ship's speed: calm → the Edge, and the overtime floor. */
    rowIntervalMax: number;
    rowIntervalMin: number;
    rowIntervalFloor: number;
    /** Width of the guaranteed open passage through each row: calm → the Edge. */
    gapMax: number;
    gapMin: number;
    /** The passage may only drift as far as this fraction of what the ship can cover between rows. */
    reachMargin: number;
    /** Share of a row's width (outside the passage) filled with rocks: calm → the Edge. */
    fillMin: number;
    fillMax: number;
    /** Intensity from which each kind of row can appear. */
    whirlpoolIntensity: number;
    debrisIntensity: number;
    wallIntensity: number;
    gateIntensity: number;
    krakenIntensity: number;
    slalomIntensity: number;
    shelfIntensity: number;
    leviathanIntensity: number;
    colossusIntensity: number;
  };
  whirlpool: {
    coreRadius: number;
    pullRadiusMin: number;
    pullRadiusMax: number;
    /** Strongest sideways drift (at the core) as a fraction of the ship's sideways speed — always escapable. */
    pullFactor: number;
  };
}

export const DEFAULT_CONFIG: GameConfig = Object.freeze({
  version: GAME_VERSION,
  tickRate: 60,
  maxTicks: 60 * 60 * 30,
  spawnProtectionSeconds: 1,
  revive: {
    shieldSeconds: 2.5,
    maxShieldSeconds: 6,
    clearance: 10,
    edgeInset: 80,
  },
  unitsPerPoint: 20,
  channelHalfWidth: 440,
  ship: {
    baseSpeed: 480,
    speedGain: 1.05,
    maxSpeed: 1100,
    baseLateral: 560,
    lateralGain: 0.5,
    lateralAccelTime: 0.12,
    lateralDecelTime: 0.09,
    hitOffsets: [22, -16],
    hitRadius: 15,
    length: 92,
    beam: 46,
  },
  evidence: {
    points: 250,
    superPoints: 2500,
    radius: 18,
    pickupRadius: 48,
    chance: 0.5,
    riskyShare: 0.4,
    scatterChance: 0.7,
    superBesideHazard: 0.2,
    superInSideOpening: 0.1,
  },
  track: {
    firstRowDistance: 800,
    spawnAhead: 3600,
    rowIntervalMax: 0.8,
    rowIntervalMin: 0.48,
    rowIntervalFloor: 0.4,
    gapMax: 200,
    gapMin: 105,
    reachMargin: 0.7,
    fillMin: 0.26,
    fillMax: 0.68,
    whirlpoolIntensity: 0.45,
    debrisIntensity: 0.45,
    wallIntensity: 0.3,
    gateIntensity: 0.3,
    krakenIntensity: 0.3,
    slalomIntensity: 0.45,
    shelfIntensity: 0.18,
    leviathanIntensity: 0.5,
    colossusIntensity: 0.55,
  },
  whirlpool: {
    coreRadius: 26,
    pullRadiusMin: 150,
    pullRadiusMax: 210,
    pullFactor: 0.45,
  },
}) as GameConfig;

export function configForVersion(version: string): GameConfig {
  if (version === GAME_VERSION) return DEFAULT_CONFIG;
  throw new Error(`Unsupported game version ${version}`);
}
