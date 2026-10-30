import { weekIdAt } from '@fes/shared';
import {
  ZERO_ADDRESS,
  type ChainGateway,
  type ConverterInfo,
  type EntryPayment,
  type ExtraLifeCheck,
  type ExtraLifePayment,
  type FeeBounds,
  type PaymentCheck,
  type TokenMeta,
  type VaultWeek,
} from '../src/chain/gateway';
import { computeEntryId } from '../src/services/attempts';

/** An in-memory stand-in for the deployed contracts, mirroring their accounting rules. */
export class FakeChain implements ChainGateway {
  readonly enabled = true;
  readonly chainId = 31337;
  readonly chainName = 'Fake Chain';
  readonly explorerUrl = 'https://explorer.example';
  readonly entryContract = '0x00000000000000000000000000000000000000e1' as const;
  readonly vaultContract = '0x00000000000000000000000000000000000000f1' as const;
  readonly converterContract = '0x00000000000000000000000000000000000000c1' as const;
  readonly settlerAddress = '0x00000000000000000000000000000000000000aa' as const;
  pricerAddress: `0x${string}` | null = '0x00000000000000000000000000000000000000bb';
  readonly startBlock = 1n;

  fee = 10n * 10n ** 18n;
  lifeFee = 500n * 10n ** 18n;
  bounds: FeeBounds = { minEntryFee: 10n ** 18n, maxEntryFee: 100n * 10n ** 18n, minExtraLifeFee: 50n * 10n ** 18n, maxExtraLifeFee: 5000n * 10n ** 18n };
  /** Prizes paid in WIF itself: every allocation joins the pool as it is. */
  inKind = false;
  /** The non-prize half is sent to the burn address. */
  burning = true;
  readonly priceUpdates: { entryFee: bigint; extraLifeFee: bigint }[] = [];
  readonly lifeReceipts = new Map<string, { status: 'success' | 'reverted'; block: bigint; life: ExtraLifePayment | null }>();
  private readonly livesBought = new Set<string>();
  paused = false;
  rate = 2n * 10n ** 18n; // 2 FES per WIF
  inventory = 10n ** 30n;
  block = 100n;
  private txCounter = 0;
  readonly receipts = new Map<string, { status: 'success' | 'reverted'; block: bigint; payments: EntryPayment[] }>();
  readonly weeks = new Map<number, VaultWeek>();
  now = () => Date.now();

