import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { GAME_VERSION, PRIZE_SHARES_BPS } from '@fes/game-core';
import { weekEndMs, weekStartMs, type PlayerStats, type PublicConfig } from '@fes/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isAddress } from 'viem';
import { z } from 'zod';
import type { ChainGateway } from './chain/gateway';
import type { Db } from './db';
import { HttpError } from './errors';
import { toView, type AttemptRow, type AttemptService } from './services/attempts';
import type { AuthService, SessionClaims } from './services/auth';
import type { CompetitionService } from './services/competition';
import type { EventHub } from './services/events';
import type { PaymentIndexer } from './services/indexer';
import type { LeaderboardService } from './services/leaderboard';
import type { PracticeService } from './services/practice';
import type { PricingService } from './services/pricing';
import type { SettlementService } from './services/settlement';

export interface AppDeps {
  db: Db;
  chain: ChainGateway;
  auth: AuthService;
  board: LeaderboardService;
  practiceBoard: LeaderboardService;
  competitions: CompetitionService;
  attempts: AttemptService;
  practice: PracticeService;
  settlement: SettlementService;
  indexer: PaymentIndexer;
  pricing: PricingService;
  events: EventHub;
  webOrigins: string[];
  confirmations: number;
  demoTokens: boolean;
  logLevel?: string;
  /** Only trust X-Forwarded-For from known proxies (rate limits key on the client IP). */
  trustProxy?: boolean | number | string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionClaims | null;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, 'bad_request', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logLevel ? { level: deps.logLevel } : false, bodyLimit: 1024 * 1024, trustProxy:
      typeof deps.trustProxy === 'number' ? (_address: string, hop: number) => hop < (deps.trustProxy as number) : (deps.trustProxy ?? false),
  });
  const { db, chain, auth, board, practiceBoard, competitions, attempts, practice, settlement, indexer, pricing, events } = deps;

  await app.register(cors, { origin: deps.webOrigins, credentials: false, methods: ['GET', 'POST'] });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    req.session = h?.startsWith('Bearer ') ? auth.readToken(h.slice(7)) : null;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    if (err.statusCode === 503) return reply.status(503).send({ error: err.code ?? 'unavailable', message: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'The Society’s clerks have made an error. Please try again.' });
  });

  const displayName = z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9 _.'-]+$/, 'letters, numbers, spaces and _ . \' - only')
    .refine((s) => !/^0x/i.test(s), 'may not look like an address');

  const requireUser = (req: FastifyRequest): `0x${string}` => {
    if (!req.session) throw new HttpError(401, 'unauthenticated', 'Sign in with your wallet first.');
    return req.session.sub;
  };
  const requireAdmin = (req: FastifyRequest): `0x${string}` => {
    const who = requireUser(req);
    if (!req.session?.adm) throw new HttpError(403, 'forbidden', 'Society administrators only.');
    return who;
  };

  // ------------------------------------------------------------- public

  app.get('/api/health', async () => ({ ok: true, version: GAME_VERSION, chain: chain.enabled ? chain.chainId : null }));

  app.get('/api/config', async (): Promise<PublicConfig> => {
    const [tokens, fee, lifeFee, burned, paused] = await Promise.all([
      chain.tokens().catch(() => null),
      chain.entryFee().catch(() => null),
      chain.extraLifeFee().catch(() => null),
      chain.burnsProtocolShare().catch(() => null),
      chain.entriesPaused().catch(() => true),
    ]);
    return {
      chainId: chain.chainId,
      chainName: chain.chainName,
      explorerUrl: chain.explorerUrl,
      entryContract: chain.entryContract,
      vaultContract: chain.vaultContract,
      converterContract: chain.converterContract,
      wif: tokens?.wif ?? null,
      fes: tokens?.fes ?? null,
      entryFee: fee?.toString() ?? null,
      extraLifeFee: lifeFee?.toString() ?? null,
      prizeInWif: tokens ? tokens.wif.address.toLowerCase() === tokens.fes.address.toLowerCase() : true,
      // Before the contracts exist, the published plan: the other half is burned.
      protocolShareBurned: burned ?? true,
      pricing: pricing.info(),
      entriesPaused: paused,
      gameVersion: GAME_VERSION,
      confirmations: deps.confirmations,
      demoTokens: deps.demoTokens,
      prizeSharesBps: [...PRIZE_SHARES_BPS] as [number, number, number],
      rewardShareBps: 5000,
    };
  });

  app.get('/api/competition/current', async () => competitions.summary(competitions.currentWeekId()));
  app.get<{ Params: { weekId: string } }>('/api/competition/:weekId', async (req) => {
    const weekId = parse(z.coerce.number().int().min(0), req.params.weekId);
    return competitions.summary(weekId);
  });

  const leaderboard = (which: LeaderboardService) => async (req: FastifyRequest<{ Querystring: { week?: string; limit?: string } }>) => {
    const q = parse(z.object({ week: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) }), req.query);
    const weekId = q.week ?? competitions.currentWeekId();
    const row = await competitions.get(weekId);
    const { entries, total } = await which.top(weekId, q.limit);
    return {
      weekId,
      startsAt: new Date(row?.starts_at ?? weekStartMs(weekId)).toISOString(),
      endsAt: new Date(row?.ends_at ?? weekEndMs(weekId)).toISOString(),
      status: competitions.publicStatus(row, weekId),
      entries,
      totalPlayers: total,
    };
  };
  app.get('/api/leaderboard', leaderboard(board));
  // The practice board: each explorer's best free voyage of the week. Never ranked for prizes.
  app.get('/api/practice/leaderboard', leaderboard(practiceBoard));

  app.get('/api/treasury', async () => competitions.treasury());
  app.get('/api/hall', async () => competitions.hall());

  app.get<{ Params: { address: string } }>('/api/players/:address', async (req): Promise<PlayerStats> => {
    if (!isAddress(req.params.address)) throw new HttpError(400, 'bad_address', 'That isn’t a wallet address.');
    const address = req.params.address.toLowerCase();
    const weekId = competitions.currentWeekId();
    const player = (await db.query<{ display_name: string | null; created_at: Date }>('select display_name, created_at from players where address = $1', [address])).rows[0];
    const standing = await board.standing(weekId, address);
    const stats = (
      await db.query<{ best: number | null; ranked: string; unused: string }>(
        `select max(score) filter (where status in ('verified','abandoned')) as best,
                count(*) filter (where started_at is not null)::text as ranked,
                count(*) filter (where status = 'paid')::text as unused
           from attempts where player = $1`,
        [address],
      )
    ).rows[0];
    const practiced = (
      await db.query<{ best: number | null; runs: string }>(
        "select max(score) as best, count(*)::text as runs from practice_runs where player = $1 and status = 'verified'",
        [address],
      )
    ).rows[0];
    const fes = (await db.query<{ total: string }>("select coalesce(sum(amount),0)::text as total from settlements where kind = 'claim' and recipient = $1", [address])).rows[0];
    const recent = (
      await db.query<AttemptRow>("select * from attempts where player = $1 and status not in ('awaiting_payment') order by created_at desc limit 10", [address])
    ).rows.map((r) => toView(r));
    // Seeds are never exposed for unfinished attempts.
    return {
      address,
      displayName: player?.display_name ?? null,
      registeredAt: player?.created_at.toISOString() ?? null,
      weeklyBest: standing?.score ?? null,
      weeklyRank: standing?.rank ?? null,
      allTimeBest: stats.best,
      rankedAttempts: Number(stats.ranked),
      unusedEntries: Number(stats.unused),
      fesEarned: fes.total,
      recent,
      practiceRuns: Number(practiced.runs),
      practiceBest: practiced.best,
    };
  });

  app.get('/api/events', (req, reply: FastifyReply) => {
    reply.hijack();
    const res = reply.raw;
    const origin = req.headers.origin;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...(origin && deps.webOrigins.includes(origin) ? { 'access-control-allow-origin': origin } : {}),
    });
    res.write('retry: 5000\n\n');
    events.add(res);
  });

  // --------------------------------------------------------------- auth

  app.get('/api/auth/nonce', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => ({ nonce: await auth.issueNonce() }));

  app.post('/api/auth/verify', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ message: z.string().max(4000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }), req.body);
    return auth.verify(body.message, body.signature as `0x${string}`);
  });

  app.get('/api/auth/me', async (req) => {
    const who = requireUser(req);
    return { address: who, isAdmin: Boolean(req.session?.adm), expiresAt: new Date(req.session!.exp * 1000).toISOString() };
  });

  // Lets the name form say "taken" before the explorer connects a wallet.
  app.get<{ Querystring: { name?: string } }>('/api/players/name-available', async (req) => {
    const name = parse(displayName, req.query.name);
    const taken = (await db.query('select 1 from players where lower(display_name) = lower($1)', [name])).rows.length > 0;
    return { available: !taken };
  });

  app.post('/api/players/me/name', async (req) => {
    const who = requireUser(req);
    const body = parse(z.object({ displayName }), req.body);
    try {
      await db.query('insert into players (address, display_name) values ($1, $2) on conflict (address) do update set display_name = excluded.display_name', [
        who.toLowerCase(),
        body.displayName,
      ]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'name_taken', 'That name is taken. Try another.');
      throw err;
    }
    board.invalidate();
    practiceBoard.invalidate();
    return { ok: true };
  });

  // ----------------------------------------------------------- practice

  // Anyone may start a practice voyage; a guest's can be claimed later by a named explorer.
  app.post('/api/practice', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => practice.start(req.session?.sub ?? null));

  app.post<{ Params: { id: string } }>('/api/practice/:id/submit', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(
      z.object({
        endTick: z.number().int(),
        inputs: z.array(z.number()).max(200_000),
        claimedScore: z.number().int(),
        finalHash: z.string().max(16),
        checkpoints: z.array(z.string().max(16)).max(400),
      }),
      req.body,
    );
    return practice.submit(requireUser(req), req.params.id, body);
  });

  // ----------------------------------------------------------- attempts

  const attemptLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.post('/api/attempts', attemptLimit, async (req) => attempts.create(requireUser(req)));
  app.get('/api/attempts/mine', async (req) => attempts.mine(requireUser(req)));

  app.post<{ Params: { id: string } }>('/api/attempts/:id/payment', attemptLimit, async (req) => {
    const body = parse(z.object({ txHash: z.string() }), req.body);
    return attempts.reportPayment(requireUser(req), req.params.id, body.txHash);
  });

  app.post<{ Params: { id: string } }>('/api/attempts/:id/start', attemptLimit, async (req) => attempts.start(requireUser(req), req.params.id));

  app.post<{ Params: { id: string } }>('/api/attempts/:id/checkpoint', async (req) => {
    const body = parse(z.object({ tick: z.number().int(), inputs: z.array(z.number()).max(200_000), checkpoints: z.array(z.string()).max(400).optional() }), req.body);
    await attempts.checkpoint(requireUser(req), req.params.id, body);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/attempts/:id/submit', attemptLimit, async (req) => {
    const body = parse(
      z.object({
        endTick: z.number().int(),
        inputs: z.array(z.number()).max(200_000),
        claimedScore: z.number().int(),
        finalHash: z.string().max(16),
        checkpoints: z.array(z.string().max(16)).max(400),
      }),
      req.body,
    );
    return attempts.submit(requireUser(req), req.params.id, body);
  });

  // The ship was lost: what the voyage's one bonus life costs, and the entry to buy it for onchain.
  app.post<{ Params: { id: string } }>('/api/attempts/:id/life', attemptLimit, async (req) => attempts.quoteLife(requireUser(req), req.params.id));

  // The bonus life's transaction; the voyage carries on once the server has confirmed it.
  app.post<{ Params: { id: string } }>('/api/attempts/:id/life/payment', attemptLimit, async (req) => {
    const body = parse(z.object({ txHash: z.string().optional() }), req.body ?? {});
    return attempts.reportLifePayment(requireUser(req), req.params.id, body.txHash);
  });

  app.post<{ Params: { id: string } }>('/api/attempts/:id/restore', attemptLimit, async (req) => {
    const who = requireUser(req);
    return attempts.restore(who, req.params.id, { admin: false, note: 'player self-service: no contact after start' });
  });

  // -------------------------------------------------------------- admin

  app.get('/api/admin/overview', async (req) => {
    requireAdmin(req);
    // Flagged runs, plus counted runs that carry anomaly flags and have not been reviewed yet.
    const flagged = (
      await db.query<AttemptRow>(
        `select * from attempts
          where status = 'flagged'
             or (status in ('verified', 'abandoned') and reviewed_at is null and week_id >= $1
                 and exists (select 1 from jsonb_array_elements(flags) f where f->>'severity' = 'review'))
          order by score desc nulls last limit 100`,
        [competitions.currentWeekId() - 2],
      )
    ).rows;
    const abandoned = (await db.query<AttemptRow>("select * from attempts where status = 'abandoned' order by created_at desc limit 50")).rows;
    const weekRows = (await db.query<{ week_id: number }>('select week_id from competitions order by week_id desc limit 8')).rows;
    const weeks = [];
    for (const w of weekRows) {
      const c = (await competitions.get(w.week_id))!;
      const vw = await chain.vaultWeek(w.week_id).catch(() => null);
      weeks.push({
        weekId: w.week_id,
        status: c.status,
        startsAt: c.starts_at.toISOString(),
        endsAt: c.ends_at.toISOString(),
        wifAllocated: vw?.wifAllocated.toString() ?? '0',
        wifConverted: vw?.wifConverted.toString() ?? '0',
        fesPool: vw?.fesPool.toString() ?? '0',
        winners: c.winners ?? (await settlement.winners(w.week_id)),
        finalizeTx: c.finalize_tx,
        blockers: await settlement.blockers(w.week_id),
      });
    }
    const audit = (
      await db.query<{ at: Date; actor: string; action: string; detail: unknown }>('select at, actor, action, detail from audit_log order by id desc limit 60')
    ).rows.map((r) => ({ at: r.at.toISOString(), actor: r.actor, action: r.action, detail: JSON.stringify(r.detail) }));
    const cursor = await indexer.cursor();
    return {
      flagged: flagged.map((r) => ({ ...toView(r), player: r.player })),
      abandoned: abandoned.map((r) => ({ ...toView(r), player: r.player })),
      weeks,
      settlerAddress: chain.settlerAddress,
      pricerAddress: chain.pricerAddress,
      pricing: { ...pricing.info(), lastError: pricing.lastError, lastUpdateAt: pricing.lastUpdateAt?.toISOString() ?? null },
      indexer: { lastBlock: cursor?.toString() ?? null, lastRunAt: indexer.lastRunAt?.toISOString() ?? null },
      practice: await practice.weekSummary(competitions.currentWeekId()),
      audit,
    };
  });

  app.post<{ Params: { id: string } }>('/api/admin/attempts/:id/review', async (req) => {
    const who = requireAdmin(req);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).default('') }), req.body);
    await attempts.review(who, req.params.id, body.decision, body.note);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/attempts/:id/restore', async (req) => {
    const who = requireAdmin(req);
    const body = parse(z.object({ note: z.string().min(3).max(500) }), req.body);
    await attempts.restore(who, req.params.id, { admin: true, note: body.note });
    return { ok: true };
  });

  const weekParam = (req: FastifyRequest<{ Params: { id: string } }>) => parse(z.coerce.number().int().min(0), req.params.id);

  app.post<{ Params: { id: string } }>('/api/admin/weeks/:id/close', async (req) => {
    const who = requireAdmin(req);
    await settlement.close(weekParam(req), who.toLowerCase());
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/weeks/:id/convert', async (req) => {
    const who = requireAdmin(req);
    const body = parse(z.object({ minFesOut: z.string().regex(/^\d+$/).optional() }), req.body ?? {});
    const txHash = await settlement.convert(weekParam(req), who.toLowerCase(), body.minFesOut ? BigInt(body.minFesOut) : undefined);
    return { txHash };
  });

  app.post<{ Params: { id: string } }>('/api/admin/weeks/:id/finalize', async (req) => {
    const who = requireAdmin(req);
    return { txHash: await settlement.finalize(weekParam(req), who.toLowerCase()) };
  });

  app.post<{ Params: { id: string } }>('/api/admin/weeks/:id/payout', async (req) => {
    const who = requireAdmin(req);
    return { txHashes: await settlement.payout(weekParam(req), who.toLowerCase()) };
  });

  app.post('/api/admin/pricing/run', async (req) => {
    requireAdmin(req);
    const out = await pricing.run();
    return out.updated
      ? { updated: true, txHash: out.txHash, entryFee: out.entryFee.toString(), extraLifeFee: out.extraLifeFee.toString(), wifUsd: out.quote.wifUsd }
      : { updated: false, reason: out.reason, wifUsd: out.quote?.wifUsd ?? null };
  });

  app.post('/api/admin/indexer/sync', async (req) => {
    requireAdmin(req);
    return { ok: true, credited: await indexer.run() };
  });

  app.addHook('onClose', async () => events.close());
  return app;
}
