import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, GAME_VERSION, decodeInputs, randomSeedHex, verifyRun, type RunFlag } from '@fes/game-core';
import type { PracticeStatus, StartPracticeResponse, SubmitAttemptRequest, SubmitPracticeResponse } from '@fes/shared';
import type { Db } from '../db';
import { HttpError } from '../errors';
import type { CompetitionService } from './competition';
import type { EventHub } from './events';
import type { LeaderboardService } from './leaderboard';

interface PracticeRow {
  id: string;
  /** Null until a guest's voyage is claimed by a named explorer. */
  player: string | null;
  week_id: number;
  status: PracticeStatus;
  seed: string;
  game_version: string;
  started_at: Date;
  score: number | null;
  evidence: number | null;
  survival_ms: number | null;
  note: string | null;
}

const TICK_RATE = DEFAULT_CONFIG.tickRate;
/** Seconds of slack between the server clock and simulated time (network latency). */
const CLOCK_SLACK_SECONDS = 5;
/** A practice voyage may be paused, so an unfinished one is only given up after a day. */
const ABANDON_AFTER_HOURS = 24;

/**
 * Free practice voyages, logged for every explorer. The server issues the seed and
 * replays each submitted run, so the practice board is verified like the Registry.
 * Practice may pause, so the only time limit is that a run cannot be faster than the
 * clock. Practice never counts towards prizes.
 */
export class PracticeService {
  constructor(
    private readonly db: Db,
    private readonly board: LeaderboardService,
    private readonly competitions: CompetitionService,
    private readonly events: EventHub,
  ) {}

  /**
   * Issue a practice voyage's seed. A named explorer's voyage is theirs from the start; anyone else's
   * (a guest's) belongs to nobody until a named explorer claims it on submission.
   */
  async start(player: `0x${string}` | null): Promise<StartPracticeResponse> {
    const address = player ? player.toLowerCase() : null;
    const named = address ? (await this.db.query<{ display_name: string | null }>('select display_name from players where address = $1', [address])).rows[0] : null;
    const owner = named?.display_name ? address : null;
    const id = randomUUID();
    const seed = randomSeedHex((n) => randomBytes(n));
    const weekId = this.competitions.currentWeekId();
    const row = await this.db.tx(async (q) => {
      // One voyage at a time: starting another gives up the one left unfinished.
      if (owner) await q.query("update practice_runs set status = 'abandoned', note = 'superseded' where player = $1 and status = 'started'", [owner]);
      return (
        await q.query<PracticeRow>(
          "insert into practice_runs (id, player, week_id, status, seed, game_version) values ($1, $2, $3, 'started', $4, $5) returning *",
          [id, owner, weekId, seed, GAME_VERSION],
        )
      ).rows[0];
    });
    return { runId: id, seed, version: GAME_VERSION, startedAt: row.started_at.toISOString() };
  }

  async submit(player: `0x${string}`, id: string, body: SubmitAttemptRequest): Promise<SubmitPracticeResponse> {
    let run = await this.own(player, id);
    if (run.player === null) run = await this.claim(player, run);
    if (run.status !== 'started') {
      if (run.status === 'verified' || run.status === 'rejected') return this.response(run);
      throw new HttpError(409, 'not_running', 'This voyage is no longer in progress.');
    }
    const inputs = decodeInputs(body.inputs);
    if (!inputs) return this.reject(run, 'malformed_inputs');
    if (!Number.isInteger(body.endTick)) return this.reject(run, 'bad_end_tick');
    const elapsed = (Date.now() - run.started_at.getTime()) / 1000;
    if (body.endTick / TICK_RATE > elapsed + CLOCK_SLACK_SECONDS) return this.reject(run, 'faster_than_real_time');

    const out = verifyRun({
      seed: run.seed,
      version: run.game_version,
      inputs,
      claimedEndTick: body.endTick,
      claimedScore: body.claimedScore,
      claimedHash: body.finalHash,
      claimedCheckpoints: body.checkpoints,
      mode: 'final',
    });
    if (!out.ok) return this.reject(run, out.reason);
    const flags: RunFlag[] = out.flags;
    // A run whose own claims disagree with the replay is not shown on the practice board.
    const status: PracticeStatus = flags.some((f) => f.severity === 'review') ? 'rejected' : 'verified';
    const r = out.result;
    const row = (
      await this.db.query<PracticeRow>(
        `update practice_runs set status = $2, verified_at = now(), end_tick = $3, inputs = $4, score = $5, evidence = $6, survival_ms = $7, death = $8,
                flags = $9, note = $10
          where id = $1 and status = 'started' returning *`,
        [run.id, status, r.ticks, JSON.stringify(inputs), r.score, r.evidence, r.survivalMs, r.death, JSON.stringify(flags), status === 'rejected' ? 'replay_mismatch' : null],
      )
    ).rows[0];
    if (!row) throw new HttpError(409, 'not_running', 'This voyage was already logged.');
    if (status === 'verified') {
      this.board.invalidate(run.week_id);
      this.events.publish('practice', { weekId: run.week_id });
    }
    return this.response(row);
  }

