import type { GameConfig } from './config';
import { clamp, lerp, smoothstep } from './detmath';

export interface Stage {
  id: 'calm' | 'uncharted' | 'dangerous' | 'rim' | 'edge';
  name: string;
  startSec: number;
  intensity: number;
  description: string;
}

/** Difficulty progression from the product spec (§5). */
export const STAGES: readonly Stage[] = [
  { id: 'calm', name: 'Calm Waters', startSec: 0, intensity: 0.18, description: 'Rocks, icebergs and the odd wreck.' },
  { id: 'uncharted', name: 'Uncharted Territory', startSec: 30, intensity: 0.35, description: 'Walls, sea gates, the first kraken.' },
  { id: 'dangerous', name: 'Dangerous Waters', startSec: 60, intensity: 0.6, description: 'Whirlpools, wreckage and slaloms.' },
  { id: 'rim', name: 'The Outer Rim', startSec: 120, intensity: 0.82, description: 'Narrow gaps, crowded rows.' },
  { id: 'edge', name: 'The Edge', startSec: 180, intensity: 1.0, description: 'Full speed ahead.' },
];

/** Seconds over which intensity eases into a new stage (no sudden jumps). */
export const STAGE_TRANSITION_SEC = 6;
/**
 * The first seconds of a voyage are a warm-up: sparser rows with wider passages and no ice shelves, easing into
 * Calm Waters, so a first-time explorer learns the helm before the course asks much of it.
 */
export const WARMUP_SEC = 12;
/** After five minutes intensity keeps creeping upward, by this much per minute… */
export const OVERTIME_GAIN_PER_MIN = 0.06;
/** …up to this ceiling. */
export const OVERTIME_MAX = 1.45;

export function stageIndexAt(tSec: number): number {
  let idx = 0;
  for (let i = 0; i < STAGES.length; i++) if (tSec >= STAGES[i].startSec) idx = i;
  return idx;
}

export function intensityAt(tSec: number): number {
  const idx = stageIndexAt(tSec);
  const stage = STAGES[idx];
  let value = stage.intensity;
  if (idx > 0) {
    const into = tSec - stage.startSec;
    if (into < STAGE_TRANSITION_SEC) {
      value = lerp(STAGES[idx - 1].intensity, stage.intensity, smoothstep(into / STAGE_TRANSITION_SEC));
    }
  }
  if (tSec > 300) value = Math.min(OVERTIME_MAX, 1 + ((tSec - 300) / 60) * OVERTIME_GAIN_PER_MIN);
  return value;
}

/** Normalised progress: 0 at 18% intensity, 1 at 100%, >1 in overtime. */
export function progressOf(intensity: number): number {
  return Math.max(0, (intensity - STAGES[0].intensity) / (1 - STAGES[0].intensity));
}

/**
 * Intensity without the stage plateaus: it climbs steadily from launch,
 * passing through each stage's intensity as that stage begins. The ship's
 * speed follows this, so it gathers way from the very first second.
 */
export function rampAt(tSec: number): number {
  if (tSec > 300) return intensityAt(tSec);
  for (let i = STAGES.length - 1; i >= 0; i--) {
    const s = STAGES[i];
    if (tSec < s.startSec) continue;
    const next = STAGES[i + 1];
    if (!next) return s.intensity;
    return lerp(s.intensity, next.intensity, (tSec - s.startSec) / (next.startSec - s.startSec));
  }
  return STAGES[0].intensity;
}

export interface DifficultyParams {
  intensity: number;
  /** Forward speed, units/second. */
  speed: number;
  /** Maximum sideways speed, units/second. */
  lateralSpeed: number;
  /** Seconds of sailing between rows of hazards. */
  rowInterval: number;
  /** Width of each row's guaranteed open passage. */
  gap: number;
  /** Share of a row (outside its passage) that rocks may fill. */
  fill: number;
  /** Chance a row is open water (a breather). */
  emptyChance: number;
  whirlpoolChance: number;
  debrisChance: number;
  /** Chance of a "wall" row: hazards across the whole channel except the passage. */
  wallChance: number;
  /** A wall with a stone gate (two pillars and an arch) around the passage. */
  gateChance: number;
  /** The start of a slalom: walls from alternate sides, a few rows in a row. */
  slalomChance: number;
  islandChance: number;
  /** A wrecked galleon with its wreckage strewn about. */
  wreckChance: number;
  icebergChance: number;
  /** Clusters of kraken tentacles. */
  krakenChance: number;
  /** A wide, flat-topped ice shelf. */
  shelfChance: number;
  /** The leviathan: a kraken's head breaking the surface, ringed by tentacles. */
  leviathanChance: number;
  /** The Colossus, standing astride the gap in a wall of rock. */
  colossusChance: number;
}

export function difficultyAt(tick: number, config: GameConfig): DifficultyParams {
  const tSec = tick / config.tickRate;
  const intensity = intensityAt(tSec);
  const p = progressOf(intensity);
  const pc = clamp(p, 0, 1);
  const ramp = progressOf(rampAt(tSec));
  const { ship, track } = config;
  const speed = Math.min(ship.maxSpeed, ship.baseSpeed * (1 + ship.speedGain * ramp));
  const lateralSpeed = ship.baseLateral * (1 + ship.lateralGain * Math.min(ramp, 1.4));
  const rowInterval = p <= 1 ? lerp(track.rowIntervalMax, track.rowIntervalMin, pc) : Math.max(track.rowIntervalFloor, track.rowIntervalMin - 0.12 * (p - 1));
  const from = (threshold: number, base: number, slope: number, max: number) => (intensity < threshold ? 0 : clamp(base + slope * (intensity - threshold), 0, max));
  // 1 at launch, easing to 0 by the end of the warm-up.
  const warm = tSec < WARMUP_SEC ? 1 - smoothstep(tSec / WARMUP_SEC) : 0;
  return {
    intensity,
    speed,
    lateralSpeed,
    rowInterval: lerp(rowInterval, 1.05, warm),
    gap: lerp(lerp(track.gapMax, track.gapMin, pc), track.gapMax + 60, warm),
    fill: lerp(lerp(track.fillMin, track.fillMax, clamp(p, 0, 1.3) / 1.3), 0.14, warm),
    emptyChance: lerp(lerp(0.18, 0.03, pc), 0.32, warm),
    whirlpoolChance: from(track.whirlpoolIntensity, 0.04, 0.1, 0.1),
    debrisChance: from(track.debrisIntensity, 0.06, 0.08, 0.1),
    wallChance: from(track.wallIntensity, 0.05, 0.12, 0.12),
    gateChance: from(track.gateIntensity, 0.04, 0.04, 0.06),
    slalomChance: from(track.slalomIntensity, 0.03, 0.04, 0.05),
    islandChance: 0.06,
    wreckChance: 0.06,
    icebergChance: lerp(0.12, 0.08, pc),
    krakenChance: from(track.krakenIntensity, 0.04, 0.06, 0.07),
    shelfChance: from(track.shelfIntensity, 0.05, 0.05, 0.08) * (1 - warm),
    leviathanChance: from(track.leviathanIntensity, 0.04, 0.06, 0.07),
    colossusChance: from(track.colossusIntensity, 0.04, 0.05, 0.06),
  };
}
