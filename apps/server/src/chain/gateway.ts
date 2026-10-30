/** Everything the server needs from Robinhood Chain, behind one interface (real: viem; tests: a fake). */

export interface TokenMeta {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface EntryPayment {
  entryId: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  player: `0x${string}`;
  weekId: number;
  attemptRef: `0x${string}`;
  fee: bigint;
  rewardShare: bigint;
  protocolShare: bigint;
}

export type PaymentCheck =
  | { status: 'confirmed'; payment: EntryPayment }
  | { status: 'pending'; reason: string }
  | { status: 'invalid'; reason: string };

/** A bonus life bought for an entry (SocietyEntry ExtraLifePurchased). */
export interface ExtraLifePayment {
  entryId: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  player: `0x${string}`;
  weekId: number;
  fee: bigint;
  rewardShare: bigint;
  protocolShare: bigint;
}

export type ExtraLifeCheck =
  | { status: 'confirmed'; payment: ExtraLifePayment }
  | { status: 'pending'; reason: string }
  | { status: 'invalid'; reason: string };

/** The range within which the pricer may set each fee (raw WIF units, inclusive). */
export interface FeeBounds {
  minEntryFee: bigint;
  maxEntryFee: bigint;
  minExtraLifeFee: bigint;
  maxExtraLifeFee: bigint;
}

export interface VaultWeek {
  weekId: number;
  wifAllocated: bigint;
  wifConverted: bigint;
  fesPool: bigint;
  finalized: boolean;
  winners: [`0x${string}`, `0x${string}`, `0x${string}`];
  amounts: [bigint, bigint, bigint];
  claimed: [boolean, boolean, boolean];
  rolledOver: bigint;
}

export interface ConverterInfo {
  address: `0x${string}`;
  rate: bigint;
  pendingRate: bigint;
  pendingRateEffectiveAt: bigint;
  rateDelay: bigint;
  inventory: bigint;
}

export interface ChainGateway {
  readonly enabled: boolean;
  readonly chainId: number;
  readonly chainName: string;
  readonly explorerUrl: string | null;
  readonly entryContract: `0x${string}` | null;
  readonly vaultContract: `0x${string}` | null;
  readonly converterContract: `0x${string}` | null;
  readonly settlerAddress: `0x${string}` | null;
  /** Account that re-prices the fees (PRICER_ROLE), when its key is configured. */
  readonly pricerAddress: `0x${string}` | null;
  readonly startBlock: bigint;

  /** In-kind vaults have the same token for `wif` and `fes`: prizes are paid in WIF. */
  tokens(): Promise<{ wif: TokenMeta; fes: TokenMeta } | null>;
  entryFee(): Promise<bigint | null>;
  extraLifeFee(): Promise<bigint | null>;
  /** Whether the non-prize half of every payment is burned (null when unknown). */
  burnsProtocolShare(): Promise<boolean | null>;
  entriesPaused(): Promise<boolean>;
  /**
   * Independently verify that `txHash` is a successful, sufficiently confirmed
   * transaction in which the entry contract emitted EntryPurchased for exactly
   * this player and attempt reference.
   */
  verifyEntryPayment(txHash: `0x${string}`, expected: { player: `0x${string}`; attemptRef: `0x${string}`; entryId: `0x${string}` }): Promise<PaymentCheck>;
  /** The same for a bonus life: ExtraLifePurchased for exactly this entry, paid by this player. */
  verifyExtraLifePayment(txHash: `0x${string}`, expected: { player: `0x${string}`; entryId: `0x${string}` }): Promise<ExtraLifeCheck>;
  /** Safe head for indexing (latest − confirmations). */
  safeBlock(): Promise<bigint>;
  entryLogs(fromBlock: bigint, toBlock: bigint): Promise<EntryPayment[]>;
  extraLifeLogs(fromBlock: bigint, toBlock: bigint): Promise<ExtraLifePayment[]>;
  vaultWeek(weekId: number): Promise<VaultWeek | null>;
  converter(): Promise<ConverterInfo | null>;

  // Settlement (require the settler key).
  convertWeek(weekId: number, wifAmount: bigint, minFesOut: bigint): Promise<{ txHash: `0x${string}`; fesOut: bigint }>;
  finalizeWeek(weekId: number, winners: [`0x${string}`, `0x${string}`, `0x${string}`], resultsHash: `0x${string}`): Promise<{ txHash: `0x${string}` }>;
  claimFor(weekId: number, rank: number): Promise<{ txHash: `0x${string}`; amount: bigint }>;

  // Pricing (requires the pricer key).
  feeBounds(): Promise<FeeBounds | null>;
  updatePrices(entryFee: bigint, extraLifeFee: bigint): Promise<{ txHash: `0x${string}` }>;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Chain integration switched off: practice and read-only leaderboards still work. */
export class DisabledChain implements ChainGateway {
  readonly enabled = false;
  readonly entryContract = null;
  readonly vaultContract = null;
  readonly converterContract = null;
  readonly settlerAddress = null;
  readonly pricerAddress = null;
  readonly explorerUrl = null;
  readonly startBlock = 0n;
  constructor(
    readonly chainId: number,
    readonly chainName: string,
  ) {}
  private off(): never {
    throw Object.assign(new Error('Competitive play isn’t available right now.'), { statusCode: 503, code: 'chain_disabled' });
  }
  async tokens() {
    return null;
  }
  async entryFee() {
    return null;
  }
  async extraLifeFee() {
    return null;
  }
  async burnsProtocolShare() {
    return null;
  }
  async entriesPaused() {
    return true;
  }
  async verifyEntryPayment(): Promise<PaymentCheck> {
    return this.off();
  }
  async verifyExtraLifePayment(): Promise<ExtraLifeCheck> {
    return this.off();
  }
  async safeBlock(): Promise<bigint> {
    return 0n;
  }
  async entryLogs() {
    return [];
  }
  async extraLifeLogs() {
    return [];
  }
  async vaultWeek() {
    return null;
  }
  async converter() {
    return null;
  }
  async convertWeek(): Promise<never> {
    return this.off();
  }
  async finalizeWeek(): Promise<never> {
    return this.off();
  }
  async claimFor(): Promise<never> {
    return this.off();
  }
  async feeBounds() {
    return null;
  }
  async updatePrices(): Promise<never> {
    return this.off();
  }
}
