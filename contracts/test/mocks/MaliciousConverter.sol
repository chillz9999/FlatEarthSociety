// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IFesConverter} from "../../src/interfaces/IFesConverter.sol";

/// @notice TEST ONLY. Converter with configurable misbehaviour, used to prove the vault measures
///         balances instead of trusting converters.
contract MaliciousConverter is IFesConverter {
    enum Mode {
        Honest, // pulls wifIn, pays wifIn * rate / 1e18
        LieAboutOutput, // pulls wifIn, pays half, returns the full amount
        PullLess, // pulls wifIn - 1, pays in full
        IgnoreMinOut, // pulls wifIn, pays half, ignores minFesOut
        Reenter // calls `reenterTarget` with `reenterData` during convert
    }

    IERC20 public immutable wif;
    IERC20 public immutable fes;
    uint256 public rate = 1e18;
    Mode public mode;
    address public reenterTarget;
    bytes public reenterData;

    constructor(IERC20 wif_, IERC20 fes_) {
        wif = wif_;
        fes = fes_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function convert(uint256 wifIn, uint256 minFesOut, address recipient) external returns (uint256 fesOut) {
        uint256 fair = wifIn * rate / 1e18;
        if (mode == Mode.Reenter) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        if (mode == Mode.PullLess) {
            wif.transferFrom(msg.sender, address(this), wifIn - 1);
        } else {
            wif.transferFrom(msg.sender, address(this), wifIn);
        }
        if (mode == Mode.LieAboutOutput || mode == Mode.IgnoreMinOut) {
            fes.transfer(recipient, fair / 2);
            return mode == Mode.LieAboutOutput ? fair : fair / 2;
        }
        require(fair >= minFesOut, "slippage");
        fes.transfer(recipient, fair);
        return fair;
    }
}
