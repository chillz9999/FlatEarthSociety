// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IFesConverter} from "../interfaces/IFesConverter.sol";

/// @title ISwapRouter02ExactInputSingle
/// @notice Minimal Uniswap V3 SwapRouter02 interface (`exactInputSingle` without a deadline field).
interface ISwapRouter02ExactInputSingle {
    /// @notice Parameters of a single-pool exact-input swap (SwapRouter02 layout).
    /// @param tokenIn Token sold.
    /// @param tokenOut Token bought.
    /// @param fee Pool fee tier (hundredths of a bip).
    /// @param recipient Receiver of `tokenOut`.
    /// @param amountIn Exact amount of `tokenIn` sold.
    /// @param amountOutMinimum Minimum `tokenOut` to receive.
    /// @param sqrtPriceLimitX96 Price limit (0 = none).
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of `tokenIn` for as much `tokenOut` as possible in one pool.
    /// @param params Swap parameters.
    /// @return amountOut Amount of `tokenOut` received.
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title UniswapV3Converter
/// @notice Converts WIF into FES through a single Uniswap V3 pool via a SwapRouter02-style router.
/// @dev Only authorized callers (the prize vault) may convert. The converter never holds funds
///      between calls. Slippage protection is enforced twice: by the router
///      (`amountOutMinimum = minFesOut`) and by measuring the recipient's FES balance delta.
///      The deadline is enforced by the vault (SwapRouter02 has no deadline field).
contract UniswapV3Converter is IFesConverter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The $WIF token sold.
    IERC20 public immutable wif;
    /// @notice The $FES token bought.
    IERC20 public immutable fes;
    /// @notice The SwapRouter02-compatible router.
    ISwapRouter02ExactInputSingle public immutable router;
    /// @notice Fee tier of the WIF/FES pool used.
    uint24 public immutable poolFee;

    /// @notice Contracts allowed to call {convert} (the prize vault).
    mapping(address caller => bool authorized) public authorizedCaller;

    /// @notice Emitted on every swap.
    /// @param wifIn WIF sold.
    /// @param fesOut FES received by the recipient (measured).
    event Swapped(uint256 wifIn, uint256 fesOut);

    /// @notice Emitted when a caller is authorized or deauthorized.
    /// @param caller The caller.
    /// @param authorized New status.
    event CallerAuthorizationUpdated(address indexed caller, bool authorized);

    /// @notice Emitted when the admin rescues tokens stuck in the converter.
    /// @param token Token rescued.
    /// @param to Recipient.
    /// @param amount Amount rescued.
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice A required amount was zero.
    error ZeroAmount();
    /// @notice WIF and FES must be different tokens.
    error IdenticalTokens();
    /// @notice The caller is not authorized to convert.
    /// @param caller The caller.
    error UnauthorizedCaller(address caller);
    /// @notice A DEX swap requires a non-zero minimum output.
    error ZeroMinOutput();
    /// @notice The router did not spend exactly `wifIn`.
    /// @param expected WIF that should have been spent.
    /// @param actual WIF actually spent.
    error UnexpectedWifSpent(uint256 expected, uint256 actual);
    /// @notice The recipient received less FES than the minimum.
    /// @param received FES received.
    /// @param minimum Minimum required.
    error InsufficientOutput(uint256 received, uint256 minimum);

    /// @notice Deploys the converter.
    /// @param wif_ The $WIF token.
    /// @param fes_ The $FES token.
    /// @param router_ SwapRouter02-compatible router.
    /// @param poolFee_ Fee tier of the WIF/FES pool.
    /// @param admin Receives DEFAULT_ADMIN_ROLE.
    constructor(IERC20 wif_, IERC20 fes_, ISwapRouter02ExactInputSingle router_, uint24 poolFee_, address admin) {
        if (
            address(wif_) == address(0) || address(fes_) == address(0) || address(router_) == address(0)
                || admin == address(0)
        ) revert ZeroAddress();
        if (address(wif_) == address(fes_)) revert IdenticalTokens();
        wif = wif_;
        fes = fes_;
        router = router_;
        poolFee = poolFee_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc IFesConverter
    function convert(uint256 wifIn, uint256 minFesOut, address recipient)
        external
        nonReentrant
        returns (uint256 fesOut)
    {
        if (!authorizedCaller[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (wifIn == 0) revert ZeroAmount();
        if (minFesOut == 0) revert ZeroMinOutput();
        if (recipient == address(0)) revert ZeroAddress();

        wif.safeTransferFrom(msg.sender, address(this), wifIn);

        uint256 wifBefore = wif.balanceOf(address(this));
        uint256 fesBefore = fes.balanceOf(recipient);

        wif.forceApprove(address(router), wifIn);
        router.exactInputSingle(
            ISwapRouter02ExactInputSingle.ExactInputSingleParams({
                tokenIn: address(wif),
                tokenOut: address(fes),
                fee: poolFee,
                recipient: recipient,
                amountIn: wifIn,
                amountOutMinimum: minFesOut,
                sqrtPriceLimitX96: 0
            })
        );
        wif.forceApprove(address(router), 0);

        uint256 wifSpent = wifBefore - wif.balanceOf(address(this));
        if (wifSpent != wifIn) revert UnexpectedWifSpent(wifIn, wifSpent);
        fesOut = fes.balanceOf(recipient) - fesBefore;
        if (fesOut < minFesOut) revert InsufficientOutput(fesOut, minFesOut);

        emit Swapped(wifIn, fesOut);
    }

    /// @notice Authorizes or deauthorizes a caller of {convert}.
    /// @param caller The caller (the prize vault).
    /// @param authorized New status.
    function setAuthorizedCaller(address caller, bool authorized) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCaller[caller] = authorized;
        emit CallerAuthorizationUpdated(caller, authorized);
    }

    /// @notice Recovers tokens accidentally left in the converter (it never holds funds between calls).
    /// @param token Token to rescue.
    /// @param to Recipient.
    /// @param amount Amount.
    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
