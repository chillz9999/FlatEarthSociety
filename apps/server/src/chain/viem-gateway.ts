import { entryAbi, fixedRateConverterAbi, resolveChain, vaultAbi } from '@fes/shared';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  erc20Abi,
  getAddress,
  http,
  parseEventLogs,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainGateway, ConverterInfo, EntryPayment, ExtraLifeCheck, ExtraLifePayment, FeeBounds, PaymentCheck, TokenMeta, VaultWeek } from './gateway';

export interface ViemGatewayOptions {
  chainId: number;
  chainName?: string;
  rpcUrl?: string;
  explorerUrl?: string;
  entry: `0x${string}`;
  vault: `0x${string}`;
  converter?: `0x${string}` | null;
  startBlock: bigint;
  confirmations: number;
  settlerKey?: `0x${string}`;
  /** Key holding PRICER_ROLE on the entry contract (re-prices both fees). */
  pricerKey?: `0x${string}`;
}

export class ViemChainGateway implements ChainGateway {
  readonly enabled = true;
  readonly chainId: number;
  readonly chainName: string;
  readonly explorerUrl: string | null;
  readonly entryContract: `0x${string}`;
  readonly vaultContract: `0x${string}`;
  readonly converterContract: `0x${string}` | null;
  readonly settlerAddress: `0x${string}` | null;
  readonly pricerAddress: `0x${string}` | null;
  readonly startBlock: bigint;
  private readonly chain: Chain;
  private readonly client: PublicClient;
  private readonly wallet: WalletClient | null;
  private readonly pricer: WalletClient | null;
  private readonly confirmations: number;
  private tokenCache: { wif: TokenMeta; fes: TokenMeta } | null = null;
  private feeCache: { at: number; fees: { entry: bigint; life: bigint } } | null = null;
  private burning: boolean | null = null;

  constructor(opts: ViemGatewayOptions) {
    this.chain = resolveChain({ id: opts.chainId, name: opts.chainName, rpcUrl: opts.rpcUrl, explorerUrl: opts.explorerUrl });
    this.chainId = opts.chainId;
    this.chainName = this.chain.name;
    this.explorerUrl = this.chain.blockExplorers?.default.url ?? null;
    this.entryContract = getAddress(opts.entry);
    this.vaultContract = getAddress(opts.vault);
    this.converterContract = opts.converter ? getAddress(opts.converter) : null;
    this.startBlock = opts.startBlock;
    this.confirmations = opts.confirmations;
    this.client = createPublicClient({ chain: this.chain, transport: http(this.chain.rpcUrls.default.http[0], { retryCount: 3 }) }) as PublicClient;
    if (opts.settlerKey) {
      const account = privateKeyToAccount(opts.settlerKey);
      this.wallet = createWalletClient({ account, chain: this.chain, transport: http(this.chain.rpcUrls.default.http[0]) });
      this.settlerAddress = account.address;
    } else {
      this.wallet = null;
      this.settlerAddress = null;
    }
    if (opts.pricerKey) {
      const account = privateKeyToAccount(opts.pricerKey);
      this.pricer = createWalletClient({ account, chain: this.chain, transport: http(this.chain.rpcUrls.default.http[0]) });
      this.pricerAddress = account.address;
    } else {
      this.pricer = null;
      this.pricerAddress = null;
    }
  }

  /** Fail fast if the RPC is pointed at a different chain than configured. */
  async assertChain(): Promise<void> {
    const id = await this.client.getChainId();
    if (id !== this.chainId) throw new Error(`RPC reports chain ${id}, expected ${this.chainId}`);
    const code = await this.client.getCode({ address: this.entryContract });
    if (!code || code === '0x') throw new Error(`No contract code at entry address ${this.entryContract}`);
  }

