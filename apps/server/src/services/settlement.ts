import { weekEndMs } from '@fes/shared';
import { keccak256, stringToHex } from 'viem';
import { ZERO_ADDRESS, type ChainGateway } from '../chain/gateway';
import type { Db } from '../db';
import { HttpError } from '../errors';
import type { AttemptService } from './attempts';
import type { CompetitionRow, CompetitionService, WinnerRecord } from './competition';
import type { EventHub } from './events';
import type { LeaderboardService } from './leaderboard';

const RATE_PRECISION = 10n ** 18n;

export interface SettlementOptions {
  closeGraceMinutes: number;
  slippageBps: number;
}

/**
 * Weekly settlement:
 *   open → closing (week ended; in-flight runs may still be submitted)
 *        → closed (grace elapsed; rankings locked)
 *        → finalized (WIF converted to FES, winners recorded onchain)
 *        → settled (every prize paid)
 */
export class SettlementService {
  constructor(
    private readonly db: Db,
    private readonly chain: ChainGateway,
    private readonly board: LeaderboardService,
    private readonly competitions: CompetitionService,
    private readonly attempts: AttemptService,
    private readonly events: EventHub,
    private readonly opts: SettlementOptions,
  ) {}

  private async audit(actor: string, action: string, weekId: number, detail: unknown): Promise<void> {
    await this.db.query('insert into audit_log (actor, action, week_id, detail) values ($1, $2, $3, $4)', [actor, action, weekId, JSON.stringify(detail)]);
  }

  /** Advance week statuses based on the clock. Safe to call repeatedly. */
  async advanceWeeks(now = Date.now()): Promise<void> {
    await this.competitions.ensureWeek(this.competitions.currentWeekId(now));
    const { rows } = await this.db.query<CompetitionRow>("select * from competitions where status in ('open', 'closing') and ends_at <= $1", [new Date(now)]);
    for (const c of rows) {
      if (c.status === 'open') {
        await this.db.query("update competitions set status = 'closing' where week_id = $1 and status = 'open'", [c.week_id]);
        await this.audit('system', 'week_closing', c.week_id, {});
        this.events.publish('competition', { weekId: c.week_id });
      }
      if (now >= weekEndMs(c.week_id) + this.opts.closeGraceMinutes * 60_000) await this.close(c.week_id, 'system', now);
    }
  }

  /** Lock the week's rankings. Any run still marked in progress is scored at its last checkpoint. */
  async close(weekId: number, actor: string, now = Date.now()): Promise<void> {
    const c = await this.competitions.get(weekId);
    if (!c) throw new HttpError(404, 'not_found', 'No such week');
    if (!['open', 'closing'].includes(c.status)) return;
    if (now < weekEndMs(weekId)) throw new HttpError(409, 'week_running', 'The week has not ended yet.');
    // Close first, under a lock that waits for any start still issuing a seed in this week;
    // then score whatever is still marked in progress.
    const closed = await this.db.tx(async (q) => {
      const row = (await q.query<{ status: string }>('select status from competitions where week_id = $1 for update', [weekId])).rows[0];
      if (!row || !['open', 'closing'].includes(row.status)) return false;
      await q.query("update competitions set status = 'closed', closed_at = now() where week_id = $1", [weekId]);
      return true;
    });
    if (!closed) return;
    const live = await this.db.query("select * from attempts where week_id = $1 and status = 'started'", [weekId]);
    for (const a of live.rows) await this.attempts.finalizeAbandoned(a as never, 'week_closed');
    await this.audit(actor, 'week_closed', weekId, {});
    this.board.invalidate(weekId);
    this.events.publish('competition', { weekId });
  }

