// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SocietyEntry} from "../../src/SocietyEntry.sol";
import {SocietyPrizeVault} from "../../src/SocietyPrizeVault.sol";
import {ISocietyPrizeVault} from "../../src/interfaces/ISocietyPrizeVault.sol";
import {FixedRateConverter} from "../../src/converters/FixedRateConverter.sol";
import {SocietyWeeks} from "../../src/libraries/SocietyWeeks.sol";
import {MockSocietyToken} from "../../src/mocks/MockSocietyToken.sol";

/// @notice Drives the Society contracts with valid random actions for invariant testing.
contract VaultHandler is Test {
    SocietyEntry public entry;
    SocietyPrizeVault public vault;
    FixedRateConverter public desk;
    MockSocietyToken public wif;
    MockSocietyToken public fes;
    address public settler;
    address public admin;

    address[] public actors;
    uint256 public immutable firstWeek;

    uint256 public ghostFeesPaid;
    uint256 public ghostEntries;
    uint256 public ghostClaimed;
    uint256 public ghostFunded;
    uint256 public ghostConverted;
    uint256 public ghostFinalized;
    uint256 internal nonce;

    constructor(
        SocietyEntry entry_,
        SocietyPrizeVault vault_,
        FixedRateConverter desk_,
        MockSocietyToken wif_,
        MockSocietyToken fes_,
        address settler_,
        address admin_
    ) {
        entry = entry_;
        vault = vault_;
        desk = desk_;
        wif = wif_;
        fes = fes_;
        settler = settler_;
        admin = admin_;
        firstWeek = SocietyWeeks.weekIdAt(block.timestamp);
        for (uint256 i; i < 6; ++i) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function currentWeek() public view returns (uint256) {
        return SocietyWeeks.weekIdAt(block.timestamp);
    }

    /// @notice Last week id the invariants need to inspect (rollovers can reach current + 1).
    function lastWeek() public view returns (uint256) {
        return currentWeek() + 1;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _pickWeek(uint256 seed, uint256 maxWeek) internal view returns (uint256) {
        return bound(seed, firstWeek, maxWeek);
    }

    function _convert(uint256 weekId, uint256 amount) internal {
        uint256 out = desk.quote(amount);
        if (out == 0) return;
        if (desk.inventory() < out) fes.mint(address(desk), out);
        vm.prank(settler);
        ghostConverted += vault.convertWeek(weekId, amount, address(desk), out, block.timestamp);
    }

    // ---------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------

    function enter(uint256 actorSeed) external {
        address player = _actor(actorSeed);
        uint256 fee = entry.entryFee();
        wif.mint(player, fee);
        vm.startPrank(player);
        wif.approve(address(entry), fee);
        entry.enter(bytes32(++nonce), type(uint256).max);
        vm.stopPrank();
        ghostFeesPaid += fee;
        ghostEntries++;
    }

    function changeFee(uint256 newFee) external {
        newFee = bound(newFee, 1, 1e24) * 2;
        vm.prank(admin);
        entry.setEntryFee(newFee);
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1, 4 days);
        vm.warp(block.timestamp + secs);
    }

    function convert(uint256 weekSeed, uint256 amountSeed) external {
        uint256 weekId = _pickWeek(weekSeed, currentWeek());
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(weekId);
        if (w.finalized) return;
        uint256 pending = w.wifAllocated - w.wifConverted;
        if (pending == 0) return;
        _convert(weekId, bound(amountSeed, 1, pending));
    }

    function changeRate(uint256 newRate) external {
        newRate = bound(newRate, 1e15, 1e21);
        vm.prank(admin);
        desk.proposeRate(newRate);
        vm.warp(block.timestamp + desk.RATE_DELAY());
        vm.prank(admin);
        desk.activateRate();
    }

    function fund(uint256 weekSeed, uint256 amount, uint256 actorSeed) external {
        uint256 weekId = _pickWeek(weekSeed, currentWeek() + 1);
        if (vault.getWeek(weekId).finalized) return;
        amount = bound(amount, 1, 1e24);
        address funder = _actor(actorSeed);
        fes.mint(funder, amount);
        vm.startPrank(funder);
        fes.approve(address(vault), amount);
        vault.fundWeek(weekId, amount);
        vm.stopPrank();
        ghostFunded += amount;
    }

    function finalize(uint256 weekSeed, uint256 winnerCount, uint256 actorSeed) external {
        uint256 cw = currentWeek();
        if (cw == firstWeek) return;
        uint256 weekId = _pickWeek(weekSeed, cw - 1);
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(weekId);
        if (w.finalized) return;

        // The settler must convert everything first.
        uint256 pending = w.wifAllocated - w.wifConverted;
        if (pending > 0) {
            if (desk.quote(pending) == 0) return; // dust that cannot be converted at this rate
            _convert(weekId, pending);
        }

        winnerCount = bound(winnerCount, 0, 3);
        // A partial podium rolls over into week+1, which must not be finalized yet.
        if (winnerCount < 3 && vault.getWeek(weekId + 1).finalized) winnerCount = 3;

        address[3] memory winners;
        uint256 start = actorSeed % actors.length;
        for (uint256 i; i < winnerCount; ++i) {
            winners[i] = actors[(start + i) % actors.length];
        }
        vm.prank(settler);
        vault.finalizeWeek(weekId, winners, keccak256(abi.encode(weekId, winners)));
        ghostFinalized++;
    }

    function claim(uint256 weekSeed, uint256 rankSeed, bool pushPayout, uint256 callerSeed) external {
        uint256 weekId = _pickWeek(weekSeed, currentWeek());
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(weekId);
        if (!w.finalized) return;
        uint8 rank = uint8(rankSeed % 3);
        address winner = w.winners[rank];
        if (winner == address(0) || w.claimed[rank] || w.amounts[rank] == 0) return;
        if (pushPayout) {
            vm.prank(_actor(callerSeed));
            vault.claimFor(weekId, rank);
        } else {
            vm.prank(winner);
            vault.claim(weekId, rank);
        }
        ghostClaimed += w.amounts[rank];
    }
}

/// @notice Accounting invariants of the prize vault.
contract VaultInvariantTest is Test {
    MockSocietyToken internal wif;
    MockSocietyToken internal fes;
    SocietyPrizeVault internal vault;
    SocietyEntry internal entry;
    FixedRateConverter internal desk;
    VaultHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal settler = makeAddr("settler");
    address internal treasury = makeAddr("treasury");
    address internal wifSink = makeAddr("wifSink");

    function setUp() public {
        vm.warp(1_792_972_800 + 1 hours);
        wif = new MockSocietyToken("Mock WIF", "mWIF", 18);
        fes = new MockSocietyToken("Mock FES", "mFES", 18);
        vault = new SocietyPrizeVault(IERC20(address(wif)), IERC20(address(fes)), admin);
        entry = new SocietyEntry(IERC20(address(wif)), vault, 10e18, 500e18, treasury, admin);
        desk = new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), 2e18, wifSink, admin);

        vm.startPrank(admin);
        vault.grantRole(vault.ENTRY_ROLE(), address(entry));
        vault.grantRole(vault.SETTLER_ROLE(), settler);
        vault.setConverter(address(desk), true);
        desk.setAuthorizedCaller(address(vault), true);
        vm.stopPrank();

        handler = new VaultHandler(entry, vault, desk, wif, fes, settler, admin);
        targetContract(address(handler));
    }

    /// @dev Sum over all weeks the handler can have touched.
    function _sums() internal view returns (uint256 unconverted, uint256 liabilities) {
        uint256 last = handler.lastWeek();
        for (uint256 id = handler.firstWeek(); id <= last; ++id) {
            ISocietyPrizeVault.WeekView memory w = vault.getWeek(id);
            unconverted += w.wifAllocated - w.wifConverted;
            if (!w.finalized) {
                liabilities += w.fesPool;
            } else {
                for (uint256 r; r < 3; ++r) {
                    if (!w.claimed[r]) liabilities += w.amounts[r];
                }
            }
        }
    }

    /// @notice vault WIF balance == sum(wifAllocated - wifConverted).
    function invariant_WifBalanceEqualsUnconvertedAllocations() public view {
        (uint256 unconverted,) = _sums();
        assertEq(wif.balanceOf(address(vault)), unconverted);
        assertEq(vault.totalWifUnconverted(), unconverted);
    }

    /// @notice vault FES balance >= unfinalized pools + unclaimed finalized rewards.
    function invariant_FesBalanceCoversLiabilities() public view {
        (, uint256 liabilities) = _sums();
        assertGe(fes.balanceOf(address(vault)), liabilities);
        assertEq(vault.totalFesLiabilities(), liabilities);
    }

    /// @notice Exactly 50% of all fees reach the treasury; the other 50% sits in the vault or was converted.
    function invariant_FeeSplitIsExactlyHalf() public view {
        uint256 fees = handler.ghostFeesPaid();
        assertEq(wif.balanceOf(treasury) * 2, fees);
        assertEq(wif.balanceOf(address(vault)) + wif.balanceOf(wifSink), fees / 2);
        assertEq(wif.balanceOf(address(entry)), 0);
    }

    /// @notice Settled weeks distribute their pool exactly (claims + rollover, no dust).
    function invariant_FinalizedWeeksAreConsistent() public view {
        uint256 last = handler.lastWeek();
        for (uint256 id = handler.firstWeek(); id <= last; ++id) {
            ISocietyPrizeVault.WeekView memory w = vault.getWeek(id);
            if (!w.finalized) {
                assertEq(w.amounts[0] + w.amounts[1] + w.amounts[2], 0);
                continue;
            }
            assertEq(w.wifConverted, w.wifAllocated);
            assertEq(w.amounts[0] + w.amounts[1] + w.amounts[2] + w.rolledOver, w.fesPool);
            for (uint256 r; r < 3; ++r) {
                if (w.winners[r] == address(0)) {
                    assertEq(w.amounts[r], 0);
                    assertFalse(w.claimed[r]);
                }
            }
        }
    }

    /// @notice Every FES that entered the vault (conversions + top-ups) is either still held or was paid out.
    function invariant_FesConservation() public view {
        assertEq(
            fes.balanceOf(address(vault)) + handler.ghostClaimed(), handler.ghostConverted() + handler.ghostFunded()
        );
    }
}
