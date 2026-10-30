// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SocietyEntry} from "../../src/SocietyEntry.sol";
import {SocietyPrizeVault} from "../../src/SocietyPrizeVault.sol";
import {ISocietyPrizeVault} from "../../src/interfaces/ISocietyPrizeVault.sol";
import {FixedRateConverter} from "../../src/converters/FixedRateConverter.sol";
import {MockSocietyToken} from "../../src/mocks/MockSocietyToken.sol";
import {SocietyWeeks} from "../../src/libraries/SocietyWeeks.sol";

/// @notice Shared deployment + helpers for Society tests.
abstract contract SocietyFixture is Test {
    uint256 internal constant ENTRY_FEE = 10e18;
    uint256 internal constant EXTRA_LIFE_FEE = 500e18;
    /// @dev 1 WIF = 2 FES (both 18 decimals).
    uint256 internal constant DESK_RATE = 2e18;
    uint256 internal constant DESK_INVENTORY = 10_000_000e18;

    /// @dev Week 2964 starts Monday 2026-10-26 00:00:00 UTC.
    uint256 internal constant WEEK0 = 2964;
    uint256 internal constant WEEK0_START = 1_792_972_800;

    MockSocietyToken internal wif;
    MockSocietyToken internal fes;
    SocietyPrizeVault internal vault;
    SocietyEntry internal entry;
    FixedRateConverter internal desk;

    address internal admin = makeAddr("admin");
    address internal settler = makeAddr("settler");
    address internal treasury = makeAddr("treasury");
    address internal wifSink = makeAddr("wifSink");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        vm.warp(WEEK0_START + 1 hours);

        wif = new MockSocietyToken("Mock WIF", "mWIF", 18);
        fes = new MockSocietyToken("Mock FES", "mFES", 18);

        vault = new SocietyPrizeVault(IERC20(address(wif)), IERC20(address(fes)), admin);
        entry = new SocietyEntry(IERC20(address(wif)), vault, ENTRY_FEE, EXTRA_LIFE_FEE, treasury, admin);
        desk = new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), DESK_RATE, wifSink, admin);

        vm.startPrank(admin);
        vault.grantRole(vault.ENTRY_ROLE(), address(entry));
        vault.grantRole(vault.SETTLER_ROLE(), settler);
        vault.setConverter(address(desk), true);
        desk.setAuthorizedCaller(address(vault), true);
        vm.stopPrank();

        fes.mint(address(desk), DESK_INVENTORY);

        vm.label(address(wif), "WIF");
        vm.label(address(fes), "FES");
        vm.label(address(vault), "SocietyPrizeVault");
        vm.label(address(entry), "SocietyEntry");
        vm.label(address(desk), "FixedRateConverter");
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _currentWeek() internal view returns (uint256) {
        return SocietyWeeks.weekIdAt(block.timestamp);
    }

    function _fund(address player, uint256 amount) internal {
        wif.mint(player, amount);
        vm.prank(player);
        wif.approve(address(entry), amount);
    }

    function _enter(address player, bytes32 attemptRef) internal returns (bytes32 entryId) {
        _fund(player, entry.entryFee());
        vm.prank(player);
        entryId = entry.enter(attemptRef, type(uint256).max);
    }

    function _enterMany(address player, uint256 count, uint256 salt) internal {
        for (uint256 i; i < count; ++i) {
            _enter(player, keccak256(abi.encode(salt, i)));
        }
    }

    function _pending(uint256 weekId) internal view returns (uint256) {
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(weekId);
        return w.wifAllocated - w.wifConverted;
    }

    function _convert(uint256 weekId, uint256 amount) internal returns (uint256 fesOut) {
        uint256 minOut = desk.quote(amount);
        vm.prank(settler);
        fesOut = vault.convertWeek(weekId, amount, address(desk), minOut, block.timestamp);
    }

    function _convertAll(uint256 weekId) internal returns (uint256 fesOut) {
        uint256 pending = _pending(weekId);
        if (pending == 0) return 0;
        return _convert(weekId, pending);
    }

    function _warpPastWeek(uint256 weekId) internal {
        uint256 end = SocietyWeeks.weekEnd(weekId);
        if (block.timestamp < end) vm.warp(end);
    }

    function _winners(address a, address b, address c) internal pure returns (address[3] memory w) {
        w[0] = a;
        w[1] = b;
        w[2] = c;
    }

    function _finalize(uint256 weekId, address a, address b, address c) internal {
        vm.prank(settler);
        vault.finalizeWeek(weekId, _winners(a, b, c), keccak256(abi.encode("results", weekId)));
    }

    function _fundWeek(address funder, uint256 weekId, uint256 amount) internal {
        fes.mint(funder, amount);
        vm.startPrank(funder);
        fes.approve(address(vault), amount);
        vault.fundWeek(weekId, amount);
        vm.stopPrank();
    }
}