  /** Gives up voyages left unfinished for a day (closed tabs, lost connections). */
  async sweepAbandoned(): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `update practice_runs set status = 'abandoned', note = 'never_submitted'
        where status = 'started' and started_at < now() - make_interval(hours => $1) returning id`,
      [ABANDON_AFTER_HOURS],
    );
    return rows.length;
  }

  /** Activity on the practice board for a week, for the Society's administrators. */
  async weekSummary(weekId: number): Promise<{ runs: number; players: number }> {
    const r = (
      await this.db.query<{ runs: string; players: string }>(
        "select count(*)::text as runs, count(distinct player)::text as players from practice_runs where week_id = $1 and status = 'verified'",
        [weekId],
      )
    ).rows[0];
    return { runs: Number(r.runs), players: Number(r.players) };
  }

  /** The voyage, if it is `player`'s or still unclaimed. */
  private async own(player: string, id: string): Promise<PracticeRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'That voyage can’t be found.');
    const row = (await this.db.query<PracticeRow>('select * from practice_runs where id = $1', [id])).rows[0];
    if (!row || (row.player !== null && row.player !== player.toLowerCase())) throw new HttpError(404, 'not_found', 'That voyage can’t be found.');
    return row;
  }

  /** A guest's voyage becomes the explorer's who records it (they need a name first). */
  private async claim(player: string, run: PracticeRow): Promise<PracticeRow> {
    const address = player.toLowerCase();
    const named = (await this.db.query<{ display_name: string | null }>('select display_name from players where address = $1', [address])).rows[0];
    if (!named?.display_name) throw new HttpError(403, 'needs_name', 'Add your name to save this voyage.');
    const row = (await this.db.query<PracticeRow>('update practice_runs set player = $2 where id = $1 and player is null returning *', [run.id, address])).rows[0];
    if (!row) return this.own(player, run.id);
    return row;
  }

  private async reject(run: PracticeRow, reason: string): Promise<SubmitPracticeResponse> {
    const row = (
      await this.db.query<PracticeRow>("update practice_runs set status = 'rejected', verified_at = now(), note = $2 where id = $1 and status = 'started' returning *", [
        run.id,
        reason,
      ])
    ).rows[0];
    return this.response(row ?? { ...run, status: 'rejected', note: reason });
  }

  private async response(run: PracticeRow): Promise<SubmitPracticeResponse> {
    if (!run.player) return { status: run.status, score: 0, evidence: 0, survivalMs: 0, rank: null, personalBest: null };
    const standing = await this.board.standing(run.week_id, run.player);
    const best = (
      await this.db.query<{ best: number | null }>("select max(score) as best from practice_runs where player = $1 and status = 'verified'", [run.player])
    ).rows[0];
    return {
      status: run.status,
      score: run.status === 'verified' ? (run.score ?? 0) : 0,
      evidence: run.status === 'verified' ? (run.evidence ?? 0) : 0,
      survivalMs: run.status === 'verified' ? (run.survival_ms ?? 0) : 0,
      rank: standing?.rank ?? null,
      personalBest: best?.best ?? null,
      ...(run.status === 'rejected' ? { reason: run.note ?? 'rejected' } : {}),
    };
  }
}
