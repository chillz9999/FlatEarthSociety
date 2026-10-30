// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockSocietyToken
/// @notice DEMO / TEST TOKEN ONLY. Stand-in for $WIF or $FES on local anvil chains and testnets.
/// @dev `mint` is an OPEN FAUCET: anyone can mint any amount to anyone. This token has no value
///      and must never be used as the real $WIF or $FES on mainnet. Supports EIP-2612 permits and
///      configurable decimals.
contract MockSocietyToken is ERC20, ERC20Permit {
    uint8 private immutable _decimals;

    /// @notice Deploys a mock token.
    /// @param name_ Token name (e.g. "Mock WIF").
    /// @param symbol_ Token symbol (e.g. "mWIF").
    /// @param decimals_ Token decimals.
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) ERC20Permit(name_) {
        _decimals = decimals_;
    }

    /// @notice Open faucet: mints `amount` tokens to `to`. DEMO ONLY - anyone can call this.
    /// @param to Recipient.
    /// @param amount Raw amount to mint.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Returns the token decimals configured at deployment.
    /// @return The number of decimals.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