  /** Reasons settlement cannot proceed yet (e.g. flagged runs that could change the top three). */
  async blockers(weekId: number): Promise<string[]> {
    const c = await this.competitions.get(weekId);
    const out: string[] = [];
    if (!c) return ['Unknown week'];
    if (c.status === 'open' || c.status === 'closing') out.push('The week is not closed yet.');
    const ranking = await this.board.ranking(weekId);
    const third = ranking[2]?.score ?? 0;
    const flagged = await this.db.query<{ id: string; score: number }>("select id, score from attempts where week_id = $1 and status = 'flagged' and score >= $2", [
      weekId,
      third,
    ]);
    for (const f of flagged.rows) out.push(`Flagged attempt ${f.id} (score ${f.score}) awaits review.`);
    // Runs in the prize positions that carry anomaly flags must be reviewed too (they may have
    // ranked lower when submitted, or been finalized at a checkpoint).
    const top = ranking.slice(0, 3).map((e) => e.attemptId);
    if (top.length) {
      const unreviewed = await this.db.query<{ id: string; score: number }>(
        `select id, score from attempts where id = any($1::uuid[]) and reviewed_at is null
            and exists (select 1 from jsonb_array_elements(flags) f where f->>'severity' = 'review')`,
        [top],
      );
      for (const f of unreviewed.rows) out.push(`Prize-winning attempt ${f.id} (score ${f.score}) carries anomaly flags and awaits review.`);
    }
    return out;
  }

  async winners(weekId: number): Promise<WinnerRecord[]> {
    const top = (await this.board.ranking(weekId)).slice(0, 3);
    return top.map((e) => ({ rank: e.rank, address: e.address, score: e.score, attemptId: e.attemptId }));
  }

  /** Step 1 — convert the week's unconverted WIF allocation to FES with slippage protection. */
  async convert(weekId: number, actor: string, minFesOutOverride?: bigint): Promise<string | null> {
    const vw = await this.chain.vaultWeek(weekId);
    if (!vw) throw new HttpError(503, 'chain_unavailable', 'Cannot read the vault');
    const amount = vw.wifAllocated - vw.wifConverted;
    if (amount === 0n) return null;
    const conv = await this.chain.converter();
    if (!conv) throw new HttpError(503, 'no_converter', 'No converter configured');
    const quote = (amount * conv.rate) / RATE_PRECISION;
    if (quote === 0n) throw new HttpError(409, 'zero_quote', 'The converter quotes zero FES for this allocation');
    if (conv.inventory < quote) throw new HttpError(409, 'converter_inventory', 'The treasury desk holds too little FES for this conversion');
    const minOut = minFesOutOverride ?? (quote * BigInt(10_000 - this.opts.slippageBps)) / 10_000n;
    const { txHash, fesOut } = await this.chain.convertWeek(weekId, amount, minOut);
    await this.db.query("insert into settlements (week_id, kind, tx_hash, wif_in, fes_out) values ($1, 'convert', $2, $3, $4)", [
      weekId,
      txHash.toLowerCase(),
      amount.toString(),
      fesOut.toString(),
    ]);
    await this.audit(actor, 'week_converted', weekId, { txHash, wifIn: amount.toString(), fesOut: fesOut.toString(), minOut: minOut.toString(), rate: conv.rate.toString() });
    this.events.publish('competition', { weekId });
    return txHash;
  }

