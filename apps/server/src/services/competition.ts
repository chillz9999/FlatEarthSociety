import { SOCIETY_TITLES } from '@fes/game-core';
import { weekEndMs, weekIdAt, weekStartMs, type CompetitionStatus, type CompetitionSummary, type ConversionRecord, type HallWeek, type TreasuryReport } from '@fes/shared';
import type { ChainGateway } from '../chain/gateway';
import type { Db } from '../db';
import type { LeaderboardService } from './leaderboard';

export interface CompetitionRow {
  week_id: number;
  starts_at: Date;
  ends_at: Date;
  status: CompetitionStatus | 'closing';
  closed_at: Date | null;
  results_hash: string | null;
  winners: WinnerRecord[] | null;
  finalize_tx: string | null;
  finalized_at: Date | null;
  settled_at: Date | null;
}

export interface WinnerRecord {
  rank: number;
  address: string;
  score: number;
  attemptId: string;
  fesAmount?: string;
  claimTx?: string | null;
}

const RATE_PRECISION = 10n ** 18n;

/**
 * The published settlement rules. `prizeInWif`: the prizes are paid in $WIF itself (no conversion). `burned`: the
 * other half of every payment is burned rather than paid to a treasury.
 */
export function settlementRules(prizeInWif: boolean, burned: boolean): string[] {
  return [
    `Ranked voyages and their bonus lives are paid in $WIF to the SocietyEntry contract. Their prices are set in dollars and re-priced in $WIF as the market moves, within limits fixed onchain; every purchase names the most the buyer will pay. Each payment is split onchain in the same transaction: exactly 50% to the SocietyPrizeVault (credited to the week in which the payment was mined) and 50% ${burned ? 'burned (sent to the dead address 0x…dEaD, permanently)' : 'to the protocol treasury'}.`,
    'Weeks run Monday 00:00:00 UTC to Sunday 23:59:59 UTC. A paid entry is a credit for one ranked attempt; the attempt counts toward the week in which it is started. Unused credits roll forward to later weeks; their $WIF stays in the week it was paid.',
    'Each ranked voyage may buy one bonus life when the ship is lost, and only then. The voyage carries on from where it was lost, and the score of the whole voyage counts.',
    'Each wallet’s single best verified score counts. Ties are won by the score verified first. Runs flagged by anomaly checks are held for administrator review before they can rank.',
    prizeInWif
      ? 'The prizes are paid in $WIF: the half of every payment sent to the vault is the prize pool itself. Nothing is converted.'
      : 'After the week closes (plus a grace period for runs in progress), the week’s $WIF allocation is converted to $FES through an approved converter with on-chain slippage protection (minimum output and deadline). The rate, amounts and transaction are public.',
    `The ${prizeInWif ? '$WIF' : '$FES'} pool is split 50% / 30% / 20% between first, second and third place by the vault contract; the remainder of integer division goes to third place, so no dust is lost. Shares for places with no eligible winner roll into the next week’s pool.`,
    'Prizes are pushed to winners by the Society (claimFor) and can always be claimed directly from the vault by the winner. A prize can be paid only once; a week can be finalized only once.',
    `Transaction costs (gas) for ${prizeInWif ? '' : 'conversion and '}settlement are paid by the Society’s settlement account, not deducted from prizes.`,
  ];
}

/** Every payment into the competition: entries and bonus lives. */
const PAID = `(select player, week_id, fee, reward_share, protocol_share, 'entry' as kind from payments
              union all select player, week_id, fee, reward_share, protocol_share, 'life' as kind from extra_lives)`;

export class CompetitionService {
  constructor(
    private readonly db: Db,
    private readonly chain: ChainGateway,
    private readonly board: LeaderboardService,
  ) {}

  currentWeekId(now = Date.now()): number {
    return weekIdAt(now);
  }

  async ensureWeek(weekId: number): Promise<CompetitionRow> {
    await this.db.query(
      'insert into competitions (week_id, starts_at, ends_at) values ($1, $2, $3) on conflict (week_id) do nothing',
      [weekId, new Date(weekStartMs(weekId)), new Date(weekEndMs(weekId))],
    );
    const { rows } = await this.db.query<CompetitionRow>('select * from competitions where week_id = $1', [weekId]);
    return rows[0];
  }

  async get(weekId: number): Promise<CompetitionRow | null> {
    const { rows } = await this.db.query<CompetitionRow>('select * from competitions where week_id = $1', [weekId]);
    return rows[0] ?? null;
  }

  publicStatus(row: CompetitionRow | null, weekId: number): CompetitionStatus {
    if (!row) return Date.now() < weekEndMs(weekId) ? 'open' : 'closed';
    return row.status === 'closing' ? 'closed' : row.status;
  }

