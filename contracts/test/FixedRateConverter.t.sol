// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {FixedRateConverter} from "../src/converters/FixedRateConverter.sol";
import {SocietyEntry} from "../src/SocietyEntry.sol";
import {SocietyPrizeVault} from "../src/SocietyPrizeVault.sol";
import {MockSocietyToken} from "../src/mocks/MockSocietyToken.sol";

contract FixedRateConverterTest is Test {
    event RateProposed(uint256 newRate, uint256 effectiveAt);
    event RateActivated(uint256 previousRate, uint256 newRate);
    event RateProposalCancelled(uint256 cancelledRate);
    event WifSinkUpdated(address previousSink, address newSink);
    event CallerAuthorizationUpdated(address indexed caller, bool authorized);
    event Converted(address indexed caller, address indexed recipient, uint256 wifIn, uint256 fesOut, uint256 rate);
    event InventoryWithdrawn(address indexed to, uint256 amount);

    MockSocietyToken internal wif;
    MockSocietyToken internal fes;
    FixedRateConverter internal desk;

    address internal admin = makeAddr("admin");
    address internal sink = makeAddr("sink");
    address internal caller = makeAddr("vault");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    bytes32 internal ADMIN_ROLE;
    bytes32 internal RATE_MANAGER_ROLE;

    function setUp() public {
        vm.warp(1_792_972_800);
        wif = new MockSocietyToken("Mock WIF", "mWIF", 18);
        fes = new MockSocietyToken("Mock FES", "mFES", 18);
        desk = new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), 2e18, sink, admin);
        ADMIN_ROLE = desk.DEFAULT_ADMIN_ROLE();
        RATE_MANAGER_ROLE = desk.RATE_MANAGER_ROLE();
        vm.prank(admin);
        desk.setAuthorizedCaller(caller, true);
        fes.mint(address(desk), 1_000_000e18);
        wif.mint(caller, 1_000_000e18);
        vm.prank(caller);
        wif.approve(address(desk), type(uint256).max);
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role);
    }

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    function test_Constructor() public {
        assertEq(address(desk.wif()), address(wif));
        assertEq(address(desk.fes()), address(fes));
        assertEq(desk.rate(), 2e18);
        assertEq(desk.wifSink(), sink);
        assertEq(desk.pendingRate(), 0);
        assertEq(desk.RATE_DELAY(), 24 hours);
        assertEq(desk.RATE_PRECISION(), 1e18);
        assertTrue(desk.hasRole(ADMIN_ROLE, admin));
        assertTrue(desk.hasRole(RATE_MANAGER_ROLE, admin));
        assertEq(RATE_MANAGER_ROLE, keccak256("RATE_MANAGER_ROLE"));

        vm.expectEmit(false, false, false, true);
        emit RateActivated(0, 5e17);
        vm.expectEmit(false, false, false, true);
        emit WifSinkUpdated(address(0), sink);
        new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), 5e17, sink, admin);
    }

    function test_Constructor_Reverts() public {
        vm.expectRevert(FixedRateConverter.ZeroAddress.selector);
        new FixedRateConverter(IERC20(address(0)), IERC20(address(fes)), 1, sink, admin);
        vm.expectRevert(FixedRateConverter.ZeroAddress.selector);
        new FixedRateConverter(IERC20(address(wif)), IERC20(address(0)), 1, sink, admin);
        vm.expectRevert(FixedRateConverter.ZeroAddress.selector);
        new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), 1, sink, address(0));
        vm.expectRevert(FixedRateConverter.ZeroAddress.selector);
        new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), 1, address(0), admin);
        vm.expectRevert(FixedRateConverter.IdenticalTokens.selector);
        new FixedRateConverter(IERC20(address(wif)), IERC20(address(wif)), 1, sink, admin);
        vm.expectRevert(FixedRateConverter.InvalidRate.selector);
        new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), 0, sink, admin);
    }

    // ---------------------------------------------------------------------------------------------
    // convert
    // ---------------------------------------------------------------------------------------------

    function test_Convert() public {
        vm.expectEmit(address(desk));
        emit Converted(caller, recipient, 10e18, 20e18, 2e18);
        vm.prank(caller);
        uint256 out = desk.convert(10e18, 20e18, recipient);
        assertEq(out, 20e18);
        assertEq(fes.balanceOf(recipient), 20e18);
        assertEq(wif.balanceOf(sink), 10e18);
        assertEq(wif.balanceOf(address(desk)), 0);
        assertEq(desk.inventory(), 1_000_000e18 - 20e18);
    }

    function test_Convert_UnauthorizedReverts() public {
        wif.mint(stranger, 1e18);
        vm.prank(stranger);
        wif.approve(address(desk), 1e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FixedRateConverter.UnauthorizedCaller.selector, stranger));
        desk.convert(1e18, 1, stranger);

        vm.prank(admin);
        desk.setAuthorizedCaller(caller, false);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(FixedRateConverter.UnauthorizedCaller.selector, caller));
        desk.convert(1e18, 1, recipient);
    }

    function test_Convert_Reverts() public {
        vm.startPrank(caller);
        vm.expectRevert(FixedRateConverter.ZeroAmount.selector);
        desk.convert(0, 0, recipient);
        vm.expectRevert(FixedRateConverter.ZeroAddress.selector);
        desk.convert(1e18, 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(FixedRateConverter.InsufficientOutput.selector, 2e18, 2e18 + 1));
        desk.convert(1e18, 2e18 + 1, recipient);
        vm.expectRevert(
            abi.encodeWithSelector(FixedRateConverter.InsufficientInventory.selector, 1_000_000e18, 2_000_000e18)
        );
        desk.convert(1_000_000e18, 1, recipient);
        vm.stopPrank();
    }

    function test_Convert_ZeroOutputReverts() public {
        FixedRateConverter tiny = new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), 1, sink, admin);
        vm.prank(admin);
        tiny.setAuthorizedCaller(caller, true);
        vm.prank(caller);
        wif.approve(address(tiny), type(uint256).max);
        // 1e17 * 1 / 1e18 == 0
        vm.prank(caller);
        vm.expectRevert(FixedRateConverter.ZeroOutput.selector);
        tiny.convert(1e17, 0, recipient);
    }

    function test_Convert_RevertsWithoutAllowance() public {
        vm.prank(caller);
        wif.approve(address(desk), 0);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(desk), 0, 1e18)
        );
        desk.convert(1e18, 1, recipient);
    }

    // ---------------------------------------------------------------------------------------------
    // Rate timelock
    // ---------------------------------------------------------------------------------------------

    function test_RateTimelock() public {
        uint256 effectiveAt = block.timestamp + 24 hours;
        vm.expectEmit(address(desk));
        emit RateProposed(3e18, effectiveAt);
        vm.prank(admin);
        desk.proposeRate(3e18);
        assertEq(desk.pendingRate(), 3e18);
        assertEq(desk.pendingRateEffectiveAt(), effectiveAt);
        assertEq(desk.rate(), 2e18);

        // Conversions keep using the active rate during the delay.
        vm.prank(caller);
        assertEq(desk.convert(1e18, 1, recipient), 2e18);

        vm.warp(effectiveAt - 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FixedRateConverter.RateNotYetEffective.selector, effectiveAt));
        desk.activateRate();

        vm.warp(effectiveAt);
        vm.expectEmit(address(desk));
        emit RateActivated(2e18, 3e18);
        vm.prank(admin);
        desk.activateRate();
        assertEq(desk.rate(), 3e18);
        assertEq(desk.pendingRate(), 0);
        assertEq(desk.pendingRateEffectiveAt(), 0);

        vm.prank(caller);
        assertEq(desk.convert(1e18, 1, recipient), 3e18);
        assertEq(desk.quote(1e18), 3e18);
    }

    function test_RateTimelock_NewProposalResetsTimer() public {
        vm.prank(admin);
        desk.proposeRate(3e18);
        vm.warp(block.timestamp + 23 hours);
        vm.prank(admin);
        desk.proposeRate(4e18);
        uint256 effectiveAt = desk.pendingRateEffectiveAt();
        assertEq(effectiveAt, block.timestamp + 24 hours);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FixedRateConverter.RateNotYetEffective.selector, effectiveAt));
        desk.activateRate();
        vm.warp(effectiveAt);
        vm.prank(admin);
        desk.activateRate();
        assertEq(desk.rate(), 4e18);
    }

    function test_RateTimelock_Cancel() public {
        vm.prank(admin);
        desk.proposeRate(3e18);
        vm.expectEmit(address(desk));
        emit RateProposalCancelled(3e18);
        vm.prank(admin);
        desk.cancelRateProposal();
        assertEq(desk.pendingRate(), 0);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        vm.expectRevert(FixedRateConverter.NoPendingRate.selector);
        desk.activateRate();
        vm.prank(admin);
        vm.expectRevert(FixedRateConverter.NoPendingRate.selector);
        desk.cancelRateProposal();
        assertEq(desk.rate(), 2e18);
    }

    function test_RateTimelock_Reverts() public {
        vm.prank(admin);
        vm.expectRevert(FixedRateConverter.InvalidRate.selector);
        desk.proposeRate(0);
        vm.prank(admin);
        vm.expectRevert(FixedRateConverter.NoPendingRate.selector);
        desk.activateRate();
    }

    function test_RateFunctions_OnlyRateManager() public {
        vm.expectRevert(_unauthorized(stranger, RATE_MANAGER_ROLE));
        vm.prank(stranger);
        desk.proposeRate(1e18);

        vm.prank(admin);
        desk.proposeRate(1e18);
        vm.warp(block.timestamp + 1 days);

        vm.expectRevert(_unauthorized(stranger, RATE_MANAGER_ROLE));
        vm.prank(stranger);
        desk.activateRate();
        vm.expectRevert(_unauthorized(stranger, RATE_MANAGER_ROLE));
        vm.prank(stranger);
        desk.cancelRateProposal();

        // A dedicated rate manager (not admin) can manage rates but not admin functions.
        address manager = makeAddr("manager");
        vm.prank(admin);
        desk.grantRole(RATE_MANAGER_ROLE, manager);
        vm.prank(manager);
        desk.activateRate();
        assertEq(desk.rate(), 1e18);
        vm.expectRevert(_unauthorized(manager, ADMIN_ROLE));
        vm.prank(manager);
        desk.withdrawInventory(1, manager);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    function test_SetAuthorizedCaller() public {
        vm.expectEmit(address(desk));
        emit CallerAuthorizationUpdated(stranger, true);
        vm.prank(admin);
        desk.setAuthorizedCaller(stranger, true);
        assertTrue(desk.authorizedCaller(stranger));

        vm.prank(admin);
        vm.expectRevert(FixedRateConverter.ZeroAddress.selector);
        desk.setAuthorizedCaller(address(0), true);

        vm.expectRevert(_unauthorized(stranger, ADMIN_ROLE));
        vm.prank(stranger);
        desk.setAuthorizedCaller(stranger, true);
    }

    function test_SetWifSink() public {
        address newSink = makeAddr("newSink");
        vm.expectEmit(address(desk));
        emit WifSinkUpdated(sink, newSink);
        vm.prank(admin);
        desk.setWifSink(newSink);
        assertEq(desk.wifSink(), newSink);

        vm.prank(caller);
        desk.convert(1e18, 1, recipient);
        assertEq(wif.balanceOf(newSink), 1e18);

        vm.startPrank(admin);
        vm.expectRevert(FixedRateConverter.ZeroAddress.selector);
        desk.setWifSink(address(0));
        vm.expectRevert(FixedRateConverter.InvalidSink.selector);
        desk.setWifSink(address(desk));
        vm.stopPrank();

        vm.expectRevert(_unauthorized(stranger, ADMIN_ROLE));
        vm.prank(stranger);
        desk.setWifSink(stranger);
    }

    function test_WithdrawInventory() public {
        vm.expectEmit(address(desk));
        emit InventoryWithdrawn(admin, 400e18);
        vm.prank(admin);
        desk.withdrawInventory(400e18, admin);
        assertEq(fes.balanceOf(admin), 400e18);

        vm.startPrank(admin);
        vm.expectRevert(FixedRateConverter.ZeroAddress.selector);
        desk.withdrawInventory(1, address(0));
        vm.expectRevert(FixedRateConverter.ZeroAmount.selector);
        desk.withdrawInventory(0, admin);
        vm.stopPrank();

        vm.expectRevert(_unauthorized(stranger, ADMIN_ROLE));
        vm.prank(stranger);
        desk.withdrawInventory(1, stranger);
    }

    function test_AnyoneCanFundInventoryByTransfer() public {
        uint256 before = desk.inventory();
        fes.mint(stranger, 5e18);
        vm.prank(stranger);
        fes.transfer(address(desk), 5e18);
        assertEq(desk.inventory(), before + 5e18);
    }

    // ---------------------------------------------------------------------------------------------
    // Decimals fuzzing
    // ---------------------------------------------------------------------------------------------

    function _decimals(uint256 seed) internal pure returns (uint8) {
        uint8[3] memory options = [uint8(6), 8, 18];
        return options[seed % 3];
    }

    /// @dev For any decimals pair in {6, 8, 18} x {6, 8, 18}, a human price of `humanRate` FES per WIF
    ///      expressed as `rate = humanRate * 10^fesDec * 1e18 / 10^wifDec` converts whole WIF exactly.
    function testFuzz_DecimalsMix(uint256 wifSeed, uint256 fesSeed, uint256 humanRate, uint256 wholeWif) public {
        uint8 wifDec = _decimals(wifSeed);
        uint8 fesDec = _decimals(fesSeed);
        humanRate = bound(humanRate, 1, 1_000_000);
        wholeWif = bound(wholeWif, 1, 1_000_000_000);

        MockSocietyToken w = new MockSocietyToken("W", "W", wifDec);
        MockSocietyToken f = new MockSocietyToken("F", "F", fesDec);
        uint256 rate_ = humanRate * 10 ** fesDec * 1e18 / 10 ** wifDec;
        FixedRateConverter d = new FixedRateConverter(IERC20(address(w)), IERC20(address(f)), rate_, sink, admin);
        vm.prank(admin);
        d.setAuthorizedCaller(caller, true);

        uint256 wifIn = wholeWif * 10 ** wifDec;
        uint256 expected = wholeWif * humanRate * 10 ** fesDec;
        f.mint(address(d), expected);
        w.mint(caller, wifIn);
        vm.startPrank(caller);
        w.approve(address(d), wifIn);
        uint256 out = d.convert(wifIn, expected, recipient);
        vm.stopPrank();

        assertEq(out, expected);
        assertEq(d.quote(wifIn), expected);
        assertEq(f.balanceOf(recipient), expected);
        assertEq(w.balanceOf(sink), wifIn);
        assertEq(f.balanceOf(address(d)), 0);
    }

    /// @dev Fractional amounts round down and never over-pay: out <= wifIn * rate / 1e18.
    function testFuzz_ConvertRoundsDown(uint256 wifIn, uint256 rate_) public {
        wifIn = bound(wifIn, 1, 1e30);
        rate_ = bound(rate_, 1, 1e36);
        FixedRateConverter d = new FixedRateConverter(IERC20(address(wif)), IERC20(address(fes)), rate_, sink, admin);
        uint256 expected = wifIn * rate_ / 1e18;
        assertEq(d.quote(wifIn), expected);
        vm.prank(admin);
        d.setAuthorizedCaller(caller, true);
        fes.mint(address(d), expected);
        wif.mint(caller, wifIn);
        vm.startPrank(caller);
        wif.approve(address(d), wifIn);
        if (expected == 0) {
            vm.expectRevert(FixedRateConverter.ZeroOutput.selector);
            d.convert(wifIn, 0, recipient);
        } else {
            assertEq(d.convert(wifIn, expected, recipient), expected);
            assertLe(expected * 1e18, wifIn * rate_);
        }
        vm.stopPrank();
    }

    /// @dev End-to-end through the vault with 6-decimal WIF and 8-decimal FES.
    function test_VaultWithMixedDecimals() public {
        MockSocietyToken w6 = new MockSocietyToken("WIF6", "W6", 6);
        MockSocietyToken f8 = new MockSocietyToken("FES8", "F8", 8);
        address settler = makeAddr("settler");
        address treasury = makeAddr("treasury");
        SocietyPrizeVault v = new SocietyPrizeVault(IERC20(address(w6)), IERC20(address(f8)), admin);
        SocietyEntry e = new SocietyEntry(IERC20(address(w6)), v, 10e6, 500e6, treasury, admin);
        // 1 WIF = 2.5 FES -> rate = 2.5e8 * 1e18 / 1e6 = 2.5e20
        FixedRateConverter d = new FixedRateConverter(IERC20(address(w6)), IERC20(address(f8)), 25e19, sink, admin);
        vm.startPrank(admin);
        v.grantRole(v.ENTRY_ROLE(), address(e));
        v.grantRole(v.SETTLER_ROLE(), settler);
        v.setConverter(address(d), true);
        d.setAuthorizedCaller(address(v), true);
        vm.stopPrank();
        f8.mint(address(d), 1_000e8);

        address player = makeAddr("player");
        w6.mint(player, 30e6);
        vm.startPrank(player);
        w6.approve(address(e), 30e6);
        e.enter("1", type(uint256).max);
        e.enter("2", type(uint256).max);
        e.enter("3", type(uint256).max);
        vm.stopPrank();

        uint256 week = v.currentWeekId();
        assertEq(v.getWeek(week).wifAllocated, 15e6);
        assertEq(w6.balanceOf(treasury), 15e6);

        vm.prank(settler);
        uint256 out = v.convertWeek(week, 15e6, address(d), 375e7, block.timestamp);
        assertEq(out, 375e7); // 15 WIF * 2.5 = 37.5 FES (8 decimals)
    }
}
