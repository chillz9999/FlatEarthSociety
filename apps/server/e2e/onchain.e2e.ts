/**
 * End-to-end test against real contracts on a local anvil chain:
 *
 *   ./scripts/local-chain.sh                       # anvil + deploy (mock tokens)
 *   npm run e2e -w @fes/server
 *
 * The fees are re-priced onchain from a WIF price. Three players pay the
 * $WIF entry fee onchain through the API and play seeded runs that the server
 * replays and verifies; one buys a bonus life when the ship is lost and sails
 * on. Then the chain is warped past the end of the week and the Society
 * settles it: the top three are finalized onchain and paid 50/30/20 in WIF.
 * Every amount is checked against the contracts.
 */
import assert from 'node:assert/strict';
import { encodeInputs, InputRecorder, LookaheadBot, Simulation } from '@fes/game-core';
import { entryAbi, localAnvil, vaultAbi, weekEndMs, weekIdAt } from '@fes/shared';
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseEther, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { loadConfig } from '../src/config';
import { createServer, createServices } from '../src/container';
import { connectPglite, migrate } from '../src/db';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const DEPLOYMENT = process.env.DEPLOYMENT_FILE ?? new URL('../../../contracts/deployments/31337.json', import.meta.url).pathname;
// Anvil development keys (public, never use on real networks).
const SETTLER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const PLAYER_KEYS = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
] as const;

const log = (...a: unknown[]) => console.log('·', ...a);

