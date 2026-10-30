import type { LeaderboardEntry } from '@fes/shared';
import type { Db, Queryable } from '../db';

/** Attempt statuses whose scores count on the Registry. Flagged runs wait for an administrator. */
export const COUNTED_STATUSES = ['verified', 'abandoned'] as const;

/** Where a board's runs live: ranked attempts (the Registry) or practice voyages (the practice board). */
export interface BoardSource {
  table: 'attempts' | 'practice_runs';
  statuses: readonly string[];
}
export const RANKED_BOARD: BoardSource = { table: 'attempts', statuses: COUNTED_STATUSES };
export const PRACTICE_BOARD: BoardSource = { table: 'practice_runs', statuses: ['verified'] };

interface BestRow {
  player: string;
  display_name: string | null;
  id: string;
  score: number;
  evidence: number | null;
  survival_ms: number | null;
  verified_at: Date;
}

/**
 * The Registry of Explorers. Each wallet's single best verified score in the
 * week counts (not the sum of attempts). Ties go to whoever verified the
 * score first; the wallet address is a final deterministic fallback.
 */
export class LeaderboardService {
  private cache = new Map<number, { at: number; rows: LeaderboardEntry[] }>();

  constructor(
    private readonly db: Db,
    private readonly source: BoardSource = RANKED_BOARD,
  ) {}

  invalidate(weekId?: number): void {
    if (weekId === undefined) this.cache.clear();
    else this.cache.delete(weekId);
  }

  /** Full ranking for a week (all players). Cached briefly; invalidated on every verification. */
  async ranking(weekId: number, q: Queryable = this.db): Promise<LeaderboardEntry[]> {
    const hit = this.cache.get(weekId);
    if (hit && Date.now() - hit.at < 10_000 && q === this.db) return hit.rows;
    const { rows } = await q.query<BestRow>(
      `select b.player, p.display_name, b.id, b.score, b.evidence, b.survival_ms, b.verified_at
         from (
           select distinct on (player) player, id, score, evidence, survival_ms, verified_at
             from ${this.source.table}
            where week_id = $1 and status = any($2::text[]) and score is not null
            order by player, score desc, verified_at asc, id asc
         ) b
         join players p on p.address = b.player
        order by b.score desc, b.verified_at asc, b.player asc`,
      [weekId, this.source.statuses],
    );
    const entries = rows.map<LeaderboardEntry>((r, i) => ({
      rank: i + 1,
      address: r.player,
      displayName: r.display_name,
      score: r.score,
      evidence: r.evidence ?? 0,
      survivalMs: r.survival_ms ?? 0,
      achievedAt: new Date(r.verified_at).toISOString(),
      attemptId: r.id,
    }));
    if (q === this.db) this.cache.set(weekId, { at: Date.now(), rows: entries });
    return entries;
  }

  async top(weekId: number, limit: number): Promise<{ entries: LeaderboardEntry[]; total: number }> {
    const all = await this.ranking(weekId);
    return { entries: all.slice(0, limit), total: all.length };
  }

  async standing(weekId: number, address: string): Promise<LeaderboardEntry | null> {
    const all = await this.ranking(weekId);
    return all.find((e) => e.address === address.toLowerCase()) ?? null;
  }

  /** The rank a brand-new score would take right now (ties lose to earlier achievements). */
  async projectedRank(weekId: number, score: number, address?: string): Promise<number> {
    const all = await this.ranking(weekId);
    let rank = 1;
    for (const e of all) {
      if (address && e.address === address.toLowerCase()) continue;
      if (e.score >= score) rank++;
    }
    return rank;
  }

  /** Points needed for `address` to take third place (0 if already in the prize positions). */
  async pointsToThird(weekId: number, address: string): Promise<number | null> {
    const all = await this.ranking(weekId);
    const me = all.find((e) => e.address === address.toLowerCase());
    if (me && me.rank <= 3) return 0;
    if (all.length < 3) return me ? 0 : null;
    const third = all[2];
    return third.score - (me?.score ?? 0) + 1;
  }
}