  async summary(weekId: number): Promise<CompetitionSummary> {
    const row = weekId === this.currentWeekId() ? await this.ensureWeek(weekId) : await this.get(weekId);
    const pay = (
      await this.db.query<{ entries: string; lives: string; players: string; fees: string | null; reward: string | null; protocol: string | null }>(
        `select count(*) filter (where kind = 'entry')::text as entries, count(*) filter (where kind = 'life')::text as lives,
                count(distinct player)::text as players,
                coalesce(sum(fee), 0)::text as fees, coalesce(sum(reward_share), 0)::text as reward, coalesce(sum(protocol_share), 0)::text as protocol
           from ${PAID} paid where week_id = $1`,
        [weekId],
      )
    ).rows[0];
    const conversions = (
      await this.db.query<{ tx_hash: string; wif_in: string; fes_out: string; created_at: Date }>(
        "select tx_hash, wif_in::text, fes_out::text, created_at from settlements where week_id = $1 and kind = 'convert' order by created_at",
        [weekId],
      )
    ).rows.map<ConversionRecord>((r) => ({ txHash: r.tx_hash, wifIn: r.wif_in, fesOut: r.fes_out, converter: this.chain.converterContract ?? '', at: r.created_at.toISOString() }));

    let fesPool = 0n;
    let estimate: bigint | null = null;
    try {
      const vw = await this.chain.vaultWeek(weekId);
      if (vw) {
        fesPool = vw.fesPool;
        const unconverted = vw.wifAllocated - vw.wifConverted;
        const conv = unconverted > 0n ? await this.chain.converter() : null;
        estimate = unconverted === 0n ? vw.fesPool : conv ? vw.fesPool + (unconverted * conv.rate) / RATE_PRECISION : null;
      }
    } catch {
      /* chain unreachable: show database figures only */
    }
    const players = await this.board.top(weekId, 3);
    const fee = await this.chain.entryFee().catch(() => null);
    return {
      weekId,
      startsAt: new Date(weekStartMs(weekId)).toISOString(),
      endsAt: new Date(weekEndMs(weekId)).toISOString(),
      status: this.publicStatus(row, weekId),
      entryFee: fee?.toString() ?? null,
      entries: Number(pay.entries),
      extraLives: Number(pay.lives),
      players: Number(pay.players),
      wifCollected: pay.fees ?? '0',
      wifRewardAllocation: pay.reward ?? '0',
      wifProtocol: pay.protocol ?? '0',
      fesPool: fesPool.toString(),
      fesPoolEstimate: estimate?.toString() ?? null,
      conversions,
      top3: players.entries,
      finalizeTx: row?.finalize_tx ?? null,
    };
  }

  async treasury(): Promise<TreasuryReport> {
    const current = await this.summary(this.currentWeekId());
    const weeks = (
      await this.db.query<{ week_id: number }>(
        `select week_id from (select week_id from payments union select week_id from extra_lives union select week_id from competitions) w
          where week_id < $1 order by week_id desc limit 12`,
        [current.weekId],
      )
    ).rows.map((r) => r.week_id);
    const history: CompetitionSummary[] = [];
    for (const w of weeks) history.push(await this.summary(w));
    const totals = (
      await this.db.query<{ fees: string; reward: string; protocol: string; entries: string }>(
        `select coalesce(sum(fee),0)::text as fees, coalesce(sum(reward_share),0)::text as reward,
                coalesce(sum(protocol_share),0)::text as protocol, (count(*) filter (where kind = 'entry'))::text as entries from ${PAID} paid`,
      )
    ).rows[0];
    const awarded = (await this.db.query<{ total: string }>("select coalesce(sum(amount),0)::text as total from settlements where kind = 'claim'")).rows[0];
    const conv = await this.chain.converter().catch(() => null);
    const tokens = await this.chain.tokens().catch(() => null);
    const prizeInWif = tokens ? tokens.wif.address.toLowerCase() === tokens.fes.address.toLowerCase() : !conv;
    const burned = (await this.chain.burnsProtocolShare().catch(() => null)) ?? true;
    return {
      current,
      history,
      totals: {
        wifCollected: totals.fees,
        wifRewardAllocation: totals.reward,
        wifProtocol: totals.protocol,
        fesAwarded: awarded.total,
        entries: Number(totals.entries),
      },
      disclosure: {
        method: prizeInWif
          ? 'Paid in $WIF: half of every payment goes straight into the week’s prize pool, with no conversion.'
          : conv
            ? 'Fixed-rate Society treasury desk (FixedRateConverter): the vault sells the week’s $WIF allocation to the treasury desk for $FES at the published rate. Rate changes are announced onchain and take effect only after a public delay.'
            : 'Conversion through an approved converter contract (see contracts).',
        converter: conv?.address ?? this.chain.converterContract,
        rate: conv?.rate.toString() ?? null,
        pendingRate: conv && conv.pendingRate > 0n ? conv.pendingRate.toString() : null,
        pendingRateEffectiveAt: conv && conv.pendingRateEffectiveAt > 0n ? new Date(Number(conv.pendingRateEffectiveAt) * 1000).toISOString() : null,
        rateDelaySeconds: conv ? Number(conv.rateDelay) : null,
        settlementRules: settlementRules(prizeInWif, burned),
      },
    };
  }

  async hall(): Promise<HallWeek[]> {
    const { rows } = await this.db.query<CompetitionRow>(
      "select * from competitions where status in ('finalized', 'settled') order by week_id desc limit 104",
    );
    const names = new Map(
      (await this.db.query<{ address: string; display_name: string | null }>('select address, display_name from players where display_name is not null')).rows.map((r) => [
        r.address,
        r.display_name,
      ]),
    );
    return rows.map((r) => {
      const winners = r.winners ?? [];
      const pool = winners.reduce((s, w) => s + BigInt(w.fesAmount ?? '0'), 0n);
      return {
        weekId: r.week_id,
        startsAt: r.starts_at.toISOString(),
        endsAt: r.ends_at.toISOString(),
        fesPool: pool.toString(),
        finalizeTx: r.finalize_tx,
        winners: winners.map((w) => ({
          rank: w.rank,
          title: SOCIETY_TITLES[w.rank - 1] ?? 'Fellow',
          address: w.address,
          displayName: names.get(w.address) ?? null,
          score: w.score,
          fesAmount: w.fesAmount ?? '0',
          claimed: Boolean(w.claimTx),
          claimTx: w.claimTx ?? null,
        })),
      };
    });
  }
}
