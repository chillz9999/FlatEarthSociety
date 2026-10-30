import { REVIVE, type InputEvent } from './replay';
import type { RunResult } from './types';

export type FlagSeverity = 'info' | 'review';

export interface RunFlag {
  code: string;
  severity: FlagSeverity;
  detail: string;
}

export interface InputAnalysis {
  changes: number;
  changesPerSecond: number;
  /** Most changes in any one-second window. */
  peakChangesPerSecond: number;
  /** Key presses (a non-zero steer that later ends). */
  presses: number;
  /** Presses lasting exactly one tick (16.7 ms) — rare for human fingers. */
  oneTickPresses: number;
  /** Coefficient of variation of the gaps between changes — near 0 means metronomic input. */
  rhythmCv: number;
  nearMissesPerMinute: number;
}

/**
 * Heuristics that help catch automated play. Replay verification proves a run
 * is *possible*; these help spot runs that were not played by a person. They
 * never change a score — they only route a run to human review.
 */
export function analyseRun(log: readonly InputEvent[], result: RunResult, tickRate: number): {
  analysis: InputAnalysis;
  flags: RunFlag[];
} {
  const inputs = log.filter((e) => e[1] !== REVIVE);
  const flags: RunFlag[] = [];
  const seconds = Math.max(1, result.ticks / tickRate);
  const changes = inputs.length;

  let peak = 0;
  let lo = 0;
  for (let hi = 0; hi < inputs.length; hi++) {
    while (inputs[hi][0] - inputs[lo][0] >= tickRate) lo++;
    peak = Math.max(peak, hi - lo + 1);
  }

  let presses = 0;
  let oneTick = 0;
  for (let i = 0; i + 1 < inputs.length; i++) {
    if (inputs[i][1] === 0) continue;
    presses++;
    if (inputs[i + 1][0] - inputs[i][0] <= 1) oneTick++;
  }

  const gaps: number[] = [];
  for (let i = 1; i < inputs.length; i++) gaps.push(inputs[i][0] - inputs[i - 1][0]);
  let rhythmCv = 1;
  if (gaps.length >= 20) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length;
    rhythmCv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  }

  const minutes = seconds / 60;
  const nearMissesPerMinute = result.stats.nearMisses / Math.max(minutes, 0.5);

  const analysis: InputAnalysis = {
    changes,
    changesPerSecond: changes / seconds,
    peakChangesPerSecond: peak,
    presses,
    oneTickPresses: oneTick,
    rhythmCv,
    nearMissesPerMinute,
  };

  if (analysis.changesPerSecond > 9) {
    flags.push({ code: 'input_rate_high', severity: 'review', detail: `${analysis.changesPerSecond.toFixed(1)} changes/s sustained` });
  }
  if (peak > 20) {
    flags.push({ code: 'input_burst', severity: 'review', detail: `${peak} changes inside one second` });
  }
  if (presses >= 30 && oneTick / presses > 0.35) {
    flags.push({ code: 'robotic_taps', severity: 'review', detail: `${oneTick}/${presses} presses lasted a single frame` });
  }
  if (gaps.length >= 40 && rhythmCv < 0.12) {
    flags.push({ code: 'robotic_rhythm', severity: 'review', detail: `input rhythm CV ${rhythmCv.toFixed(3)}` });
  }
  if (result.ticks > tickRate * 120 && nearMissesPerMinute > 30) {
    flags.push({ code: 'near_miss_rate', severity: 'review', detail: `${nearMissesPerMinute.toFixed(1)} near misses/min` });
  }
  if (result.ticks > tickRate * 60 && changes === 0) {
    flags.push({ code: 'no_input', severity: 'info', detail: 'run had no steering input' });
  }
  return { analysis, flags };
}
