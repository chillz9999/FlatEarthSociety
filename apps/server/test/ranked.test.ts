import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_KEY, KEYS, authed, backdate, encodeInputs, playRun, setup, signIn, startRanked, submitRun, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.close();
});

const alice = privateKeyToAccount(KEYS[0]);
const bob = privateKeyToAccount(KEYS[1]);
const carol = privateKeyToAccount(KEYS[2]);
const admin = privateKeyToAccount(ADMIN_KEY);

describe('authentication', () => {
  it('signs in with Ethereum and rejects replayed nonces', async () => {
    const token = await signIn(h.app, alice);
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: authed(token) });
    expect(me.json().address).toBe(alice.address);
    expect(me.json().isAdmin).toBe(false);

    const { nonce } = (await h.app.inject({ method: 'GET', url: '/api/auth/nonce' })).json();
    const { createSiweMessage } = await import('viem/siwe');
    const message = createSiweMessage({ address: alice.address, chainId: 31337, domain: 'localhost:3000', uri: 'http://localhost:3000', nonce, version: '1', issuedAt: new Date() });
    const signature = await alice.signMessage({ message });
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message, signature } })).statusCode).toBe(200);
    const replay = await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message, signature } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('bad_nonce');
  });

  it('rejects signatures from another wallet, other chains and other sites', async () => {
    const { createSiweMessage } = await import('viem/siwe');
    const mk = async (over: Record<string, unknown>) => {
      const { nonce } = (await h.app.inject({ method: 'GET', url: '/api/auth/nonce' })).json();
      return createSiweMessage({ address: alice.address, chainId: 31337, domain: 'localhost:3000', uri: 'http://localhost:3000', nonce, version: '1', issuedAt: new Date(), ...over });
    };
    const forged = await mk({});
    const sigByBob = await bob.signMessage({ message: forged });
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message: forged, signature: sigByBob } })).statusCode).toBe(401);
    const otherChain = await mk({ chainId: 1 });
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message: otherChain, signature: await alice.signMessage({ message: otherChain }) } })).json().error).toBe('wrong_chain');
    const otherSite = await mk({ domain: 'evil.example' });
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message: otherSite, signature: await alice.signMessage({ message: otherSite }) } })).json().error).toBe('bad_domain');
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: authed('garbage.token') })).statusCode).toBe(401);
  });

  it('only administrators reach admin endpoints', async () => {
    const t = await signIn(h.app, alice);
    expect((await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: authed(t) })).statusCode).toBe(403);
    const a = await signIn(h.app, admin);
    expect((await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: authed(a) })).statusCode).toBe(200);
  });
});