  async tokens() {
    if (this.tokenCache) return this.tokenCache;
    const [wifAddr, fesAddr] = await Promise.all([
      this.client.readContract({ address: this.vaultContract, abi: vaultAbi, functionName: 'wif' }),
      this.client.readContract({ address: this.vaultContract, abi: vaultAbi, functionName: 'fes' }),
    ]);
    const meta = async (address: `0x${string}`): Promise<TokenMeta> => {
      const [symbol, decimals] = await Promise.all([
        this.client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
        this.client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      return { address, symbol, decimals };
    };
    this.tokenCache = { wif: await meta(wifAddr), fes: await meta(fesAddr) };
    return this.tokenCache;
  }

  private async fees() {
    if (this.feeCache && Date.now() - this.feeCache.at < 15_000) return this.feeCache.fees;
    const [entry, life] = await Promise.all([
      this.client.readContract({ address: this.entryContract, abi: entryAbi, functionName: 'entryFee' }),
      this.client.readContract({ address: this.entryContract, abi: entryAbi, functionName: 'extraLifeFee' }),
    ]);
    this.feeCache = { at: Date.now(), fees: { entry, life } };
    return this.feeCache.fees;
  }

  async entryFee() {
    return (await this.fees()).entry;
  }

  async extraLifeFee() {
    return (await this.fees()).life;
  }

  async burnsProtocolShare() {
    // Permanent once true, so it is read once and then kept.
    if (!this.burning) {
      this.burning = await this.client.readContract({ address: this.entryContract, abi: entryAbi, functionName: 'burnsProtocolShare' });
    }
    return this.burning;
  }

  async entriesPaused() {
    return this.client.readContract({ address: this.entryContract, abi: entryAbi, functionName: 'paused' });
  }

  async verifyEntryPayment(txHash: `0x${string}`, expected: { player: `0x${string}`; attemptRef: `0x${string}`; entryId: `0x${string}` }): Promise<PaymentCheck> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch {
      return { status: 'pending', reason: 'Transaction not yet mined' };
    }
    if (receipt.status !== 'success') return { status: 'invalid', reason: 'Transaction reverted' };
    const head = await this.client.getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(this.confirmations)) {
      return { status: 'pending', reason: `Awaiting ${this.confirmations} confirmations` };
    }
    const logs = parseEventLogs({ abi: entryAbi, logs: receipt.logs, eventName: 'EntryPurchased', strict: true }).filter(
      (l) => getAddress(l.address) === this.entryContract,
    );
    const match = logs.find((l) => l.args.entryId.toLowerCase() === expected.entryId.toLowerCase());
    if (!match) return { status: 'invalid', reason: 'No entry payment for this attempt in that transaction' };
    if (getAddress(match.args.player) !== getAddress(expected.player)) return { status: 'invalid', reason: 'Payment was made by a different wallet' };
    if (match.args.attemptRef.toLowerCase() !== expected.attemptRef.toLowerCase()) return { status: 'invalid', reason: 'Attempt reference mismatch' };
    return { status: 'confirmed', payment: this.toPayment(match.args, match.transactionHash, match.logIndex, match.blockNumber) };
  }

