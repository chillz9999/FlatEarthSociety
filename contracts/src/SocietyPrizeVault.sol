// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IFesConverter} from "./interfaces/IFesConverter.sol";
import {ISocietyPrizeVault} from "./interfaces/ISocietyPrizeVault.sol";
import {SocietyWeeks} from "./libraries/SocietyWeeks.sol";

/// @title SocietyPrizeVault
/// @notice Custodies the weekly rewards of The Flat Earth Society competition.
/// @dev Lifecycle of a week:
///      1. `SocietyEntry` sends 50% of every entry fee here and calls {notifyEntryAllocation}
///         (WIF is credited to the week of the payment).
///      2. The settler converts the week's WIF into FES through an approved converter with
///         {convertWeek} (minimum output + deadline; may be split across several calls).
///      3. Anyone may add FES to a week with {fundWeek} (always disclosed onchain).
///      4. After the week ends and all of its WIF has been converted, the settler calls
///         {finalizeWeek} with the top 3: 50% / 30% / 20% of the FES pool. Shares of empty
///         ranks roll over into the next week's pool.
///      5. Winners call {claim}, or anyone calls {claimFor} to push the payout to the winner.
///      The admin can never withdraw WIF or FES from this contract.
///      In-kind mode: deployed with the same token as `wif` and `fes`, the prizes are paid in WIF itself.
///      Every allocation is then credited straight to the week's pool and there is nothing to convert.
contract SocietyPrizeVault is ISocietyPrizeVault, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Role of the entry contract, allowed to record WIF allocations.
    bytes32 public constant ENTRY_ROLE = keccak256("ENTRY_ROLE");
    /// @notice Role of the backend settlement key: converts WIF and finalizes weeks.
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    /// @notice Role allowed to pause and unpause claims.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Basis-point denominator for reward shares.
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Share of the weekly pool for 1st place (50%).
    uint256 public constant FIRST_PLACE_BPS = 5_000;
    /// @notice Share of the weekly pool for 2nd place (30%).
    uint256 public constant SECOND_PLACE_BPS = 3_000;
    /// @notice Share of the weekly pool for 3rd place (20%, computed as the remainder so no dust is lost).
    uint256 public constant THIRD_PLACE_BPS = 2_000;

    /// @dev Storage layout of one week.
    struct Week {
        uint256 wifAllocated;
        uint256 wifConverted;
        uint256 fesPool;
        address[3] winners;
        uint256[3] amounts;
        bytes32 resultsHash;
        uint64 finalizedAt;
        uint8 claimedMask;
        bool finalized;
    }

    /// @notice The $WIF token in which entry fees (and therefore reward allocations) are paid.
    IERC20 public immutable wif;
    /// @notice The $FES token in which weekly rewards are paid (the same as `wif` in in-kind mode).
    IERC20 public immutable fes;
    /// @notice Whether prizes are paid in WIF itself (`wif == fes`), with no conversion.
    bool public immutable inKind;

    /// @notice Whether a converter may be used by {convertWeek}.
    mapping(address converter => bool approved) public isApprovedConverter;

    /// @notice Sum over all weeks of `wifAllocated - wifConverted` (equals the vault's WIF balance).
    uint256 public totalWifUnconverted;

    /// @notice FES owed by the vault: sum of unfinalized week pools plus unclaimed rewards of settled weeks.
    uint256 public totalFesLiabilities;

    mapping(uint256 weekId => Week) internal _weeks;

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice A required amount was zero.
    error ZeroAmount();
    /// @notice Allocations can only be credited to the current week.
    /// @param weekId Requested week.
    /// @param currentWeekId Current week.
    error AllocationWeekMismatch(uint256 weekId, uint256 currentWeekId);
    /// @notice The vault does not hold the WIF being credited.
    /// @param balance Vault WIF balance.
    /// @param required Required balance (`totalWifUnconverted + wifAmount`).
    error AllocationNotFunded(uint256 balance, uint256 required);
    /// @notice The converter is not approved.
    /// @param converter The converter.
    error ConverterNotApproved(address converter);
    /// @notice The deadline has passed.
    /// @param deadline The deadline supplied.
    error DeadlineExpired(uint256 deadline);
    /// @notice The minimum output must be non-zero.
    error ZeroMinOutput();
    /// @notice The conversion would exceed the week's unconverted WIF.
    /// @param requested WIF requested.
    /// @param available Unconverted WIF of the week.
    error ExceedsUnconvertedAllocation(uint256 requested, uint256 available);
    /// @notice The converter did not pull exactly the requested WIF.
    /// @param expected WIF requested.
    /// @param actual WIF that left the vault.
    error UnexpectedWifSpent(uint256 expected, uint256 actual);
    /// @notice The vault received less FES than the minimum.
    /// @param received FES received.
    /// @param minimum Minimum required.
    error InsufficientOutput(uint256 received, uint256 minimum);
    /// @notice The week has already been finalized.
    /// @param weekId The week.
    error WeekAlreadyFinalized(uint256 weekId);
    /// @notice The week has not ended yet.
    /// @param weekId The week.
    /// @param weekEnd Timestamp at which the week ends.
    error WeekNotEnded(uint256 weekId, uint256 weekEnd);
    /// @notice Part of the week's WIF allocation has not been converted.
    /// @param weekId The week.
    /// @param unconverted Unconverted WIF.
    error UnconvertedAllocation(uint256 weekId, uint256 unconverted);
    /// @notice Non-zero winners must come before zero (empty) ranks.
    error InvalidWinnerOrder();
    /// @notice The same address appears twice among the winners.
    /// @param winner The duplicated winner.
    error DuplicateWinner(address winner);
    /// @notice Rollover target week is already finalized.
    /// @param weekId The next week.
    error NextWeekAlreadyFinalized(uint256 weekId);
    /// @notice The week has not been finalized.
    /// @param weekId The week.
    error WeekNotFinalized(uint256 weekId);
    /// @notice Rank must be 0, 1 or 2.
    /// @param rank The rank supplied.
    error InvalidRank(uint8 rank);
    /// @notice The rank has no winner.
    /// @param weekId The week.
    /// @param rank The rank.
    error NoWinnerForRank(uint256 weekId, uint8 rank);
    /// @notice The caller is not the winner of the rank.
    /// @param caller The caller.
    /// @param winner The recorded winner.
    error NotWinner(address caller, address winner);
    /// @notice The reward has already been claimed.
    /// @param weekId The week.
    /// @param rank The rank.
    error AlreadyClaimed(uint256 weekId, uint8 rank);
    /// @notice The rank's reward is zero.
    /// @param weekId The week.
    /// @param rank The rank.
    error NothingToClaim(uint256 weekId, uint8 rank);
    /// @notice The token received differs from the amount requested.
    /// @param expected Amount requested.
    /// @param received Amount received.
    error UnexpectedAmountReceived(uint256 expected, uint256 received);
    /// @notice WIF and FES can never be rescued.
    /// @param token The prize token.
    error CannotRescuePrizeToken(address token);

    /// @notice Deploys the vault.
    /// @param wif_ The $WIF token (entry fee / allocation token).
    /// @param fes_ The $FES token (reward token).
    /// @param admin Receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE.
    constructor(IERC20 wif_, IERC20 fes_, address admin) {
        if (address(wif_) == address(0) || address(fes_) == address(0) || admin == address(0)) revert ZeroAddress();
        wif = wif_;
        fes = fes_;
        inKind = address(wif_) == address(fes_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------------------------------------
    // Allocation (ENTRY_ROLE)
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISocietyPrizeVault
    function notifyEntryAllocation(uint256 weekId, bytes32 entryId, uint256 wifAmount)
        external
        onlyRole(ENTRY_ROLE)
        nonReentrant
    {
        if (wifAmount == 0) revert ZeroAmount();
        uint256 current = SocietyWeeks.weekIdAt(block.timestamp);
        if (weekId != current) revert AllocationWeekMismatch(weekId, current);
        uint256 balance = wif.balanceOf(address(this));
        Week storage w = _weeks[weekId];

        // A week's allocation can only grow while the week is current, and a week can only be
        // finalized after it ended, so the week receiving the allocation is never finalized.
        if (inKind) {
            // The WIF is the prize: it joins the pool as it is, already "converted".
            uint256 owed = totalFesLiabilities + wifAmount;
            if (balance < owed) revert AllocationNotFunded(balance, owed);
            w.wifAllocated += wifAmount;
            w.wifConverted += wifAmount;
            w.fesPool += wifAmount;
            totalFesLiabilities = owed;
        } else {
            uint256 required = totalWifUnconverted + wifAmount;
            if (balance < required) revert AllocationNotFunded(balance, required);
            w.wifAllocated += wifAmount;
            totalWifUnconverted = required;
        }

        emit AllocationRecorded(weekId, entryId, wifAmount);
    }

    // ---------------------------------------------------------------------------------------------
    // Conversion (SETTLER_ROLE)
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISocietyPrizeVault
    function convertWeek(uint256 weekId, uint256 wifAmount, address converter, uint256 minFesOut, uint256 deadline)
        external
        onlyRole(SETTLER_ROLE)
        nonReentrant
        returns (uint256 fesOut)
    {
        if (!isApprovedConverter[converter]) revert ConverterNotApproved(converter);
        // Time-based by design (weekly competition / timelock); sequencer drift is irrelevant at this granularity.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        if (wifAmount == 0) revert ZeroAmount();
        if (minFesOut == 0) revert ZeroMinOutput();

        Week storage w = _weeks[weekId];
        if (w.finalized) revert WeekAlreadyFinalized(weekId);
        uint256 available = w.wifAllocated - w.wifConverted;
        if (wifAmount > available) revert ExceedsUnconvertedAllocation(wifAmount, available);

        w.wifConverted += wifAmount;
        totalWifUnconverted -= wifAmount;

        uint256 wifBefore = wif.balanceOf(address(this));
        uint256 fesBefore = fes.balanceOf(address(this));

        wif.forceApprove(converter, wifAmount);
        IFesConverter(converter).convert(wifAmount, minFesOut, address(this));
        wif.forceApprove(converter, 0);

        uint256 wifSpent = wifBefore - wif.balanceOf(address(this));
        if (wifSpent != wifAmount) revert UnexpectedWifSpent(wifAmount, wifSpent);
        fesOut = fes.balanceOf(address(this)) - fesBefore;
        if (fesOut < minFesOut) revert InsufficientOutput(fesOut, minFesOut);

        w.fesPool += fesOut;
        totalFesLiabilities += fesOut;

        emit WeekConverted(weekId, converter, wifAmount, fesOut);
    }

    // ---------------------------------------------------------------------------------------------
    // Top-ups (anyone)
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISocietyPrizeVault
    function fundWeek(uint256 weekId, uint256 fesAmount) external nonReentrant {
        if (fesAmount == 0) revert ZeroAmount();
        Week storage w = _weeks[weekId];
        if (w.finalized) revert WeekAlreadyFinalized(weekId);

        uint256 balanceBefore = fes.balanceOf(address(this));
        fes.safeTransferFrom(msg.sender, address(this), fesAmount);
        uint256 received = fes.balanceOf(address(this)) - balanceBefore;
        if (received != fesAmount) revert UnexpectedAmountReceived(fesAmount, received);

        w.fesPool += fesAmount;
        totalFesLiabilities += fesAmount;

        emit WeekFunded(weekId, msg.sender, fesAmount);
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement (SETTLER_ROLE)
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISocietyPrizeVault
    function finalizeWeek(uint256 weekId, address[3] calldata winners, bytes32 resultsHash)
        external
        onlyRole(SETTLER_ROLE)
        nonReentrant
    {
        Week storage w = _weeks[weekId];
        if (w.finalized) revert WeekAlreadyFinalized(weekId);
        uint256 end = SocietyWeeks.weekEnd(weekId);
        // Time-based by design (weekly competition / timelock); sequencer drift is irrelevant at this granularity.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < end) revert WeekNotEnded(weekId, end);
        if (w.wifConverted != w.wifAllocated) revert UnconvertedAllocation(weekId, w.wifAllocated - w.wifConverted);
        _validateWinners(winners);

        uint256[3] memory shares = splitPool(w.fesPool);
        uint256[3] memory amounts;
        uint256 rolledOver;
        for (uint256 i; i < 3; ++i) {
            if (winners[i] == address(0)) {
                rolledOver += shares[i];
            } else {
                w.winners[i] = winners[i];
                w.amounts[i] = shares[i];
                amounts[i] = shares[i];
            }
        }

        w.finalized = true;
        w.finalizedAt = SafeCast.toUint64(block.timestamp);
        w.resultsHash = resultsHash;

        if (rolledOver != 0) {
            uint256 nextWeekId = weekId + 1;
            Week storage next = _weeks[nextWeekId];
            if (next.finalized) revert NextWeekAlreadyFinalized(nextWeekId);
            next.fesPool += rolledOver;
            emit PoolRolledOver(weekId, nextWeekId, rolledOver);
        }

        emit WeekFinalized(weekId, winners, amounts, resultsHash);
    }

    // ---------------------------------------------------------------------------------------------
    // Claims
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISocietyPrizeVault
    function claim(uint256 weekId, uint8 rank) external whenNotPaused nonReentrant returns (uint256 amount) {
        return _claim(weekId, rank, true);
    }

    /// @inheritdoc ISocietyPrizeVault
    function claimFor(uint256 weekId, uint8 rank) external whenNotPaused nonReentrant returns (uint256 amount) {
        return _claim(weekId, rank, false);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISocietyPrizeVault
    function setConverter(address converter, bool approved) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (converter == address(0)) revert ZeroAddress();
        isApprovedConverter[converter] = approved;
        emit ConverterApproved(converter, approved);
    }

    /// @notice Pauses claims.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes claims.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Returns tokens other than WIF and FES that were sent to the vault by mistake.
    /// @dev Reverts for WIF and FES: prize funds can never be withdrawn by the admin.
    /// @param token Token to rescue.
    /// @param to Recipient.
    /// @param amount Amount to transfer.
    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (token == address(wif) || token == address(fes)) revert CannotRescuePrizeToken(token);
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISocietyPrizeVault
    function getWeek(uint256 weekId) external view returns (WeekView memory view_) {
        Week storage w = _weeks[weekId];
        view_.weekId = weekId;
        view_.startTime = SocietyWeeks.weekStart(weekId);
        view_.endTime = SocietyWeeks.weekEnd(weekId);
        view_.wifAllocated = w.wifAllocated;
        view_.wifConverted = w.wifConverted;
        view_.fesPool = w.fesPool;
        view_.finalized = w.finalized;
        view_.finalizedAt = w.finalizedAt;
        view_.resultsHash = w.resultsHash;
        view_.winners = w.winners;
        view_.amounts = w.amounts;
        uint8 mask = w.claimedMask;
        for (uint256 i; i < 3; ++i) {
            view_.claimed[i] = (mask >> i) & 1 == 1;
        }
        if (w.finalized) {
            view_.rolledOver = w.fesPool - (w.amounts[0] + w.amounts[1] + w.amounts[2]);
        }
    }

    /// @notice Splits a pool into the 1st / 2nd / 3rd place amounts (50% / 30% / 20%).
    /// @dev `first = pool * 5000 / 10000`, `second = pool * 3000 / 10000`, `third = pool - first - second`,
    ///      so the three amounts always sum to `pool` exactly.
    /// @param pool The FES pool.
    /// @return shares The amounts for ranks 0, 1 and 2.
    function splitPool(uint256 pool) public pure returns (uint256[3] memory shares) {
        // mulDiv == pool * bps / 10_000 exactly, without overflow for any pool size.
        shares[0] = Math.mulDiv(pool, FIRST_PLACE_BPS, BPS_DENOMINATOR);
        shares[1] = Math.mulDiv(pool, SECOND_PLACE_BPS, BPS_DENOMINATOR);
        shares[2] = pool - shares[0] - shares[1];
    }

    /// @notice Returns the current competition week id.
    /// @return The week id containing `block.timestamp`.
    function currentWeekId() external view returns (uint256) {
        return SocietyWeeks.weekIdAt(block.timestamp);
    }

    /// @notice Returns the week id containing timestamp `ts`.
    /// @param ts Unix timestamp.
    /// @return The week id.
    function weekIdAt(uint256 ts) external pure returns (uint256) {
        return SocietyWeeks.weekIdAt(ts);
    }

    /// @notice Returns the first second of week `weekId` (Monday 00:00:00 UTC).
    /// @param weekId The week id.
    /// @return Start timestamp (inclusive).
    function weekStart(uint256 weekId) external pure returns (uint256) {
        return SocietyWeeks.weekStart(weekId);
    }

    /// @notice Returns the end of week `weekId` (next Monday 00:00:00 UTC, exclusive).
    /// @param weekId The week id.
    /// @return End timestamp (exclusive).
    function weekEnd(uint256 weekId) external pure returns (uint256) {
        return SocietyWeeks.weekEnd(weekId);
    }

    /// @notice Returns whether `rank` of `weekId` has been claimed.
    /// @param weekId The week id.
    /// @param rank The rank (0, 1 or 2).
    /// @return True if claimed.
    function isClaimed(uint256 weekId, uint8 rank) external view returns (bool) {
        if (rank >= 3) revert InvalidRank(rank);
        return (_weeks[weekId].claimedMask >> rank) & 1 == 1;
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _claim(uint256 weekId, uint8 rank, bool onlyWinner) internal returns (uint256 amount) {
        Week storage w = _weeks[weekId];
        if (!w.finalized) revert WeekNotFinalized(weekId);
        if (rank >= 3) revert InvalidRank(rank);
        address winner = w.winners[rank];
        if (winner == address(0)) revert NoWinnerForRank(weekId, rank);
        if (onlyWinner && msg.sender != winner) revert NotWinner(msg.sender, winner);
        uint8 mask = w.claimedMask;
        if ((mask >> rank) & 1 == 1) revert AlreadyClaimed(weekId, rank);
        amount = w.amounts[rank];
        if (amount == 0) revert NothingToClaim(weekId, rank);

        w.claimedMask = mask | uint8(2 ** rank);
        totalFesLiabilities -= amount;
        fes.safeTransfer(winner, amount);

        emit RewardClaimed(weekId, rank, winner, amount);
    }

    function _validateWinners(address[3] calldata winners) internal pure {
        bool seenEmpty;
        for (uint256 i; i < 3; ++i) {
            address winner = winners[i];
            if (winner == address(0)) {
                seenEmpty = true;
                continue;
            }
            if (seenEmpty) revert InvalidWinnerOrder();
            for (uint256 j; j < i; ++j) {
                if (winners[j] == winner) revert DuplicateWinner(winner);
            }
        }
    }
}
