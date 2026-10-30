// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISocietyPrizeVault} from "./interfaces/ISocietyPrizeVault.sol";
import {SocietyWeeks} from "./libraries/SocietyWeeks.sol";

/// @title SocietyEntry
/// @notice Sells ranked attempts, and one bonus life per attempt, for The Flat Earth Society weekly competition.
/// @dev Every entry costs `entryFee` $WIF and a bonus life costs `extraLifeFee` $WIF. Exactly 50% of every
///      payment is sent to the prize vault and credited to the week of the payment; the other 50% is sent
///      to `protocolTreasury`. The deployment burns it: `protocolTreasury` is `BURN_ADDRESS`, and once it
///      is, it can never be changed again.
///      Each entry is identified by `entryId = keccak256(abi.encode(player, attemptRef))`, so an
///      `attemptRef` observed in the mempool cannot be used by anyone else, and every entry id can
///      only be bought once. Only the entry's player can buy its bonus life, and only once.
///      Both fees are priced in dollars off-chain: the PRICER_ROLE re-prices them in WIF as the market
///      moves, never outside the bounds set by the admin and never by more than 2x per update. Every
///      purchase names the most the buyer is willing to pay. This contract never holds funds between
///      transactions.
contract SocietyEntry is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to pause and unpause entries.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Role allowed to re-price both fees within the admin's bounds (the backend price feed).
    bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
    /// @notice The conventional dead address: $WIF sent here can never move again. (Most ERC-20s refuse
    ///         transfers to the zero address, and not every token has a `burn` function.)
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice A purchased entry.
    /// @param player Address that paid for the entry.
    /// @param weekId Competition week the entry belongs to.
    /// @param fee WIF paid (raw units).
    struct Entry {
        address player;
        uint64 weekId;
        uint128 fee;
    }

    /// @notice The $WIF token used to pay entry fees.
    IERC20 public immutable wif;

    /// @notice Prize vault receiving the 50% reward share of every entry.
    ISocietyPrizeVault public immutable vault;

    /// @notice Current entry fee in raw WIF units. Always non-zero and even.
    uint256 public entryFee;

    /// @notice Current price of a bonus life in raw WIF units. Always non-zero and even.
    uint256 public extraLifeFee;

    /// @notice Bounds within which the PRICER_ROLE may set each fee (inclusive). Zero until the admin sets them.
    uint256 public minEntryFee;
    uint256 public maxEntryFee;
    uint256 public minExtraLifeFee;
    uint256 public maxExtraLifeFee;

    /// @notice Recipient of the 50% protocol share of every payment (`BURN_ADDRESS` when it is burned).
    address public protocolTreasury;

    /// @notice Purchased entries by entry id.
    mapping(bytes32 entryId => Entry) public entries;

    /// @notice Whether an entry's bonus life has been bought.
    mapping(bytes32 entryId => bool) public extraLifeBought;

    /// @notice Emitted for every purchased entry. Indexed by the game backend.
    /// @param entryId `keccak256(abi.encode(player, attemptRef))`.
    /// @param player Address that paid.
    /// @param weekId Week credited with the reward share.
    /// @param attemptRef Opaque reference supplied by the player (links the entry to a game attempt).
    /// @param fee Total WIF paid.
    /// @param rewardShare WIF sent to the prize vault (`fee / 2`).
    /// @param protocolShare WIF sent to the protocol treasury (`fee - rewardShare`).
    event EntryPurchased(
        bytes32 indexed entryId,
        address indexed player,
        uint256 indexed weekId,
        bytes32 attemptRef,
        uint256 fee,
        uint256 rewardShare,
        uint256 protocolShare
    );

    /// @notice Emitted when an entry's bonus life is bought. Indexed by the game backend.
    /// @param entryId The entry whose attempt gets the bonus life.
    /// @param player Address that paid (always the entry's player).
    /// @param weekId Week credited with the reward share (the week of the payment).
    /// @param fee Total WIF paid.
    /// @param rewardShare WIF sent to the prize vault (`fee / 2`).
    /// @param protocolShare WIF sent to the protocol treasury (`fee - rewardShare`).
    event ExtraLifePurchased(
        bytes32 indexed entryId,
        address indexed player,
        uint256 indexed weekId,
        uint256 fee,
        uint256 rewardShare,
        uint256 protocolShare
    );

    /// @notice Emitted when the entry fee changes.
    /// @param previousFee Old fee (0 at deployment).
    /// @param newFee New fee.
    event EntryFeeUpdated(uint256 previousFee, uint256 newFee);

    /// @notice Emitted when the bonus-life fee changes.
    /// @param previousFee Old fee (0 at deployment).
    /// @param newFee New fee.
    event ExtraLifeFeeUpdated(uint256 previousFee, uint256 newFee);

    /// @notice Emitted when the admin changes the bounds of the PRICER_ROLE.
    event FeeBoundsUpdated(uint256 minEntryFee, uint256 maxEntryFee, uint256 minExtraLifeFee, uint256 maxExtraLifeFee);

    /// @notice Emitted when the protocol treasury changes.
    /// @param previousTreasury Old treasury (zero address at deployment).
    /// @param newTreasury New treasury.
    event ProtocolTreasuryUpdated(address previousTreasury, address newTreasury);

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice The fee is zero, odd, or does not fit in 128 bits.
    /// @param fee The rejected fee.
    error InvalidEntryFee(uint256 fee);
    /// @notice The treasury may not be this contract or the prize vault.
    /// @param treasury The rejected treasury.
    error InvalidTreasury(address treasury);
    /// @notice The protocol share is burned, and burning is permanent.
    error BurnIsPermanent();
    /// @notice The entry id has already been purchased.
    /// @param entryId The duplicate entry id.
    error EntryAlreadyUsed(bytes32 entryId);
    /// @notice The token delivered a different amount than requested (fee-on-transfer tokens are unsupported).
    /// @param expected Amount requested.
    /// @param received Amount actually received.
    error UnexpectedAmountReceived(uint256 expected, uint256 received);
    /// @notice The vault was deployed for a different WIF token.
    error VaultTokenMismatch();
    /// @notice The current fee is above the most the buyer agreed to pay.
    /// @param fee The current fee.
    /// @param maxFee The buyer's limit.
    error FeeAboveMax(uint256 fee, uint256 maxFee);
    /// @notice No such entry, or the caller is not its player.
    /// @param entryId The entry.
    error NotEntryPlayer(bytes32 entryId);
    /// @notice The entry's bonus life has already been bought.
    /// @param entryId The entry.
    error ExtraLifeAlreadyBought(bytes32 entryId);
    /// @notice A re-priced fee lies outside the admin's bounds, or moves by more than 2x at once.
    /// @param fee The rejected fee.
    error FeeOutOfBounds(uint256 fee);
    /// @notice A minimum bound is above its maximum, or a maximum is not a valid fee.
    error InvalidFeeBounds();

    /// @notice Deploys the entry contract.
    /// @param wif_ The $WIF token (must match `vault_.wif()`).
    /// @param vault_ The prize vault.
    /// @param entryFee_ Initial entry fee in raw WIF units (non-zero, even).
    /// @param extraLifeFee_ Initial bonus-life fee in raw WIF units (non-zero, even).
    /// @param protocolTreasury_ Recipient of the 50% protocol share.
    /// @param admin Receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE.
    constructor(
        IERC20 wif_,
        ISocietyPrizeVault vault_,
        uint256 entryFee_,
        uint256 extraLifeFee_,
        address protocolTreasury_,
        address admin
    ) {
        if (address(wif_) == address(0) || address(vault_) == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        if (address(vault_.wif()) != address(wif_)) revert VaultTokenMismatch();
        wif = wif_;
        vault = vault_;
        _setEntryFee(entryFee_);
        _setExtraLifeFee(extraLifeFee_);
        _setProtocolTreasury(protocolTreasury_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------------------------------------
    // Entries
    // ---------------------------------------------------------------------------------------------

    /// @notice Buys one ranked attempt for the current week, paying `entryFee` WIF.
    /// @dev The caller must have approved this contract for at least `entryFee` WIF.
    /// @param attemptRef Opaque reference (e.g. a backend-issued attempt nonce) bound to the caller.
    /// @param maxFee The most the caller will pay (the fee may be re-priced while the transaction is pending).
    /// @return entryId The id of the purchased entry.
    function enter(bytes32 attemptRef, uint256 maxFee) external whenNotPaused nonReentrant returns (bytes32 entryId) {
        return _enter(msg.sender, attemptRef, maxFee);
    }

    /// @notice Same as {enter}, but first tries to set the allowance with an EIP-2612 permit.
    /// @dev The permit is wrapped in try/catch: if someone front-runs the permit, the call still
    ///      succeeds as long as the allowance is in place. The permit value must be `maxFee`.
    /// @param attemptRef Opaque reference bound to the caller.
    /// @param maxFee The most the caller will pay.
    /// @param deadline Permit deadline.
    /// @param v Permit signature `v`.
    /// @param r Permit signature `r`.
    /// @param s Permit signature `s`.
    /// @return entryId The id of the purchased entry.
    function enterWithPermit(bytes32 attemptRef, uint256 maxFee, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 entryId)
    {
        try IERC20Permit(address(wif)).permit(msg.sender, address(this), maxFee, deadline, v, r, s) {} catch {}
        return _enter(msg.sender, attemptRef, maxFee);
    }

    /// @notice Buys the bonus life of one of the caller's entries, paying `extraLifeFee` WIF.
    /// @dev The reward share is credited to the week of the payment. The caller must have approved this
    ///      contract for at least `extraLifeFee` WIF.
    /// @param entryId The caller's entry.
    /// @param maxFee The most the caller will pay.
    function buyExtraLife(bytes32 entryId, uint256 maxFee) external whenNotPaused nonReentrant {
        address player = entries[entryId].player;
        if (player == address(0) || player != msg.sender) revert NotEntryPlayer(entryId);
        if (extraLifeBought[entryId]) revert ExtraLifeAlreadyBought(entryId);
        uint256 fee = extraLifeFee;
        if (fee > maxFee) revert FeeAboveMax(fee, maxFee);
        extraLifeBought[entryId] = true;

        uint256 weekId = SocietyWeeks.weekIdAt(block.timestamp);
        (uint256 rewardShare, uint256 protocolShare) = _collect(player, weekId, entryId, fee);
        emit ExtraLifePurchased(entryId, player, weekId, fee, rewardShare, protocolShare);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Updates the entry fee.
    /// @param newFee New fee in raw WIF units (non-zero, even, < 2^128).
    function setEntryFee(uint256 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setEntryFee(newFee);
    }

    /// @notice Updates the bonus-life fee.
    /// @param newFee New fee in raw WIF units (non-zero, even, < 2^128).
    function setExtraLifeFee(uint256 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setExtraLifeFee(newFee);
    }

    /// @notice Sets the bounds within which the PRICER_ROLE may re-price each fee (inclusive).
    /// @dev Setting a maximum of zero stops all re-pricing of that fee.
    function setFeeBounds(uint256 minEntry, uint256 maxEntry, uint256 minLife, uint256 maxLife)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (minEntry > maxEntry || minLife > maxLife) revert InvalidFeeBounds();
        if (maxEntry > type(uint128).max || maxLife > type(uint128).max) revert InvalidFeeBounds();
        minEntryFee = minEntry;
        maxEntryFee = maxEntry;
        minExtraLifeFee = minLife;
        maxExtraLifeFee = maxLife;
        emit FeeBoundsUpdated(minEntry, maxEntry, minLife, maxLife);
    }

    /// @notice Re-prices both fees in WIF as the market moves (both are priced in dollars off-chain).
    /// @dev Each new fee must be non-zero, even, within the admin's bounds, and between half and double the
    ///      current fee, so one bad price reading can never move a fee far.
    /// @param newEntryFee New entry fee in raw WIF units.
    /// @param newExtraLifeFee New bonus-life fee in raw WIF units.
    function updatePrices(uint256 newEntryFee, uint256 newExtraLifeFee) external onlyRole(PRICER_ROLE) {
        _checkRepricing(newEntryFee, entryFee, minEntryFee, maxEntryFee);
        _checkRepricing(newExtraLifeFee, extraLifeFee, minExtraLifeFee, maxExtraLifeFee);
        if (newEntryFee != entryFee) _setEntryFee(newEntryFee);
        if (newExtraLifeFee != extraLifeFee) _setExtraLifeFee(newExtraLifeFee);
    }

    /// @notice Updates the protocol treasury. Impossible once it is `BURN_ADDRESS`.
    /// @param newTreasury New treasury (non-zero, not this contract, not the vault).
    function setProtocolTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setProtocolTreasury(newTreasury);
    }

    /// @notice Pauses new entries.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes new entries.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Returns the current competition week id.
    /// @return The week id containing `block.timestamp`.
    function currentWeekId() external view returns (uint256) {
        return SocietyWeeks.weekIdAt(block.timestamp);
    }

    /// @notice Computes the entry id for `player` and `attemptRef`.
    /// @param player The paying address.
    /// @param attemptRef The attempt reference.
    /// @return `keccak256(abi.encode(player, attemptRef))`.
    function computeEntryId(address player, bytes32 attemptRef) public pure returns (bytes32) {
        return keccak256(abi.encode(player, attemptRef));
    }

    /// @notice Whether the protocol share of every payment is burned (for good).
    /// @return True if `protocolTreasury` is `BURN_ADDRESS`.
    function burnsProtocolShare() external view returns (bool) {
        return protocolTreasury == BURN_ADDRESS;
    }

    /// @notice Returns whether `entryId` has already been purchased.
    /// @param entryId The entry id.
    /// @return True if the entry exists.
    function isEntryUsed(bytes32 entryId) external view returns (bool) {
        return entries[entryId].player != address(0);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _enter(address player, bytes32 attemptRef, uint256 maxFee) internal returns (bytes32 entryId) {
        entryId = computeEntryId(player, attemptRef);
        if (entries[entryId].player != address(0)) revert EntryAlreadyUsed(entryId);

        uint256 fee = entryFee;
        if (fee > maxFee) revert FeeAboveMax(fee, maxFee);
        uint256 weekId = SocietyWeeks.weekIdAt(block.timestamp);
        entries[entryId] = Entry({player: player, weekId: SafeCast.toUint64(weekId), fee: SafeCast.toUint128(fee)});

        (uint256 rewardShare, uint256 protocolShare) = _collect(player, weekId, entryId, fee);
        emit EntryPurchased(entryId, player, weekId, attemptRef, fee, rewardShare, protocolShare);
    }

    /// @dev Takes `fee` from `player` and splits it: half to the vault for `weekId`, half to the treasury.
    function _collect(address player, uint256 weekId, bytes32 entryId, uint256 fee)
        internal
        returns (uint256 rewardShare, uint256 protocolShare)
    {
        uint256 balanceBefore = wif.balanceOf(address(this));
        wif.safeTransferFrom(player, address(this), fee);
        uint256 received = wif.balanceOf(address(this)) - balanceBefore;
        if (received != fee) revert UnexpectedAmountReceived(fee, received);

        rewardShare = fee / 2;
        protocolShare = fee - rewardShare;

        wif.safeTransfer(address(vault), rewardShare);
        vault.notifyEntryAllocation(weekId, entryId, rewardShare);
        wif.safeTransfer(protocolTreasury, protocolShare);
    }

    function _checkRepricing(uint256 newFee, uint256 currentFee, uint256 minFee, uint256 maxFee) internal pure {
        if (newFee < minFee || newFee > maxFee) revert FeeOutOfBounds(newFee);
        if (newFee > currentFee * 2 || newFee * 2 < currentFee) revert FeeOutOfBounds(newFee);
    }

    function _setEntryFee(uint256 newFee) internal {
        _checkFee(newFee);
        uint256 previousFee = entryFee;
        entryFee = newFee;
        emit EntryFeeUpdated(previousFee, newFee);
    }

    function _setExtraLifeFee(uint256 newFee) internal {
        _checkFee(newFee);
        uint256 previousFee = extraLifeFee;
        extraLifeFee = newFee;
        emit ExtraLifeFeeUpdated(previousFee, newFee);
    }

    function _checkFee(uint256 fee) internal pure {
        if (fee == 0 || fee % 2 != 0 || fee > type(uint128).max) revert InvalidEntryFee(fee);
    }

    function _setProtocolTreasury(address newTreasury) internal {
        if (protocolTreasury == BURN_ADDRESS) revert BurnIsPermanent();
        if (newTreasury == address(0)) revert ZeroAddress();
        if (newTreasury == address(this) || newTreasury == address(vault)) revert InvalidTreasury(newTreasury);
        address previousTreasury = protocolTreasury;
        protocolTreasury = newTreasury;
        emit ProtocolTreasuryUpdated(previousTreasury, newTreasury);
    }
}