  /** Step 2 — record the top three onchain (50/30/20 computed by the vault). */
  async finalize(weekId: number, actor: string): Promise<string> {
    const c = await this.competitions.get(weekId);
    if (!c) throw new HttpError(404, 'not_found', 'No such week');
    if (c.status === 'finalized' || c.status === 'settled') return c.finalize_tx ?? '';
    if (c.status !== 'closed') throw new HttpError(409, 'not_closed', 'Close the week first.');
    const blockers = await this.blockers(weekId);
    if (blockers.length) throw new HttpError(409, 'blocked', blockers.join(' '));
    const vw = await this.chain.vaultWeek(weekId);
    if (!vw) throw new HttpError(503, 'chain_unavailable', 'Cannot read the vault');
    if (vw.wifAllocated !== vw.wifConverted) await this.convert(weekId, actor);

    const winners = await this.winners(weekId);
    const ranking = await this.board.ranking(weekId);
    const resultsHash = keccak256(
      stringToHex(JSON.stringify({ weekId, results: ranking.slice(0, 100).map((e) => [e.rank, e.address, e.score, e.attemptId]) })),
    );
    let txHash = '';
    if (!vw.finalized) {
      const addrs = [0, 1, 2].map((i) => (winners[i]?.address ?? ZERO_ADDRESS) as `0x${string}`) as [`0x${string}`, `0x${string}`, `0x${string}`];
      txHash = (await this.chain.finalizeWeek(weekId, addrs, resultsHash)).txHash;
      await this.db.query("insert into settlements (week_id, kind, tx_hash) values ($1, 'finalize', $2)", [weekId, txHash.toLowerCase()]);
    }
    const after = await this.chain.vaultWeek(weekId);
    const records = winners.map((w, i) => ({ ...w, fesAmount: (after?.amounts[i] ?? 0n).toString(), claimTx: null }));
    await this.db.query(
      "update competitions set status = 'finalized', results_hash = $2, winners = $3, finalize_tx = $4, finalized_at = now() where week_id = $1",
      [weekId, resultsHash, JSON.stringify(records), txHash || null],
    );
    await this.audit(actor, 'week_finalized', weekId, { txHash, resultsHash, winners: records });
    this.events.publish('competition', { weekId });
    return txHash;
  }

  /** Step 3 — push each prize to its winner (winners may also claim directly from the vault). */
  async payout(weekId: number, actor: string): Promise<string[]> {
    const c = await this.competitions.get(weekId);
    if (!c || !['finalized', 'settled'].includes(c.status)) throw new HttpError(409, 'not_finalized', 'Finalize the week first.');
    const vw = await this.chain.vaultWeek(weekId);
    if (!vw) throw new HttpError(503, 'chain_unavailable', 'Cannot read the vault');
    const records = (c.winners ?? []).map((w) => ({ ...w }));
    const txs: string[] = [];
    for (let rank = 0; rank < 3; rank++) {
      if (vw.winners[rank] === ZERO_ADDRESS || vw.amounts[rank] === 0n) continue;
      const rec = records.find((r) => r.rank === rank + 1);
      if (vw.claimed[rank]) continue;
      const { txHash, amount } = await this.chain.claimFor(weekId, rank);
      txs.push(txHash);
      await this.db.query("insert into settlements (week_id, kind, tx_hash, rank, recipient, amount) values ($1, 'claim', $2, $3, $4, $5)", [
        weekId,
        txHash.toLowerCase(),
        rank + 1,
        vw.winners[rank].toLowerCase(),
        amount.toString(),
      ]);
      if (rec) rec.claimTx = txHash;
    }
    // Pick up prizes the winners claimed themselves.
    const final = await this.chain.vaultWeek(weekId);
    const allPaid = final ? [0, 1, 2].every((i) => final.winners[i] === ZERO_ADDRESS || final.amounts[i] === 0n || final.claimed[i]) : false;
    await this.db.query(`update competitions set winners = $2${allPaid ? ", status = 'settled', settled_at = now()" : ''} where week_id = $1`, [
      weekId,
      JSON.stringify(records),
    ]);
    await this.audit(actor, 'week_paid_out', weekId, { txs, settled: allPaid });
    this.events.publish('competition', { weekId });
    return txs;
  }

  /** Run every settlement step that is currently possible (used by AUTO_SETTLE and the admin "settle" button). */
  async settle(weekId: number, actor: string): Promise<void> {
    let c = await this.competitions.get(weekId);
    if (!c) return;
    if (c.status === 'closed') {
      if ((await this.blockers(weekId)).length) return;
      await this.finalize(weekId, actor);
      c = await this.competitions.get(weekId);
    }
    if (c?.status === 'finalized') await this.payout(weekId, actor);
  }

  async autoSettle(): Promise<void> {
    const { rows } = await this.db.query<{ week_id: number }>("select week_id from competitions where status in ('closed', 'finalized') order by week_id");
    for (const r of rows) {
      try {
        await this.settle(r.week_id, 'system');
      } catch (err) {
        await this.audit('system', 'auto_settle_failed', r.week_id, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
