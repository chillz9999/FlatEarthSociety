// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {SocietyPrizeVault} from "../src/SocietyPrizeVault.sol";
import {ISocietyPrizeVault} from "../src/interfaces/ISocietyPrizeVault.sol";
import {FixedRateConverter} from "../src/converters/FixedRateConverter.sol";
import {SocietyWeeks} from "../src/libraries/SocietyWeeks.sol";
import {MockSocietyToken} from "../src/mocks/MockSocietyToken.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {MaliciousConverter} from "./mocks/MaliciousConverter.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {SocietyFixture} from "./utils/SocietyFixture.sol";

contract SocietyPrizeVaultTest is SocietyFixture {
    event AllocationRecorded(uint256 indexed weekId, bytes32 indexed entryId, uint256 wifAmount);
    event ConverterApproved(address indexed converter, bool approved);
    event WeekConverted(uint256 indexed weekId, address indexed converter, uint256 wifIn, uint256 fesOut);
    event WeekFunded(uint256 indexed weekId, address indexed funder, uint256 fesAmount);
    event PoolRolledOver(uint256 indexed fromWeek, uint256 indexed toWeek, uint256 amount);
    event WeekFinalized(uint256 indexed weekId, address[3] winners, uint256[3] amounts, bytes32 resultsHash);
    event RewardClaimed(uint256 indexed weekId, uint8 indexed rank, address indexed winner, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    bytes32 internal ENTRY_ROLE;
    bytes32 internal SETTLER_ROLE;
    bytes32 internal PAUSER_ROLE;
    bytes32 internal ADMIN_ROLE;

    function setUp() public override {
        super.setUp();
        ENTRY_ROLE = vault.ENTRY_ROLE();
        SETTLER_ROLE = vault.SETTLER_ROLE();
        PAUSER_ROLE = vault.PAUSER_ROLE();
        ADMIN_ROLE = vault.DEFAULT_ADMIN_ROLE();
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role);
    }

    /// @dev 10 entries in WEEK0 -> 50 WIF allocated.
    function _seedWeek0() internal {
        _enterMany(alice, 4, 1);
        _enterMany(bob, 3, 2);
        _enterMany(carol, 2, 3);
        _enterMany(dave, 1, 4);
    }

    /// @dev Seeds WEEK0, converts everything (100 FES pool) and warps past the end of WEEK0.
    function _readyWeek0() internal returns (uint256 pool) {
        _seedWeek0();
        pool = _convertAll(WEEK0);
        _warpPastWeek(WEEK0);
    }

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    function test_Constructor() public view {
        assertEq(address(vault.wif()), address(wif));
        assertEq(address(vault.fes()), address(fes));
        assertTrue(vault.hasRole(ADMIN_ROLE, admin));
        assertTrue(vault.hasRole(PAUSER_ROLE, admin));
        assertFalse(vault.hasRole(SETTLER_ROLE, admin));
        assertEq(ENTRY_ROLE, keccak256("ENTRY_ROLE"));
        assertEq(SETTLER_ROLE, keccak256("SETTLER_ROLE"));
        assertEq(PAUSER_ROLE, keccak256("PAUSER_ROLE"));
        assertEq(vault.FIRST_PLACE_BPS() + vault.SECOND_PLACE_BPS() + vault.THIRD_PLACE_BPS(), vault.BPS_DENOMINATOR());
    }

    function test_Constructor_Reverts() public {
        vm.expectRevert(SocietyPrizeVault.ZeroAddress.selector);
        new SocietyPrizeVault(IERC20(address(0)), IERC20(address(fes)), admin);
        vm.expectRevert(SocietyPrizeVault.ZeroAddress.selector);
        new SocietyPrizeVault(IERC20(address(wif)), IERC20(address(0)), admin);
        vm.expectRevert(SocietyPrizeVault.ZeroAddress.selector);
        new SocietyPrizeVault(IERC20(address(wif)), IERC20(address(fes)), address(0));
        // The same token twice is in-kind mode (prizes paid in WIF), not an error.
        assertTrue(new SocietyPrizeVault(IERC20(address(wif)), IERC20(address(wif)), admin).inKind());
        assertFalse(vault.inKind());
    }

    // ---------------------------------------------------------------------------------------------
    // notifyEntryAllocation
    // ---------------------------------------------------------------------------------------------

    function test_Notify_DirectCallerWithRole() public {
        address feeder = makeAddr("feeder");
        vm.prank(admin);
        vault.grantRole(ENTRY_ROLE, feeder);
        wif.mint(address(vault), 7e18);

        vm.expectEmit(address(vault));
        emit AllocationRecorded(WEEK0, bytes32("e1"), 7e18);
        vm.prank(feeder);
        vault.notifyEntryAllocation(WEEK0, "e1", 7e18);

        assertEq(vault.getWeek(WEEK0).wifAllocated, 7e18);
        assertEq(vault.totalWifUnconverted(), 7e18);
    }

    function test_Notify_OnlyEntryRole() public {
        wif.mint(address(vault), 1e18);
        vm.expectRevert(_unauthorized(stranger, ENTRY_ROLE));
        vm.prank(stranger);
        vault.notifyEntryAllocation(WEEK0, "e", 1e18);
        // Not even the admin or settler.
        vm.expectRevert(_unauthorized(admin, ENTRY_ROLE));
        vm.prank(admin);
        vault.notifyEntryAllocation(WEEK0, "e", 1e18);
        vm.expectRevert(_unauthorized(settler, ENTRY_ROLE));
        vm.prank(settler);
        vault.notifyEntryAllocation(WEEK0, "e", 1e18);
    }

    function test_Notify_Reverts() public {
        address feeder = makeAddr("feeder");
        vm.prank(admin);
        vault.grantRole(ENTRY_ROLE, feeder);

        vm.startPrank(feeder);
        vm.expectRevert(SocietyPrizeVault.ZeroAmount.selector);
        vault.notifyEntryAllocation(WEEK0, "e", 0);

        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.AllocationWeekMismatch.selector, WEEK0 + 1, WEEK0));
        vault.notifyEntryAllocation(WEEK0 + 1, "e", 1);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.AllocationWeekMismatch.selector, WEEK0 - 1, WEEK0));
        vault.notifyEntryAllocation(WEEK0 - 1, "e", 1);

        // Unfunded allocation.
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.AllocationNotFunded.selector, 0, 1e18));
        vault.notifyEntryAllocation(WEEK0, "e", 1e18);
        vm.stopPrank();

        // Existing allocations cannot be double counted.
        _enter(alice, "a");
        vm.prank(feeder);
        vm.expectRevert(
            abi.encodeWithSelector(SocietyPrizeVault.AllocationNotFunded.selector, ENTRY_FEE / 2, ENTRY_FEE)
        );
        vault.notifyEntryAllocation(WEEK0, "e", ENTRY_FEE / 2);
    }

    // ---------------------------------------------------------------------------------------------
    // setConverter
    // ---------------------------------------------------------------------------------------------

    function test_SetConverter() public {
        address c = makeAddr("converter");
        vm.expectEmit(address(vault));
        emit ConverterApproved(c, true);
        vm.prank(admin);
        vault.setConverter(c, true);
        assertTrue(vault.isApprovedConverter(c));

        vm.expectEmit(address(vault));
        emit ConverterApproved(c, false);
        vm.prank(admin);
        vault.setConverter(c, false);
        assertFalse(vault.isApprovedConverter(c));
    }

    function test_SetConverter_Reverts() public {
        vm.prank(admin);
        vm.expectRevert(SocietyPrizeVault.ZeroAddress.selector);
        vault.setConverter(address(0), true);

        vm.expectRevert(_unauthorized(settler, ADMIN_ROLE));
        vm.prank(settler);
        vault.setConverter(settler, true);
    }

    // ---------------------------------------------------------------------------------------------
    // convertWeek
    // ---------------------------------------------------------------------------------------------

    function test_ConvertWeek_Full() public {
        _seedWeek0();
        uint256 wifIn = 50e18;
        uint256 expectedOut = 100e18;

        vm.expectEmit(address(vault));
        emit WeekConverted(WEEK0, address(desk), wifIn, expectedOut);
        vm.prank(settler);
        uint256 out = vault.convertWeek(WEEK0, wifIn, address(desk), expectedOut, block.timestamp);

        assertEq(out, expectedOut);
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0);
        assertEq(w.wifAllocated, wifIn);
        assertEq(w.wifConverted, wifIn);
        assertEq(w.fesPool, expectedOut);
        assertEq(wif.balanceOf(address(vault)), 0);
        assertEq(wif.balanceOf(wifSink), wifIn);
        assertEq(fes.balanceOf(address(vault)), expectedOut);
        assertEq(wif.allowance(address(vault), address(desk)), 0);
        assertEq(vault.totalWifUnconverted(), 0);
        assertEq(vault.totalFesLiabilities(), expectedOut);
    }

    function test_ConvertWeek_PartialAcrossSeveralCalls() public {
        _seedWeek0();
        _convert(WEEK0, 10e18);
        assertEq(_pending(WEEK0), 40e18);
        // Rate changes between tranches are reflected in the measured output.
        vm.prank(admin);
        desk.proposeRate(3e18);
        vm.warp(block.timestamp + 1 days);
        vm.prank(admin);
        desk.activateRate();
        _convert(WEEK0, 15e18);
        _convert(WEEK0, 25e18);
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0);
        assertEq(w.wifConverted, 50e18);
        assertEq(w.fesPool, 20e18 + 45e18 + 75e18);
        assertEq(_pending(WEEK0), 0);
    }

    function test_ConvertWeek_ExceedingAllocationReverts() public {
        _seedWeek0();
        _convert(WEEK0, 30e18);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.ExceedsUnconvertedAllocation.selector, 21e18, 20e18));
        vault.convertWeek(WEEK0, 21e18, address(desk), 1, block.timestamp);
        // Another week's allocation can never be used.
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.ExceedsUnconvertedAllocation.selector, 1, 0));
        vault.convertWeek(WEEK0 + 1, 1, address(desk), 1, block.timestamp);
    }

    function test_ConvertWeek_UnapprovedConverterReverts() public {
        _seedWeek0();
        FixedRateConverter rogue =
            new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), 1e18, wifSink, admin);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.ConverterNotApproved.selector, address(rogue)));
        vault.convertWeek(WEEK0, 1e18, address(rogue), 1, block.timestamp);

        // Revoked converters cannot be used either.
        vm.prank(admin);
        vault.setConverter(address(desk), false);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.ConverterNotApproved.selector, address(desk)));
        vault.convertWeek(WEEK0, 1e18, address(desk), 1, block.timestamp);
    }

    function test_ConvertWeek_DeadlineReverts() public {
        _seedWeek0();
        uint256 deadline = block.timestamp - 1;
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.DeadlineExpired.selector, deadline));
        vault.convertWeek(WEEK0, 1e18, address(desk), 1, deadline);

        // deadline == block.timestamp is still valid
        vm.prank(settler);
        vault.convertWeek(WEEK0, 1e18, address(desk), 1, block.timestamp);
    }

    function test_ConvertWeek_SlippageReverts() public {
        _seedWeek0();
        // Desk quotes 2 FES per WIF; asking for more must revert.
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(FixedRateConverter.InsufficientOutput.selector, 2e18, 2e18 + 1));
        vault.convertWeek(WEEK0, 1e18, address(desk), 2e18 + 1, block.timestamp);
        assertEq(_pending(WEEK0), 50e18);
    }

    function test_ConvertWeek_ZeroAmountAndZeroMinOutReverts() public {
        _seedWeek0();
        vm.startPrank(settler);
        vm.expectRevert(SocietyPrizeVault.ZeroAmount.selector);
        vault.convertWeek(WEEK0, 0, address(desk), 1, block.timestamp);
        vm.expectRevert(SocietyPrizeVault.ZeroMinOutput.selector);
        vault.convertWeek(WEEK0, 1e18, address(desk), 0, block.timestamp);
        vm.stopPrank();
    }

    function test_ConvertWeek_FinalizedWeekReverts() public {
        _readyWeek0();
        _finalize(WEEK0, alice, bob, carol);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.WeekAlreadyFinalized.selector, WEEK0));
        vault.convertWeek(WEEK0, 1, address(desk), 1, block.timestamp);
    }

    function test_ConvertWeek_OnlySettler() public {
        _seedWeek0();
        vm.expectRevert(_unauthorized(admin, SETTLER_ROLE));
        vm.prank(admin);
        vault.convertWeek(WEEK0, 1e18, address(desk), 1, block.timestamp);
        vm.expectRevert(_unauthorized(stranger, SETTLER_ROLE));
        vm.prank(stranger);
        vault.convertWeek(WEEK0, 1e18, address(desk), 1, block.timestamp);
    }

    function _maliciousConverter(MaliciousConverter.Mode mode) internal returns (MaliciousConverter m) {
        m = new MaliciousConverter(IERC20(address(wif)), IERC20(address(fes)));
        m.setMode(mode);
        fes.mint(address(m), 1_000e18);
        vm.prank(admin);
        vault.setConverter(address(m), true);
    }

    function test_ConvertWeek_UsesMeasuredOutputNotReturnValue() public {
        _seedWeek0();
        MaliciousConverter m = _maliciousConverter(MaliciousConverter.Mode.LieAboutOutput);
        // Converter claims 10 FES but only sends 5.
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.InsufficientOutput.selector, 5e18, 10e18));
        vault.convertWeek(WEEK0, 10e18, address(m), 10e18, block.timestamp);

        // With a lower minimum the pool is credited with what was actually received.
        vm.prank(settler);
        uint256 out = vault.convertWeek(WEEK0, 10e18, address(m), 5e18, block.timestamp);
        assertEq(out, 5e18);
        assertEq(vault.getWeek(WEEK0).fesPool, 5e18);
    }

    function test_ConvertWeek_ConverterIgnoringMinOutStillReverts() public {
        _seedWeek0();
        MaliciousConverter m = _maliciousConverter(MaliciousConverter.Mode.IgnoreMinOut);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.InsufficientOutput.selector, 5e18, 10e18));
        vault.convertWeek(WEEK0, 10e18, address(m), 10e18, block.timestamp);
    }

    function test_ConvertWeek_ConverterPullingWrongAmountReverts() public {
        _seedWeek0();
        MaliciousConverter m = _maliciousConverter(MaliciousConverter.Mode.PullLess);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.UnexpectedWifSpent.selector, 10e18, 10e18 - 1));
        vault.convertWeek(WEEK0, 10e18, address(m), 1, block.timestamp);
    }

    function test_ConvertWeek_ReentrantConverterFails() public {
        _seedWeek0();
        MaliciousConverter m = _maliciousConverter(MaliciousConverter.Mode.Reenter);
        // Converter tries to sneak FES in through fundWeek (would be double counted) ...
        fes.mint(address(m), 10e18);
        vm.prank(address(m));
        fes.approve(address(vault), type(uint256).max);
        m.setReenter(address(vault), abi.encodeCall(SocietyPrizeVault.fundWeek, (WEEK0, 10e18)));
        vm.prank(settler);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.convertWeek(WEEK0, 10e18, address(m), 1, block.timestamp);

        // ... or to claim during conversion.
        m.setReenter(address(vault), abi.encodeCall(SocietyPrizeVault.claimFor, (WEEK0, 0)));
        vm.prank(settler);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.convertWeek(WEEK0, 10e18, address(m), 1, block.timestamp);
    }

    // ---------------------------------------------------------------------------------------------
    // fundWeek
    // ---------------------------------------------------------------------------------------------

    function test_FundWeek() public {
        address sponsor = makeAddr("sponsor");
        fes.mint(sponsor, 30e18);
        vm.prank(sponsor);
        fes.approve(address(vault), 30e18);

        vm.expectEmit(address(vault));
        emit WeekFunded(WEEK0, sponsor, 30e18);
        vm.prank(sponsor);
        vault.fundWeek(WEEK0, 30e18);

        assertEq(vault.getWeek(WEEK0).fesPool, 30e18);
        assertEq(fes.balanceOf(address(vault)), 30e18);
        assertEq(vault.totalFesLiabilities(), 30e18);

        // Future weeks may be pre-funded.
        _fundWeek(sponsor, WEEK0 + 5, 1e18);
        assertEq(vault.getWeek(WEEK0 + 5).fesPool, 1e18);
    }

    function test_FundWeek_Reverts() public {
        vm.expectRevert(SocietyPrizeVault.ZeroAmount.selector);
        vault.fundWeek(WEEK0, 0);

        _readyWeek0();
        _finalize(WEEK0, alice, bob, carol);
        fes.mint(address(this), 1e18);
        fes.approve(address(vault), 1e18);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.WeekAlreadyFinalized.selector, WEEK0));
        vault.fundWeek(WEEK0, 1e18);
    }

    function test_FundWeek_RejectsFeeOnTransferFes() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        SocietyPrizeVault v = new SocietyPrizeVault(IERC20(address(wif)), IERC20(address(fot)), admin);
        fot.mint(address(this), 100e18);
        fot.approve(address(v), 100e18);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.UnexpectedAmountReceived.selector, 100e18, 99e18));
        v.fundWeek(WEEK0, 100e18);
    }

    // ---------------------------------------------------------------------------------------------
    // finalizeWeek
    // ---------------------------------------------------------------------------------------------

    function test_Finalize_ThreeWinners() public {
        uint256 pool = _readyWeek0();
        assertEq(pool, 100e18);
        bytes32 resultsHash = keccak256("leaderboard");
        address[3] memory winners = _winners(alice, bob, carol);
        uint256[3] memory expected = [uint256(50e18), 30e18, 20e18];

        vm.expectEmit(address(vault));
        emit WeekFinalized(WEEK0, winners, expected, resultsHash);
        vm.prank(settler);
        vault.finalizeWeek(WEEK0, winners, resultsHash);

        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0);
        assertTrue(w.finalized);
        assertEq(w.finalizedAt, block.timestamp);
        assertEq(w.resultsHash, resultsHash);
        assertEq(w.winners[0], alice);
        assertEq(w.winners[1], bob);
        assertEq(w.winners[2], carol);
        assertEq(w.amounts[0], 50e18);
        assertEq(w.amounts[1], 30e18);
        assertEq(w.amounts[2], 20e18);
        assertEq(w.rolledOver, 0);
        assertEq(w.startTime, WEEK0_START);
        assertEq(w.endTime, WEEK0_START + 7 days);
        assertEq(vault.getWeek(WEEK0 + 1).fesPool, 0);
        assertEq(vault.totalFesLiabilities(), 100e18);
    }

    function test_Finalize_RoundingNoDust() public {
        _seedWeek0();
        _convertAll(WEEK0);
        // Pool of 100e18 + 7 wei makes 50/30/20 non-integral.
        _fundWeek(stranger, WEEK0, 7);
        _warpPastWeek(WEEK0);
        _finalize(WEEK0, alice, bob, carol);
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0);
        uint256 pool = 100e18 + 7;
        assertEq(w.amounts[0], pool * 5000 / 10_000);
        assertEq(w.amounts[1], pool * 3000 / 10_000);
        assertEq(w.amounts[2], pool - w.amounts[0] - w.amounts[1]);
        assertEq(w.amounts[0] + w.amounts[1] + w.amounts[2], pool);
    }

    function test_Finalize_BeforeWeekEndReverts() public {
        _seedWeek0();
        _convertAll(WEEK0);
        uint256 end = SocietyWeeks.weekEnd(WEEK0);
        vm.warp(end - 1);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.WeekNotEnded.selector, WEEK0, end));
        vault.finalizeWeek(WEEK0, _winners(alice, bob, carol), bytes32(0));

        // Future weeks cannot be finalized either.
        vm.prank(settler);
        vm.expectRevert(
            abi.encodeWithSelector(SocietyPrizeVault.WeekNotEnded.selector, WEEK0 + 3, SocietyWeeks.weekEnd(WEEK0 + 3))
        );
        vault.finalizeWeek(WEEK0 + 3, _winners(alice, bob, carol), bytes32(0));

        // Exactly at the end (next Monday 00:00:00 UTC) it works.
        vm.warp(end);
        _finalize(WEEK0, alice, bob, carol);
    }

    function test_Finalize_TwiceReverts() public {
        _readyWeek0();
        _finalize(WEEK0, alice, bob, carol);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.WeekAlreadyFinalized.selector, WEEK0));
        vault.finalizeWeek(WEEK0, _winners(dave, bob, carol), bytes32(0));
        // State untouched by the replay attempt.
        assertEq(vault.getWeek(WEEK0).winners[0], alice);
    }

    function test_Finalize_WithUnconvertedWifReverts() public {
        _seedWeek0();
        _convert(WEEK0, 49e18);
        _warpPastWeek(WEEK0);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.UnconvertedAllocation.selector, WEEK0, 1e18));
        vault.finalizeWeek(WEEK0, _winners(alice, bob, carol), bytes32(0));

        // Conversion is still possible after the week ended; then finalization works.
        _convertAll(WEEK0);
        _finalize(WEEK0, alice, bob, carol);
    }

    function test_Finalize_DuplicateWinnersRevert() public {
        _readyWeek0();
        vm.startPrank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.DuplicateWinner.selector, alice));
        vault.finalizeWeek(WEEK0, _winners(alice, alice, carol), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.DuplicateWinner.selector, alice));
        vault.finalizeWeek(WEEK0, _winners(alice, bob, alice), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.DuplicateWinner.selector, bob));
        vault.finalizeWeek(WEEK0, _winners(alice, bob, bob), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.DuplicateWinner.selector, alice));
        vault.finalizeWeek(WEEK0, _winners(alice, alice, address(0)), bytes32(0));
        vm.stopPrank();
    }

    function test_Finalize_ZeroWinnerOrdering() public {
        _readyWeek0();
        vm.startPrank(settler);
        vm.expectRevert(SocietyPrizeVault.InvalidWinnerOrder.selector);
        vault.finalizeWeek(WEEK0, _winners(address(0), alice, bob), bytes32(0));
        vm.expectRevert(SocietyPrizeVault.InvalidWinnerOrder.selector);
        vault.finalizeWeek(WEEK0, _winners(alice, address(0), bob), bytes32(0));
        vm.expectRevert(SocietyPrizeVault.InvalidWinnerOrder.selector);
        vault.finalizeWeek(WEEK0, _winners(address(0), address(0), bob), bytes32(0));
        vm.expectRevert(SocietyPrizeVault.InvalidWinnerOrder.selector);
        vault.finalizeWeek(WEEK0, _winners(address(0), alice, address(0)), bytes32(0));
        vm.stopPrank();
    }

    function test_Finalize_OneWinnerRollsOverRest() public {
        _readyWeek0();
        vm.expectEmit(address(vault));
        emit PoolRolledOver(WEEK0, WEEK0 + 1, 50e18);
        vm.expectEmit(address(vault));
        emit WeekFinalized(WEEK0, _winners(alice, address(0), address(0)), [uint256(50e18), 0, 0], bytes32("r"));
        vm.prank(settler);
        vault.finalizeWeek(WEEK0, _winners(alice, address(0), address(0)), "r");

        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0);
        assertEq(w.amounts[0], 50e18);
        assertEq(w.amounts[1], 0);
        assertEq(w.amounts[2], 0);
        assertEq(w.rolledOver, 50e18);
        assertEq(vault.getWeek(WEEK0 + 1).fesPool, 50e18);
        assertEq(vault.totalFesLiabilities(), 100e18);
    }

    function test_Finalize_TwoWinnersRollsOverThird() public {
        _readyWeek0();
        vm.expectEmit(address(vault));
        emit PoolRolledOver(WEEK0, WEEK0 + 1, 20e18);
        _finalize(WEEK0, alice, bob, address(0));
        assertEq(vault.getWeek(WEEK0 + 1).fesPool, 20e18);
        assertEq(vault.getWeek(WEEK0).rolledOver, 20e18);
    }

    function test_Finalize_NoWinnersRollsOverEverything() public {
        _readyWeek0();
        _finalize(WEEK0, address(0), address(0), address(0));
        assertEq(vault.getWeek(WEEK0 + 1).fesPool, 100e18);
        assertEq(vault.getWeek(WEEK0).rolledOver, 100e18);
    }

    function test_Finalize_RolloverAddsToExistingNextWeekPool() public {
        _readyWeek0();
        // WEEK0+1 is now the current week and already has entries / conversions.
        _enterMany(alice, 2, 99);
        _convertAll(WEEK0 + 1);
        uint256 before = vault.getWeek(WEEK0 + 1).fesPool;
        assertEq(before, 20e18);
        _finalize(WEEK0, alice, address(0), address(0));
        assertEq(vault.getWeek(WEEK0 + 1).fesPool, before + 50e18);
    }

    function test_Finalize_RolloverRevertsIfNextWeekFinalized() public {
        _readyWeek0();
        _warpPastWeek(WEEK0 + 1);
        // Week+1 (no entries) is settled first.
        _finalize(WEEK0 + 1, alice, bob, carol);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.NextWeekAlreadyFinalized.selector, WEEK0 + 1));
        vault.finalizeWeek(WEEK0, _winners(alice, bob, address(0)), bytes32(0));
        // A full podium needs no rollover and still works.
        _finalize(WEEK0, alice, bob, carol);
    }

    function test_Finalize_EmptyWeekWithFewerWinnersNoRolloverNeeded() public {
        _warpPastWeek(WEEK0 + 1);
        _finalize(WEEK0 + 1, address(0), address(0), address(0));
        // Nothing to roll over, so finalizing the previous week with no winners is fine.
        _finalize(WEEK0, address(0), address(0), address(0));
        assertTrue(vault.getWeek(WEEK0).finalized);
    }

    function test_Finalize_RolledOverFundsAreClaimableNextWeek() public {
        _readyWeek0();
        _finalize(WEEK0, alice, bob, address(0)); // 20 FES rolls over
        _warpPastWeek(WEEK0 + 1);
        _finalize(WEEK0 + 1, carol, address(0), address(0)); // carol gets 10, 10 rolls to +2
        vm.prank(carol);
        vault.claim(WEEK0 + 1, 0);
        assertEq(fes.balanceOf(carol), 10e18);
        assertEq(vault.getWeek(WEEK0 + 2).fesPool, 10e18);
    }

    function test_Finalize_OnlySettler() public {
        _readyWeek0();
        vm.expectRevert(_unauthorized(admin, SETTLER_ROLE));
        vm.prank(admin);
        vault.finalizeWeek(WEEK0, _winners(alice, bob, carol), bytes32(0));
        vm.expectRevert(_unauthorized(alice, SETTLER_ROLE));
        vm.prank(alice);
        vault.finalizeWeek(WEEK0, _winners(alice, bob, carol), bytes32(0));
    }

    function testFuzz_SplitPoolSumsExactly(uint256 pool) public view {
        uint256[3] memory s = vault.splitPool(pool);
        if (pool <= type(uint256).max / 10_000) {
            assertEq(s[0], pool * 5000 / 10_000);
            assertEq(s[1], pool * 3000 / 10_000);
        }
        assertEq(s[0], pool / 2);
        assertEq(s[0] + s[1] + s[2], pool);
        assertGe(s[0], s[1]);
        // 3rd place gets 20% plus at most 2 wei of rounding remainder.
        assertLe(s[2], pool / 5 + 2);
        assertGe(s[2], pool / 5);
    }

    function testFuzz_FinalizeDistributesExactly(uint256 pool, uint8 winnerCount) public {
        pool = bound(pool, 0, 1e36);
        winnerCount = uint8(bound(winnerCount, 0, 3));
        if (pool > 0) _fundWeek(stranger, WEEK0, pool);
        _warpPastWeek(WEEK0);
        address[3] memory winners;
        address[3] memory players = [alice, bob, carol];
        for (uint256 i; i < winnerCount; ++i) {
            winners[i] = players[i];
        }
        vm.prank(settler);
        vault.finalizeWeek(WEEK0, winners, bytes32(0));

        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0);
        uint256 assigned = w.amounts[0] + w.amounts[1] + w.amounts[2];
        uint256 rolled = vault.getWeek(WEEK0 + 1).fesPool;
        assertEq(assigned + rolled, pool);
        assertEq(w.rolledOver, rolled);
        assertEq(vault.totalFesLiabilities(), pool);

        // Everyone claims; vault ends with exactly the rolled-over amount.
        for (uint8 r; r < winnerCount; ++r) {
            if (w.amounts[r] > 0) vault.claimFor(WEEK0, r);
        }
        assertEq(fes.balanceOf(address(vault)), rolled);
        assertEq(vault.totalFesLiabilities(), rolled);
    }

    // ---------------------------------------------------------------------------------------------
    // claim / claimFor
    // ---------------------------------------------------------------------------------------------

    function test_Claim() public {
        _readyWeek0();
        _finalize(WEEK0, alice, bob, carol);

        vm.expectEmit(address(vault));
        emit RewardClaimed(WEEK0, 0, alice, 50e18);
        vm.prank(alice);
        uint256 amount = vault.claim(WEEK0, 0);
        assertEq(amount, 50e18);
        assertEq(fes.balanceOf(alice), 50e18);
        assertTrue(vault.isClaimed(WEEK0, 0));
        assertFalse(vault.isClaimed(WEEK0, 1));

        vm.prank(bob);
        vault.claim(WEEK0, 1);
        vm.prank(carol);
        vault.claim(WEEK0, 2);
        assertEq(fes.balanceOf(bob), 30e18);
        assertEq(fes.balanceOf(carol), 20e18);
        assertEq(fes.balanceOf(address(vault)), 0);
        assertEq(vault.totalFesLiabilities(), 0);

        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0);
        assertTrue(w.claimed[0] && w.claimed[1] && w.claimed[2]);
    }

    function test_Claim_DoubleClaimReverts() public {
        _readyWeek0();
        _finalize(WEEK0, alice, bob, carol);
        vm.prank(alice);
        vault.claim(WEEK0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.AlreadyClaimed.selector, WEEK0, 0));
        vault.claim(WEEK0, 0);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.AlreadyClaimed.selector, WEEK0, 0));
        vault.claimFor(WEEK0, 0);
        assertEq(fes.balanceOf(alice), 50e18);
    }

    function test_Claim_NotWinnerReverts() public {
        _readyWeek0();
        _finalize(WEEK0, alice, bob, carol);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.NotWinner.selector, bob, alice));
        vault.claim(WEEK0, 0);
    }

    function test_Claim_Reverts() public {
        _readyWeek0();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.WeekNotFinalized.selector, WEEK0));
        vault.claim(WEEK0, 0);

        _finalize(WEEK0, alice, address(0), address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.InvalidRank.selector, 3));
        vault.claim(WEEK0, 3);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.InvalidRank.selector, 255));
        vault.claimFor(WEEK0, 255);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.NoWinnerForRank.selector, WEEK0, 1));
        vault.claimFor(WEEK0, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.NoWinnerForRank.selector, WEEK0, 2));
        vault.claim(WEEK0, 2);
    }

    function test_Claim_NothingToClaimWhenPoolEmpty() public {
        _warpPastWeek(WEEK0);
        _finalize(WEEK0, alice, bob, carol);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.NothingToClaim.selector, WEEK0, 0));
        vault.claim(WEEK0, 0);
    }

    function test_ClaimFor_PaysWinnerNotCaller() public {
        _readyWeek0();
        _finalize(WEEK0, alice, bob, carol);
        vm.expectEmit(address(vault));
        emit RewardClaimed(WEEK0, 1, bob, 30e18);
        vm.prank(stranger);
        uint256 amount = vault.claimFor(WEEK0, 1);
        assertEq(amount, 30e18);
        assertEq(fes.balanceOf(bob), 30e18);
        assertEq(fes.balanceOf(stranger), 0);
        // Winner can no longer claim it again.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.AlreadyClaimed.selector, WEEK0, 1));
        vault.claim(WEEK0, 1);
    }

    function test_Claim_PausedBlocksClaims() public {
        _readyWeek0();
        _finalize(WEEK0, alice, bob, carol);
        vm.prank(admin);
        vault.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.claim(WEEK0, 0);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.claimFor(WEEK0, 0);

        vm.prank(admin);
        vault.unpause();
        vm.prank(alice);
        vault.claim(WEEK0, 0);
        assertEq(fes.balanceOf(alice), 50e18);
    }

    function test_Pause_OnlyPauser() public {
        vm.expectRevert(_unauthorized(settler, PAUSER_ROLE));
        vm.prank(settler);
        vault.pause();
        vm.prank(admin);
        vault.pause();
        vm.expectRevert(_unauthorized(settler, PAUSER_ROLE));
        vm.prank(settler);
        vault.unpause();
    }

    function test_Pause_DoesNotBlockEntriesOrSettlement() public {
        vm.prank(admin);
        vault.pause();
        _seedWeek0();
        _convertAll(WEEK0);
        _warpPastWeek(WEEK0);
        _finalize(WEEK0, alice, bob, carol);
        assertTrue(vault.getWeek(WEEK0).finalized);
    }

    function test_Claim_ReentrancyViaMaliciousFesFails() public {
        ReentrantToken rFes = new ReentrantToken();
        SocietyPrizeVault v = new SocietyPrizeVault(IERC20(address(wif)), IERC20(address(rFes)), admin);
        vm.prank(admin);
        v.grantRole(SETTLER_ROLE, settler);
        rFes.mint(address(this), 100e18);
        rFes.approve(address(v), 100e18);
        v.fundWeek(WEEK0, 100e18);
        _warpPastWeek(WEEK0);
        vm.prank(settler);
        v.finalizeWeek(WEEK0, _winners(alice, bob, carol), bytes32(0));

        rFes.arm(address(v), abi.encodeCall(SocietyPrizeVault.claimFor, (WEEK0, 1)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        v.claimFor(WEEK0, 0);

        rFes.arm(address(v), abi.encodeCall(SocietyPrizeVault.claimFor, (WEEK0, 0)));
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        v.claim(WEEK0, 0);

        assertEq(rFes.balanceOf(address(v)), 100e18);
        assertFalse(v.isClaimed(WEEK0, 0));
    }

    // ---------------------------------------------------------------------------------------------
    // rescueToken
    // ---------------------------------------------------------------------------------------------

    function test_RescueToken_CannotTakePrizeTokens() public {
        _seedWeek0();
        _convert(WEEK0, 10e18);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.CannotRescuePrizeToken.selector, address(wif)));
        vault.rescueToken(address(wif), admin, 1);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.CannotRescuePrizeToken.selector, address(fes)));
        vault.rescueToken(address(fes), admin, 1);
        vm.stopPrank();
    }

    function test_RescueToken_OtherTokens() public {
        MockSocietyToken stray = new MockSocietyToken("Stray", "STR", 6);
        stray.mint(address(vault), 5e6);
        vm.prank(admin);
        vm.expectRevert(SocietyPrizeVault.ZeroAddress.selector);
        vault.rescueToken(address(stray), address(0), 5e6);

        vm.expectEmit(address(vault));
        emit TokenRescued(address(stray), alice, 5e6);
        vm.prank(admin);
        vault.rescueToken(address(stray), alice, 5e6);
        assertEq(stray.balanceOf(alice), 5e6);
    }

    function test_RescueToken_OnlyAdmin() public {
        MockSocietyToken stray = new MockSocietyToken("Stray", "STR", 18);
        stray.mint(address(vault), 1e18);
        vm.expectRevert(_unauthorized(settler, ADMIN_ROLE));
        vm.prank(settler);
        vault.rescueToken(address(stray), settler, 1e18);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function test_Views() public view {
        assertEq(vault.currentWeekId(), WEEK0);
        assertEq(vault.weekIdAt(WEEK0_START), WEEK0);
        assertEq(vault.weekStart(WEEK0), WEEK0_START);
        assertEq(vault.weekEnd(WEEK0), WEEK0_START + 7 days);
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0 + 10);
        assertEq(w.weekId, WEEK0 + 10);
        assertEq(w.startTime, WEEK0_START + 70 days);
        assertFalse(w.finalized);
        assertEq(w.fesPool, 0);
    }

    function test_IsClaimed_InvalidRankReverts() public {
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.InvalidRank.selector, 3));
        vault.isClaimed(WEEK0, 3);
    }

    // ---------------------------------------------------------------------------------------------
    // Role administration
    // ---------------------------------------------------------------------------------------------

    function test_OnlyAdminGrantsRoles() public {
        vm.expectRevert(_unauthorized(settler, ADMIN_ROLE));
        vm.prank(settler);
        vault.grantRole(SETTLER_ROLE, stranger);

        vm.prank(admin);
        vault.grantRole(SETTLER_ROLE, stranger);
        assertTrue(vault.hasRole(SETTLER_ROLE, stranger));
        vm.prank(admin);
        vault.revokeRole(SETTLER_ROLE, stranger);
        assertFalse(vault.hasRole(SETTLER_ROLE, stranger));
    }
}
