import { analyseRun, type InputAnalysis, type RunFlag } from './analysis';
import { configForVersion, type GameConfig } from './config';
import { reviveTickOf, runReplay, validateInputs, type InputEvent } from './replay';
import type { RunResult } from './types';

export interface VerifyRequest {
  seed: string;
  version: string;
  inputs: unknown;
  /** Tick at which the client says the run ended. */
  claimedEndTick: number;
  claimedScore?: number;
  claimedHash?: string;
  claimedCheckpoints?: string[];
  /**
   * `final`: a completed run — the ship must have been lost exactly at the claimed tick.
   * `partial`: an interrupted run (disconnect) — score the run as it stood at the claimed tick.
   */
  mode: 'final' | 'partial';
}

export type VerifyOutcome =
  | {
      ok: true;
      result: RunResult;
      /** True when the run ended (lost/timeout) inside the replay; false for a partial run still afloat. */
      completed: boolean;
      flags: RunFlag[];
      analysis: InputAnalysis;
      /** First checkpoint index where client and server disagreed (desync diagnostics), or -1. */
      divergedAtCheckpoint: number;
    }
  | { ok: false; reason: string; result?: RunResult };

/**
 * Authoritative scoring. The server never trusts a client score: it rebuilds
 * the run from the seed it issued and the player's inputs, and the score is
 * whatever the simulation says.
 */
export function verifyRun(req: VerifyRequest): VerifyOutcome {
  let config: GameConfig;
  try {
    config = configForVersion(req.version);
  } catch {
    return { ok: false, reason: 'unsupported_version' };
  }
  if (!/^[0-9a-f]{32}$/i.test(req.seed)) return { ok: false, reason: 'bad_seed' };
  const end = req.claimedEndTick;
  if (!Number.isInteger(end) || end < 1 || end > config.maxTicks) return { ok: false, reason: 'bad_end_tick' };

  const valid = validateInputs(req.inputs, config.maxTicks);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  const inputs = req.inputs as InputEvent[];
  if (inputs.length > 0 && inputs[inputs.length - 1][0] > end) return { ok: false, reason: 'inputs_after_end' };

  const sim = runReplay(req.seed, inputs, end, config);
  const result = sim.result();
  const flags: RunFlag[] = [];
  const reviveTick = reviveTickOf(inputs);
  if (reviveTick !== null && !sim.revived) {
    flags.push({ code: 'revive_unused', severity: 'review', detail: `bonus life logged at tick ${reviveTick}, but the ship was not lost then` });
  }

  if (req.mode === 'final') {
    if (!sim.over) return { ok: false, reason: 'run_did_not_end_at_claimed_tick', result };
    if (sim.tick !== end) {
      flags.push({ code: 'end_tick_mismatch', severity: 'review', detail: `client ${end}, server ${sim.tick}` });
    }
  }
  if (req.claimedScore !== undefined && req.claimedScore !== result.score) {
    flags.push({ code: 'score_mismatch', severity: 'review', detail: `client ${req.claimedScore}, server ${result.score}` });
  }
  if (req.claimedHash !== undefined && sim.over && sim.tick === end && req.claimedHash !== result.finalHash) {
    flags.push({ code: 'hash_mismatch', severity: 'review', detail: `client ${req.claimedHash}, server ${result.finalHash}` });
  }
  let divergedAtCheckpoint = -1;
  if (req.claimedCheckpoints) {
    const n = Math.min(req.claimedCheckpoints.length, result.checkpointHashes.length);
    for (let i = 0; i < n; i++) {
      if (req.claimedCheckpoints[i] !== result.checkpointHashes[i]) {
        divergedAtCheckpoint = i;
        break;
      }
    }
  }

  const { analysis, flags: heuristic } = analyseRun(inputs, result, config.tickRate);
  flags.push(...heuristic);
  return { ok: true, result, completed: sim.over, flags, analysis, divergedAtCheckpoint };
}
