// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SocietyWeeks
/// @notice Weekly competition calendar used by every Society contract.
/// @dev Weeks run Monday 00:00:00 UTC through Sunday 23:59:59 UTC. Week 0 starts at
///      `EPOCH` (Monday 1970-01-05 00:00:00 UTC). `weekEnd` is exclusive: it equals the
///      start of the following week.
library SocietyWeeks {
    /// @notice Unix timestamp of Monday 1970-01-05 00:00:00 UTC, the start of week 0.
    uint256 internal constant EPOCH = 345_600;

    /// @notice Length of one competition week in seconds (7 days).
    uint256 internal constant WEEK = 604_800;

    /// @notice Thrown when a timestamp precedes the start of week 0.
    /// @param timestamp The offending timestamp.
    error TimestampBeforeEpoch(uint256 timestamp);

    /// @notice Returns the week id containing timestamp `ts`.
    /// @param ts Unix timestamp in seconds. Must be >= `EPOCH`.
    /// @return The week id, `(ts - EPOCH) / WEEK`.
    function weekIdAt(uint256 ts) internal pure returns (uint256) {
        if (ts < EPOCH) revert TimestampBeforeEpoch(ts);
        unchecked {
            return (ts - EPOCH) / WEEK;
        }
    }

    /// @notice Returns the first second (Monday 00:00:00 UTC) of week `id`.
    /// @param id The week id.
    /// @return Unix timestamp of the start of the week (inclusive).
    function weekStart(uint256 id) internal pure returns (uint256) {
        return EPOCH + id * WEEK;
    }

    /// @notice Returns the exclusive end of week `id` (the start of week `id + 1`).
    /// @param id The week id.
    /// @return Unix timestamp of the end of the week (exclusive).
    function weekEnd(uint256 id) internal pure returns (uint256) {
        return weekStart(id + 1);
    }
}
