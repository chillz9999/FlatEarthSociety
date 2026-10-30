import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_CONFIG,
  GAME_VERSION,
  decodeInputs,
  randomSeedHex,
  reviveTickOf,
  validateInputs,
  verifyRun,
  type InputEvent,
  type RunFlag,
} from '@fes/game-core';
import type {
  AttemptStatus,
  AttemptView,
  CreateAttemptResponse,
  ExtraLifeQuote,
  ExtraLifeReport,
  StartAttemptResponse,
  SubmitAttemptRequest,
  SubmitAttemptResponse,
} from '@fes/shared';
import { encodeAbiParameters, keccak256 } from 'viem';
import type { ChainGateway, EntryPayment, ExtraLifePayment } from '../chain/gateway';
import type { Db, Queryable } from '../db';
import { HttpError } from '../errors';
import type { CompetitionService } from './competition';
import type { EventHub } from './events';
import type { LeaderboardService } from './leaderboard';

export interface AttemptRow {
  id: string;
  player: string;
  attempt_ref: string;
  entry_id: string;
  status: AttemptStatus;
  payment_entry_id: string | null;
  week_id: number | null;
  game_version: string | null;
  seed: string | null;
  created_at: Date;
  paid_at: Date | null;
  started_at: Date | null;
  submitted_at: Date | null;
  verified_at: Date | null;
  end_tick: number | null;
  inputs: InputEvent[] | null;
  checkpoint_tick: number | null;
  checkpoint_at: Date | null;
  checkpoints: string[] | null;
  claimed_score: number | null;
  score: number | null;
  distance_score: number | null;
  evidence: number | null;
  survival_ms: number | null;
  death: string | null;
  flags: RunFlag[];
  analysis: unknown;
  note: string | null;
  restored_from: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  life_offered_at: Date | null;
  revived_at: Date | null;
}

export interface AttemptPolicy {
  /** Seconds of slack allowed between server wall-clock and simulated time. */
  clockSlackSeconds: number;
  /** A run claiming far less simulated time than real time elapsed is flagged (pausing a ranked run is not allowed). */
  clockGapFlagSeconds: number;
  reviewTopN: number;
  autoRestorePerWeek: number;
  /** Extra minutes after the longest possible run before an unsubmitted attempt is finalized as abandoned. */
  abandonGraceMinutes: number;
}

export const DEFAULT_POLICY: AttemptPolicy = {
  clockSlackSeconds: 5,
  clockGapFlagSeconds: 90,
  reviewTopN: 10,
  autoRestorePerWeek: 1,
  abandonGraceMinutes: 10,
};

const TICK_RATE = DEFAULT_CONFIG.tickRate;
const MAX_RUN_SECONDS = DEFAULT_CONFIG.maxTicks / TICK_RATE;

export function computeEntryId(player: `0x${string}`, attemptRef: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [player, attemptRef]));
}

export function toView(r: AttemptRow, paymentWeek: number | null = null, entryTx: string | null = null): AttemptView {
  return {
    id: r.id,
    status: r.status,
    attemptRef: r.attempt_ref as `0x${string}`,
    entryId: r.entry_id as `0x${string}`,
    weekId: r.week_id,
    paymentWeekId: paymentWeek,
    entryTx,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    score: r.score,
    evidence: r.evidence,
    survivalMs: r.survival_ms,
    flags: (r.flags ?? []).map((f) => f.code),
    note: r.note,
  };
}

export class AttemptService {
  constructor(
    private readonly db: Db,
    private readonly chain: ChainGateway,
    private readonly board: LeaderboardService,
    private readonly competitions: CompetitionService,
    private readonly events: EventHub,
    private readonly policy: AttemptPolicy = DEFAULT_POLICY,
  ) {}

  private async audit(q: Queryable, actor: string, action: string, attemptId: string | null, weekId: number | null, detail: unknown): Promise<void> {
    await q.query('insert into audit_log (actor, action, attempt_id, week_id, detail) values ($1, $2, $3, $4, $5)', [
      actor,
      action,
      attemptId,
      weekId,
      JSON.stringify(detail ?? {}),
    ]);
  }

  async get(id: string): Promise<AttemptRow | null> {
    const { rows } = await this.db.query<AttemptRow>('select * from attempts where id = $1', [id]);
    return rows[0] ?? null;
  }

