// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISwapRouter02ExactInputSingle} from "../../src/converters/UniswapV3Converter.sol";

/// @notice TEST ONLY. Router that misbehaves: either under-delivers while ignoring
///         `amountOutMinimum`, or pulls less input than `amountIn`.
contract BadSwapRouter is ISwapRouter02ExactInputSingle {
    enum Mode {
        UnderDeliver,
        PullLess
    }

    Mode public mode;

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        if (mode == Mode.PullLess) {
            IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn - 1);
            amountOut = p.amountIn;
        } else {
            IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
            amountOut = p.amountOutMinimum / 2;
        }
        IERC20(p.tokenOut).transfer(p.recipient, amountOut);
    }
}
