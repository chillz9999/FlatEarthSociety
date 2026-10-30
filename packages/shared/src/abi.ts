import { parseAbi } from 'viem';

/**
 * SocietyEntry — accepts $WIF entry fees and bonus lives, splits each payment 50% to the prize vault and 50% to the
 * protocol treasury. Both fees are re-priced in WIF by the pricer as the market moves, within the admin's bounds.
 */
export const entryAbi = parseAbi([
  'event EntryPurchased(bytes32 indexed entryId, address indexed player, uint256 indexed weekId, bytes32 attemptRef, uint256 fee, uint256 rewardShare, uint256 protocolShare)',
  'event ExtraLifePurchased(bytes32 indexed entryId, address indexed player, uint256 indexed weekId, uint256 fee, uint256 rewardShare, uint256 protocolShare)',
  'event EntryFeeUpdated(uint256 previousFee, uint256 newFee)',
  'event ExtraLifeFeeUpdated(uint256 previousFee, uint256 newFee)',
  'event FeeBoundsUpdated(uint256 minEntryFee, uint256 maxEntryFee, uint256 minExtraLifeFee, uint256 maxExtraLifeFee)',
  'event ProtocolTreasuryUpdated(address previousTreasury, address newTreasury)',
  'event Paused(address account)',
  'event Unpaused(address account)',
  'function enter(bytes32 attemptRef, uint256 maxFee) returns (bytes32 entryId)',
  'function enterWithPermit(bytes32 attemptRef, uint256 maxFee, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (bytes32 entryId)',
  'function buyExtraLife(bytes32 entryId, uint256 maxFee)',
  'function updatePrices(uint256 newEntryFee, uint256 newExtraLifeFee)',
  'function setEntryFee(uint256 newFee)',
  'function setExtraLifeFee(uint256 newFee)',
  'function setFeeBounds(uint256 minEntry, uint256 maxEntry, uint256 minLife, uint256 maxLife)',
  'function setProtocolTreasury(address newTreasury)',
  'function pause()',
  'function unpause()',
  'function paused() view returns (bool)',
  'function currentWeekId() view returns (uint256)',
  'function computeEntryId(address player, bytes32 attemptRef) pure returns (bytes32)',
  'function isEntryUsed(bytes32 entryId) view returns (bool)',
  'function entries(bytes32) view returns (address player, uint64 weekId, uint128 fee)',
  'function entryFee() view returns (uint256)',
  'function extraLifeFee() view returns (uint256)',
  'function extraLifeBought(bytes32 entryId) view returns (bool)',
  'function minEntryFee() view returns (uint256)',
  'function maxEntryFee() view returns (uint256)',
  'function minExtraLifeFee() view returns (uint256)',
  'function maxExtraLifeFee() view returns (uint256)',
  'function PRICER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function protocolTreasury() view returns (address)',
  'function burnsProtocolShare() view returns (bool)',
  'function BURN_ADDRESS() view returns (address)',
  'function wif() view returns (address)',
  'function vault() view returns (address)',
]);

/**
 * SocietyPrizeVault — holds each week's WIF allocation and pays the top three. In-kind (wif == fes) the prizes are paid
 * in WIF itself; otherwise the allocation is first converted to the prize token.
 */
export const vaultAbi = parseAbi([
  'struct WeekView { uint256 weekId; uint256 startTime; uint256 endTime; uint256 wifAllocated; uint256 wifConverted; uint256 fesPool; bool finalized; uint256 finalizedAt; bytes32 resultsHash; address[3] winners; uint256[3] amounts; bool[3] claimed; uint256 rolledOver; }',
  'event AllocationRecorded(uint256 indexed weekId, bytes32 indexed entryId, uint256 wifAmount)',
  'event ConverterApproved(address indexed converter, bool approved)',
  'event WeekConverted(uint256 indexed weekId, address indexed converter, uint256 wifIn, uint256 fesOut)',
  'event WeekFunded(uint256 indexed weekId, address indexed funder, uint256 fesAmount)',
  'event PoolRolledOver(uint256 indexed fromWeek, uint256 indexed toWeek, uint256 amount)',
  'event WeekFinalized(uint256 indexed weekId, address[3] winners, uint256[3] amounts, bytes32 resultsHash)',
  'event RewardClaimed(uint256 indexed weekId, uint8 indexed rank, address indexed winner, uint256 amount)',
  'function convertWeek(uint256 weekId, uint256 wifAmount, address converter, uint256 minFesOut, uint256 deadline) returns (uint256 fesOut)',
  'function fundWeek(uint256 weekId, uint256 fesAmount)',
  'function finalizeWeek(uint256 weekId, address[3] winners, bytes32 resultsHash)',
  'function claim(uint256 weekId, uint8 rank) returns (uint256 amount)',
  'function claimFor(uint256 weekId, uint8 rank) returns (uint256 amount)',
  'function getWeek(uint256 weekId) view returns (WeekView)',
  'function isClaimed(uint256 weekId, uint8 rank) view returns (bool)',
  'function splitPool(uint256 pool) pure returns (uint256[3])',
  'function currentWeekId() view returns (uint256)',
  'function isApprovedConverter(address) view returns (bool)',
  'function totalWifUnconverted() view returns (uint256)',
  'function totalFesLiabilities() view returns (uint256)',
  'function wif() view returns (address)',
  'function fes() view returns (address)',
  'function inKind() view returns (bool)',
  'function paused() view returns (bool)',
]);

/** FixedRateConverter — the Society treasury desk: swaps a week's WIF allocation for FES at a published, timelocked rate. */
export const fixedRateConverterAbi = parseAbi([
  'event RateProposed(uint256 newRate, uint256 effectiveAt)',
  'event RateActivated(uint256 previousRate, uint256 newRate)',
  'event Converted(address indexed caller, address indexed recipient, uint256 wifIn, uint256 fesOut, uint256 rate)',
  'function quote(uint256 wifIn) view returns (uint256)',
  'function inventory() view returns (uint256)',
  'function rate() view returns (uint256)',
  'function pendingRate() view returns (uint256)',
  'function pendingRateEffectiveAt() view returns (uint256)',
  'function wifSink() view returns (address)',
  'function RATE_DELAY() view returns (uint256)',
]);

/** Demo-only mock token faucet (local / testnet). */
export const mockTokenAbi = parseAbi(['function mint(address to, uint256 amount)']);