  private week(weekId: number): VaultWeek {
    let w = this.weeks.get(weekId);
    if (!w) {
      w = {
        weekId,
        wifAllocated: 0n,
        wifConverted: 0n,
        fesPool: 0n,
        finalized: false,
        winners: [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
        amounts: [0n, 0n, 0n],
        claimed: [false, false, false],
        rolledOver: 0n,
      };
      this.weeks.set(weekId, w);
    }
    return w;
  }

  private tx(): `0x${string}` {
    this.txCounter++;
    return `0x${this.txCounter.toString(16).padStart(64, '0')}`;
  }

  /** Simulate SocietyEntry.enter(attemptRef) by `player`. Returns the tx hash. */
  pay(player: `0x${string}`, attemptRef: `0x${string}`, opts: { weekId?: number; reverted?: boolean } = {}): `0x${string}` {
    const hash = this.tx();
    this.block++;
    const weekId = opts.weekId ?? weekIdAt(this.now());
    const reward = this.fee / 2n;
    const payment: EntryPayment = {
      entryId: computeEntryId(player, attemptRef).toLowerCase() as `0x${string}`,
      txHash: hash,
      logIndex: 0,
      blockNumber: this.block,
      player: player.toLowerCase() as `0x${string}`,
      weekId,
      attemptRef: attemptRef.toLowerCase() as `0x${string}`,
      fee: this.fee,
      rewardShare: reward,
      protocolShare: this.fee - reward,
    };
    this.receipts.set(hash, { status: opts.reverted ? 'reverted' : 'success', block: this.block, payments: opts.reverted ? [] : [payment] });
    if (!opts.reverted) this.allocate(weekId, reward);
    return hash;
  }

  private allocate(weekId: number, reward: bigint): void {
    const w = this.week(weekId);
    w.wifAllocated += reward;
    if (this.inKind) {
      w.wifConverted += reward;
      w.fesPool += reward;
    }
  }

  /** Simulate SocietyEntry.buyExtraLife(entryId) by `player` (the contract allows one per entry, by its player). */
  buyLife(player: `0x${string}`, entryId: `0x${string}`, opts: { reverted?: boolean } = {}): `0x${string}` {
    const hash = this.tx();
    this.block++;
    const id = entryId.toLowerCase() as `0x${string}`;
    const ok = !opts.reverted && !this.livesBought.has(id);
    const weekId = weekIdAt(this.now());
    const reward = this.lifeFee / 2n;
    const life: ExtraLifePayment = {
      entryId: id,
      txHash: hash,
      logIndex: 0,
      blockNumber: this.block,
      player: player.toLowerCase() as `0x${string}`,
      weekId,
      fee: this.lifeFee,
      rewardShare: reward,
      protocolShare: this.lifeFee - reward,
    };
    this.lifeReceipts.set(hash, { status: ok ? 'success' : 'reverted', block: this.block, life: ok ? life : null });
    if (ok) {
      this.livesBought.add(id);
      this.allocate(weekId, reward);
    }
    return hash;
  }

  confirm(blocks = 3): void {
    this.block += BigInt(blocks);
  }

  async tokens(): Promise<{ wif: TokenMeta; fes: TokenMeta }> {
    const wif: TokenMeta = { address: '0x0000000000000000000000000000000000000a01', symbol: 'WIF', decimals: 18 };
    return { wif, fes: this.inKind ? wif : { address: '0x0000000000000000000000000000000000000a02', symbol: 'FES', decimals: 18 } };
  }
  async entryFee() {
    return this.fee;
  }
  async extraLifeFee() {
    return this.lifeFee;
  }
  async burnsProtocolShare() {
    return this.burning;
  }
  async verifyExtraLifePayment(txHash: `0x${string}`, expected: { player: `0x${string}`; entryId: `0x${string}` }): Promise<ExtraLifeCheck> {
    const r = this.lifeReceipts.get(txHash);
    if (!r) return { status: 'pending', reason: 'not mined' };
    if (r.status !== 'success' || !r.life) return { status: 'invalid', reason: 'Transaction reverted' };
    if (this.block - r.block + 1n < 2n) return { status: 'pending', reason: 'confirmations' };
    if (r.life.entryId !== expected.entryId.toLowerCase()) return { status: 'invalid', reason: 'No bonus life for this voyage in that transaction' };
    if (r.life.player !== expected.player.toLowerCase()) return { status: 'invalid', reason: 'Bonus life was bought by a different wallet' };
    return { status: 'confirmed', payment: r.life };
  }
  async extraLifeLogs(from: bigint, to: bigint) {
    const out: ExtraLifePayment[] = [];
    for (const r of this.lifeReceipts.values()) if (r.life && r.life.blockNumber >= from && r.life.blockNumber <= to) out.push(r.life);
    return out;
  }
  async feeBounds() {
    return { ...this.bounds };
  }
  async updatePrices(entryFee: bigint, extraLifeFee: bigint) {
    const check = (fee: bigint, cur: bigint, min: bigint, max: bigint) => {
      if (fee === 0n || fee % 2n !== 0n) throw new Error('InvalidEntryFee');
      if (fee < min || fee > max || fee > cur * 2n || fee * 2n < cur) throw new Error('FeeOutOfBounds');
    };
    check(entryFee, this.fee, this.bounds.minEntryFee, this.bounds.maxEntryFee);
    check(extraLifeFee, this.lifeFee, this.bounds.minExtraLifeFee, this.bounds.maxExtraLifeFee);
    this.fee = entryFee;
    this.lifeFee = extraLifeFee;
    this.priceUpdates.push({ entryFee, extraLifeFee });
    return { txHash: this.tx() };
  }
  async entriesPaused() {
    return this.paused;
  }
  async verifyEntryPayment(txHash: `0x${string}`, expected: { player: `0x${string}`; attemptRef: `0x${string}`; entryId: `0x${string}` }): Promise<PaymentCheck> {
    const r = this.receipts.get(txHash);
    if (!r) return { status: 'pending', reason: 'not mined' };
    if (r.status !== 'success') return { status: 'invalid', reason: 'Transaction reverted' };
    if (this.block - r.block + 1n < 2n) return { status: 'pending', reason: 'confirmations' };
    const p = r.payments.find((x) => x.entryId === expected.entryId.toLowerCase());
    if (!p) return { status: 'invalid', reason: 'No entry payment for this attempt in that transaction' };
    if (p.player !== expected.player.toLowerCase()) return { status: 'invalid', reason: 'Payment was made by a different wallet' };
    return { status: 'confirmed', payment: p };
  }
  async safeBlock() {
    return this.block - 2n;
  }
  async entryLogs(from: bigint, to: bigint) {
    const out: EntryPayment[] = [];
    for (const r of this.receipts.values()) for (const p of r.payments) if (p.blockNumber >= from && p.blockNumber <= to) out.push(p);
    return out.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  }
  async vaultWeek(weekId: number) {
    return { ...this.week(weekId) };
  }
  async converter(): Promise<ConverterInfo> {
    return { address: this.converterContract, rate: this.rate, pendingRate: 0n, pendingRateEffectiveAt: 0n, rateDelay: 86400n, inventory: this.inventory };
  }
  async convertWeek(weekId: number, wifAmount: bigint, minFesOut: bigint) {
    const w = this.week(weekId);
    if (w.finalized) throw new Error('WeekAlreadyFinalized');
    if (wifAmount > w.wifAllocated - w.wifConverted) throw new Error('ExceedsUnconvertedAllocation');
    const out = (wifAmount * this.rate) / 10n ** 18n;
    if (out < minFesOut) throw new Error('InsufficientOutput');
    w.wifConverted += wifAmount;
    w.fesPool += out;
    this.inventory -= out;
    return { txHash: this.tx(), fesOut: out };
  }
  async finalizeWeek(weekId: number, winners: [`0x${string}`, `0x${string}`, `0x${string}`]) {
    const w = this.week(weekId);
    if (w.finalized) throw new Error('WeekAlreadyFinalized');
    if (w.wifConverted !== w.wifAllocated) throw new Error('UnconvertedAllocation');
    const s0 = (w.fesPool * 5000n) / 10000n;
    const s1 = (w.fesPool * 3000n) / 10000n;
    const shares = [s0, s1, w.fesPool - s0 - s1];
    let rolled = 0n;
    for (let i = 0; i < 3; i++) {
      if (winners[i] === ZERO_ADDRESS) rolled += shares[i];
      else {
        w.winners[i] = winners[i];
        w.amounts[i] = shares[i];
      }
    }
    w.finalized = true;
    w.rolledOver = rolled;
    if (rolled) this.week(weekId + 1).fesPool += rolled;
    return { txHash: this.tx() };
  }
  async claimFor(weekId: number, rank: number) {
    const w = this.week(weekId);
    if (!w.finalized || w.claimed[rank] || w.winners[rank] === ZERO_ADDRESS) throw new Error('cannot claim');
    w.claimed[rank] = true;
    return { txHash: this.tx(), amount: w.amounts[rank] };
  }
}
