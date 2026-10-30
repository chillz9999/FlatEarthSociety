// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {MockSocietyToken} from "../src/mocks/MockSocietyToken.sol";

/// @title DemoSeed
/// @notice LOCAL / DEMO ONLY. Mints mock WIF (the open-faucet MockSocietyToken) to demo wallets.
/// @dev Intended for a local anvil chain after `Deploy` ran with `DEPLOY_MOCK_TOKENS=true`.
///      Refuses to run on Robinhood Chain mainnet (4663).
///      Environment variables:
///      - `DEMO_RECIPIENTS`  comma-separated addresses to fund (required).
///      - `DEMO_AMOUNT`      raw amount per recipient (default: 1000e18).
///      - `WIF_TOKEN`        mock WIF address (default: `wifToken` from `deployments/<chainid>.json`).
contract DemoSeed is Script {
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;

    /// @notice Entry point for `forge script script/DemoSeed.s.sol --broadcast`.
    function run() external {
        address token = vm.envOr("WIF_TOKEN", address(0));
        if (token == address(0)) {
            string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
            token = vm.parseJsonAddress(vm.readFile(path), ".wifToken");
        }
        address[] memory recipients = vm.envAddress("DEMO_RECIPIENTS", ",");
        uint256 amount = vm.envOr("DEMO_AMOUNT", uint256(1000e18));

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        seed(token, recipients, amount);
        vm.stopBroadcast();
    }

    /// @notice Mints `amount` mock WIF to each recipient.
    /// @param token The MockSocietyToken acting as WIF.
    /// @param recipients Wallets to fund.
    /// @param amount Raw amount per wallet.
    function seed(address token, address[] memory recipients, uint256 amount) public {
        require(block.chainid != ROBINHOOD_MAINNET_CHAIN_ID, "DemoSeed: not allowed on mainnet");
        require(token.code.length > 0, "DemoSeed: token has no code");
        for (uint256 i; i < recipients.length; ++i) {
            MockSocietyToken(token).mint(recipients[i], amount);
            console2.log("minted mock WIF to", recipients[i], amount);
        }
    }
}
