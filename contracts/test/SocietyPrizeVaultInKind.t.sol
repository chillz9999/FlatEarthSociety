// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SocietyEntry} from "../src/SocietyEntry.sol";
import {SocietyPrizeVault} from "../src/SocietyPrizeVault.sol";
import {ISocietyPrizeVault} from "../src/interfaces/ISocietyPrizeVault.sol";
import {MockSocietyToken} from "../src/mocks/MockSocietyToken.sol";
import {SocietyWeeks} from "../src/libraries/SocietyWeeks.sol";

/// @notice In-kind mode: the prizes are paid in WIF itself, with nothing to convert.
contract SocietyPrizeVaultInKindTest is Test {
    uint256 internal constant ENTRY_FEE = 10e18;
    uint256 internal constant EXTRA_LIFE_FEE = 500e18;
    uint256 internal constant WEEK0_START = 1_792_972_800;

    MockSocietyToken internal wif;
    SocietyPrizeVault internal vault;
    SocietyEntry internal entry;

    address internal admin = makeAddr("admin");
    address internal settler = makeAddr("settler");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        vm.warp(WEEK0_START + 1 hours);
        wif = new MockSocietyToken("Mock WIF", "mWIF", 18);
        vault = new SocietyPrizeVault(IERC20(address(wif)), IERC20(address(wif)), admin);
        entry = new SocietyEntry(IERC20(address(wif)), vault, ENTRY_FEE, EXTRA_LIFE_FEE, treasury, admin);
        vm.startPrank(admin);
        vault.grantRole(vault.ENTRY_ROLE(), address(entry));
        vault.grantRole(vault.SETTLER_ROLE(), settler);
        vm.stopPrank();
    }

    function _enter(address player, bytes32 ref, bool life) internal returns (bytes32 id) {
        uint256 cost = ENTRY_FEE + (life ? EXTRA_LIFE_FEE : 0);
        wif.mint(player, cost);
        vm.startPrank(player);
        wif.approve(address(entry), cost);
        id = entry.enter(ref, ENTRY_FEE);
        if (life) entry.buyExtraLife(id, EXTRA_LIFE_FEE);
        vm.stopPrank();
    }

    function test_InKind_EveryPaymentJoinsThePoolAsItIs() public {
        assertTrue(vault.inKind());
        uint256 week = vault.currentWeekId();
        _enter(alice, "a", true);
        _enter(bob, "b", false);
        _enter(carol, "c", false);

        uint256 pool = (3 * ENTRY_FEE + EXTRA_LIFE_FEE) / 2;
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(week);
        assertEq(w.wifAllocated, pool);
        assertEq(w.wifConverted, pool);
        assertEq(w.fesPool, pool);
        assertEq(vault.totalWifUnconverted(), 0);
        assertEq(vault.totalFesLiabilities(), pool);
        assertEq(wif.balanceOf(address(vault)), pool);
    }

    function test_InKind_NothingToConvert() public {
        uint256 week = vault.currentWeekId();
        _enter(alice, "a", false);
        address converter = makeAddr("converter");
        vm.prank(admin);
        vault.setConverter(converter, true);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.ExceedsUnconvertedAllocation.selector, 1, 0));
        vault.convertWeek(week, 1, converter, 1, block.timestamp);
    }

    function test_InKind_SettlesAndPaysTheTopThreeInWif() public {
        uint256 week = vault.currentWeekId();
        _enter(alice, "a", true);
        _enter(bob, "b", false);
        _enter(carol, "c", false);
        uint256 pool = (3 * ENTRY_FEE + EXTRA_LIFE_FEE) / 2;

        vm.warp(SocietyWeeks.weekEnd(week));
        vm.prank(settler);
        vault.finalizeWeek(week, [bob, alice, carol], keccak256("results"));
        vault.claimFor(week, 0);
        vault.claimFor(week, 1);
        vault.claimFor(week, 2);

        uint256[3] memory shares = vault.splitPool(pool);
        assertEq(wif.balanceOf(bob), shares[0]);
        assertEq(wif.balanceOf(alice), shares[1]);
        assertEq(wif.balanceOf(carol), shares[2]);
        assertEq(wif.balanceOf(address(vault)), 0);
        assertEq(vault.totalFesLiabilities(), 0);
    }

    function test_InKind_EmptyRanksRollOverAndNewPaymentsStillBalance() public {
        uint256 week = vault.currentWeekId();
        _enter(alice, "a", false);
        vm.warp(SocietyWeeks.weekEnd(week));
        vm.prank(settler);
        vault.finalizeWeek(week, [alice, address(0), address(0)], keccak256("results"));

        // Next week's payments are still checked against everything the vault owes.
        _enter(bob, "b", false);
        uint256[3] memory shares = vault.splitPool(ENTRY_FEE / 2);
        assertEq(vault.getWeek(week + 1).fesPool, shares[1] + shares[2] + ENTRY_FEE / 2);
        assertEq(vault.totalFesLiabilities(), wif.balanceOf(address(vault)));
        vault.claimFor(week, 0);
        assertEq(vault.totalFesLiabilities(), wif.balanceOf(address(vault)));
    }

    function test_InKind_TopUpsInWif() public {
        uint256 week = vault.currentWeekId();
        address sponsor = makeAddr("sponsor");
        wif.mint(sponsor, 100e18);
        vm.startPrank(sponsor);
        wif.approve(address(vault), 100e18);
        vault.fundWeek(week, 100e18);
        vm.stopPrank();
        _enter(alice, "a", false);
        assertEq(vault.getWeek(week).fesPool, 100e18 + ENTRY_FEE / 2);
        assertEq(vault.totalFesLiabilities(), wif.balanceOf(address(vault)));
    }

    function test_InKind_AllocationMustBeBackedBeyondWhatIsOwed() public {
        // A feeder crediting WIF it never sent is refused, even though the vault holds owed WIF.
        _enter(alice, "a", false);
        address feeder = makeAddr("feeder");
        bytes32 role = vault.ENTRY_ROLE();
        vm.prank(admin);
        vault.grantRole(role, feeder);
        uint256 week = vault.currentWeekId();
        uint256 balance = wif.balanceOf(address(vault));
        vm.prank(feeder);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.AllocationNotFunded.selector, balance, balance + 1));
        vault.notifyEntryAllocation(week, keccak256("ghost"), 1);
    }

    function test_InKind_PrizeTokenCannotBeRescued() public {
        _enter(alice, "a", false);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.CannotRescuePrizeToken.selector, address(wif)));
        vault.rescueToken(address(wif), admin, 1);
    }
}
