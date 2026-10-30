import { CHECKPOINT_TICKS, encodeInputs, InputRecorder, LookaheadBot, Simulation, type InputEvent } from '@fes/game-core';
import type { FastifyInstance } from 'fastify';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { loadConfig } from '../src/config';
import { createServer, createServices, type Services } from '../src/container';
import { connectPglite, migrate } from '../src/db';
import { FakeChain } from './fake-chain';

export const ADMIN_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
export const KEYS = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
] as const;

export interface Harness {
  app: FastifyInstance;
  services: Services;
  chain: FakeChain;
  close(): Promise<void>;
}

export async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const admin = privateKeyToAccount(ADMIN_KEY);
  const cfg = loadConfig({
    CHAIN_ID: '31337',
    WEB_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: 'test-secret-test-secret-test-secret-0123',
    ADMIN_ADDRESSES: admin.address,
    REVIEW_TOP_N: '10',
    ...env,
  } as NodeJS.ProcessEnv);
  const db = await connectPglite();
  await migrate(db);
  const chain = new FakeChain();
  const services = await createServices(cfg, { db, chain });
  const app = await createServer({ ...cfg, LOG_LEVEL: '' } as never, services);
  return {
    app,
    services,
    chain,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export async function signIn(app: FastifyInstance, account: PrivateKeyAccount): Promise<string> {
  const { nonce } = (await app.inject({ method: 'GET', url: '/api/auth/nonce' })).json();
  const message = createSiweMessage({
    address: account.address,
    chainId: 31337,
    domain: 'localhost:3000',
    uri: 'http://localhost:3000',
    nonce,
    version: '1',
    issuedAt: new Date(),
  });
  const signature = await account.signMessage({ message });
  const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message, signature } });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.body}`);
  return res.json().token;
}

export function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

export interface PlayedRun {
  inputs: InputEvent[];
  endTick: number;
  score: number;
  finalHash: string;
  checkpoints: string[];
  completed: boolean;
}

/** Play a run on the seed with a fallible navigator, until it is lost or `maxTicks` elapse. */
export function playRun(seed: string, opts: { maxTicks?: number; skill?: 'novice' | 'good' | 'expert' } = {}): PlayedRun {
  const sim = new Simulation(seed);
  const bot =
    opts.skill === 'expert'
      ? new LookaheadBot({ seed, reactionTicks: 6, replanTicks: 6, horizonTicks: 96, margin: 6 })
      : opts.skill === 'good'
        ? new LookaheadBot({ seed, reactionTicks: 10, replanTicks: 8, horizonTicks: 80, blunderRate: 0.01 })
        : new LookaheadBot({ seed, reactionTicks: 24, replanTicks: 15, horizonTicks: 54, margin: 0, viewRadius: 520, blunderRate: 0.08 });
  const rec = new InputRecorder();
  const max = opts.maxTicks ?? 60 * 60 * 30;
  while (!sim.over && sim.tick < max) {
    const s = bot.decide(sim);
    rec.record(sim.tick + 1, s);
    sim.step(s);
  }
  return { inputs: rec.events, endTick: sim.tick, score: sim.score, finalHash: sim.stateHash(), checkpoints: [...sim.checkpointHashes], completed: sim.over };
}

/** Pretend the attempt started `seconds` ago (tests can't wait for real time to pass). */
export async function backdate(h: Harness, attemptId: string, seconds: number): Promise<void> {
  await h.services.db.query(`update attempts set started_at = now() - ($2 || ' seconds')::interval where id = $1`, [attemptId, String(seconds)]);
}

/** Reserve → pay (fake chain) → report → start. Returns the attempt id and seed. */
export async function startRanked(h: Harness, token: string, account: PrivateKeyAccount): Promise<{ id: string; seed: string }> {
  const created = (await h.app.inject({ method: 'POST', url: '/api/attempts', headers: authed(token), payload: {} })).json();
  const tx = h.chain.pay(account.address, created.attempt.attemptRef);
  h.chain.confirm();
  const paid = await h.app.inject({ method: 'POST', url: `/api/attempts/${created.attempt.id}/payment`, headers: authed(token), payload: { txHash: tx } });
  if (paid.json().attempt.status !== 'paid') throw new Error(`payment not credited: ${paid.body}`);
  const started = await h.app.inject({ method: 'POST', url: `/api/attempts/${created.attempt.id}/start`, headers: authed(token), payload: {} });
  if (started.statusCode !== 200) throw new Error(`start failed: ${started.body}`);
  return { id: created.attempt.id, seed: started.json().seed };
}

export async function submitRun(h: Harness, token: string, id: string, run: PlayedRun, overrides: Partial<{ claimedScore: number; endTick: number; inputs: number[] }> = {}) {
  return h.app.inject({
    method: 'POST',
    url: `/api/attempts/${id}/submit`,
    headers: authed(token),
    payload: {
      endTick: overrides.endTick ?? run.endTick,
      inputs: overrides.inputs ?? encodeInputs(run.inputs),
      claimedScore: overrides.claimedScore ?? run.score,
      finalHash: run.finalHash,
      checkpoints: run.checkpoints,
    },
  });
}

export { CHECKPOINT_TICKS, encodeInputs };
