import { encodeInputs } from '@fes/game-core';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEYS, authed, playRun, setup, signIn, type Harness, type PlayedRun } from './helpers';

const [alice, bob] = KEYS.map((k) => privateKeyToAccount(k));

async function name(h: Harness, token: string, displayName: string) {
  return h.app.inject({ method: 'POST', url: '/api/players/me/name', headers: authed(token), payload: { displayName } });
}

async function startPractice(h: Harness, token: string) {
  return h.app.inject({ method: 'POST', url: '/api/practice', headers: authed(token), payload: {} });
}

async function submitPractice(h: Harness, token: string, id: string, run: PlayedRun) {
  return h.app.inject({
    method: 'POST',
    url: `/api/practice/${id}/submit`,
    headers: authed(token),
    payload: { endTick: run.endTick, inputs: encodeInputs(run.inputs), claimedScore: run.score, finalHash: run.finalHash, checkpoints: run.checkpoints },
  });
}

/** Pretend the voyage started `seconds` ago (tests can't wait for real time to pass). */
async function backdate(h: Harness, id: string, seconds: number) {
  await h.services.db.query(`update practice_runs set started_at = now() - ($2 || ' seconds')::interval where id = $1`, [id, String(seconds)]);
}

describe('explorer names', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => h.close());

  it('are unique regardless of case, and can be changed', async () => {
    const a = await signIn(h.app, alice);
    const b = await signIn(h.app, bob);
    expect((await name(h, a, 'Capt. Meridian')).statusCode).toBe(200);
    const taken = await name(h, b, 'capt. meridian');
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('name_taken');
    // Renaming frees the old name.
    expect((await name(h, a, 'Admiral Flat')).statusCode).toBe(200);
    expect((await name(h, b, 'Capt. Meridian')).statusCode).toBe(200);
    const stats = (await h.app.inject({ method: 'GET', url: `/api/players/${bob.address}` })).json();
    expect(stats.displayName).toBe('Capt. Meridian');
  });

  it('must be a real name', async () => {
    const a = await signIn(h.app, alice);
    for (const bad of ['ab', '0xdeadbeef', 'x'.repeat(25), '<script>', '']) {
      expect((await name(h, a, bad)).statusCode, bad).toBe(400);
    }
  });
});

describe('practice voyages', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => h.close());

  it('can be started by a guest and claimed when the explorer adds a name', async () => {
    const guest = (await h.app.inject({ method: 'POST', url: '/api/practice', payload: {} })).json();
    expect(guest.runId).toBeTruthy();
    const run = playRun(guest.seed, { skill: 'novice' });
    await backdate(h, guest.runId, run.endTick / 60 + 5);
    // Recording needs a signed-in explorer with a name.
    const body = { endTick: run.endTick, inputs: encodeInputs(run.inputs), claimedScore: run.score, finalHash: run.finalHash, checkpoints: run.checkpoints };
    expect((await h.app.inject({ method: 'POST', url: `/api/practice/${guest.runId}/submit`, payload: body })).statusCode).toBe(401);
    const a = await signIn(h.app, alice);
    const unnamed = await submitPractice(h, a, guest.runId, run);
    expect(unnamed.statusCode).toBe(403);
    expect(unnamed.json().error).toBe('needs_name');
    expect((await h.app.inject({ method: 'GET', url: '/api/players/name-available?name=Capt.%20Meridian' })).json().available).toBe(true);
    await name(h, a, 'Capt. Meridian');
    expect((await h.app.inject({ method: 'GET', url: '/api/players/name-available?name=capt.%20meridian' })).json().available).toBe(false);
    const claimed = await submitPractice(h, a, guest.runId, run);
    expect(claimed.json().status).toBe('verified');
    expect(claimed.json().rank).toBe(1);
    // Once claimed, it is nobody else's.
    const b = await signIn(h.app, bob);
    await name(h, b, 'Admiral Flat');
    expect((await submitPractice(h, b, guest.runId, run)).statusCode).toBe(404);
    const board = (await h.app.inject({ method: 'GET', url: '/api/practice/leaderboard' })).json();
    expect(board.entries.map((e: { displayName: string }) => e.displayName)).toEqual(['Capt. Meridian']);
  });

  it('are replayed, logged and ranked on the practice board, never on the Registry', async () => {
    const a = await signIn(h.app, alice);
    const b = await signIn(h.app, bob);
    await name(h, a, 'Capt. Meridian');
    await name(h, b, 'Admiral Flat');

    const scores: Record<string, number> = {};
    for (const [token, skill, who] of [
      [a, 'good', alice.address],
      [b, 'novice', bob.address],
    ] as const) {
      const started = (await startPractice(h, token)).json();
      const run = playRun(started.seed, { skill });
      await backdate(h, started.runId, run.endTick / 60 + 5);
      const res = await submitPractice(h, token, started.runId, run);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('verified');
      expect(body.score).toBe(run.score);
      expect(body.personalBest).toBe(run.score);
      expect(body.rank).toBeGreaterThanOrEqual(1);
      scores[who.toLowerCase()] = run.score;
    }
    expect(Object.keys(scores)).toHaveLength(2);

    const board = (await h.app.inject({ method: 'GET', url: '/api/practice/leaderboard' })).json();
    expect(board.entries.map((e: { address: string }) => e.address).sort()).toEqual(Object.keys(scores).sort());
    expect(board.entries[0].displayName).toMatch(/Capt\. Meridian|Admiral Flat/);
    const sorted = [...board.entries].sort((x: { score: number }, y: { score: number }) => y.score - x.score);
    expect(board.entries).toEqual(sorted);

    // Practice never touches the prize Registry.
    expect((await h.app.inject({ method: 'GET', url: '/api/leaderboard' })).json().entries).toEqual([]);
    const stats = (await h.app.inject({ method: 'GET', url: `/api/players/${alice.address}` })).json();
    expect(stats.practiceRuns).toBe(1);
    expect(stats.practiceBest).toBe(scores[alice.address.toLowerCase()]);
  });

  it('rejects voyages faster than the clock and claims that do not match the replay', async () => {
    const a = await signIn(h.app, alice);
    await name(h, a, 'Capt. Meridian');

    const fast = (await startPractice(h, a)).json();
    const run = playRun(fast.seed, { skill: 'expert', maxTicks: 60 * 60 });
    const res = (await submitPractice(h, a, fast.runId, run)).json();
    expect(run.endTick / 60).toBeGreaterThan(10);
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('faster_than_real_time');

    const forged = (await startPractice(h, a)).json();
    const real = playRun(forged.seed, { skill: 'novice' });
    await backdate(h, forged.runId, real.endTick / 60 + 5);
    const lie = await submitPractice(h, a, forged.runId, { ...real, score: real.score + 5000 });
    expect(lie.json().status).toBe('rejected');
    expect((await h.app.inject({ method: 'GET', url: '/api/practice/leaderboard' })).json().entries).toEqual([]);
  });

  it('starting another voyage gives up the unfinished one, and nobody can submit for someone else', async () => {
    const a = await signIn(h.app, alice);
    const b = await signIn(h.app, bob);
    await name(h, a, 'Capt. Meridian');
    const first = (await startPractice(h, a)).json();
    const second = (await startPractice(h, a)).json();
    const run = playRun(first.seed, { skill: 'novice', maxTicks: 60 * 60 });
    await backdate(h, first.runId, run.endTick / 60 + 5);
    expect((await submitPractice(h, a, first.runId, run)).statusCode).toBe(409);
    expect((await submitPractice(h, b, second.runId, run)).statusCode).toBe(404);
  });
});