async function main() {
  const cfg = loadConfig({
    CHAIN_ID: '31337',
    RPC_URL: RPC,
    DEPLOYMENT_FILE: DEPLOYMENT,
    SETTLER_PRIVATE_KEY: SETTLER,
    ADMIN_ADDRESSES: privateKeyToAccount(SETTLER).address,
    CONFIRMATIONS: '1',
    // $0.10 a voyage and $5 a bonus life at $0.008 a WIF: 12.5 WIF and 625 WIF.
    PRICE_FEED: 'fixed',
    WIF_USD: '0.008',
    WEB_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-01234',
  } as NodeJS.ProcessEnv);
  // E2E_PGLITE_DIR lets a local dev server reuse the resulting database (e.g. to show the Hall of Fellows).
  const db = await connectPglite(process.env.E2E_PGLITE_DIR);
  await migrate(db);
  const services = await createServices(cfg, { db });
  const app = await createServer({ ...cfg, LOG_LEVEL: '' } as never, services);
  const dep = cfg.deployment!;
  const chain = { ...localAnvil, rpcUrls: { default: { http: [RPC] } } };
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });

  // Keep the chain clock in step with ours (earlier runs may have warped it).
  const head = await pub.getBlock();
  if (Number(head.timestamp) * 1000 > Date.now() + 60_000) {
    throw new Error('The anvil clock is ahead of real time (a previous run warped it). Restart anvil and redeploy: ./scripts/local-chain.sh');
  }
  const weekId = weekIdAt(Date.now());
  log(`week ${weekId}, entry ${dep.entry}, vault ${dep.prizeVault}`);
  assert.equal(dep.wifToken.toLowerCase(), dep.fesToken.toLowerCase(), 'expected a deployment paying prizes in WIF (no FES_TOKEN)');

  // The pricer follows the market: the fees move to their dollar prices in WIF.
  const priced = await services.pricing.run();
  assert.equal(priced.updated, true, JSON.stringify(priced, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const [entryFee, lifeFee] = await Promise.all([
    pub.readContract({ address: dep.entry, abi: entryAbi, functionName: 'entryFee' }),
    pub.readContract({ address: dep.entry, abi: entryAbi, functionName: 'extraLifeFee' }),
  ]);
  assert.equal(entryFee, parseEther('12.5'));
  assert.equal(lifeFee, parseEther('625'));
  log(`re-priced: ${entryFee} WIF wei a voyage, ${lifeFee} WIF wei a bonus life`);
  const results: { address: string; score: number; tx: Hash }[] = [];

  for (const [i, key] of PLAYER_KEYS.entries()) {
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain, transport: http(RPC) });
    // Sign in.
    const { nonce } = (await app.inject({ method: 'GET', url: '/api/auth/nonce' })).json();
    const message = createSiweMessage({ address: account.address, chainId: 31337, domain: 'localhost:3000', uri: 'http://localhost:3000', nonce, version: '1', issuedAt: new Date() });
    const auth = (await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message, signature: await account.signMessage({ message }) } })).json();
    const headers = { authorization: `Bearer ${auth.token}` };

    // Reserve, approve exactly the fee, pay onchain.
    const created = (await app.inject({ method: 'POST', url: '/api/attempts', headers, payload: {} })).json();
    const fee = BigInt(created.entryFee);
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: dep.wifToken, abi: [{ type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }], functionName: 'mint', args: [account.address, parseEther('1000')] }) });
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: dep.wifToken, abi: erc20Abi, functionName: 'approve', args: [dep.entry, fee] }) });
    const tx = await wallet.writeContract({ address: dep.entry, abi: entryAbi, functionName: 'enter', args: [created.attempt.attemptRef, fee] });
    await pub.waitForTransactionReceipt({ hash: tx });
    await testClient.mine({ blocks: 2 });
    const paid = (await app.inject({ method: 'POST', url: `/api/attempts/${created.attempt.id}/payment`, headers, payload: { txHash: tx } })).json();
    assert.equal(paid.attempt.status, 'paid', `payment for player ${i} not credited: ${JSON.stringify(paid)}`);

    // Play the server-issued seed.
    const started = (await app.inject({ method: 'POST', url: `/api/attempts/${created.attempt.id}/start`, headers, payload: {} })).json();
    const sim = new Simulation(started.seed);
    const bot = new LookaheadBot({ seed: started.seed, reactionTicks: 20 - i * 6, replanTicks: 12, horizonTicks: 60 + i * 15, blunderRate: 0.05 - i * 0.015 });
    const rec = new InputRecorder();
    const sail = () => {
      while (!sim.over && sim.tick < 60 * 60 * 4) {
        const s = bot.decide(sim);
        rec.record(sim.tick + 1, s);
        sim.step(s);
      }
    };
    sail();
    // The first explorer buys the bonus life when the ship is lost, and sails on.
    if (i === 0 && sim.canRevive) {
      const quote = (await app.inject({ method: 'POST', url: `/api/attempts/${created.attempt.id}/life`, headers, payload: {} })).json();
      assert.equal(BigInt(quote.extraLifeFee), lifeFee);
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: dep.wifToken, abi: erc20Abi, functionName: 'approve', args: [dep.entry, lifeFee] }) });
      const lifeTx = await wallet.writeContract({ address: dep.entry, abi: entryAbi, functionName: 'buyExtraLife', args: [quote.entryId, lifeFee] });
      await pub.waitForTransactionReceipt({ hash: lifeTx });
      await testClient.mine({ blocks: 2 });
      const life = (await app.inject({ method: 'POST', url: `/api/attempts/${created.attempt.id}/life/payment`, headers, payload: { txHash: lifeTx } })).json();
      assert.equal(life.status, 'confirmed', JSON.stringify(life));
      const lostAt = sim.tick;
      sim.revive();
      rec.revive(lostAt);
      sail();
      log(`player ${account.address} bought a bonus life (${lifeTx}) at tick ${lostAt}`);
    }
    if (!sim.over) {
      // End the voyage at the Edge so it can be submitted as complete.
      while (!sim.over) {
        rec.record(sim.tick + 1, 0);
        sim.step(0);
      }
    }
    await db.query(`update attempts set started_at = now() - ($2 || ' seconds')::interval where id = $1`, [created.attempt.id, String(Math.ceil(sim.tick / 60) + 2)]);
    const res = (
      await app.inject({
        method: 'POST',
        url: `/api/attempts/${created.attempt.id}/submit`,
        headers,
        payload: { endTick: sim.tick, inputs: encodeInputs(rec.events), claimedScore: sim.score, finalHash: sim.stateHash(), checkpoints: sim.checkpointHashes },
      })
    ).json();
    assert.equal(res.status, 'verified', JSON.stringify(res));
    assert.equal(res.score, sim.score);
    results.push({ address: account.address.toLowerCase(), score: res.score, tx });
    log(`player ${account.address} paid (${tx}) and scored ${res.score}`);
  }

  const vaultBefore = await pub.readContract({ address: dep.prizeVault, abi: vaultAbi, functionName: 'getWeek', args: [BigInt(weekId)] });
  const comp = (await app.inject({ method: 'GET', url: '/api/competition/current' })).json();
  assert.equal(comp.extraLives, 1);
  assert.equal(BigInt(comp.wifRewardAllocation), (3n * entryFee + lifeFee) / 2n);
  // The other half was burned: sent to the dead address, out of anyone's reach.
  const burnAddress = await pub.readContract({ address: dep.entry, abi: entryAbi, functionName: 'BURN_ADDRESS' });
  assert.equal(await pub.readContract({ address: dep.entry, abi: entryAbi, functionName: 'burnsProtocolShare' }), true);
  assert.equal(await pub.readContract({ address: dep.wifToken, abi: erc20Abi, functionName: 'balanceOf', args: [burnAddress] }), (3n * entryFee + lifeFee) / 2n);
  // Paid in WIF: the whole allocation is the prize pool, with nothing to convert.
  assert.equal(vaultBefore.wifAllocated, (3n * entryFee + lifeFee) / 2n);
  assert.equal(vaultBefore.fesPool, vaultBefore.wifAllocated);
  log(`vault holds ${vaultBefore.wifAllocated} WIF wei for week ${weekId}; API reports ${comp.wifRewardAllocation} from indexed payments`);

  // Warp the chain past the end of the week, then settle.
  const target = Math.floor(weekEndMs(weekId) / 1000) + 3600;
  await testClient.setNextBlockTimestamp({ timestamp: BigInt(target) });
  await testClient.mine({ blocks: 1 });
  await services.indexer.run();
  await services.settlement.advanceWeeks(weekEndMs(weekId) + 41 * 60_000);
  const closed = await services.competitions.get(weekId);
  assert.equal(closed?.status, 'closed');

  const ranking = await services.board.ranking(weekId);
  const top = ranking.slice(0, 3).map((e) => e.address);
  const fesBefore = await Promise.all(top.map((a) => pub.readContract({ address: dep.fesToken, abi: erc20Abi, functionName: 'balanceOf', args: [a as `0x${string}`] })));

  const finalizeTx = await services.settlement.finalize(weekId, 'e2e');
  const payTxs = await services.settlement.payout(weekId, 'e2e');
  const vw = await pub.readContract({ address: dep.prizeVault, abi: vaultAbi, functionName: 'getWeek', args: [BigInt(weekId)] });
  assert.equal(vw.finalized, true);
  assert.equal(vw.wifConverted, vw.wifAllocated);
  const pool = vw.fesPool;
  const expected = [(pool * 5000n) / 10000n, (pool * 3000n) / 10000n];
  expected.push(pool - expected[0] - expected[1]);
  for (let r = 0; r < top.length; r++) {
    assert.equal(vw.winners[r].toLowerCase(), top[r]);
    assert.equal(vw.amounts[r], expected[r]);
    assert.equal(vw.claimed[r], true);
    const after = await pub.readContract({ address: dep.fesToken, abi: erc20Abi, functionName: 'balanceOf', args: [top[r] as `0x${string}`] });
    assert.equal(after - fesBefore[r], expected[r]);
  }
  assert.equal((await services.competitions.get(weekId))?.status, 'settled');
  const hall = (await app.inject({ method: 'GET', url: '/api/hall' })).json();
  assert.equal(hall[0].weekId, weekId);

  // A second finalization is refused onchain.
  await assert.rejects(services.chain.finalizeWeek(weekId, [vw.winners[0], vw.winners[1], vw.winners[2]], vw.resultsHash));

  console.log('\nOnchain settlement verified:');
  console.log(`  pool ${pool} WIF wei → ${expected.join(' / ')} (50/30/20)`);
  console.log(`  finalize tx ${finalizeTx}`);
  for (const t of payTxs) console.log(`  payout tx   ${t}`);
  await app.close();
  await db.close();
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
