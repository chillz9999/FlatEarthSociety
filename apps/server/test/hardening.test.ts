import { weekEndMs, weekIdAt } from '@fes/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { ADMIN_KEY, KEYS, authed, backdate, encodeInputs, playRun, setup, signIn, startRanked, submitRun, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.close();
});

const alice = privateKeyToAccount(KEYS[0]);
const admin = privateKeyToAccount(ADMIN_KEY);

/** Reserve and pay for an attempt without starting it. */
async function paidAttempt(token: string): Promise<string> {
  const created = (await h.app.inject({ method: 'POST', url: '/api/attempts', headers: authed(token), payload: {} })).json();
  // Force a fresh reservation each time (the API reuses a recent unpaid one).
  const tx = h.chain.pay(alice.address, created.attempt.attemptRef);
  h.chain.confirm();
  const r = (await h.app.inject({ method: 'POST', url: `/api/attempts/${created.attempt.id}/payment`, headers: authed(token), payload: { txHash: tx } })).json();
  expect(r.attempt.status).toBe('paid');
  return created.attempt.id;
}

describe('race conditions', () => {
  it('a player never has more than one run in progress, however starts interleave', async () => {
    const t = await signIn(h.app, alice);
    const ids = [await paidAttempt(t), await paidAttempt(t), await paidAttempt(t)];
    const res = await Promise.all(ids.map((id) => h.app.inject({ method: 'POST', url: `/api/attempts/${id}/start`, headers: authed(t), payload: {} })));
    expect(res.every((r) => r.statusCode === 200 || r.json().error === 'attempt_in_progress')).toBe(true);
    const rows = (await h.services.db.query<{ status: string }>('select status from attempts where id = any($1::uuid[])', [ids])).rows;
    expect(rows.filter((r) => r.status === 'started')).toHaveLength(1);
    // Every other seed that was issued is consumed (superseded), not left playable.
    expect(rows.filter((r) => r.status === 'paid').length + rows.filter((r) => r.status === 'abandoned').length).toBe(2);
    // The database refuses a second run in progress outright.
    await expect(h.services.db.query("update attempts set status = 'started' where id = any($1::uuid[])", [ids])).rejects.toThrow();
  });

  it('concurrent restorations cannot exceed the allowance', async () => {
    const t = await signIn(h.app, alice);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await startRanked(h, t, alice);
      ids.push(id);
    }
    // All but the last were superseded with no contact; finalize the last too.
    await backdate(h, ids[2], 60 * 60);
    await h.services.attempts.sweepAbandoned();
    const res = await Promise.all(ids.map((id) => h.app.inject({ method: 'POST', url: `/api/attempts/${id}/restore`, headers: authed(t), payload: {} })));
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });
});

describe('runs that are never submitted', () => {
  it('are held for review when real time is unaccounted for, like a submission', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const run = playRun(seed);
    // The run was played with a long pause: 10 minutes of real time more than simulated.
    await backdate(h, id, run.endTick / 60 + 600);
    const cp = await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/checkpoint`, headers: authed(t), payload: { tick: run.endTick, inputs: encodeInputs(run.inputs), checkpoints: [] } });
    expect(cp.statusCode).toBe(200);
    await backdate(h, id, 60 * 60);
    await h.services.db.query("update attempts set checkpoint_at = started_at + interval '20 minutes' where id = $1", [id]);
    await h.services.attempts.sweepAbandoned();
    const a = await h.services.attempts.get(id);
    expect(a?.status).toBe('flagged');
    expect(a?.flags.map((f) => f.code)).toContain('clock_gap');
    expect((await h.app.inject({ method: 'GET', url: '/api/leaderboard' })).json().entries).toHaveLength(0);
  });

  it('a run the Society never heard from does not rank', async () => {
    const t = await signIn(h.app, alice);
    const { id } = await startRanked(h, t, alice);
    await backdate(h, id, 60 * 60);
    await h.services.attempts.sweepAbandoned();
    const a = await h.services.attempts.get(id);
    expect(a?.status).toBe('abandoned');
    expect(a?.score).toBeNull();
    expect((await h.app.inject({ method: 'GET', url: '/api/leaderboard' })).json().entries).toHaveLength(0);
  });

  it('checkpoints cannot insert events before an earlier checkpoint', async () => {
    const t = await signIn(h.app, alice);
    const { id } = await startRanked(h, t, alice);
    await backdate(h, id, 120);
    const first = await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/checkpoint`, headers: authed(t), payload: { tick: 3000, inputs: encodeInputs([[100, 1]]), checkpoints: [] } });
    expect(first.statusCode).toBe(200);
    const rewrite = await h.app.inject({
      method: 'POST',
      url: `/api/attempts/${id}/checkpoint`,
      headers: authed(t),
      payload: { tick: 3300, inputs: encodeInputs([[100, 1], [500, 0]]), checkpoints: [] },
    });
    expect(rewrite.statusCode).toBe(409);
    const extend = await h.app.inject({
      method: 'POST',
      url: `/api/attempts/${id}/checkpoint`,
      headers: authed(t),
      payload: { tick: 3300, inputs: encodeInputs([[100, 1], [3100, 0]]), checkpoints: [] },
    });
    expect(extend.statusCode).toBe(200);
  });
});

describe('settlement review gates', () => {
  it('a flagged run in the prize positions blocks finalization until reviewed', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const run = playRun(seed);
    await backdate(h, id, run.endTick / 60 + 3);
    await submitRun(h, t, id, run);
    // Simulate a run that verified while ranking low, carrying a review flag, and has since risen to first.
    const weekId = weekIdAt(Date.now());
    await h.services.db.query(`update attempts set flags = '[{"code":"robotic_taps","severity":"review","detail":"x"}]'::jsonb, week_id = $2 where id = $1`, [id, weekId - 1]);
    await h.services.competitions.ensureWeek(weekId - 1);
    h.services.board.invalidate();
    await h.services.settlement.advanceWeeks(weekEndMs(weekId - 1) + 41 * 60_000);
    const blockers = await h.services.settlement.blockers(weekId - 1);
    expect(blockers.join(' ')).toMatch(/carries anomaly flags/);

    const ta = await signIn(h.app, admin);
    const overview = (await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: authed(ta) })).json();
    expect(overview.flagged.map((f: { id: string }) => f.id)).toContain(id);
    await h.app.inject({ method: 'POST', url: `/api/admin/attempts/${id}/review`, headers: authed(ta), payload: { decision: 'approve', note: 'watched the replay' } });
    expect(await h.services.settlement.blockers(weekId - 1)).toEqual([]);
    expect((await h.services.attempts.get(id))?.status).toBe('verified');
  });
});

describe('configuration', () => {
  it('never falls back to a public session secret', () => {
    expect(() => loadConfig({ SESSION_SECRET: 'change-me-to-a-long-random-string' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({ SESSION_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
    const a = loadConfig({} as NodeJS.ProcessEnv).SESSION_SECRET;
    const b = loadConfig({} as NodeJS.ProcessEnv).SESSION_SECRET;
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });
});