  private async own(player: string, id: string): Promise<AttemptRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'That game can’t be found.');
    const a = await this.get(id);
    if (!a || a.player !== player.toLowerCase()) throw new HttpError(404, 'not_found', 'That game can’t be found.');
    return a;
  }

  // ------------------------------------------------------------------ entry

  /** Reserve an attempt reference the player will pay for onchain (SocietyEntry.enter(attemptRef)). */
  async create(player: `0x${string}`): Promise<CreateAttemptResponse> {
    if (!this.chain.enabled || !this.chain.entryContract) throw new HttpError(503, 'chain_disabled', 'Competitive play isn’t available right now.');
    if (await this.chain.entriesPaused()) throw new HttpError(409, 'entries_paused', 'Competitive play is paused for now. Please try again later.');
    const [fee, tokens] = await Promise.all([this.chain.entryFee(), this.chain.tokens()]);
    if (fee === null || !tokens) throw new HttpError(503, 'chain_unavailable', 'Can’t read the current price right now. Please try again in a moment.');
    const p = player.toLowerCase();
    await this.db.query('insert into players (address) values ($1) on conflict (address) do nothing', [p]);

    // Re-use a recent unpaid reservation rather than piling up new ones.
    const existing = await this.db.query<AttemptRow>(
      "select * from attempts where player = $1 and status = 'awaiting_payment' and created_at > now() - interval '6 hours' order by created_at desc limit 1",
      [p],
    );
    let row = existing.rows[0];
    if (!row) {
      const ref = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
      const entryId = computeEntryId(player, ref);
      row = (
        await this.db.query<AttemptRow>(
          "insert into attempts (id, player, attempt_ref, entry_id, status) values ($1, $2, $3, $4, 'awaiting_payment') returning *",
          [randomUUID(), p, ref, entryId.toLowerCase()],
        )
      ).rows[0];
    }
    return { attempt: toView(row), entryContract: this.chain.entryContract, entryFee: fee.toString(), wif: tokens.wif };
  }

  /**
   * Record a verified EntryPurchased payment. Idempotent. Used both by the
   * payment endpoint and by the log indexer, so a payment is credited even if
   * the player's browser never reports it. One payment ⇒ exactly one attempt.
   */
  async recordPayment(payment: EntryPayment, source: 'player' | 'indexer'): Promise<{ attemptId: string; credited: boolean }> {
    return this.db.tx(async (q) => {
      const inserted = await q.query<{ entry_id: string }>(
        `insert into payments (entry_id, tx_hash, log_index, block_number, player, week_id, attempt_ref, fee, reward_share, protocol_share)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (entry_id) do nothing returning entry_id`,
        [
          payment.entryId,
          payment.txHash,
          payment.logIndex,
          payment.blockNumber.toString(),
          payment.player,
          payment.weekId,
          payment.attemptRef,
          payment.fee.toString(),
          payment.rewardShare.toString(),
          payment.protocolShare.toString(),
        ],
      );
      const existing = (await q.query<AttemptRow>('select * from attempts where entry_id = $1', [payment.entryId])).rows[0];
      if (existing) {
        if (existing.status === 'awaiting_payment') {
          await q.query("update attempts set status = 'paid', payment_entry_id = $2, paid_at = now() where id = $1", [existing.id, payment.entryId]);
          await this.audit(q, source === 'player' ? payment.player : 'system', 'payment_verified', existing.id, payment.weekId, { txHash: payment.txHash, source });
          return { attemptId: existing.id, credited: true };
        }
        return { attemptId: existing.id, credited: false };
      }
      if (inserted.rows.length === 0) {
        const linked = (await q.query<{ id: string }>('select id from attempts where payment_entry_id = $1', [payment.entryId])).rows[0];
        return { attemptId: linked?.id ?? '', credited: false };
      }
      // Paid directly on the contract without reserving first: still exactly one attempt.
      await q.query('insert into players (address) values ($1) on conflict (address) do nothing', [payment.player]);
      const id = randomUUID();
      await q.query(
        "insert into attempts (id, player, attempt_ref, entry_id, status, payment_entry_id, paid_at) values ($1,$2,$3,$4,'paid',$5, now())",
        [id, payment.player, payment.attemptRef, payment.entryId, payment.entryId],
      );
      await this.audit(q, 'system', 'payment_credited', id, payment.weekId, { txHash: payment.txHash, source, note: 'payment without prior reservation' });
      return { attemptId: id, credited: true };
    });
  }

  /** The player reports their transaction; the server checks it onchain itself before crediting anything. */
  async reportPayment(player: `0x${string}`, id: string, txHash: string): Promise<{ attempt: AttemptView; pending: boolean }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, 'bad_tx', 'Invalid transaction hash');
    const a = await this.own(player, id);
    if (a.status !== 'awaiting_payment') return { attempt: toView(a), pending: false };
    const check = await this.chain.verifyEntryPayment(txHash as `0x${string}`, {
      player,
      attemptRef: a.attempt_ref as `0x${string}`,
      entryId: a.entry_id as `0x${string}`,
    });
    if (check.status === 'pending') return { attempt: toView(a), pending: true };
    if (check.status === 'invalid') throw new HttpError(400, 'payment_invalid', check.reason);
    await this.recordPayment(check.payment, 'player');
    this.events.publish('competition', { weekId: check.payment.weekId });
    const updated = (await this.get(id))!;
    return { attempt: toView(updated, check.payment.weekId, check.payment.txHash), pending: false };
  }

  async mine(player: string): Promise<{ available: AttemptView[]; awaitingPayment: AttemptView[]; recent: AttemptView[] }> {
    const p = player.toLowerCase();
    const { rows } = await this.db.query<AttemptRow & { pay_week: number | null; tx_hash: string | null }>(
      `select a.*, pay.week_id as pay_week, pay.tx_hash from attempts a left join payments pay on pay.entry_id = a.payment_entry_id
        where a.player = $1 order by a.created_at desc limit 60`,
      [p],
    );
    const view = (r: (typeof rows)[number]) => toView(r, r.pay_week, r.tx_hash);
    return {
      available: rows.filter((r) => r.status === 'paid').map(view),
      awaitingPayment: rows.filter((r) => r.status === 'awaiting_payment').map(view),
      recent: rows.filter((r) => !['paid', 'awaiting_payment'].includes(r.status)).slice(0, 15).map(view),
    };
  }

  // ------------------------------------------------------------- bonus life

  /**
   * The paid entry a voyage's bonus life is bought for: its own, or for a restored attempt the entry of the
   * attempt it replaced (one paid entry, one bonus life, however often it is restored).
   */
  private async lifeEntryId(a: AttemptRow): Promise<`0x${string}` | null> {
    if (a.payment_entry_id) return a.payment_entry_id as `0x${string}`;
    const { rows } = await this.db.query<{ payment_entry_id: string }>(
      `with recursive lineage (id, restored_from, payment_entry_id, depth) as (
         select id, restored_from, payment_entry_id, 0 from attempts where id = $1
         union all
         select p.id, p.restored_from, p.payment_entry_id, l.depth + 1 from attempts p join lineage l on p.id = l.restored_from where l.depth < 20
       )
       select payment_entry_id from lineage where payment_entry_id is not null limit 1`,
      [a.id],
    );
    return (rows[0]?.payment_entry_id as `0x${string}` | undefined) ?? null;
  }

  private async lifePaid(a: AttemptRow): Promise<boolean> {
    const entryId = await this.lifeEntryId(a);
    if (!entryId) return false;
    return (await this.db.query('select 1 from extra_lives where entry_id = $1', [entryId])).rows.length > 0;
  }

  /** Real time spent buying the bonus life (from the loss to the confirmed payment), not held against the voyage. */
  private lifePauseSeconds(a: AttemptRow, inputs: readonly InputEvent[], until: Date | null): number {
    const reviveTick = reviveTickOf(inputs);
    if (!a.revived_at || !a.started_at || reviveTick === null) return 0;
    const lostAt = a.started_at.getTime() + (reviveTick / TICK_RATE) * 1000;
    const from = Math.max(lostAt, a.life_offered_at?.getTime() ?? lostAt);
    const to = Math.min(a.revived_at.getTime(), until?.getTime() ?? Number.POSITIVE_INFINITY);
    return Math.max(0, (to - from) / 1000);
  }

  /** The ship was lost on a ranked voyage: what its one bonus life costs, and the entry to buy it for. */
  async quoteLife(player: `0x${string}`, id: string): Promise<ExtraLifeQuote & { paid: boolean }> {
    const a = await this.own(player, id);
    if (a.status !== 'started') throw new HttpError(409, 'not_running', 'This game is no longer in progress.');
    if (a.revived_at) throw new HttpError(409, 'life_used', 'This voyage has already used its bonus life.');
    if (!this.chain.entryContract) throw new HttpError(503, 'chain_disabled', 'Competitive play isn’t available right now.');
    const entryId = await this.lifeEntryId(a);
    if (!entryId) throw new HttpError(409, 'no_entry', 'Bonus lives are only for paid competitive games.');
    const [fee, tokens] = await Promise.all([this.chain.extraLifeFee(), this.chain.tokens()]);
    if (fee === null || !tokens) throw new HttpError(503, 'chain_unavailable', 'Can’t read the price of a bonus life right now. Please try again in a moment.');
    await this.db.query("update attempts set life_offered_at = coalesce(life_offered_at, now()) where id = $1 and status = 'started'", [a.id]);
    const paid = (await this.db.query('select 1 from extra_lives where entry_id = $1', [entryId])).rows.length > 0;
    return { entryContract: this.chain.entryContract, entryId, extraLifeFee: fee.toString(), wif: tokens.wif, paid };
  }

  /** Record a verified ExtraLifePurchased payment. Idempotent (one bonus life per entry). Used by the player and the indexer. */
  async recordLifePayment(payment: ExtraLifePayment, source: 'player' | 'indexer'): Promise<boolean> {
    const inserted = await this.db.query(
      `insert into extra_lives (entry_id, tx_hash, log_index, block_number, player, week_id, fee, reward_share, protocol_share)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing returning entry_id`,
      [
        payment.entryId,
        payment.txHash,
        payment.logIndex,
        payment.blockNumber.toString(),
        payment.player,
        payment.weekId,
        payment.fee.toString(),
        payment.rewardShare.toString(),
        payment.protocolShare.toString(),
      ],
    );
    if (inserted.rows.length === 0) return false;
    const attempt = (await this.db.query<{ id: string }>('select id from attempts where payment_entry_id = $1', [payment.entryId])).rows[0];
    await this.audit(this.db, source === 'player' ? payment.player : 'system', 'extra_life_paid', attempt?.id ?? null, payment.weekId, {
      txHash: payment.txHash,
      fee: payment.fee.toString(),
      source,
    });
    return true;
  }

  /** The player reports their bonus-life transaction; once the server has confirmed it onchain the voyage may carry on. */
  async reportLifePayment(player: `0x${string}`, id: string, txHash: string | undefined): Promise<ExtraLifeReport> {
    const a = await this.own(player, id);
    if (a.status !== 'started') throw new HttpError(409, 'not_running', 'This game is no longer in progress.');
    const entryId = await this.lifeEntryId(a);
    if (!entryId) throw new HttpError(409, 'no_entry', 'Bonus lives are only for paid competitive games.');
    if (!(await this.lifePaid(a))) {
      if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, 'bad_tx', 'Invalid transaction hash');
      const check = await this.chain.verifyExtraLifePayment(txHash as `0x${string}`, { player, entryId });
      if (check.status === 'pending') return { status: 'pending' };
      if (check.status === 'invalid') throw new HttpError(400, 'payment_invalid', check.reason);
      await this.recordLifePayment(check.payment, 'player');
      this.events.publish('competition', { weekId: check.payment.weekId });
    }
    await this.db.query(
      "update attempts set revived_at = coalesce(revived_at, now()), life_offered_at = coalesce(life_offered_at, now()) where id = $1 and status = 'started'",
      [a.id],
    );
    return { status: 'confirmed' };
  }

  // ------------------------------------------------------------------ play

  /** Consume a paid entry and issue the secret seed. Single-use: a second call fails. */
  async start(player: `0x${string}`, id: string): Promise<StartAttemptResponse> {
    const a = await this.own(player, id);
    if (a.status !== 'paid') throw new HttpError(409, 'not_available', a.status === 'started' ? 'This attempt has already begun.' : 'This game can’t be started.');
    const weekId = this.competitions.currentWeekId();
    const comp = await this.competitions.ensureWeek(weekId);
    if (comp.status !== 'open') throw new HttpError(409, 'competition_closed', 'This week’s competition is closed.');

    // Starting a new attempt ends any run still marked in progress (its last checkpoint is scored).
    const live = await this.db.query<AttemptRow>("select * from attempts where player = $1 and status = 'started' and id <> $2", [a.player, id]);
    for (const other of live.rows) await this.finalizeAbandoned(other, 'superseded_by_new_attempt');

    const seed = randomSeedHex((n) => randomBytes(n));
    const started = await this.db.tx(async (q) => {
      // Serialise this player's starts/restores, and hold the week open while the seed is issued.
      await this.lockPlayer(q, a.player);
      const week = (await q.query<{ status: string }>('select status from competitions where week_id = $1 for share', [weekId])).rows[0];
      if (!week || week.status !== 'open') throw new HttpError(409, 'competition_closed', 'This week’s competition is closed.');
      const running = await q.query<{ id: string }>("select id from attempts where player = $1 and status = 'started' and id <> $2", [a.player, id]);
      if (running.rows.length) throw new HttpError(409, 'attempt_in_progress', 'You already have a competitive game in progress.');
      const upd = await q.query<AttemptRow>(
        "update attempts set status = 'started', seed = $3, week_id = $4, game_version = $5, started_at = now() where id = $1 and player = $2 and status = 'paid' returning *",
        [id, a.player, seed, weekId, GAME_VERSION],
      );
      if (upd.rows.length === 0) throw new HttpError(409, 'not_available', 'This game can’t be started.');
      await this.audit(q, a.player, 'attempt_started', id, weekId, {});
      return upd.rows[0];
    });
    return { attemptId: id, seed, version: GAME_VERSION, startedAt: started.started_at!.toISOString(), maxTicks: DEFAULT_CONFIG.maxTicks };
  }

  private elapsedSeconds(a: AttemptRow): number {
    return (Date.now() - (a.started_at?.getTime() ?? Date.now())) / 1000;
  }

  /** Runs with review flags that would place in the top N are held for an administrator. */
  private async reviewStatus(a: AttemptRow, flags: RunFlag[], score: number, otherwise: AttemptStatus): Promise<AttemptStatus> {
    if (!flags.some((f) => f.severity === 'review') || a.week_id === null) return otherwise;
    const projected = await this.board.projectedRank(a.week_id, score, a.player);
    return projected <= this.policy.reviewTopN ? 'flagged' : otherwise;
  }

  /** Row lock on the player, serialising their start / restore / supersede operations. */
  private async lockPlayer(q: Queryable, player: string): Promise<void> {
    await q.query('select address from players where address = $1 for update', [player]);
  }

  /** Periodic progress from the client, so an interrupted run can be scored up to its last checkpoint. */
  async checkpoint(player: `0x${string}`, id: string, body: { tick: number; inputs: unknown; checkpoints?: unknown }): Promise<void> {
    const a = await this.own(player, id);
    if (a.status !== 'started') throw new HttpError(409, 'not_running', 'This game is no longer in progress.');
    const inputs = decodeInputs(body.inputs);
    if (!inputs) throw new HttpError(400, 'bad_inputs', 'Malformed inputs');
    if (!Number.isInteger(body.tick) || body.tick < 0 || body.tick > DEFAULT_CONFIG.maxTicks) throw new HttpError(400, 'bad_tick', 'Bad tick');
    const v = validateInputs(inputs, DEFAULT_CONFIG.maxTicks);
    if (!v.ok) throw new HttpError(400, 'bad_inputs', v.reason);
    if (inputs.length && inputs[inputs.length - 1][0] > body.tick) throw new HttpError(400, 'bad_inputs', 'Inputs beyond checkpoint tick');
    if (body.tick / TICK_RATE > this.elapsedSeconds(a) + this.policy.clockSlackSeconds) {
      throw new HttpError(400, 'clock', 'Checkpoint is ahead of real time');
    }
    const prev = a.inputs ?? [];
    if (body.tick < (a.checkpoint_tick ?? 0) || !extendsHistory(prev, a.checkpoint_tick ?? 0, inputs)) {
      throw new HttpError(409, 'checkpoint_conflict', 'Checkpoint does not extend the previous one');
    }
    const cps = Array.isArray(body.checkpoints) ? body.checkpoints.filter((c): c is string => typeof c === 'string').slice(0, 400) : [];
    await this.db.query('update attempts set inputs = $2, checkpoint_tick = $3, checkpoints = $4, checkpoint_at = now() where id = $1 and status = $5', [
      id,
      JSON.stringify(inputs),
      body.tick,
      JSON.stringify(cps),
      'started',
    ]);
  }

  /** Verify a finished run by replaying it. The score is whatever the server's simulation says. */
  async submit(player: `0x${string}`, id: string, body: SubmitAttemptRequest): Promise<SubmitAttemptResponse> {
    const a = await this.own(player, id);
    if (a.status !== 'started') {
      if (a.score !== null) return this.response(a);
      throw new HttpError(409, 'not_running', 'This game is no longer in progress.');
    }
    const comp = a.week_id !== null ? await this.competitions.get(a.week_id) : null;
    if (comp && !['open', 'closing'].includes(comp.status)) return this.reject(a, 'week_closed');
    const inputs = decodeInputs(body.inputs);
    if (!inputs) return this.reject(a, 'malformed_inputs');
    const elapsed = this.elapsedSeconds(a);
    const flags: RunFlag[] = [];
    if (!Number.isInteger(body.endTick)) return this.reject(a, 'bad_end_tick');
    if (body.endTick / TICK_RATE > elapsed + this.policy.clockSlackSeconds) return this.reject(a, 'faster_than_real_time');
    const gap = elapsed - this.lifePauseSeconds(a, inputs, null) - body.endTick / TICK_RATE;
    if (gap > this.policy.clockGapFlagSeconds) {
      flags.push({ code: 'clock_gap', severity: 'review', detail: `${Math.round(gap)}s of real time unaccounted for` });
    }
    if (a.inputs && !extendsHistory(a.inputs, a.checkpoint_tick ?? 0, inputs)) {
      flags.push({ code: 'checkpoint_mismatch', severity: 'review', detail: 'Submitted inputs rewrite an earlier checkpoint' });
    }

    const out = verifyRun({
      seed: a.seed!,
      version: a.game_version ?? GAME_VERSION,
      inputs,
      claimedEndTick: body.endTick,
      claimedScore: body.claimedScore,
      claimedHash: body.finalHash,
      claimedCheckpoints: body.checkpoints,
      mode: 'final',
    });
    if (!out.ok) return this.reject(a, out.reason, inputs);
    // A voyage that carried on after the ship was lost must have paid for its bonus life onchain.
    if (out.result.revived && !(await this.lifePaid(a))) return this.reject(a, 'bonus_life_not_paid', inputs);
    flags.push(...out.flags);
    const status = await this.reviewStatus(a, flags, out.result.score, 'verified');
    const r = out.result;
    const updated = await this.db.tx(async (q) => {
      const row = (
        await q.query<AttemptRow>(
          `update attempts set status = $2, submitted_at = now(), verified_at = now(), end_tick = $3, inputs = $4, claimed_score = $5,
                  score = $6, distance_score = $7, evidence = $8, survival_ms = $9, death = $10, flags = $11, analysis = $12, checkpoints = $13
            where id = $1 and status = 'started' returning *`,
          [
            a.id,
            status,
            r.ticks,
            JSON.stringify(inputs),
            body.claimedScore,
            r.score,
            r.distanceScore,
            r.evidence,
            r.survivalMs,
            r.death,
            JSON.stringify(flags),
            JSON.stringify({ ...out.analysis, divergedAtCheckpoint: out.divergedAtCheckpoint, finalHash: r.finalHash }),
            JSON.stringify(r.checkpointHashes),
          ],
        )
      ).rows[0];
      if (!row) throw new HttpError(409, 'not_running', 'This game has already been scored.');
      await this.audit(q, a.player, status === 'flagged' ? 'attempt_flagged' : 'attempt_verified', a.id, a.week_id, { score: r.score, flags: flags.map((f) => f.code) });
      return row;
    });
    this.board.invalidate(a.week_id!);
    this.events.publish('leaderboard', { weekId: a.week_id });
    return this.response(updated);
  }

  private async reject(a: AttemptRow, reason: string, inputs?: InputEvent[]): Promise<SubmitAttemptResponse> {
    const row = (
      await this.db.query<AttemptRow>(
        "update attempts set status = 'rejected', submitted_at = now(), note = $2, inputs = coalesce($3, inputs) where id = $1 and status = 'started' returning *",
        [a.id, reason, inputs ? JSON.stringify(inputs) : null],
      )
    ).rows[0];
    await this.audit(this.db, 'system', 'attempt_rejected', a.id, a.week_id, { reason });
    return { status: 'rejected', score: 0, evidence: 0, survivalMs: 0, rank: null, personalBest: await this.personalBest(a), pointsToThird: null, reason: row?.note ?? reason };
  }

  private async personalBest(a: AttemptRow): Promise<number | null> {
    if (a.week_id === null) return null;
    const s = await this.board.standing(a.week_id, a.player);
    return s?.score ?? null;
  }

  private async response(a: AttemptRow): Promise<SubmitAttemptResponse> {
    const standing = a.week_id !== null ? await this.board.standing(a.week_id, a.player) : null;
    return {
      status: a.status,
      score: a.score ?? 0,
      evidence: a.evidence ?? 0,
      survivalMs: a.survival_ms ?? 0,
      rank: standing?.rank ?? null,
      personalBest: standing?.score ?? null,
      pointsToThird: a.week_id !== null ? await this.board.pointsToThird(a.week_id, a.player) : null,
      reason: a.note ?? undefined,
    };
  }

  // ------------------------------------------------- the restoration policy

  /**
   * An attempt that was started but never finished. If the client sent
   * checkpoints, the run is scored as it stood at the last one (status
   * `abandoned`, which counts on the Registry). If nothing was ever received
   * the attempt is marked `abandoned` with note `no_contact` and is eligible
   * for restoration.
   */
  async finalizeAbandoned(a: AttemptRow, reason: string): Promise<void> {
    const tick = a.checkpoint_tick ?? 0;
    // A run the Society never heard from has no score and does not rank.
    let score: number | null = null;
    let fields: unknown[] = [null, null, null, null, null];
    let flags: RunFlag[] = [];
    let note = reason;
    let status: AttemptStatus = 'abandoned';
    if (tick > 0 && a.seed) {
      const out = verifyRun({ seed: a.seed, version: a.game_version ?? GAME_VERSION, inputs: a.inputs ?? [], claimedEndTick: tick, mode: 'partial' });
      if (out.ok && out.result.revived && !(await this.lifePaid(a))) {
        note = `${reason}; checkpoint invalid: bonus_life_not_paid`;
      } else if (out.ok) {
        score = out.result.score;
        fields = [out.result.distanceScore, out.result.evidence, out.result.survivalMs, out.result.death, out.result.ticks];
        flags = [...out.flags];
        // The same real-time check as a submission, measured at the last checkpoint.
        if (a.checkpoint_at && a.started_at) {
          const pause = this.lifePauseSeconds(a, a.inputs ?? [], a.checkpoint_at);
          const gap = (a.checkpoint_at.getTime() - a.started_at.getTime()) / 1000 - pause - tick / TICK_RATE;
          if (gap > this.policy.clockGapFlagSeconds) {
            flags.push({ code: 'clock_gap', severity: 'review', detail: `${Math.round(gap)}s of real time unaccounted for` });
          }
        }
        status = await this.reviewStatus(a, flags, score, 'abandoned');
      } else {
        note = `${reason}; checkpoint invalid: ${out.reason}`;
      }
    } else {
      note = `${reason}; no_contact`;
    }
    const upd = await this.db.query<AttemptRow>(
      `update attempts set status = $10, verified_at = now(), score = $2, distance_score = $3, evidence = $4, survival_ms = $5, death = $6,
              end_tick = $7, flags = $8, note = $9 where id = $1 and status = 'started' returning *`,
      [a.id, score, ...fields, JSON.stringify(flags), note, status],
    );
    if (upd.rows.length) {
      await this.audit(this.db, 'system', status === 'flagged' ? 'attempt_flagged' : 'attempt_abandoned', a.id, a.week_id, { reason, scoredAtTick: tick, score });
      if (a.week_id !== null) {
        this.board.invalidate(a.week_id);
        this.events.publish('leaderboard', { weekId: a.week_id });
      }
    }
  }

  /** Finalize every started attempt that can no longer be submitted. */
  async sweepAbandoned(): Promise<number> {
    const cutoffSeconds = MAX_RUN_SECONDS + this.policy.abandonGraceMinutes * 60;
    const { rows } = await this.db.query<AttemptRow>(
      `select * from attempts where status = 'started' and started_at < now() - ($1 || ' seconds')::interval`,
      [String(Math.round(cutoffSeconds))],
    );
    for (const a of rows) await this.finalizeAbandoned(a, 'not_submitted_in_time');
    return rows.length;
  }

  /**
   * Restore an attempt: the old one is marked `restored` and a fresh paid
   * attempt is issued. Players may self-restore attempts the server never
   * heard from after start (no checkpoint, no submission) up to the weekly
   * allowance; anything else needs an administrator. Every restoration is
   * written to the audit log.
   */
  async restore(actor: string, id: string, opts: { admin: boolean; note: string }): Promise<AttemptView> {
    const first = await this.get(id);
    if (!first || (!opts.admin && first.player !== actor.toLowerCase())) throw new HttpError(404, 'not_found', 'That game can’t be found.');
    const fresh = await this.db.tx(async (q) => {
      // Everything below runs under the player's lock, so concurrent requests cannot overspend the allowance.
      await this.lockPlayer(q, first.player);
      const a = (await q.query<AttemptRow>('select * from attempts where id = $1', [id])).rows[0];
      const noContact = (a.checkpoint_tick ?? 0) === 0 && a.submitted_at === null;
      if (!opts.admin) {
        const eligible = (a.status === 'started' && noContact && this.elapsedSeconds(a) > 20) || (a.status === 'abandoned' && noContact);
        if (!eligible) throw new HttpError(403, 'needs_admin', 'This game can’t be restored automatically.');
        const used = (
          await q.query<{ n: string }>("select count(*)::text as n from audit_log where actor = $1 and action = 'attempt_restored' and at >= $2", [
            a.player,
            new Date(Date.now() - 7 * 86400_000),
          ])
        ).rows[0];
        if (Number(used.n) >= this.policy.autoRestorePerWeek) {
          throw new HttpError(403, 'needs_admin', 'You’ve used this week’s automatic restore.');
        }
      } else if (!['started', 'abandoned', 'rejected', 'flagged'].includes(a.status)) {
        throw new HttpError(409, 'not_restorable', `Attempts in status ${a.status} cannot be restored.`);
      }
      // A run that counted toward a finalized week cannot also be handed back.
      if (a.week_id !== null && a.score !== null) {
        const week = (await q.query<{ status: string }>('select status from competitions where week_id = $1', [a.week_id])).rows[0];
        if (week && ['finalized', 'settled'].includes(week.status)) throw new HttpError(409, 'week_finalized', 'Results for that week are final.');
      }
      const upd = await q.query('update attempts set status = $2, note = $3 where id = $1 and status = $4 returning id', [
        a.id,
        'restored',
        `restored: ${opts.note}`,
        a.status,
      ]);
      if (upd.rows.length === 0) throw new HttpError(409, 'conflict', 'Please try again.');
      const ref = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
      const row = (
        await q.query<AttemptRow>(
          "insert into attempts (id, player, attempt_ref, entry_id, status, paid_at, restored_from, note) values ($1,$2,$3,$4,'paid', now(), $5, $6) returning *",
          [randomUUID(), a.player, ref, computeEntryId(a.player as `0x${string}`, ref).toLowerCase(), a.id, `restoration of ${a.id}`],
        )
      ).rows[0];
      await this.audit(q, opts.admin ? actor.toLowerCase() : a.player, 'attempt_restored', a.id, a.week_id, { note: opts.note, admin: opts.admin, newAttempt: row.id });
      return row;
    });
    if (first.week_id !== null && ['abandoned', 'flagged'].includes(first.status)) {
      this.board.invalidate(first.week_id);
      this.events.publish('leaderboard', { weekId: first.week_id });
    }
    return toView(fresh);
  }

  /** Administrator decision on a flagged run. */
  async review(admin: string, id: string, decision: 'approve' | 'reject', note: string): Promise<void> {
    const a = await this.get(id);
    if (!a) throw new HttpError(404, 'not_found', 'That game can’t be found.');
    // Flagged runs, and counted runs that carry anomaly flags, can be reviewed; any counted run can be rejected.
    if (a.status !== 'flagged' && !['verified', 'abandoned'].includes(a.status)) {
      throw new HttpError(409, 'not_reviewable', `Attempt is ${a.status}`);
    }
    const comp = a.week_id !== null ? await this.competitions.get(a.week_id) : null;
    if (comp && ['finalized', 'settled'].includes(comp.status)) throw new HttpError(409, 'week_finalized', 'Results for that week are final.');
    await this.db.tx(async (q) => {
      await q.query('update attempts set status = $2, note = $3, reviewed_at = now(), reviewed_by = $4 where id = $1', [
        id,
        decision === 'reject' ? 'rejected' : a.status === 'flagged' ? 'verified' : a.status,
        note || null,
        admin.toLowerCase(),
      ]);
      await this.audit(q, admin.toLowerCase(), decision === 'approve' ? 'review_approved' : 'review_rejected', id, a.week_id, { note });
    });
    if (a.week_id !== null) {
      this.board.invalidate(a.week_id);
      this.events.publish('leaderboard', { weekId: a.week_id });
    }
  }
}

/**
 * True when `full` keeps every event already reported (`prefix`) and only adds
 * events after the last reported tick — history up to a checkpoint is fixed.
 */
function extendsHistory(prefix: readonly InputEvent[], reportedTick: number, full: readonly InputEvent[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i][0] !== full[i][0] || prefix[i][1] !== full[i][1]) return false;
  }
  for (let i = prefix.length; i < full.length; i++) {
    if (full[i][0] <= reportedTick) return false;
  }
  return true;
}
