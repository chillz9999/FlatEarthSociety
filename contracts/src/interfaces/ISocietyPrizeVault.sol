// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ISocietyPrizeVault
/// @notice External surface of the Society prize vault: weekly WIF reward allocations,
///         WIF -> FES conversion, weekly settlement (top 3 = 50% / 30% / 20%) and claims.
interface ISocietyPrizeVault {
    /// @notice Full public state of one competition week.
    /// @param weekId The week id.
    /// @param startTime First second of the week (Monday 00:00:00 UTC, inclusive).
    /// @param endTime End of the week (next Monday 00:00:00 UTC, exclusive).
    /// @param wifAllocated Total WIF reward share credited to this week by entries.
    /// @param wifConverted Portion of `wifAllocated` already converted to FES.
    /// @param fesPool Total FES prize pool of the week (conversions + top-ups + rollovers in).
    /// @param finalized Whether the week has been settled.
    /// @param finalizedAt Timestamp of settlement (0 while unfinalized).
    /// @param resultsHash Hash of the off-chain results/leaderboard snapshot committed at settlement.
    /// @param winners Winners by rank (index 0 = 1st). Zero address = no winner for that rank.
    /// @param amounts FES amount assigned to each rank (0 for empty ranks).
    /// @param claimed Whether each rank's reward has been paid out.
    /// @param rolledOver FES moved to the next week's pool at settlement for empty ranks.
    struct WeekView {
        uint256 weekId;
        uint256 startTime;
        uint256 endTime;
        uint256 wifAllocated;
        uint256 wifConverted;
        uint256 fesPool;
        bool finalized;
        uint256 finalizedAt;
        bytes32 resultsHash;
        address[3] winners;
        uint256[3] amounts;
        bool[3] claimed;
        uint256 rolledOver;
    }

    /// @notice Emitted when an entry's WIF reward share is credited to a week.
    /// @param weekId Week credited.
    /// @param entryId Entry that produced the allocation.
    /// @param wifAmount WIF amount credited (raw units).
    event AllocationRecorded(uint256 indexed weekId, bytes32 indexed entryId, uint256 wifAmount);

    /// @notice Emitted when a converter is approved or revoked.
    /// @param converter Converter contract.
    /// @param approved New approval status.
    event ConverterApproved(address indexed converter, bool approved);

    /// @notice Emitted when part (or all) of a week's WIF allocation is converted into FES.
    /// @param weekId Week whose allocation was converted.
    /// @param converter Approved converter used.
    /// @param wifIn WIF sent to the converter.
    /// @param fesOut FES actually received by the vault (measured balance delta).
    event WeekConverted(uint256 indexed weekId, address indexed converter, uint256 wifIn, uint256 fesOut);

    /// @notice Emitted when FES is added to a week's pool directly (Society top-up / sponsorship).
    /// @param weekId Week funded.
    /// @param funder Address that supplied the FES.
    /// @param fesAmount FES received (raw units).
    event WeekFunded(uint256 indexed weekId, address indexed funder, uint256 fesAmount);

    /// @notice Emitted when unassigned shares of a settled week roll into the next week's pool.
    /// @param fromWeek Week that was settled with fewer than 3 winners.
    /// @param toWeek Week receiving the FES (`fromWeek + 1`).
    /// @param amount FES rolled over.
    event PoolRolledOver(uint256 indexed fromWeek, uint256 indexed toWeek, uint256 amount);

    /// @notice Emitted when a week is settled.
    /// @param weekId Week settled.
    /// @param winners Winners by rank (zero address = empty rank).
    /// @param amounts FES assigned per rank (0 for empty ranks).
    /// @param resultsHash Hash committing to the off-chain results.
    event WeekFinalized(uint256 indexed weekId, address[3] winners, uint256[3] amounts, bytes32 resultsHash);

    /// @notice Emitted when a winner's reward is paid.
    /// @param weekId Week of the reward.
    /// @param rank Rank paid (0 = 1st, 1 = 2nd, 2 = 3rd).
    /// @param winner Recipient of the FES.
    /// @param amount FES paid.
    event RewardClaimed(uint256 indexed weekId, uint8 indexed rank, address indexed winner, uint256 amount);

    /// @notice Emitted when the admin rescues a non-prize token sent to the vault by mistake.
    /// @param token Token rescued.
    /// @param to Recipient.
    /// @param amount Amount rescued.
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /// @notice The $WIF token in which entry fees (and therefore reward allocations) are paid.
    /// @return The WIF token.
    function wif() external view returns (IERC20);

    /// @notice The $FES token in which weekly rewards are paid.
    /// @return The FES token.
    function fes() external view returns (IERC20);

    /// @notice Credits `wifAmount` WIF (already transferred to the vault) to week `weekId`.
    /// @dev Restricted to ENTRY_ROLE. `weekId` must be the current week.
    /// @param weekId Week of the payment.
    /// @param entryId Entry id producing the allocation.
    /// @param wifAmount WIF reward share.
    function notifyEntryAllocation(uint256 weekId, bytes32 entryId, uint256 wifAmount) external;

    /// @notice Approves or revokes a WIF -> FES converter.
    /// @param converter Converter address.
    /// @param approved Whether it may be used by `convertWeek`.
    function setConverter(address converter, bool approved) external;

    /// @notice Converts part of a week's unconverted WIF allocation into FES through an approved converter.
    /// @param weekId Week whose allocation is converted.
    /// @param wifAmount WIF to convert.
    /// @param converter Approved converter.
    /// @param minFesOut Minimum FES the vault must receive (slippage protection).
    /// @param deadline Latest timestamp at which the conversion may execute.
    /// @return fesOut FES actually received (measured balance delta).
    function convertWeek(uint256 weekId, uint256 wifAmount, address converter, uint256 minFesOut, uint256 deadline)
        external
        returns (uint256 fesOut);

    /// @notice Adds FES from the caller to week `weekId`'s pool.
    /// @param weekId Week to fund (must not be finalized).
    /// @param fesAmount FES to pull from the caller.
    function fundWeek(uint256 weekId, uint256 fesAmount) external;

    /// @notice Settles week `weekId` with its top 3 winners.
    /// @param weekId Week to settle.
    /// @param winners Winners by rank; non-zero addresses first, then zero addresses for empty ranks.
    /// @param resultsHash Hash committing to the off-chain results snapshot.
    function finalizeWeek(uint256 weekId, address[3] calldata winners, bytes32 resultsHash) external;

    /// @notice Claims the caller's reward for `rank` in week `weekId`.
    /// @param weekId Settled week.
    /// @param rank Rank (0 = 1st, 1 = 2nd, 2 = 3rd).
    /// @return amount FES paid.
    function claim(uint256 weekId, uint8 rank) external returns (uint256 amount);

    /// @notice Pays the recorded winner of `rank` in week `weekId`. Callable by anyone.
    /// @param weekId Settled week.
    /// @param rank Rank (0 = 1st, 1 = 2nd, 2 = 3rd).
    /// @return amount FES paid to the recorded winner.
    function claimFor(uint256 weekId, uint8 rank) external returns (uint256 amount);

    /// @notice Returns the full state of week `weekId`.
    /// @param weekId The week id.
    /// @return The week view.
    function getWeek(uint256 weekId) external view returns (WeekView memory);
}
