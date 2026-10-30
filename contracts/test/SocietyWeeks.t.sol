// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SocietyWeeks} from "../src/libraries/SocietyWeeks.sol";

/// @dev External wrappers so reverts of the internal library can be asserted.
contract WeeksHarness {
    function weekIdAt(uint256 ts) external pure returns (uint256) {
        return SocietyWeeks.weekIdAt(ts);
    }

    function weekStart(uint256 id) external pure returns (uint256) {
        return SocietyWeeks.weekStart(id);
    }

    function weekEnd(uint256 id) external pure returns (uint256) {
        return SocietyWeeks.weekEnd(id);
    }
}

contract SocietyWeeksTest is Test {
    WeeksHarness internal h;

    function setUp() public {
        h = new WeeksHarness();
    }

    function test_Constants() public pure {
        assertEq(SocietyWeeks.EPOCH, 345_600);
        assertEq(SocietyWeeks.WEEK, 604_800);
        assertEq(SocietyWeeks.WEEK, 7 days);
        // 1970-01-05 00:00:00 UTC is a Monday (1970-01-01 was a Thursday).
        assertEq(SocietyWeeks.EPOCH, 4 days);
    }

    function test_WeekZero() public view {
        assertEq(h.weekIdAt(345_600), 0);
        assertEq(h.weekIdAt(345_600 + 604_799), 0);
        assertEq(h.weekIdAt(345_600 + 604_800), 1);
        assertEq(h.weekStart(0), 345_600);
        assertEq(h.weekEnd(0), 345_600 + 604_800);
    }

    function test_RevertWhen_TimestampBeforeEpoch() public {
        vm.expectRevert(abi.encodeWithSelector(SocietyWeeks.TimestampBeforeEpoch.selector, 345_599));
        h.weekIdAt(345_599);
        vm.expectRevert(abi.encodeWithSelector(SocietyWeeks.TimestampBeforeEpoch.selector, 0));
        h.weekIdAt(0);
    }

    function test_KnownCalendarDates() public view {
        // Monday 2026-10-26 00:00:00 UTC
        uint256 monday = 1_792_972_800;
        // Sunday 2026-11-01 23:59:59 UTC
        uint256 sunday = 1_793_577_599;
        // Monday 2026-11-02 00:00:00 UTC
        uint256 nextMonday = 1_793_577_600;

        assertEq(h.weekIdAt(monday), 2964);
        assertEq(h.weekIdAt(sunday), 2964);
        assertEq(h.weekIdAt(nextMonday), 2965);
        assertEq(h.weekStart(2964), monday);
        assertEq(h.weekEnd(2964), nextMonday);
        assertEq(h.weekIdAt(monday - 1), 2963);
    }

    function testFuzz_TimestampFallsInsideItsWeek(uint256 ts) public view {
        ts = bound(ts, SocietyWeeks.EPOCH, type(uint64).max);
        uint256 id = h.weekIdAt(ts);
        assertLe(h.weekStart(id), ts);
        assertLt(ts, h.weekEnd(id));
        assertEq(h.weekEnd(id) - h.weekStart(id), SocietyWeeks.WEEK);
        assertEq(h.weekIdAt(h.weekStart(id)), id);
        assertEq(h.weekIdAt(h.weekEnd(id) - 1), id);
        assertEq(h.weekIdAt(h.weekEnd(id)), id + 1);
    }

    function testFuzz_WeekStartIsMondayMidnight(uint32 id) public view {
        uint256 start = h.weekStart(id);
        // Unix day 0 was a Thursday: day index % 7 == 4 -> Monday.
        assertEq(start % 1 days, 0);
        assertEq((start / 1 days) % 7, 4);
        assertEq(h.weekEnd(id), h.weekStart(uint256(id) + 1));
    }
}
