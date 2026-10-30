import { InputRecorder, LookaheadBot, Simulation } from '@fes/game-core';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEYS, authed, backdate, setup, signIn, startRanked, submitRun, type Harness, type PlayedRun } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.close();
});

const alice = privateKeyToAccount(KEYS[0]);
const bob = privateKeyToAccount(KEYS[1]);

/** Sail until the ship is lost, take the bonus life there, and sail on until it is lost again. */
function playWithLife(seed: string): PlayedRun & { lostAt: number } {
  const sim = new Simulation(seed);
  const bot = new LookaheadBot({ seed, reactionTicks: 24, replanTicks: 15, horizonTicks: 54, margin: 0, viewRadius: 520, blunderRate: 0.08 });
  const rec = new InputRecorder();
  let lostAt = -1;
  for (;;) {
    while (!sim.over) {
      const s = bot.decide(sim);
      rec.record(sim.tick + 1, s);
      sim.step(s);
    }
    if (lostAt >= 0 || !sim.canRevive) break;
    lostAt = sim.tick;
    sim.revive();
    rec.revive(lostAt);
  }
  return { inputs: rec.events, endTick: sim.tick, score: sim.score, finalHash: sim.stateHash(), checkpoints: [...sim.checkpointHashes], completed: sim.over, lostAt };
}

async function buyLife(token: string, id: string, player = alice) {
  const quote = await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/life`, headers: authed(token), payload: {} });
  expect(quote.statusCode).toBe(200);
  const tx = h.chain.buyLife(player.address, quote.json().entryId);
  h.chain.confirm();
  return { quote: quote.json(), tx };
}

describe('the bonus life', () => {
  it('is quoted, paid onchain, confirmed by the server, and the revived voyage is verified', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const attempt = await h.services.attempts.get(id);

    const quote = (await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/life`, headers: authed(t), payload: {} })).json();
    expect(quote.entryId).toBe(attempt!.entry_id);
    expect(quote.extraLifeFee).toBe((500n * 10n ** 18n).toString());
    expect(quote.paid).toBe(false);

    // An unknown hash is pending; a mined but unconfirmed one too; a confirmed one lets the voyage carry on.
    const unknown = await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/life/payment`, headers: authed(t), payload: { txHash: `0x${'ab'.repeat(32)}` } });
    expect(unknown.json().status).toBe('pending');
    const tx = h.chain.buyLife(alice.address, quote.entryId);
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/life/payment`, headers: authed(t), payload: { txHash: tx } })).json().status).toBe('pending');
    h.chain.confirm();
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/life/payment`, headers: authed(t), payload: { txHash: tx } })).json().status).toBe('confirmed');

    // One bonus life per voyage.
    const again = await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/life`, headers: authed(t), payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('life_used');

    const run = playWithLife(seed);
    expect(run.lostAt).toBeGreaterThan(0);
    await backdate(h, id, run.endTick / 60 + 3);
    const res = (await submitRun(h, t, id, run)).json();
    expect(res.status).toBe('verified');
    expect(res.score).toBe(run.score);

    const comp = (await h.app.inject({ method: 'GET', url: '/api/competition/current' })).json();
    expect(comp.entries).toBe(1);
    expect(comp.extraLives).toBe(1);
    expect(comp.wifCollected).toBe((510n * 10n ** 18n).toString());
    expect(comp.wifRewardAllocation).toBe((255n * 10n ** 18n).toString());
  });

  it('rejects a voyage that carried on after a loss without paying for the bonus life', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const run = playWithLife(seed);
    await backdate(h, id, run.endTick / 60 + 3);
    const res = (await submitRun(h, t, id, run)).json();
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('bonus_life_not_paid');
  });

  it('only counts a bonus life bought by the voyage’s own wallet, for its own entry', async () => {
    const t = await signIn(h.app, alice);
    const tb = await signIn(h.app, bob);
    const mine = await startRanked(h, t, alice);
    const theirs = await startRanked(h, tb, bob);

    // Bob buys a bonus life for his own voyage and offers that transaction as Alice's.
    const { tx } = await buyLife(tb, theirs.id, bob);
    const stolen = await h.app.inject({ method: 'POST', url: `/api/attempts/${mine.id}/life/payment`, headers: authed(t), payload: { txHash: tx } });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error).toBe('payment_invalid');
    // Nor can anyone ask about another explorer's voyage.
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${theirs.id}/life`, headers: authed(t), payload: {} })).statusCode).toBe(404);
  });

  it('is only sold while the voyage is under way', async () => {
    const t = await signIn(h.app, alice);
    const created = (await h.app.inject({ method: 'POST', url: '/api/attempts', headers: authed(t), payload: {} })).json();
    const r = await h.app.inject({ method: 'POST', url: `/api/attempts/${created.attempt.id}/life`, headers: authed(t), payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('not_running');
  });

  it('is recorded by the indexer even if the browser never reports it', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    await buyLife(t, id);
    h.chain.confirm(3);
    await h.services.indexer.run();
    // The payment is known, so the voyage may carry on without its transaction hash.
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/life/payment`, headers: authed(t), payload: {} })).json().status).toBe('confirmed');
    const run = playWithLife(seed);
    await backdate(h, id, run.endTick / 60 + 3);
    expect((await submitRun(h, t, id, run)).json().status).toBe('verified');
  });

  it('does not hold the time spent paying against the voyage', async () => {
    const t = await signIn(h.app, alice);
    const { id, seed } = await startRanked(h, t, alice);
    const { tx } = await buyLife(t, id);
    expect((await h.app.inject({ method: 'POST', url: `/api/attempts/${id}/life/payment`, headers: authed(t), payload: { txHash: tx } })).json().status).toBe('confirmed');
    const run = playWithLife(seed);
    // Five minutes passed between the loss and the confirmed payment.
    const pause = 300;
    await backdate(h, id, run.endTick / 60 + pause + 3);
    await h.services.db.query(
      `update attempts set life_offered_at = started_at + ($2 || ' seconds')::interval, revived_at = started_at + ($3 || ' seconds')::interval where id = $1`,
      [id, String(run.lostAt / 60), String(run.lostAt / 60 + pause)],
    );
    const res = (await submitRun(h, t, id, run)).json();
    expect(res.status).toBe('verified');
    const a = await h.services.attempts.get(id);
    expect(a?.flags.map((f) => f.code)).not.toContain('clock_gap');
  });
});