describe('payments', () => {
  it('never credits an attempt from a client-reported hash alone', async () => {
    const t = await signIn(h.app, alice);
    const created = (await h.app.inject({ method: 'POST', url: '/api/attempts', headers: authed(t), payload: {} })).json();
    expect(created.entryFee).toBe((10n * 10n ** 18n).toString());
    const id = created.attempt.id;

    // A hash the chain has never seen: pending, not paid.
    const fake = `0x${'ab'.repeat(32)}`;
    const r1 = (await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/payment`, headers: authed(t), payload: { txHash: fake } })).json();
    expect(r1.pending).toBe(true);
    expect(r1.attempt.status).toBe('awaiting_payment');

    // Bob pays for his own reservation; Alice cannot claim Bob's transaction.
    const tb = await signIn(h.app, bob);
    const bobAttempt = (await h.app.inject({ method: 'POST', url: '/api/attempts', headers: authed(tb), payload: {} })).json();
    const bobTx = h.chain.pay(bob.address, bobAttempt.attempt.attemptRef);
    h.chain.confirm();
    const stolen = await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/payment`, headers: authed(t), payload: { txHash: bobTx } });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error).toBe('payment_invalid');

    // A reverted payment is rejected.
    const reverted = h.chain.pay(alice.address, created.attempt.attemptRef, { reverted: true });
    h.chain.confirm();
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/payment`, headers: authed(t), payload: { txHash: reverted } })).statusCode).toBe(400);

    // Unconfirmed → pending; confirmed → paid.
    const good = h.chain.pay(alice.address, created.attempt.attemptRef);
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/payment`, headers: authed(t), payload: { txHash: good } })).json().pending).toBe(true);
    h.chain.confirm();
    const ok = (await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/payment`, headers: authed(t), payload: { txHash: good } })).json();
    expect(ok.attempt.status).toBe('paid');
  });

  it('the indexer credits payments the browser never reported, exactly once', async () => {
    const t = await signIn(h.app, alice);
    const created = (await h.app.inject({ method: 'POST', url: '/api/attempts', headers: authed(t), payload: {} })).json();
    h.chain.pay(alice.address, created.attempt.attemptRef);
    // Paid straight on the contract with a reference the server never issued:
    h.chain.pay(carol.address, `0x${'cd'.repeat(32)}`);
    h.chain.confirm(5);
    expect(await h.services.indexer.run()).toBe(2);
    expect(await h.services.indexer.run()).toBe(0);
    const mine = (await h.app.inject({ method: 'GET', url: '/api/attempts/mine', headers: authed(t) })).json();
    expect(mine.available).toHaveLength(1);
    const tc = await signIn(h.app, carol);
    const carolMine = (await h.app.inject({ method: 'GET', url: '/api/attempts/mine', headers: authed(tc) })).json();
    expect(carolMine.available).toHaveLength(1);
    const comp = (await h.app.inject({ method: 'GET', url: '/api/competition/current' })).json();
    expect(comp.entries).toBe(2);
    expect(comp.wifCollected).toBe((20n * 10n ** 18n).toString());
    expect(comp.wifRewardAllocation).toBe((10n * 10n ** 18n).toString());
    expect(comp.wifProtocol).toBe((10n * 10n ** 18n).toString());
  });

  it('refuses entries while the contract is paused', async () => {
    const t = await signIn(h.app, alice);
    h.chain.paused = true;
    const r = await h.app.inject({ method: 'POST', url: '/api/attempts', headers: authed(t), payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('entries_paused');
  });
});

describe('ranked attempts', () => {
  it('verifies an honest run by replay and ranks it', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    expect(seed).toMatch(/^[0-9a-f]{32}$/);

    // Single use.
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/start`, headers: authed(t), payload: {} })).statusCode).toBe(409);

    const run = playRun(seed);
    expect(run.completed).toBe(true);
    await backdate(h, id, run.endTick / 60 + 3);
    const res = (await submitRun(h, t, id, run)).json();
    expect(res.status).toBe('verified');
    expect(res.score).toBe(run.score);
    expect(res.rank).toBe(1);
    expect(res.pointsToThird).toBe(0);

    const board = (await h.app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    expect(board.entries[0]).toMatchObject({ rank: 1, address: alice.address.toLowerCase(), score: run.score });

    // Idempotent: a repeat submission returns the recorded result and changes nothing.
    const again = (await submitRun(h, t, id, run, { claimedScore: 999999 })).json();
    expect(again.score).toBe(run.score);
  });

  it('ignores the client’s claimed score', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const run = playRun(seed);
    await backdate(h, id, run.endTick / 60 + 3);
    const res = (await submitRun(h, t, id, run, { claimedScore: run.score * 50 })).json();
    expect(res.score).toBe(run.score);
    expect(['verified', 'flagged']).toContain(res.status);
  });

  it('rejects runs longer than the real time that has passed', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    // A navigator that does not blunder outlives the calm opening, so the run is comfortably longer than the slack.
    const run = playRun(seed, { skill: 'expert', maxTicks: 60 * 60 });
    expect(run.endTick).toBeGreaterThan(60 * 20);
    // Only (run length − 10 s) of real time has passed: the run claims 10 s more than the clock allows.
    await backdate(h, id, run.endTick / 60 - 10);
    const res = (await submitRun(h, t, id, run)).json();
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('faster_than_real_time');
  });

  it('rejects fabricated inputs and other wallets’ submissions', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const run = playRun(seed);
    await backdate(h, id, run.endTick / 60 + 3);
    const tb = await signIn(h.app, bob);
    expect((await submitRun(h, tb, id, run)).statusCode).toBe(404);
    // Inputs cut short but claiming the original ending: the ship cannot have been lost at that tick.
    const cut = Math.floor(run.endTick / 2);
    const truncated = run.inputs.filter(([tick]) => tick <= cut);
    const res = (await submitRun(h, t, id, run, { inputs: encodeInputs(truncated), endTick: cut })).json();
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('run_did_not_end_at_claimed_tick');
  });

  it('scores tampered-but-valid inputs by the server’s replay, never the claim', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    // A voyage long enough that losing half its steering changes it (a two-second loss would not).
    const run = playRun(seed, { skill: 'good', maxTicks: 60 * 90 });
    await backdate(h, id, run.endTick / 60 + 3);
    // Dropping the second half of the steering produces a different (valid) voyage.
    const truncated = run.inputs.slice(0, Math.max(1, Math.floor(run.inputs.length / 2)));
    const res = (await submitRun(h, t, id, run, { inputs: encodeInputs(truncated) })).json();
    const a = await h.services.attempts.get(id);
    // Depending on the sea, the altered voyage either ends earlier (scored by the replay and
    // flagged) or outlives the claimed ending (rejected). Either way the claim is never credited.
    expect(res.score).not.toBe(run.score);
    if (res.status === 'rejected') {
      expect(res.reason).toBe('run_did_not_end_at_claimed_tick');
    } else {
      expect(a?.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['end_tick_mismatch']));
      expect(['flagged', 'verified']).toContain(res.status);
    }
  });

  it('survives a griefer reusing someone else’s attempt reference onchain', async () => {
    const t = await signIn(h.app, alice);
    const created = (await h.app.inject({ method: 'POST', url: '/api/attempts', headers: authed(t), payload: {} })).json();
    h.chain.pay(bob.address, created.attempt.attemptRef);
    h.chain.pay(alice.address, created.attempt.attemptRef);
    h.chain.confirm(5);
    expect(await h.services.indexer.run()).toBe(2);
    const mine = (await h.app.inject({ method: 'GET', url: '/api/attempts/mine', headers: authed(t) })).json();
    expect(mine.available).toHaveLength(1);
  });

  it('counts only each wallet’s best score; ties go to the earlier verification', async () => {
    const ta = await signIn(h.app, alice);
    const tb = await signIn(h.app, bob);
    const a1 = await startRanked(h, ta, alice);
    const run1 = playRun(a1.seed);
    await backdate(h, a1.id, run1.endTick / 60 + 3);
    await submitRun(h, ta, a1.id, run1);
    const a2 = await startRanked(h, ta, alice);
    const run2 = playRun(a2.seed);
    await backdate(h, a2.id, run2.endTick / 60 + 3);
    await submitRun(h, ta, a2.id, run2);

    // Bob replays Alice's exact seed and inputs (as if he had the same sea) to tie her best.
    const b1 = await startRanked(h, tb, bob);
    const best = run1.score >= run2.score ? { run: run1, seed: a1.seed } : { run: run2, seed: a2.seed };
    await h.services.db.query('update attempts set seed = $2 where id = $1', [b1.id, best.seed]);
    await backdate(h, b1.id, best.run.endTick / 60 + 3);
    await submitRun(h, tb, b1.id, best.run);

    const board = (await h.app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    expect(board.entries).toHaveLength(2);
    expect(board.entries[0].score).toBe(board.entries[1].score);
    expect(board.entries[0].address).toBe(alice.address.toLowerCase());
    expect(board.entries[1].address).toBe(bob.address.toLowerCase());
  });
});

