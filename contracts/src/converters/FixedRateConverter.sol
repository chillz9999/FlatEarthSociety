// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IFesConverter} from "../interfaces/IFesConverter.sol";

/// @title FixedRateConverter ("Society treasury desk")
/// @notice Sells FES from a pre-funded inventory for WIF at a public, timelocked fixed rate.
/// @dev `rate` is the number of raw FES units paid per 1e18 raw WIF units, so
///      `fesOut = wifIn * rate / 1e18` works for any combination of token decimals.
///      Example: WIF with 6 decimals, FES with 18 decimals, 1 WIF = 2 FES -> rate = 2e30.
///      Rate changes are proposed publicly and can only be activated after `RATE_DELAY`.
///      Received WIF is forwarded to `wifSink`. Anyone can fund the FES inventory with a plain
///      ERC-20 transfer to this contract.
contract FixedRateConverter is IFesConverter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to propose, activate and cancel rate changes.
    bytes32 public constant RATE_MANAGER_ROLE = keccak256("RATE_MANAGER_ROLE");

    /// @notice Minimum delay between a rate proposal and its activation.
    uint256 public constant RATE_DELAY = 24 hours;

    /// @notice Fixed-point base of `rate` (FES raw units per this many raw WIF units).
    uint256 public constant RATE_PRECISION = 1e18;

    /// @notice The $WIF token accepted.
    IERC20 public immutable wif;

    /// @notice The $FES token paid out from inventory.
    IERC20 public immutable fes;

    /// @notice Active rate: raw FES units per 1e18 raw WIF units.
    uint256 public rate;

    /// @notice Proposed rate waiting for activation (0 if none).
    uint256 public pendingRate;

    /// @notice Earliest timestamp at which `pendingRate` can be activated (0 if none).
    uint256 public pendingRateEffectiveAt;

    /// @notice Address receiving all WIF paid into the desk (Society treasury).
    address public wifSink;

    /// @notice Contracts allowed to call {convert} (the prize vault).
    mapping(address caller => bool authorized) public authorizedCaller;

    /// @notice Emitted when a new rate is proposed.
    /// @param newRate Proposed rate.
    /// @param effectiveAt Earliest activation timestamp.
    event RateProposed(uint256 newRate, uint256 effectiveAt);

    /// @notice Emitted when a rate becomes active (also at deployment, with `previousRate = 0`).
    /// @param previousRate Previous rate.
    /// @param newRate New active rate.
    event RateActivated(uint256 previousRate, uint256 newRate);

    /// @notice Emitted when a pending rate proposal is cancelled.
    /// @param cancelledRate The rate that will not be activated.
    event RateProposalCancelled(uint256 cancelledRate);

    /// @notice Emitted when the WIF sink changes.
    /// @param previousSink Old sink (zero address at deployment).
    /// @param newSink New sink.
    event WifSinkUpdated(address previousSink, address newSink);

    /// @notice Emitted when a caller is authorized or deauthorized.
    /// @param caller The caller.
    /// @param authorized New status.
    event CallerAuthorizationUpdated(address indexed caller, bool authorized);

    /// @notice Emitted on every conversion.
    /// @param caller Authorized caller (the vault).
    /// @param recipient FES recipient.
    /// @param wifIn WIF received (forwarded to `wifSink`).
    /// @param fesOut FES paid.
    /// @param rate Rate used.
    event Converted(address indexed caller, address indexed recipient, uint256 wifIn, uint256 fesOut, uint256 rate);

    /// @notice Emitted when the admin withdraws FES inventory.
    /// @param to Recipient.
    /// @param amount FES withdrawn.
    event InventoryWithdrawn(address indexed to, uint256 amount);

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice A required amount was zero.
    error ZeroAmount();
    /// @notice WIF and FES must be different tokens.
    error IdenticalTokens();
    /// @notice The rate must be non-zero.
    error InvalidRate();
    /// @notice The WIF sink may not be this contract.
    error InvalidSink();
    /// @notice There is no pending rate proposal.
    error NoPendingRate();
    /// @notice The pending rate cannot be activated yet.
    /// @param effectiveAt Earliest activation timestamp.
    error RateNotYetEffective(uint256 effectiveAt);
    /// @notice The caller is not authorized to convert.
    /// @param caller The caller.
    error UnauthorizedCaller(address caller);
    /// @notice The conversion would pay zero FES.
    error ZeroOutput();
    /// @notice The conversion pays less than the minimum requested.
    /// @param fesOut FES that would be paid.
    /// @param minFesOut Minimum requested.
    error InsufficientOutput(uint256 fesOut, uint256 minFesOut);
    /// @notice The desk does not hold enough FES.
    /// @param available FES inventory.
    /// @param required FES required.
    error InsufficientInventory(uint256 available, uint256 required);

    /// @notice Deploys the desk.
    /// @param wif_ The $WIF token.
    /// @param fes_ The $FES token.
    /// @param initialRate Initial rate (active immediately), raw FES per 1e18 raw WIF.
    /// @param wifSink_ Recipient of the WIF paid into the desk.
    /// @param admin Receives DEFAULT_ADMIN_ROLE and RATE_MANAGER_ROLE.
    constructor(IERC20 wif_, IERC20 fes_, uint256 initialRate, address wifSink_, address admin) {
        if (address(wif_) == address(0) || address(fes_) == address(0) || admin == address(0)) revert ZeroAddress();
        if (address(wif_) == address(fes_)) revert IdenticalTokens();
        if (initialRate == 0) revert InvalidRate();
        wif = wif_;
        fes = fes_;
        rate = initialRate;
        emit RateActivated(0, initialRate);
        _setWifSink(wifSink_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RATE_MANAGER_ROLE, admin);
    }

    // ---------------------------------------------------------------------------------------------
    // Conversion
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFesConverter
    function convert(uint256 wifIn, uint256 minFesOut, address recipient)
        external
        nonReentrant
        returns (uint256 fesOut)
    {
        if (!authorizedCaller[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (wifIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 currentRate = rate;
        fesOut = Math.mulDiv(wifIn, currentRate, RATE_PRECISION);
        if (fesOut == 0) revert ZeroOutput();
        if (fesOut < minFesOut) revert InsufficientOutput(fesOut, minFesOut);
        uint256 available = fes.balanceOf(address(this));
        if (available < fesOut) revert InsufficientInventory(available, fesOut);

        wif.safeTransferFrom(msg.sender, wifSink, wifIn);
        fes.safeTransfer(recipient, fesOut);

        emit Converted(msg.sender, recipient, wifIn, fesOut, currentRate);
    }

    // ---------------------------------------------------------------------------------------------
    // Rate management (RATE_MANAGER_ROLE)
    // ---------------------------------------------------------------------------------------------

    /// @notice Proposes a new rate, activatable after `RATE_DELAY`. Replaces any pending proposal.
    /// @param newRate Proposed rate (non-zero), raw FES per 1e18 raw WIF.
    function proposeRate(uint256 newRate) external onlyRole(RATE_MANAGER_ROLE) {
        if (newRate == 0) revert InvalidRate();
        uint256 effectiveAt = block.timestamp + RATE_DELAY;
        pendingRate = newRate;
        pendingRateEffectiveAt = effectiveAt;
        emit RateProposed(newRate, effectiveAt);
    }

    /// @notice Activates the pending rate once its delay has elapsed.
    function activateRate() external onlyRole(RATE_MANAGER_ROLE) {
        uint256 newRate = pendingRate;
        if (newRate == 0) revert NoPendingRate();
        uint256 effectiveAt = pendingRateEffectiveAt;
        // Time-based by design (weekly competition / timelock); sequencer drift is irrelevant at this granularity.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < effectiveAt) revert RateNotYetEffective(effectiveAt);
        uint256 previousRate = rate;
        rate = newRate;
        pendingRate = 0;
        pendingRateEffectiveAt = 0;
        emit RateActivated(previousRate, newRate);
    }

    /// @notice Cancels the pending rate proposal.
    function cancelRateProposal() external onlyRole(RATE_MANAGER_ROLE) {
        uint256 cancelled = pendingRate;
        if (cancelled == 0) revert NoPendingRate();
        pendingRate = 0;
        pendingRateEffectiveAt = 0;
        emit RateProposalCancelled(cancelled);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin (DEFAULT_ADMIN_ROLE)
    // ---------------------------------------------------------------------------------------------

    /// @notice Authorizes or deauthorizes a caller of {convert}.
    /// @param caller The caller (the prize vault).
    /// @param authorized New status.
    function setAuthorizedCaller(address caller, bool authorized) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCaller[caller] = authorized;
        emit CallerAuthorizationUpdated(caller, authorized);
    }

    /// @notice Changes the address receiving WIF.
    /// @param newSink New sink (non-zero, not this contract).
    function setWifSink(address newSink) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setWifSink(newSink);
    }

    /// @notice Withdraws FES inventory.
    /// @param amount FES to withdraw.
    /// @param to Recipient.
    function withdrawInventory(uint256 amount, address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        fes.safeTransfer(to, amount);
        emit InventoryWithdrawn(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Returns the FES paid for `wifIn` WIF at the active rate.
    /// @param wifIn WIF amount (raw units).
    /// @return FES amount (raw units).
    function quote(uint256 wifIn) external view returns (uint256) {
        return Math.mulDiv(wifIn, rate, RATE_PRECISION);
    }

    /// @notice Returns the FES inventory available for conversions.
    /// @return FES balance of the desk.
    function inventory() external view returns (uint256) {
        return fes.balanceOf(address(this));
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _setWifSink(address newSink) internal {
        if (newSink == address(0)) revert ZeroAddress();
        if (newSink == address(this)) revert InvalidSink();
        address previousSink = wifSink;
        wifSink = newSink;
        emit WifSinkUpdated(previousSink, newSink);
    }
}
