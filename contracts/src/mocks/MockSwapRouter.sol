// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ISwapRouter02ExactInputSingle} from "../converters/UniswapV3Converter.sol";

/// @title MockSwapRouter
/// @notice TEST / DEMO ONLY. Fake SwapRouter02 that fills `exactInputSingle` at a settable rate
///         from its own token inventory. Not a DEX; there is no access control on `setRate`.
contract MockSwapRouter is ISwapRouter02ExactInputSingle {
    using SafeERC20 for IERC20;

    /// @notice Raw `tokenOut` units paid per 1e18 raw `tokenIn` units.
    uint256 public rate;

    /// @notice Fee tier the router expects (swaps with another fee revert, like a missing pool).
    uint24 public immutable expectedFee;

    /// @notice Last swap parameters received (for test assertions).
    ExactInputSingleParams public lastParams;

    /// @notice Thrown when output is below `amountOutMinimum` (mirrors Uniswap's "Too little received").
    error TooLittleReceived();
    /// @notice Thrown when the fee tier does not match `expectedFee`.
    error UnknownPool();

    /// @notice Deploys the mock router.
    /// @param rate_ Initial rate (raw out per 1e18 raw in).
    /// @param expectedFee_ Fee tier of the only "pool".
    constructor(uint256 rate_, uint24 expectedFee_) {
        rate = rate_;
        expectedFee = expectedFee_;
    }

    /// @notice Sets the swap rate. Anyone can call (test helper).
    /// @param newRate Raw out per 1e18 raw in.
    function setRate(uint256 newRate) external {
        rate = newRate;
    }

    /// @inheritdoc ISwapRouter02ExactInputSingle
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        if (params.fee != expectedFee) revert UnknownPool();
        lastParams = params;
        amountOut = Math.mulDiv(params.amountIn, rate, 1e18);
        if (amountOut < params.amountOutMinimum) revert TooLittleReceived();
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
