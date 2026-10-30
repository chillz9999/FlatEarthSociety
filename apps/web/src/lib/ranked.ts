'use client';

import { entryAbi, mockTokenAbi } from '@fes/shared';
import { getBlockNumber, getPublicClient, readContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import type { SubmitAttemptResponse } from '@fes/shared';
import { erc20Abi, type Hash } from 'viem';
import { api } from './api';
import { CHAIN } from './env';
import { load, store } from './storage';
import { wagmiConfig } from './wagmi';

const PENDING_TX_KEY = 'fes:pending-entry-tx';
const PENDING_SUBMIT_KEY = 'fes:pending-submission';
/** How long to look onchain for a transaction the wallet said it could not send. */
const LOOK_SECONDS = 30;

export type PurchaseStep = 'idle' | 'reserving' | 'approving' | 'paying' | 'checking' | 'confirming' | 'verifying' | 'done';

export function pendingEntryTx(): { attemptId: string; txHash: Hash } | null {
  return load(PENDING_TX_KEY);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Errors that mean nothing was sent: the explorer said no, or the transaction failed before it left (no ETH for gas,
 * not enough $WIF, a revert in the fee estimate, the wrong network). Anything else may hide a sent transaction.
 */
function nothingSent(err: unknown): boolean {
  let e = err as { code?: number; message?: string; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 6; depth++, e = e.cause as typeof e) {
    if (e.code === 4001) return true;
    if (/User rejected|denied|insufficient funds|exceeds balance|InsufficientBalance|FeeAboveMax|revert|chain mismatch|does not match the target chain|Provider not found|No provider/i.test(e.message ?? '')) return true;
  }
  return false;
}

/**
 * Some wallets report an error for a transaction they did send (a time-out in their own service, a stale
 * transaction count). Before believing them, look onchain for a while; resolves to what was found, or null.
 */
async function lookFor<T>(probe: () => Promise<T | null>): Promise<T | null> {
  const until = Date.now() + LOOK_SECONDS * 1000;
  for (;;) {
    const found = await probe().catch(() => null);
    if (found !== null || Date.now() >= until) return found;
    await sleep(3000);
  }
}

/** Where to look back from for a transaction the wallet just reported on: a minute or so of blocks before now. */
async function lookBackFrom(): Promise<bigint | null> {
  const head = await getBlockNumber(wagmiConfig).catch(() => null);
  return head === null ? null : head > 1000n ? head - 1000n : 0n;
}

/** Approve exactly `fee` (never an unlimited allowance), unless it is already allowed. */
async function allowFee(token: `0x${string}`, spender: `0x${string}`, player: `0x${string}`, fee: bigint, onStep: (s: 'approving' | 'checking') => void) {
  const allowed = async () => (await readContract(wagmiConfig, { address: token, abi: erc20Abi, functionName: 'allowance', args: [player, spender] })) >= fee;
  if (await allowed()) return;
  onStep('approving');
  try {
    const hash = await writeContract(wagmiConfig, { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, fee] });
    await waitForTransactionReceipt(wagmiConfig, { hash });
  } catch (err) {
    if (nothingSent(err)) throw err;
    onStep('checking');
    if (!(await lookFor(async () => ((await allowed()) ? true : null)))) throw err;
  }
}

/** The transaction that paid for `attemptRef` since block `from`, if there is one. */
async function entryTx(entry: `0x${string}`, player: `0x${string}`, attemptRef: string, from: bigint): Promise<Hash | null> {
  const client = getPublicClient(wagmiConfig, { chainId: CHAIN.id });
  if (!client) return null;
  const logs = await client.getContractEvents({ address: entry, abi: entryAbi, eventName: 'EntryPurchased', args: { player }, fromBlock: from });
  return logs.find((l) => l.args.attemptRef?.toLowerCase() === attemptRef.toLowerCase())?.transactionHash ?? null;
}

/** The transaction that bought the bonus life of entry `entryId` since block `from`, if there is one. */
async function lifeTx(entry: `0x${string}`, entryId: `0x${string}`, from: bigint): Promise<Hash | null> {
  const client = getPublicClient(wagmiConfig, { chainId: CHAIN.id });
  if (!client) return null;
  const logs = await client.getContractEvents({ address: entry, abi: entryAbi, eventName: 'ExtraLifePurchased', args: { entryId }, fromBlock: from });
  return logs[0]?.transactionHash ?? null;
}

/**
 * Send a payment. Should the wallet report an error for a payment that landed anyway, carry on with the
 * transaction found onchain instead of telling the explorer it failed.
 */
async function send(write: () => Promise<Hash>, find: (from: bigint) => Promise<Hash | null>, onStep: (s: 'checking') => void): Promise<Hash> {
  try {
    return await write();
  } catch (err) {
    if (nothingSent(err)) throw err;
    onStep('checking');
    const from = await lookBackFrom();
    if (from === null) throw err;
    const hash = await lookFor(() => find(from));
    if (!hash) throw err;
    return hash;
  }
}

/**
 * Buy one ranked attempt:
 *   reserve an attempt reference → approve exactly the fee (never an unlimited allowance) →
 *   SocietyEntry.enter(attemptRef) → wait for the receipt → ask the server to verify it onchain.
 */
export async function purchaseAttempt(player: `0x${string}`, onStep: (s: PurchaseStep) => void): Promise<string> {
  onStep('reserving');
  const { attempt, entryContract, entryFee, wif } = await api.createAttempt();
  const fee = BigInt(entryFee);
  await allowFee(wif.address, entryContract, player, fee, onStep);

  onStep('paying');
  const hash = await send(
    // The quoted fee is the most this transaction will pay, should the fee be re-priced while it is pending.
    () => writeContract(wagmiConfig, { address: entryContract, abi: entryAbi, functionName: 'enter', args: [attempt.attemptRef, fee] }),
    (from) => entryTx(entryContract, player, attempt.attemptRef, from),
    onStep,
  );
  store(PENDING_TX_KEY, { attemptId: attempt.id, txHash: hash });
  onStep('confirming');
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
  if (receipt.status !== 'success') throw new Error('The entry transaction reverted. No $WIF was taken.');

  onStep('verifying');
  await confirmPayment(attempt.id, hash);
  onStep('done');
  return attempt.id;
}

export type LifeStep = 'idle' | 'quoting' | 'approving' | 'paying' | 'checking' | 'confirming' | 'verifying';

/**
 * Buy the bonus life of the voyage under way: approve exactly its price → SocietyEntry.buyExtraLife(entryId) →
 * wait for the receipt → report it until the server has confirmed it onchain. Resolves once the voyage may carry on.
 */
export async function purchaseLife(player: `0x${string}`, attemptId: string, onStep: (s: LifeStep) => void): Promise<void> {
  onStep('quoting');
  const quote = await api.quoteLife(attemptId);
  if (!quote.paid) {
    const fee = BigInt(quote.extraLifeFee);
    await allowFee(quote.wif.address, quote.entryContract, player, fee, onStep);
    onStep('paying');
    const hash = await send(
      () => writeContract(wagmiConfig, { address: quote.entryContract, abi: entryAbi, functionName: 'buyExtraLife', args: [quote.entryId, fee] }),
      (from) => lifeTx(quote.entryContract, quote.entryId, from),
      onStep,
    );
    onStep('confirming');
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
    if (receipt.status !== 'success') throw new Error('The bonus-life transaction reverted. No $WIF was taken.');
    onStep('verifying');
    for (let i = 0; i < 60; i++) {
      if ((await api.reportLifePayment(attemptId, hash)).status === 'confirmed') return;
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error('Your bonus life payment is still confirming. Don’t pay again: it will be credited automatically.');
  }
  onStep('verifying');
  await api.reportLifePayment(attemptId);
}

/** Report a payment until the server has verified it onchain (it waits for confirmations). */
export async function confirmPayment(attemptId: string, txHash: Hash): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await api.reportPayment(attemptId, txHash);
    if (!r.pending && r.attempt.status !== 'awaiting_payment') {
      store(PENDING_TX_KEY, null);
      return;
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw new Error('Your payment is still confirming. Don’t pay again: it will be credited automatically.');
}

export async function wifBalance(token: `0x${string}`, player: `0x${string}`): Promise<bigint> {
  return readContract(wagmiConfig, { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [player] });
}

/** Demo deployments only: mint mock $WIF from the open faucet. */
export async function mintDemoWif(token: `0x${string}`, player: `0x${string}`, amount: bigint): Promise<void> {
  const hash = await writeContract(wagmiConfig, { address: token, abi: mockTokenAbi, functionName: 'mint', args: [player, amount] });
  await waitForTransactionReceipt(wagmiConfig, { hash });
}

export interface PendingSubmission {
  attemptId: string;
  /** Wallet that played the run (only that wallet's session may submit it). */
  player?: string;
  body: { endTick: number; inputs: number[]; claimedScore: number; finalHash: string; checkpoints: string[] };
}

/** Finished runs are kept locally, per attempt, until the server acknowledges them (survives reloads and outages). */
export function savePendingSubmission(p: PendingSubmission): void {
  const all = load<Record<string, PendingSubmission>>(PENDING_SUBMIT_KEY) ?? {};
  all[p.attemptId] = p;
  store(PENDING_SUBMIT_KEY, all);
}

export function clearPendingSubmission(attemptId: string): void {
  const all = load<Record<string, PendingSubmission>>(PENDING_SUBMIT_KEY) ?? {};
  delete all[attemptId];
  store(PENDING_SUBMIT_KEY, Object.keys(all).length ? all : null);
}

export function pendingSubmissions(player?: string | null): PendingSubmission[] {
  const all = load<Record<string, PendingSubmission> | PendingSubmission>(PENDING_SUBMIT_KEY);
  if (!all) return [];
  // Older single-entry format.
  const list = 'attemptId' in all && 'body' in all ? [all as PendingSubmission] : Object.values(all as Record<string, PendingSubmission>);
  return player ? list.filter((p) => !p.player || p.player.toLowerCase() === player.toLowerCase()) : list;
}

/** Thrown when the session expired: the run stays saved and is sent after signing in again. */
export class NeedsSignIn extends Error {}

/**
 * Submit a finished run. Network and server errors are retried; a run is only
 * forgotten once the server has answered for it (accepted, or definitively refused).
 */
export async function submitPending(p: PendingSubmission): Promise<SubmitAttemptResponse> {
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      const res = await api.submitAttempt(p.attemptId, p.body);
      clearPendingSubmission(p.attemptId);
      return res;
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status ?? 0;
      if (status === 401) throw new NeedsSignIn('Your sign-in expired. Sign in again to submit your voyage.');
      if (status >= 400 && status < 500 && status !== 429) {
        clearPendingSubmission(p.attemptId);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'Something went wrong. Please try again.';
  const m = err.message;
  if (/User rejected|denied/i.test(m)) return 'You cancelled in your wallet. Nothing was charged.';
  if (/insufficient funds/i.test(m)) return `You need a little ETH on ${CHAIN.name} to pay the network fee.`;
  if (/transfer amount exceeds balance|ERC20InsufficientBalance/i.test(m)) return 'Not enough $WIF in this wallet.';
  if (/FeeAboveMax/i.test(m)) return 'The price changed while you were paying. Nothing was charged. Please try again.';
  if (/Provider not found|No provider|window\.ethereum/i.test(m)) return 'No wallet found in this browser. Install a wallet such as MetaMask or Rabby, then reload.';
  if (/Connector already connected/i.test(m)) return 'This wallet is already connected.';
  if (/chain mismatch|does not match the target chain|switch chain/i.test(m)) return `Switch your wallet to ${CHAIN.name}, then try again.`;
  // Wallets' own failures: the payment flows have already looked onchain and found nothing sent.
  if (/invalid nonce|nonce too (low|high)|nonce has already been used/i.test(m))
    return 'Your wallet lost count of its transactions, so nothing was sent. Clear its pending transactions in its settings, then try again.';
  if (/HTTPConnectionPool/i.test(m)) return 'Your wallet’s service didn’t answer in time, so nothing was sent. Please try again.';
  return m.split('\n')[0].slice(0, 220);
}

/** Why the Society did not count a voyage, in plain words (the server sends a short code). */
export function describeRejection(reason: string | null | undefined): string {
  switch (reason) {
    case 'unsupported_version':
      return 'The game was updated while you played. Reload the page to get the new version.';
    case 'week_closed':
      return 'The week closed before this voyage arrived, so it wasn’t counted.';
    case 'bonus_life_not_paid':
      return 'The bonus life payment wasn’t confirmed, so this voyage wasn’t counted.';
    default:
      return 'This voyage didn’t match the Society’s replay of it, so it wasn’t counted.';
  }
}