  async verifyExtraLifePayment(txHash: `0x${string}`, expected: { player: `0x${string}`; entryId: `0x${string}` }): Promise<ExtraLifeCheck> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch {
      return { status: 'pending', reason: 'Transaction not yet mined' };
    }
    if (receipt.status !== 'success') return { status: 'invalid', reason: 'Transaction reverted' };
    const head = await this.client.getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(this.confirmations)) {
      return { status: 'pending', reason: `Awaiting ${this.confirmations} confirmations` };
    }
    const match = parseEventLogs({ abi: entryAbi, logs: receipt.logs, eventName: 'ExtraLifePurchased', strict: true }).find(
      (l) => getAddress(l.address) === this.entryContract && l.args.entryId.toLowerCase() === expected.entryId.toLowerCase(),
    );
    if (!match) return { status: 'invalid', reason: 'No bonus life for this voyage in that transaction' };
    if (getAddress(match.args.player) !== getAddress(expected.player)) return { status: 'invalid', reason: 'Bonus life was bought by a different wallet' };
    return { status: 'confirmed', payment: this.toLife(match.args, match.transactionHash, match.logIndex, match.blockNumber) };
  }

  private toLife(
    args: { entryId: Hex; player: `0x${string}`; weekId: bigint; fee: bigint; rewardShare: bigint; protocolShare: bigint },
    txHash: `0x${string}`,
    logIndex: number,
    blockNumber: bigint,
  ): ExtraLifePayment {
    return {
      entryId: args.entryId.toLowerCase() as `0x${string}`,
      txHash: txHash.toLowerCase() as `0x${string}`,
      logIndex,
      blockNumber,
      player: args.player.toLowerCase() as `0x${string}`,
      weekId: Number(args.weekId),
      fee: args.fee,
      rewardShare: args.rewardShare,
      protocolShare: args.protocolShare,
    };
  }

  private toPayment(
    args: { entryId: Hex; player: `0x${string}`; weekId: bigint; attemptRef: Hex; fee: bigint; rewardShare: bigint; protocolShare: bigint },
    txHash: `0x${string}`,
    logIndex: number,
    blockNumber: bigint,
  ): EntryPayment {
    return {
      entryId: args.entryId.toLowerCase() as `0x${string}`,
      txHash: txHash.toLowerCase() as `0x${string}`,
      logIndex,
      blockNumber,
      player: args.player.toLowerCase() as `0x${string}`,
      weekId: Number(args.weekId),
      attemptRef: args.attemptRef.toLowerCase() as `0x${string}`,
      fee: args.fee,
      rewardShare: args.rewardShare,
      protocolShare: args.protocolShare,
    };
  }

  async safeBlock() {
    const head = await this.client.getBlockNumber();
    const safe = head - BigInt(this.confirmations);
    return safe < 0n ? 0n : safe;
  }

  async entryLogs(fromBlock: bigint, toBlock: bigint): Promise<EntryPayment[]> {
    const logs = await this.client.getLogs({
      address: this.entryContract,
      event: entryAbi.find((x) => x.type === 'event' && x.name === 'EntryPurchased') as Extract<(typeof entryAbi)[number], { type: 'event'; name: 'EntryPurchased' }>,
      fromBlock,
      toBlock,
    });
    return logs.map((l) => {
      const d = decodeEventLog({ abi: entryAbi, data: l.data, topics: l.topics, eventName: 'EntryPurchased' });
      return this.toPayment(d.args, l.transactionHash!, l.logIndex!, l.blockNumber!);
    });
  }

  async extraLifeLogs(fromBlock: bigint, toBlock: bigint): Promise<ExtraLifePayment[]> {
    const logs = await this.client.getLogs({
      address: this.entryContract,
      event: entryAbi.find((x) => x.type === 'event' && x.name === 'ExtraLifePurchased') as Extract<(typeof entryAbi)[number], { type: 'event'; name: 'ExtraLifePurchased' }>,
      fromBlock,
      toBlock,
    });
    return logs.map((l) => {
      const d = decodeEventLog({ abi: entryAbi, data: l.data, topics: l.topics, eventName: 'ExtraLifePurchased' });
      return this.toLife(d.args, l.transactionHash!, l.logIndex!, l.blockNumber!);
    });
  }

  async vaultWeek(weekId: number): Promise<VaultWeek | null> {
    const w = await this.client.readContract({ address: this.vaultContract, abi: vaultAbi, functionName: 'getWeek', args: [BigInt(weekId)] });
    return {
      weekId,
      wifAllocated: w.wifAllocated,
      wifConverted: w.wifConverted,
      fesPool: w.fesPool,
      finalized: w.finalized,
      winners: [...w.winners] as VaultWeek['winners'],
      amounts: [...w.amounts] as VaultWeek['amounts'],
      claimed: [...w.claimed] as VaultWeek['claimed'],
      rolledOver: w.rolledOver,
    };
  }

  async converter(): Promise<ConverterInfo | null> {
    if (!this.converterContract) return null;
    const address = this.converterContract;
    const read = <F extends 'rate' | 'pendingRate' | 'pendingRateEffectiveAt' | 'RATE_DELAY' | 'inventory'>(functionName: F) =>
      this.client.readContract({ address, abi: fixedRateConverterAbi, functionName }) as Promise<bigint>;
    const [rate, pendingRate, pendingRateEffectiveAt, rateDelay, inventory] = await Promise.all([
      read('rate'),
      read('pendingRate'),
      read('pendingRateEffectiveAt'),
      read('RATE_DELAY'),
      read('inventory'),
    ]);
    return { address, rate, pendingRate, pendingRateEffectiveAt, rateDelay, inventory };
  }

  private requireWallet(): WalletClient {
    if (!this.wallet) {
      throw Object.assign(new Error('No SETTLER_PRIVATE_KEY configured; settlement transactions cannot be sent.'), { statusCode: 503, code: 'no_settler' });
    }
    return this.wallet;
  }

  private async send(functionName: 'convertWeek' | 'finalizeWeek' | 'claimFor', args: readonly unknown[]) {
    const wallet = this.requireWallet();
    const { request } = await this.client.simulateContract({
      account: wallet.account!,
      address: this.vaultContract,
      abi: vaultAbi,
      functionName,
      args: args as never,
    });
    const hash = await wallet.writeContract(request as never);
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: Math.max(1, this.confirmations) });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  }

  async convertWeek(weekId: number, wifAmount: bigint, minFesOut: bigint) {
    if (!this.converterContract) throw new Error('No converter configured');
    // Deadline relative to the chain's own clock, not the server's.
    const latest = await this.client.getBlock();
    const deadline = latest.timestamp + 15n * 60n;
    const receipt = await this.send('convertWeek', [BigInt(weekId), wifAmount, this.converterContract, minFesOut, deadline]);
    const ev = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: 'WeekConverted' })[0];
    return { txHash: receipt.transactionHash, fesOut: ev?.args.fesOut ?? 0n };
  }

  async finalizeWeek(weekId: number, winners: [`0x${string}`, `0x${string}`, `0x${string}`], resultsHash: `0x${string}`) {
    const receipt = await this.send('finalizeWeek', [BigInt(weekId), winners, resultsHash]);
    return { txHash: receipt.transactionHash };
  }

  async claimFor(weekId: number, rank: number) {
    const receipt = await this.send('claimFor', [BigInt(weekId), rank]);
    const ev = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: 'RewardClaimed' })[0];
    return { txHash: receipt.transactionHash, amount: ev?.args.amount ?? 0n };
  }

  async feeBounds(): Promise<FeeBounds> {
    const read = (functionName: 'minEntryFee' | 'maxEntryFee' | 'minExtraLifeFee' | 'maxExtraLifeFee') =>
      this.client.readContract({ address: this.entryContract, abi: entryAbi, functionName }) as Promise<bigint>;
    const [minEntryFee, maxEntryFee, minExtraLifeFee, maxExtraLifeFee] = await Promise.all([
      read('minEntryFee'),
      read('maxEntryFee'),
      read('minExtraLifeFee'),
      read('maxExtraLifeFee'),
    ]);
    return { minEntryFee, maxEntryFee, minExtraLifeFee, maxExtraLifeFee };
  }

  async updatePrices(entryFee: bigint, extraLifeFee: bigint) {
    if (!this.pricer) {
      throw Object.assign(new Error('No PRICER_PRIVATE_KEY configured; the fees cannot be re-priced.'), { statusCode: 503, code: 'no_pricer' });
    }
    const { request } = await this.client.simulateContract({
      account: this.pricer.account!,
      address: this.entryContract,
      abi: entryAbi,
      functionName: 'updatePrices',
      args: [entryFee, extraLifeFee],
    });
    const hash = await this.pricer.writeContract(request as never);
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: Math.max(1, this.confirmations) });
    if (receipt.status !== 'success') throw new Error(`updatePrices reverted (${hash})`);
    this.feeCache = null;
    return { txHash: receipt.transactionHash };
  }
}
