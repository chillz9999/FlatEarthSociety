/** Wire types shared by the API server and the web client. All token amounts are raw integer strings. */

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface PublicConfig {
  chainId: number;
  chainName: string;
  explorerUrl: string | null;
  entryContract: `0x${string}` | null;
  vaultContract: `0x${string}` | null;
  converterContract: `0x${string}` | null;
  wif: TokenInfo | null;
  fes: TokenInfo | null;
  entryFee: string | null;
  /** Price of a ranked voyage's one bonus life, raw WIF units. */
  extraLifeFee: string | null;
  /** Prizes are paid in $WIF itself (no conversion). */
  prizeInWif: boolean;
  /** The other half of every payment is burned (sent to the dead address for good). */
  protocolShareBurned: boolean;
  /** Dollar prices, and the market price of $WIF the fees are set from. */
  pricing: PricingInfo;
  entriesPaused: boolean;
  gameVersion: string;
  confirmations: number;
  /** True when the server runs against mock tokens (local/testnet demo). */
  demoTokens: boolean;
  prizeSharesBps: [number, number, number];
  rewardShareBps: number;
}

export interface PricingInfo {
  entryUsd: number;
  extraLifeUsd: number;
  /** Latest market price of one $WIF in dollars, or null when no price feed is configured. */
  wifUsd: number | null;
  source: string | null;
  updatedAt: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName: string | null;
  score: number;
  evidence: number;
  survivalMs: number;
  achievedAt: string;
  attemptId: string;
}

export interface Leaderboard {
  weekId: number;
  startsAt: string;
  endsAt: string;
  status: CompetitionStatus;
  entries: LeaderboardEntry[];
  totalPlayers: number;
}

export type CompetitionStatus = 'open' | 'closed' | 'finalized' | 'settled';

export interface ConversionRecord {
  txHash: string;
  wifIn: string;
  fesOut: string;
  converter: string;
  at: string;
}

export interface CompetitionSummary {
  weekId: number;
  startsAt: string;
  endsAt: string;
  status: CompetitionStatus;
  entryFee: string | null;
  entries: number;
  /** Bonus lives bought this week. */
  extraLives: number;
  players: number;
  /** Total WIF paid this week (entries and bonus lives). */
  wifCollected: string;
  /** 50% of eligible fees allocated to the weekly prize. */
  wifRewardAllocation: string;
  /** The remaining 50%: burned, or paid to the protocol treasury (see PublicConfig.protocolShareBurned). */
  wifProtocol: string;
  /** FES already in the week's pool (conversions + disclosed top-ups + rollover). */
  fesPool: string;
  /** Estimated FES pool if the unconverted allocation were converted at the current published rate. */
  fesPoolEstimate: string | null;
  conversions: ConversionRecord[];
  top3: LeaderboardEntry[];
  finalizeTx: string | null;
}

export interface HallWinner {
  rank: number;
  title: string;
  address: string;
  displayName: string | null;
  score: number;
  fesAmount: string;
  claimed: boolean;
  claimTx: string | null;
}

export interface HallWeek {
  weekId: number;
  startsAt: string;
  endsAt: string;
  fesPool: string;
  finalizeTx: string | null;
  winners: HallWinner[];
}

export interface TreasuryReport {
  current: CompetitionSummary;
  history: CompetitionSummary[];
  totals: { wifCollected: string; wifRewardAllocation: string; wifProtocol: string; fesAwarded: string; entries: number };
  disclosure: {
    method: string;
    converter: string | null;
    rate: string | null;
    pendingRate: string | null;
    pendingRateEffectiveAt: string | null;
    rateDelaySeconds: number | null;
    settlementRules: string[];
  };
}

export type AttemptStatus =
  | 'awaiting_payment'
  | 'paid'
  | 'started'
  | 'submitted'
  | 'verified'
  | 'flagged'
  | 'rejected'
  | 'abandoned'
  | 'restored';

export interface AttemptView {
  id: string;
  status: AttemptStatus;
  attemptRef: `0x${string}`;
  entryId: `0x${string}`;
  weekId: number | null;
  paymentWeekId: number | null;
  entryTx: string | null;
  createdAt: string;
  startedAt: string | null;
  score: number | null;
  evidence: number | null;
  survivalMs: number | null;
  flags: string[];
  note: string | null;
}

export interface CreateAttemptResponse {
  attempt: AttemptView;
  entryContract: `0x${string}`;
  entryFee: string;
  wif: TokenInfo;
}

/** What a ranked voyage's bonus life costs, and the entry it is bought for (SocietyEntry.buyExtraLife). */
export interface ExtraLifeQuote {
  entryContract: `0x${string}`;
  entryId: `0x${string}`;
  extraLifeFee: string;
  wif: TokenInfo;
}

export interface ExtraLifeReport {
  /** `confirmed`: the voyage may carry on. `pending`: not mined or not yet confirmed; report again. */
  status: 'confirmed' | 'pending';
}

export interface StartAttemptResponse {
  attemptId: string;
  seed: string;
  version: string;
  startedAt: string;
  maxTicks: number;
}

export interface SubmitAttemptRequest {
  endTick: number;
  /** Delta-encoded [dt, steer, dt, steer, …] (see game-core encodeInputs). */
  inputs: number[];
  claimedScore: number;
  finalHash: string;
  checkpoints: string[];
}

export interface SubmitAttemptResponse {
  status: AttemptStatus;
  score: number;
  evidence: number;
  survivalMs: number;
  rank: number | null;
  personalBest: number | null;
  /** Points still needed to reach third place this week (0 if already in the top three). */
  pointsToThird: number | null;
  reason?: string;
}

export interface PlayerStats {
  address: string;
  displayName: string | null;
  registeredAt: string | null;
  weeklyBest: number | null;
  weeklyRank: number | null;
  allTimeBest: number | null;
  rankedAttempts: number;
  unusedEntries: number;
  fesEarned: string;
  recent: AttemptView[];
  /** Verified practice voyages, all time. */
  practiceRuns: number;
  /** Best verified practice score, all time. */
  practiceBest: number | null;
}

export type PracticeStatus = 'started' | 'verified' | 'rejected' | 'abandoned';

export interface StartPracticeResponse {
  runId: string;
  seed: string;
  version: string;
  startedAt: string;
}

/** A practice voyage, replayed by the server and logged on the practice board. Never ranked for prizes. */
export interface SubmitPracticeResponse {
  status: PracticeStatus;
  score: number;
  evidence: number;
  survivalMs: number;
  /** Where the explorer's best practice voyage of the week stands on the practice board. */
  rank: number | null;
  /** Best verified practice score, all time. */
  personalBest: number | null;
  reason?: string;
}

export interface SessionInfo {
  address: `0x${string}`;
  isAdmin: boolean;
  expiresAt: string;
}

export interface ApiError {
  error: string;
  message: string;
}
