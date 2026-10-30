// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISocietyPrizeVault} from "../src/interfaces/ISocietyPrizeVault.sol";
import {SocietyFixture} from "./utils/SocietyFixture.sol";

/// @notice Full lifecycle: entry -> allocation -> conversion -> finalize -> claim, over three weeks.
contract IntegrationTest is SocietyFixture {
    function test_ThreeWeekLifecycle() public {
        // ---- Week 0: 12 entries (120 WIF), 60 WIF allocated -------------------------------------
        _enterMany(alice, 5, 1);
        _enterMany(bob, 4, 2);
        _enterMany(carol, 3, 3);
        assertEq(wif.balanceOf(treasury), 60e18);
        assertEq(vault.getWeek(WEEK0).wifAllocated, 60e18);

        // Convert in two tranches during the week (desk: 1 WIF = 2 FES).
        _convert(WEEK0, 25e18);
        vm.warp(block.timestamp + 3 days);
        _convert(WEEK0, 35e18);
        assertEq(vault.getWeek(WEEK0).fesPool, 120e18);

        // Society sponsors the week with 30 FES (disclosed onchain).
        _fundWeek(admin, WEEK0, 30e18);
        assertEq(vault.getWeek(WEEK0).fesPool, 150e18);

        // ---- Week 1 starts. Week 0 is settled with only 2 winners -> 20% rolls over -----------
        _warpPastWeek(WEEK0);
        assertEq(_currentWeek(), WEEK0 + 1);
        _finalize(WEEK0, alice, bob, address(0));
        ISocietyPrizeVault.WeekView memory w0 = vault.getWeek(WEEK0);
        assertEq(w0.amounts[0], 75e18);
        assertEq(w0.amounts[1], 45e18);
        assertEq(w0.amounts[2], 0);
        assertEq(w0.rolledOver, 30e18);
        assertEq(vault.getWeek(WEEK0 + 1).fesPool, 30e18);

        // Backend pushes payouts.
        vault.claimFor(WEEK0, 0);
        vault.claimFor(WEEK0, 1);
        assertEq(fes.balanceOf(alice), 75e18);
        assertEq(fes.balanceOf(bob), 45e18);

        // Week 1 entries: 4 entries -> 20 WIF allocated -> 40 FES.
        _enterMany(dave, 4, 4);
        _convertAll(WEEK0 + 1);
        assertEq(vault.getWeek(WEEK0 + 1).fesPool, 70e18);

        // ---- Week 2 starts. Week 1 settled with full podium ------------------------------------
        _warpPastWeek(WEEK0 + 1);
        _finalize(WEEK0 + 1, dave, carol, alice);
        ISocietyPrizeVault.WeekView memory w1 = vault.getWeek(WEEK0 + 1);
        assertEq(w1.amounts[0], 35e18);
        assertEq(w1.amounts[1], 21e18);
        assertEq(w1.amounts[2], 14e18);
        assertEq(w1.rolledOver, 0);

        vm.prank(dave);
        vault.claim(WEEK0 + 1, 0);
        vm.prank(carol);
        vault.claim(WEEK0 + 1, 1);
        // Alice has not claimed yet: funds stay reserved.
        assertEq(fes.balanceOf(address(vault)), 14e18);
        assertEq(vault.totalFesLiabilities(), 14e18);

        // Week 2 has no entries and no winners -> nothing to roll (pool empty).
        _warpPastWeek(WEEK0 + 2);
        _finalize(WEEK0 + 2, address(0), address(0), address(0));

        // Alice claims later; vault ends empty.
        vm.prank(alice);
        vault.claim(WEEK0 + 1, 2);
        assertEq(fes.balanceOf(address(vault)), 0);
        assertEq(wif.balanceOf(address(vault)), 0);
        assertEq(vault.totalFesLiabilities(), 0);
        assertEq(vault.totalWifUnconverted(), 0);

        // Treasury got exactly half of all fees (16 entries * 10 WIF / 2), the desk sink the other half.
        assertEq(wif.balanceOf(treasury), 80e18);
        assertEq(wif.balanceOf(wifSink), 80e18);
        assertEq(wif.balanceOf(address(entry)), 0);
    }
}
