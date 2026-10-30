// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {SocietyEntry} from "../src/SocietyEntry.sol";
import {ISocietyPrizeVault} from "../src/interfaces/ISocietyPrizeVault.sol";
import {SocietyFixture} from "./utils/SocietyFixture.sol";

/// @notice The bonus life, the buyer's price limit, and market re-pricing of both fees.
contract SocietyEntryPaymentsTest is SocietyFixture {
    address internal pricer = makeAddr("pricer");

    event ExtraLifePurchased(
        bytes32 indexed entryId,
        address indexed player,
        uint256 indexed weekId,
        uint256 fee,
        uint256 rewardShare,
        uint256 protocolShare
    );
    event EntryFeeUpdated(uint256 previousFee, uint256 newFee);
    event ExtraLifeFeeUpdated(uint256 previousFee, uint256 newFee);
    event FeeBoundsUpdated(uint256 minEntryFee, uint256 maxEntryFee, uint256 minExtraLifeFee, uint256 maxExtraLifeFee);

    function setUp() public override {
        super.setUp();
        vm.startPrank(admin);
        entry.grantRole(entry.PRICER_ROLE(), pricer);
        entry.setFeeBounds(1e18, 100e18, 50e18, 5_000e18);
        vm.stopPrank();
    }

    function _buyLife(address player, bytes32 entryId) internal {
        _fund(player, EXTRA_LIFE_FEE);
        vm.prank(player);
        entry.buyExtraLife(entryId, EXTRA_LIFE_FEE);
    }

    // ---------------------------------------------------------------------------------------------
    // Bonus life
    // ---------------------------------------------------------------------------------------------

    function test_ExtraLife_SplitsLikeAnEntry() public {
        bytes32 id = _enter(alice, "a");
        uint256 week = _currentWeek();
        _fund(alice, EXTRA_LIFE_FEE);

        vm.expectEmit(address(entry));
        emit ExtraLifePurchased(id, alice, week, EXTRA_LIFE_FEE, EXTRA_LIFE_FEE / 2, EXTRA_LIFE_FEE / 2);
        vm.prank(alice);
        entry.buyExtraLife(id, EXTRA_LIFE_FEE);

        assertTrue(entry.extraLifeBought(id));
        assertEq(wif.balanceOf(alice), 0);
        assertEq(wif.balanceOf(treasury), (ENTRY_FEE + EXTRA_LIFE_FEE) / 2);
        assertEq(wif.balanceOf(address(vault)), (ENTRY_FEE + EXTRA_LIFE_FEE) / 2);
        assertEq(wif.balanceOf(address(entry)), 0);
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(week);
        assertEq(w.wifAllocated, (ENTRY_FEE + EXTRA_LIFE_FEE) / 2);
    }

    function test_ExtraLife_OnlyOncePerEntry() public {
        bytes32 id = _enter(alice, "a");
        _buyLife(alice, id);
        _fund(alice, EXTRA_LIFE_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.ExtraLifeAlreadyBought.selector, id));
        entry.buyExtraLife(id, EXTRA_LIFE_FEE);
    }

    function test_ExtraLife_OnlyTheEntrysPlayer() public {
        bytes32 id = _enter(alice, "a");
        _fund(bob, EXTRA_LIFE_FEE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.NotEntryPlayer.selector, id));
        entry.buyExtraLife(id, EXTRA_LIFE_FEE);

        bytes32 unknown = keccak256("nobody");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.NotEntryPlayer.selector, unknown));
        entry.buyExtraLife(unknown, EXTRA_LIFE_FEE);
    }

    function test_ExtraLife_RespectsTheBuyersLimit() public {
        bytes32 id = _enter(alice, "a");
        _fund(alice, EXTRA_LIFE_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeAboveMax.selector, EXTRA_LIFE_FEE, EXTRA_LIFE_FEE - 2));
        entry.buyExtraLife(id, EXTRA_LIFE_FEE - 2);
        assertFalse(entry.extraLifeBought(id));
    }

    function test_ExtraLife_BlockedWhilePaused() public {
        bytes32 id = _enter(alice, "a");
        vm.prank(admin);
        entry.pause();
        _fund(alice, EXTRA_LIFE_FEE);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        entry.buyExtraLife(id, EXTRA_LIFE_FEE);
    }

    function test_ExtraLife_CreditsTheWeekOfPayment() public {
        bytes32 id = _enter(alice, "a");
        uint256 week = _currentWeek();
        _warpPastWeek(week);
        _buyLife(alice, id);
        assertEq(vault.getWeek(week).wifAllocated, ENTRY_FEE / 2);
        assertEq(vault.getWeek(week + 1).wifAllocated, EXTRA_LIFE_FEE / 2);
    }

    // ---------------------------------------------------------------------------------------------
    // The buyer's limit on entries
    // ---------------------------------------------------------------------------------------------

    function test_Enter_RespectsTheBuyersLimit() public {
        _fund(alice, ENTRY_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeAboveMax.selector, ENTRY_FEE, ENTRY_FEE - 2));
        entry.enter("a", ENTRY_FEE - 2);

        vm.prank(alice);
        entry.enter("a", ENTRY_FEE);
        assertEq(wif.balanceOf(treasury), ENTRY_FEE / 2);
    }

    function test_Enter_RepricedWhilePendingIsRefused() public {
        _fund(alice, 100e18);
        uint256 quoted = entry.entryFee();
        vm.prank(pricer);
        entry.updatePrices(quoted * 2, EXTRA_LIFE_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeAboveMax.selector, quoted * 2, quoted));
        entry.enter("a", quoted);
    }

    // ---------------------------------------------------------------------------------------------
    // Re-pricing
    // ---------------------------------------------------------------------------------------------

    function test_UpdatePrices_FollowsTheMarket() public {
        vm.expectEmit(address(entry));
        emit EntryFeeUpdated(ENTRY_FEE, 12e18);
        vm.expectEmit(address(entry));
        emit ExtraLifeFeeUpdated(EXTRA_LIFE_FEE, 600e18);
        vm.prank(pricer);
        entry.updatePrices(12e18, 600e18);
        assertEq(entry.entryFee(), 12e18);
        assertEq(entry.extraLifeFee(), 600e18);
    }

    function test_UpdatePrices_UnchangedFeeEmitsNothing() public {
        vm.recordLogs();
        vm.prank(pricer);
        entry.updatePrices(ENTRY_FEE, EXTRA_LIFE_FEE);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_UpdatePrices_OnlyPricer() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, entry.PRICER_ROLE()
            )
        );
        vm.prank(stranger);
        entry.updatePrices(12e18, 600e18);
    }

    function test_UpdatePrices_NeverOutsideTheBounds() public {
        vm.startPrank(pricer);
        // Each step may halve or double, but not leave the admin's bounds.
        entry.updatePrices(20e18, 1_000e18);
        entry.updatePrices(40e18, 2_000e18);
        entry.updatePrices(80e18, 4_000e18);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeOutOfBounds.selector, 160e18));
        entry.updatePrices(160e18, 4_000e18);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeOutOfBounds.selector, 8_000e18));
        entry.updatePrices(80e18, 8_000e18);
        vm.stopPrank();
    }

    function test_UpdatePrices_AtMostDoubleOrHalfPerUpdate() public {
        vm.startPrank(pricer);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeOutOfBounds.selector, ENTRY_FEE * 2 + 2));
        entry.updatePrices(ENTRY_FEE * 2 + 2, EXTRA_LIFE_FEE);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeOutOfBounds.selector, ENTRY_FEE / 2 - 2));
        entry.updatePrices(ENTRY_FEE / 2 - 2, EXTRA_LIFE_FEE);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeOutOfBounds.selector, EXTRA_LIFE_FEE / 2 - 2));
        entry.updatePrices(ENTRY_FEE, EXTRA_LIFE_FEE / 2 - 2);
        entry.updatePrices(ENTRY_FEE * 2, EXTRA_LIFE_FEE / 2);
        vm.stopPrank();
        assertEq(entry.entryFee(), ENTRY_FEE * 2);
        assertEq(entry.extraLifeFee(), EXTRA_LIFE_FEE / 2);
    }

    function test_UpdatePrices_RejectsOddFees() public {
        vm.prank(pricer);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 12e18 + 1));
        entry.updatePrices(12e18 + 1, EXTRA_LIFE_FEE);
    }

    function test_UpdatePrices_StoppedUntilBoundsAreSet() public {
        vm.prank(admin);
        entry.setFeeBounds(0, 0, 0, 0);
        vm.prank(pricer);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.FeeOutOfBounds.selector, ENTRY_FEE));
        entry.updatePrices(ENTRY_FEE, EXTRA_LIFE_FEE);
    }

    function testFuzz_UpdatePrices_StaysWithinBounds(uint256 entryFee, uint256 lifeFee) public {
        entryFee = bound(entryFee, 0, 1_000e18);
        lifeFee = bound(lifeFee, 0, 50_000e18);
        vm.prank(pricer);
        try entry.updatePrices(entryFee, lifeFee) {
            assertGe(entry.entryFee(), 5e18);
            assertLe(entry.entryFee(), 20e18);
            assertGe(entry.extraLifeFee(), 250e18);
            assertLe(entry.extraLifeFee(), 1_000e18);
            assertEq(entry.entryFee() % 2, 0);
            assertEq(entry.extraLifeFee() % 2, 0);
        } catch {
            assertEq(entry.entryFee(), ENTRY_FEE);
            assertEq(entry.extraLifeFee(), EXTRA_LIFE_FEE);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    function test_SetFeeBounds_OnlyAdminAndOrdered() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pricer, entry.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(pricer);
        entry.setFeeBounds(0, type(uint128).max, 0, type(uint128).max);

        vm.startPrank(admin);
        vm.expectRevert(SocietyEntry.InvalidFeeBounds.selector);
        entry.setFeeBounds(2, 1, 0, 0);
        vm.expectRevert(SocietyEntry.InvalidFeeBounds.selector);
        entry.setFeeBounds(0, 0, 0, uint256(type(uint128).max) + 1);
        vm.expectEmit(address(entry));
        emit FeeBoundsUpdated(2e18, 30e18, 100e18, 900e18);
        entry.setFeeBounds(2e18, 30e18, 100e18, 900e18);
        vm.stopPrank();
        assertEq(entry.minEntryFee(), 2e18);
        assertEq(entry.maxEntryFee(), 30e18);
        assertEq(entry.minExtraLifeFee(), 100e18);
        assertEq(entry.maxExtraLifeFee(), 900e18);
    }

    function test_SetExtraLifeFee_OnlyAdminAndValid() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pricer, entry.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(pricer);
        entry.setExtraLifeFee(2e18);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 0));
        entry.setExtraLifeFee(0);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 3));
        entry.setExtraLifeFee(3);
        entry.setExtraLifeFee(2e18);
        vm.stopPrank();
        assertEq(entry.extraLifeFee(), 2e18);
    }

    function test_Constructor_RejectsBadExtraLifeFee() public {
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 7));
        new SocietyEntry(wif, vault, ENTRY_FEE, 7, treasury, admin);
    }
}
