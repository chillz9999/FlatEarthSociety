'use client';

import type { SubmitAttemptRequest, SubmitPracticeResponse } from '@fes/shared';
import { api } from './api';
import { NeedsSignIn } from './ranked';
import { load, store } from './storage';

const PENDING_KEY = 'fes:pending-practice';
/** Older unsent voyages are dropped beyond this many. */
const MAX_PENDING = 20;

export interface PendingPractice {
  runId: string;
  /** Wallet that sailed the voyage (only that wallet's session may log it). */
  player: string;
  body: SubmitAttemptRequest;
}

function all(): PendingPractice[] {
  return load<PendingPractice[]>(PENDING_KEY) ?? [];
}

/** Finished practice voyages are kept locally until the server has logged them. */
export function savePendingPractice(p: PendingPractice): void {
  store(PENDING_KEY, [...all().filter((x) => x.runId !== p.runId), p].slice(-MAX_PENDING));
}

function clearPendingPractice(runId: string): void {
  const rest = all().filter((x) => x.runId !== runId);
  store(PENDING_KEY, rest.length ? rest : null);
}

export function pendingPractice(player: string): PendingPractice[] {
  return all().filter((p) => p.player.toLowerCase() === player.toLowerCase());
}

/** Log a practice voyage, retrying network and server errors. */
export async function sendPractice(p: PendingPractice): Promise<SubmitPracticeResponse> {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await api.submitPractice(p.runId, p.body);
      clearPendingPractice(p.runId);
      return res;
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status ?? 0;
      if (status === 401) throw new NeedsSignIn('Your sign-in expired. Sign in again to save your voyage.');
      if (status >= 400 && status < 500 && status !== 429) {
        clearPendingPractice(p.runId);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}
