import { weekEndMs, weekIdAt } from '@fes/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeEntryId } from '../src/services/attempts';
import { ADMIN_KEY, KEYS, authed, setup, signIn, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.close();
});

const admin = privateKeyToAccount(ADMIN_KEY);
const players = KEYS.map((k) => privateKeyToAccount(k));

/** Seed a finished week directly: payments onchain (fake) plus verified scores in the database. */
async function seedPastWeek(scores: number[]): Promise<number> {
  const weekId = weekIdAt(Date.now()) - 1;
  await h.services.competitions.ensureWeek(weekId);
  for (let i = 0; i < scores.length; i++) {
    const p = players[i];
    const ref = `0x${(i + 1).toString(16).padStart(64, '0')}` as `0x${string}`;
    h.chain.pay(p.address, ref, { weekId });
    await h.services.db.query('insert into players (address) values ($1) on conflict do nothing', [p.address.toLowerCase()]);
    await h.services.db.query(
      `insert into attempts (id, player, attempt_ref, entry_id, status, week_id, score, evidence, survival_ms, verified_at, started_at)
       values (gen_random_uuid(), $1, $2, $3, 'verified', $4, $5, 1, 60000, now() - ($6 || ' minutes')::interval, now())`,
      [p.address.toLowerCase(), ref, computeEntryId(p.address, ref).toLowerCase(), weekId, scores[i], String(100 - i)],
    );
  }
  h.chain.confirm(5);
  await h.services.indexer.run();
  return weekId;
}

describe('weekly settlement', () => {
  it('closes, converts at the published rate, finalizes 50/30/20 and pays the top three', async () => {
    const weekId = await seedPastWeek([5000, 9000, 7000, 3000]);
    await h.services.settlement.advanceWeeks(weekEndMs(weekId) + 41 * 60_000);
    expect((await h.services.competitions.get(weekId))?.status).toBe('closed');

    const ta = await signIn(h.app, admin);
    const fin = await h.app.inject({ method: 'POST', url: `/api/admin/weeks/${weekId}/finalize`, headers: authed(ta), payload: {} });
    expect(fin.statusCode).toBe(200);
    const vw = await h.chain.vaultWeek(weekId);
    // 4 entries × 10 WIF × 50% = 20 WIF → ×2 FES/WIF = 40 FES.
    expect(vw.fesPool).toBe(40n * 10n ** 18n);
    expect(vw.winners.map((w) => w.toLowerCase())).toEqual([players[1], players[2], players[0]].map((p) => p.address.toLowerCase()));
    expect(vw.amounts).toEqual([20n * 10n ** 18n, 12n * 10n ** 18n, 8n * 10n ** 18n]);

    // Replayed settlement is refused.
    await expect(h.chain.finalizeWeek(weekId, vw.winners)).rejects.toThrow();

    const pay = await h.app.inject({ method: 'POST', url: `/api/admin/weeks/${weekId}/payout`, headers: authed(ta), payload: {} });
    expect(pay.json().txHashes).toHaveLength(3);
    expect((await h.services.competitions.get(weekId))?.status).toBe('settled');
    // Paying again does nothing.
    expect((await h.app.inject({ method: 'POST', url: `/api/admin/weeks/${weekId}/payout`, headers: authed(ta), payload: {} })).json().txHashes).toHaveLength(0);

    const hall = (await h.app.inject({ method: 'GET', url: '/api/hall' })).json();
    expect(hall[0].weekId).toBe(weekId);
    expect(hall[0].winners.map((w: { title: string }) => w.title)).toEqual(['Grand Cartographer', 'Master Navigator', 'Distinguished Fellow']);
    expect(hall[0].winners.every((w: { claimTx: string | null }) => w.claimTx)).toBe(true);

    const treasury = (await h.app.inject({ method: 'GET', url: '/api/treasury' })).json();
    expect(treasury.totals.fesAwarded).toBe((40n * 10n ** 18n).toString());
    expect(treasury.history[0].conversions).toHaveLength(1);
    expect(treasury.disclosure.settlementRules.length).toBeGreaterThan(3);
  });

  it('rolls unassigned shares into the next week when fewer than three explorers rank', async () => {
    const weekId = await seedPastWeek([4000]);
    await h.services.settlement.advanceWeeks(weekEndMs(weekId) + 41 * 60_000);
    await h.services.settlement.settle(weekId, 'test');
    const vw = await h.chain.vaultWeek(weekId);
    expect(vw.amounts[0]).toBe(5n * 10n ** 18n);
    expect((await h.chain.vaultWeek(weekId + 1)).fesPool).toBe(5n * 10n ** 18n);
  });

  it('will not finalize while a flagged run could change the top three', async () => {
    const weekId = await seedPastWeek([5000, 4000, 3000]);
    await h.services.db.query("update attempts set status = 'flagged', score = 8000 where player = $1", [players[2].address.toLowerCase()]);
    h.services.board.invalidate();
    await h.services.settlement.advanceWeeks(weekEndMs(weekId) + 41 * 60_000);
    expect((await h.services.settlement.blockers(weekId)).length).toBe(1);
    await expect(h.services.settlement.finalize(weekId, 'test')).rejects.toThrow(/awaits review/);
  });

  it('keeps the current week open and refuses to close it early', async () => {
    const current = weekIdAt(Date.now());
    await h.services.settlement.advanceWeeks();
    expect((await h.services.competitions.get(current))?.status).toBe('open');
    await expect(h.services.settlement.close(current, 'test')).rejects.toThrow(/not ended/);
  });
});