describe('interrupted runs (attempt-restoration policy)', () => {
  it('scores an abandoned run at its last checkpoint', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const run = playRun(seed, { maxTicks: 1200 });
    await backdate(h, id, 25);
    const cp = await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/checkpoint`, headers: authed(t), payload: { tick: run.endTick, inputs: encodeInputs(run.inputs), checkpoints: run.checkpoints } });
    expect(cp.statusCode).toBe(200);
    // A checkpoint cannot rewrite history.
    const rewrite = await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/checkpoint`, headers: authed(t), payload: { tick: run.endTick + 50, inputs: [5, 1], checkpoints: [] } });
    expect(rewrite.statusCode).toBe(409);

    await backdate(h, id, 60 * 60);
    // Keep the checkpoint's arrival time consistent with the backdated start (25 s in).
    await h.services.db.query("update attempts set checkpoint_at = started_at + interval '25 seconds' where id = $1", [id]);
    expect(await h.services.attempts.sweepAbandoned()).toBe(1);
    const a = await h.services.attempts.get(id);
    expect(a?.status).toBe('abandoned');
    expect(a?.score).toBe(run.score);
    const board = (await h.app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    expect(board.entries[0].score).toBe(run.score);
  });

  it('restores an attempt the server never heard from, once per week without an admin', async () => {
    const t = await signIn(h.app, alice);
    const first = await startRanked(h, t, alice);
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${first.id}/restore`, headers: authed(t), payload: {} })).statusCode).toBe(403);
    await backdate(h, first.id, 30);
    const restored = await h.app.inject({ method: 'POST', url: `/api/attempts/${first.id}/restore`, headers: authed(t), payload: {} });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().status).toBe('paid');

    const second = await startRanked(h, t, alice);
    await backdate(h, second.id, 30);
    const denied = await h.app.inject({ method: 'POST', url: `/api/attempts/${second.id}/restore`, headers: authed(t), payload: {} });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('needs_admin');

    const ta = await signIn(h.app, admin);
    const byAdmin = await h.app.inject({ method: 'POST', url: `/api/admin/attempts/${second.id}/restore`, headers: authed(ta), payload: { note: 'support ticket #12' } });
    expect(byAdmin.statusCode).toBe(200);
    const mine = (await h.app.inject({ method: 'GET', url: '/api/attempts/mine', headers: authed(t) })).json();
    expect(mine.available).toHaveLength(2);
    const audit = (await h.services.db.query<{ action: string }>("select action from audit_log where action = 'attempt_restored'")).rows;
    expect(audit).toHaveLength(2);
  });

  it('starting a new attempt finalizes the one left running', async () => {
    const t = await signIn(h.app, alice);
    const first = await startRanked(h, t, alice);
    await startRanked(h, t, alice);
    expect((await h.services.attempts.get(first.id))?.status).toBe('abandoned');
  });
});

describe('review of suspicious runs', () => {
  it('holds a flagged top run off the Registry until an administrator approves it', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const run = playRun(seed);
    // Lots of real time unaccounted for (a ranked run cannot be paused) → review.
    await backdate(h, id, run.endTick / 60 + 600);
    const res = (await submitRun(h, t, id, run)).json();
    expect(res.status).toBe('flagged');
    expect((await h.app.inject({ method: 'GET', url: '/api/leaderboard' })).json().entries).toHaveLength(0);

    const ta = await signIn(h.app, admin);
    const overview = (await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: authed(ta) })).json();
    expect(overview.flagged.map((f: { id: string }) => f.id)).toContain(id);
    await h.app.inject({ method: 'POST', url: `/api/admin/attempts/${id}/review`, headers: authed(ta), payload: { decision: 'approve', note: 'reviewed replay' } });
    expect((await h.app.inject({ method: 'GET', url: '/api/leaderboard' })).json().entries[0].score).toBe(run.score);
  });
});
