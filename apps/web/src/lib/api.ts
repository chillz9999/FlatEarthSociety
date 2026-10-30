import type {
  AttemptView,
  CompetitionSummary,
  CreateAttemptResponse,
  ExtraLifeQuote,
  ExtraLifeReport,
  HallWeek,
  Leaderboard,
  PlayerStats,
  PublicConfig,
  SessionInfo,
  StartAttemptResponse,
  StartPracticeResponse,
  SubmitAttemptRequest,
  SubmitAttemptResponse,
  SubmitPracticeResponse,
  TreasuryReport,
} from '@fes/shared';
import { ENV } from './env';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'fes:session';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

async function request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.auth) {
    const t = getToken();
    if (t) headers.set('authorization', `Bearer ${t}`);
  }
  let res: Response;
  try {
    res = await fetch(`${ENV.apiUrl}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'network', 'Can’t reach the Society’s server. Check your connection and try again.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Something went wrong (error ${res.status}). Please try again.`);
  }
  return data as T;
}

export const api = {
  config: () => request<PublicConfig>('/api/config'),
  competition: () => request<CompetitionSummary>('/api/competition/current'),
  leaderboard: (week?: number, limit = 100) => request<Leaderboard>(`/api/leaderboard?limit=${limit}${week !== undefined ? `&week=${week}` : ''}`),
  practiceLeaderboard: (week?: number, limit = 100) =>
    request<Leaderboard>(`/api/practice/leaderboard?limit=${limit}${week !== undefined ? `&week=${week}` : ''}`),
  treasury: () => request<TreasuryReport>('/api/treasury'),
  hall: () => request<HallWeek[]>('/api/hall'),
  player: (address: string) => request<PlayerStats>(`/api/players/${address}`),

  nonce: () => request<{ nonce: string }>('/api/auth/nonce'),
  verify: (message: string, signature: string) =>
    request<SessionInfo & { token: string }>('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) }),
  me: () => request<SessionInfo>('/api/auth/me', { auth: true }),
  nameAvailable: (name: string) => request<{ available: boolean }>(`/api/players/name-available?name=${encodeURIComponent(name)}`),
  setName: (displayName: string) =>
    request<{ ok: true }>('/api/players/me/name', { method: 'POST', auth: true, body: JSON.stringify({ displayName }) }),

  myAttempts: () => request<{ available: AttemptView[]; awaitingPayment: AttemptView[]; recent: AttemptView[] }>('/api/attempts/mine', { auth: true }),
  createAttempt: () => request<CreateAttemptResponse>('/api/attempts', { method: 'POST', auth: true, body: '{}' }),
  reportPayment: (id: string, txHash: string) =>
    request<{ attempt: AttemptView; pending: boolean }>(`/api/attempts/${id}/payment`, { method: 'POST', auth: true, body: JSON.stringify({ txHash }) }),
  startAttempt: (id: string) => request<StartAttemptResponse>(`/api/attempts/${id}/start`, { method: 'POST', auth: true, body: '{}' }),
  checkpoint: (id: string, body: { tick: number; inputs: number[]; checkpoints: string[] }) =>
    request<{ ok: true }>(`/api/attempts/${id}/checkpoint`, { method: 'POST', auth: true, body: JSON.stringify(body) }),
  quoteLife: (id: string) => request<ExtraLifeQuote & { paid: boolean }>(`/api/attempts/${id}/life`, { method: 'POST', auth: true, body: '{}' }),
  reportLifePayment: (id: string, txHash?: string) =>
    request<ExtraLifeReport>(`/api/attempts/${id}/life/payment`, { method: 'POST', auth: true, body: JSON.stringify(txHash ? { txHash } : {}) }),
  restoreAttempt: (id: string) => request<AttemptView>(`/api/attempts/${id}/restore`, { method: 'POST', auth: true, body: '{}' }),
  submitAttempt: (id: string, body: SubmitAttemptRequest) =>
    request<SubmitAttemptResponse>(`/api/attempts/${id}/submit`, { method: 'POST', auth: true, body: JSON.stringify(body) }),

  startPractice: () => request<StartPracticeResponse>('/api/practice', { method: 'POST', auth: true, body: '{}' }),
  submitPractice: (id: string, body: SubmitAttemptRequest) =>
    request<SubmitPracticeResponse>(`/api/practice/${id}/submit`, { method: 'POST', auth: true, body: JSON.stringify(body) }),

  admin: {
    overview: () => request<AdminOverview>('/api/admin/overview', { auth: true }),
    review: (id: string, decision: 'approve' | 'reject', note: string) =>
      request<{ ok: true }>(`/api/admin/attempts/${id}/review`, { method: 'POST', auth: true, body: JSON.stringify({ decision, note }) }),
    restore: (id: string, note: string) =>
      request<{ ok: true }>(`/api/admin/attempts/${id}/restore`, { method: 'POST', auth: true, body: JSON.stringify({ note }) }),
    closeWeek: (weekId: number) => request<{ ok: true }>(`/api/admin/weeks/${weekId}/close`, { method: 'POST', auth: true, body: '{}' }),
    convertWeek: (weekId: number, minFesOut?: string) =>
      request<{ txHash: string }>(`/api/admin/weeks/${weekId}/convert`, { method: 'POST', auth: true, body: JSON.stringify({ minFesOut }) }),
    finalizeWeek: (weekId: number) => request<{ txHash: string }>(`/api/admin/weeks/${weekId}/finalize`, { method: 'POST', auth: true, body: '{}' }),
    payout: (weekId: number) => request<{ txHashes: string[] }>(`/api/admin/weeks/${weekId}/payout`, { method: 'POST', auth: true, body: '{}' }),
    sync: () => request<{ ok: true; credited: number }>('/api/admin/indexer/sync', { method: 'POST', auth: true, body: '{}' }),
  },
};

export interface AdminWeek {
  weekId: number;
  status: string;
  startsAt: string;
  endsAt: string;
  wifAllocated: string;
  wifConverted: string;
  fesPool: string;
  winners: { rank: number; address: string; score: number }[];
  finalizeTx: string | null;
  blockers: string[];
}

export interface AdminOverview {
  flagged: (AttemptView & { player: string })[];
  abandoned: (AttemptView & { player: string })[];
  weeks: AdminWeek[];
  settlerAddress: string | null;
  indexer: { lastBlock: string | null; lastRunAt: string | null };
  practice: { runs: number; players: number };
  audit: { at: string; actor: string; action: string; detail: string }[];
}

/** Live updates from the server (Server-Sent Events). */
export function subscribeEvents(onEvent: (type: string, data: unknown) => void): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  const es = new EventSource(`${ENV.apiUrl}/api/events`);
  const handler = (type: string) => (e: MessageEvent) => {
    try {
      onEvent(type, JSON.parse(e.data));
    } catch {
      onEvent(type, null);
    }
  };
  const types = ['leaderboard', 'competition', 'practice'];
  const listeners = types.map((t) => [t, handler(t)] as const);
  for (const [t, l] of listeners) es.addEventListener(t, l as EventListener);
  return () => {
    for (const [t, l] of listeners) es.removeEventListener(t, l as EventListener);
    es.close();
  };
}
