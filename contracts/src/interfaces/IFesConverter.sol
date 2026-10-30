// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IFesConverter
/// @notice Converts $WIF into $FES for the Society prize vault.
/// @dev Implementations pull exactly `wifIn` WIF from `msg.sender` (which must have approved
///      the converter beforehand) and deliver FES to `recipient`. Implementations MUST revert
///      when fewer than `minFesOut` FES would be delivered. Callers should not trust the return
///      value and should measure the balance change of `recipient` instead.
interface IFesConverter {
    /// @notice Converts `wifIn` WIF pulled from the caller into FES sent to `recipient`.
    /// @param wifIn Amount of WIF (raw units) to pull from `msg.sender`.
    /// @param minFesOut Minimum FES (raw units) that `recipient` must receive.
    /// @param recipient Address that receives the FES.
    /// @return fesOut Amount of FES (raw units) delivered to `recipient`.
    function convert(uint256 wifIn, uint256 minFesOut, address recipient) external returns (uint256 fesOut);
}
