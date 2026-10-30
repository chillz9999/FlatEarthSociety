// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {SocietyEntry} from "../src/SocietyEntry.sol";
import {SocietyPrizeVault} from "../src/SocietyPrizeVault.sol";
import {ISocietyPrizeVault} from "../src/interfaces/ISocietyPrizeVault.sol";
import {SocietyWeeks} from "../src/libraries/SocietyWeeks.sol";
import {MockSocietyToken} from "../src/mocks/MockSocietyToken.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {SocietyFixture} from "./utils/SocietyFixture.sol";

contract SocietyEntryTest is SocietyFixture {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event EntryPurchased(
        bytes32 indexed entryId,
        address indexed player,
        uint256 indexed weekId,
        bytes32 attemptRef,
        uint256 fee,
        uint256 rewardShare,
        uint256 protocolShare
    );
    event EntryFeeUpdated(uint256 previousFee, uint256 newFee);
    event ProtocolTreasuryUpdated(address previousTreasury, address newTreasury);
    event AllocationRecorded(uint256 indexed weekId, bytes32 indexed entryId, uint256 wifAmount);

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    function test_Constructor_SetsState() public view {
        assertEq(address(entry.wif()), address(wif));
        assertEq(address(entry.vault()), address(vault));
        assertEq(entry.entryFee(), ENTRY_FEE);
        assertEq(entry.protocolTreasury(), treasury);
        assertTrue(entry.hasRole(entry.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(entry.hasRole(entry.PAUSER_ROLE(), admin));
        assertEq(entry.PAUSER_ROLE(), keccak256("PAUSER_ROLE"));
        assertFalse(entry.paused());
    }

    function test_Constructor_EmitsConfigEvents() public {
        vm.expectEmit(false, false, false, true);
        emit EntryFeeUpdated(0, 4e18);
        vm.expectEmit(false, false, false, true);
        emit ProtocolTreasuryUpdated(address(0), treasury);
        new SocietyEntry(IERC20(address(wif)), vault, 4e18, EXTRA_LIFE_FEE, treasury, admin);
    }

    function test_Constructor_RevertsOnZeroAddresses() public {
        vm.expectRevert(SocietyEntry.ZeroAddress.selector);
        new SocietyEntry(IERC20(address(0)), vault, ENTRY_FEE, EXTRA_LIFE_FEE, treasury, admin);
        vm.expectRevert(SocietyEntry.ZeroAddress.selector);
        new SocietyEntry(
            IERC20(address(wif)), ISocietyPrizeVault(address(0)), ENTRY_FEE, EXTRA_LIFE_FEE, treasury, admin
        );
        vm.expectRevert(SocietyEntry.ZeroAddress.selector);
        new SocietyEntry(IERC20(address(wif)), vault, ENTRY_FEE, EXTRA_LIFE_FEE, treasury, address(0));
        vm.expectRevert(SocietyEntry.ZeroAddress.selector);
        new SocietyEntry(IERC20(address(wif)), vault, ENTRY_FEE, EXTRA_LIFE_FEE, address(0), admin);
    }

    function test_Constructor_RevertsOnInvalidFee() public {
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 0));
        new SocietyEntry(IERC20(address(wif)), vault, 0, EXTRA_LIFE_FEE, treasury, admin);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 3));
        new SocietyEntry(IERC20(address(wif)), vault, 3, EXTRA_LIFE_FEE, treasury, admin);
    }

    function test_Constructor_RevertsOnVaultTokenMismatch() public {
        MockSocietyToken other = new MockSocietyToken("Other", "OTH", 18);
        vm.expectRevert(SocietyEntry.VaultTokenMismatch.selector);
        new SocietyEntry(IERC20(address(other)), vault, ENTRY_FEE, EXTRA_LIFE_FEE, treasury, admin);
    }

    function test_Constructor_RevertsWhenTreasuryIsVault() public {
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidTreasury.selector, address(vault)));
        new SocietyEntry(IERC20(address(wif)), vault, ENTRY_FEE, EXTRA_LIFE_FEE, address(vault), admin);
    }

    // ---------------------------------------------------------------------------------------------
    // enter
    // ---------------------------------------------------------------------------------------------

    function test_Enter_SplitsFeeAndRecordsEntry() public {
        bytes32 ref = keccak256("attempt-1");
        _fund(alice, ENTRY_FEE);
        bytes32 expectedId = keccak256(abi.encode(alice, ref));
        uint256 week = _currentWeek();

        vm.expectEmit(address(vault));
        emit AllocationRecorded(week, expectedId, ENTRY_FEE / 2);
        vm.expectEmit(address(entry));
        emit EntryPurchased(expectedId, alice, week, ref, ENTRY_FEE, ENTRY_FEE / 2, ENTRY_FEE / 2);

        vm.prank(alice);
        bytes32 entryId = entry.enter(ref, type(uint256).max);

        assertEq(entryId, expectedId);
        assertEq(entryId, entry.computeEntryId(alice, ref));
        assertTrue(entry.isEntryUsed(entryId));
        (address player, uint64 weekId, uint128 fee) = entry.entries(entryId);
        assertEq(player, alice);
        assertEq(weekId, week);
        assertEq(fee, ENTRY_FEE);

        assertEq(wif.balanceOf(alice), 0);
        assertEq(wif.balanceOf(treasury), ENTRY_FEE / 2);
        assertEq(wif.balanceOf(address(vault)), ENTRY_FEE / 2);
        assertEq(wif.balanceOf(address(entry)), 0);

        ISocietyPrizeVault.WeekView memory w = vault.getWeek(week);
        assertEq(w.wifAllocated, ENTRY_FEE / 2);
        assertEq(vault.totalWifUnconverted(), ENTRY_FEE / 2);
    }

    function test_Enter_RevertsOnDuplicateEntryId() public {
        bytes32 ref = keccak256("dup");
        bytes32 id = _enter(alice, ref);
        _fund(alice, ENTRY_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.EntryAlreadyUsed.selector, id));
        entry.enter(ref, type(uint256).max);
        // Still reverts in a later week: entry ids are globally unique.
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.EntryAlreadyUsed.selector, id));
        entry.enter(ref, type(uint256).max);
    }

    function test_Enter_SameAttemptRefDifferentSendersYieldsDifferentIds() public {
        bytes32 ref = keccak256("shared-ref");
        bytes32 idAlice = _enter(alice, ref);
        bytes32 idBob = _enter(bob, ref);
        assertTrue(idAlice != idBob);
        (address pa,,) = entry.entries(idAlice);
        (address pb,,) = entry.entries(idBob);
        assertEq(pa, alice);
        assertEq(pb, bob);
        assertEq(wif.balanceOf(treasury), ENTRY_FEE);
    }

    function test_Enter_FrontRunningAttemptRefDoesNotBlockOwner() public {
        bytes32 ref = keccak256("alice-secret-ref");
        // Bob copies Alice's attemptRef from the mempool and submits first.
        bytes32 bobId = _enter(bob, ref);
        // Alice's own entry still succeeds and has a distinct id.
        bytes32 aliceId = _enter(alice, ref);
        assertTrue(aliceId != bobId);
        assertEq(aliceId, entry.computeEntryId(alice, ref));
    }

    function test_Enter_RevertsWithoutAllowance() public {
        wif.mint(alice, ENTRY_FEE);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(entry), 0, ENTRY_FEE)
        );
        entry.enter(keccak256("x"), type(uint256).max);
    }

    function test_Enter_RevertsWithoutBalance() public {
        vm.prank(alice);
        wif.approve(address(entry), ENTRY_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, ENTRY_FEE));
        entry.enter(keccak256("x"), type(uint256).max);
    }

    function test_Enter_CreditsWeekOfPayment_AtBoundaries() public {
        uint256 end = SocietyWeeks.weekEnd(WEEK0);
        vm.warp(end - 1); // Sunday 23:59:59 UTC
        bytes32 a = _enter(alice, "a");
        vm.warp(end); // Monday 00:00:00 UTC
        bytes32 b = _enter(alice, "b");
        (, uint64 wa,) = entry.entries(a);
        (, uint64 wb,) = entry.entries(b);
        assertEq(wa, WEEK0);
        assertEq(wb, WEEK0 + 1);
        assertEq(vault.getWeek(WEEK0).wifAllocated, ENTRY_FEE / 2);
        assertEq(vault.getWeek(WEEK0 + 1).wifAllocated, ENTRY_FEE / 2);
    }

    function test_Enter_UsesUpdatedFee() public {
        vm.prank(admin);
        entry.setEntryFee(4e18);
        _enter(alice, "a");
        assertEq(wif.balanceOf(treasury), 2e18);
        assertEq(wif.balanceOf(address(vault)), 2e18);
    }

    function testFuzz_Enter_SplitIsExactlyHalf(uint256 fee, bytes32 ref) public {
        fee = bound(fee, 1, type(uint128).max / 2) * 2; // any even fee in [2, 2^128 - 2]
        vm.prank(admin);
        entry.setEntryFee(fee);
        _fund(alice, fee);

        vm.expectEmit(address(entry));
        emit EntryPurchased(entry.computeEntryId(alice, ref), alice, _currentWeek(), ref, fee, fee / 2, fee / 2);
        vm.prank(alice);
        entry.enter(ref, type(uint256).max);

        assertEq(wif.balanceOf(treasury), fee / 2);
        assertEq(wif.balanceOf(address(vault)), fee / 2);
        assertEq(wif.balanceOf(treasury) + wif.balanceOf(address(vault)), fee);
        assertEq(wif.balanceOf(treasury), wif.balanceOf(address(vault)));
        assertEq(vault.getWeek(_currentWeek()).wifAllocated, fee / 2);
    }

    function testFuzz_Enter_CreditsCurrentWeek(uint256 ts) public {
        ts = bound(ts, WEEK0_START, WEEK0_START + 520 weeks);
        vm.warp(ts);
        bytes32 id = _enter(alice, bytes32(ts));
        (, uint64 weekId,) = entry.entries(id);
        assertEq(weekId, (ts - 345_600) / 604_800);
        assertEq(weekId, entry.currentWeekId());
        assertEq(vault.getWeek(weekId).wifAllocated, ENTRY_FEE / 2);
    }

    // ---------------------------------------------------------------------------------------------
    // enterWithPermit
    // ---------------------------------------------------------------------------------------------

    function _permitSig(uint256 pk, address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(entry), value, wif.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wif.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function test_EnterWithPermit_Works() public {
        (address player, uint256 pk) = makeAddrAndKey("permitPlayer");
        wif.mint(player, ENTRY_FEE);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, player, ENTRY_FEE, deadline);

        vm.prank(player);
        bytes32 id = entry.enterWithPermit("ref", ENTRY_FEE, deadline, v, r, s);

        assertEq(id, entry.computeEntryId(player, "ref"));
        assertEq(wif.balanceOf(player), 0);
        assertEq(wif.balanceOf(treasury), ENTRY_FEE / 2);
        assertEq(wif.allowance(player, address(entry)), 0);
    }

    function test_EnterWithPermit_SucceedsWhenPermitWasFrontRun() public {
        (address player, uint256 pk) = makeAddrAndKey("permitPlayer");
        wif.mint(player, ENTRY_FEE);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, player, ENTRY_FEE, deadline);

        // Griefer submits the permit first; the nonce is consumed and the permit call inside
        // enterWithPermit will fail, but the allowance is already in place.
        vm.prank(stranger);
        wif.permit(player, address(entry), ENTRY_FEE, deadline, v, r, s);

        vm.prank(player);
        entry.enterWithPermit("ref", ENTRY_FEE, deadline, v, r, s);
        assertEq(wif.balanceOf(treasury), ENTRY_FEE / 2);
    }

    function test_EnterWithPermit_RevertsWithInvalidPermitAndNoAllowance() public {
        (address player,) = makeAddrAndKey("permitPlayer");
        wif.mint(player, ENTRY_FEE);
        (, uint256 wrongPk) = makeAddrAndKey("someoneElse");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(wrongPk, player, ENTRY_FEE, deadline);

        vm.prank(player);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(entry), 0, ENTRY_FEE)
        );
        entry.enterWithPermit("ref", ENTRY_FEE, deadline, v, r, s);
    }

    function test_EnterWithPermit_ExpiredPermitButExistingAllowanceWorks() public {
        (address player, uint256 pk) = makeAddrAndKey("permitPlayer");
        _fund(player, ENTRY_FEE);
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, player, ENTRY_FEE, deadline);
        vm.prank(player);
        entry.enterWithPermit("ref", ENTRY_FEE, deadline, v, r, s);
        assertEq(wif.balanceOf(treasury), ENTRY_FEE / 2);
    }

    function test_EnterWithPermit_RevertsOnDuplicate() public {
        (address player, uint256 pk) = makeAddrAndKey("permitPlayer");
        _enter(player, "ref");
        wif.mint(player, ENTRY_FEE);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, player, ENTRY_FEE, deadline);
        bytes32 id = entry.computeEntryId(player, "ref");
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.EntryAlreadyUsed.selector, id));
        entry.enterWithPermit("ref", ENTRY_FEE, deadline, v, r, s);
    }

    // ---------------------------------------------------------------------------------------------
    // Pause
    // ---------------------------------------------------------------------------------------------

    function test_Pause_BlocksEntries() public {
        vm.prank(admin);
        entry.pause();
        assertTrue(entry.paused());

        _fund(alice, ENTRY_FEE);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        entry.enter("a", type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        entry.enterWithPermit("a", ENTRY_FEE, block.timestamp, 0, bytes32(0), bytes32(0));

        vm.prank(admin);
        entry.unpause();
        vm.prank(alice);
        entry.enter("a", type(uint256).max);
        assertEq(wif.balanceOf(treasury), ENTRY_FEE / 2);
    }

    function test_Pause_OnlyPauser() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, entry.PAUSER_ROLE()
            )
        );
        vm.prank(stranger);
        entry.pause();

        vm.prank(admin);
        entry.pause();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, entry.PAUSER_ROLE()
            )
        );
        vm.prank(stranger);
        entry.unpause();
    }

    function test_Pause_DedicatedPauserRole() public {
        address pauser = makeAddr("pauser");
        bytes32 role = entry.PAUSER_ROLE();
        vm.prank(admin);
        entry.grantRole(role, pauser);
        vm.prank(pauser);
        entry.pause();
        vm.prank(pauser);
        entry.unpause();
        // Pauser cannot change the fee.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, entry.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(pauser);
        entry.setEntryFee(2);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin setters
    // ---------------------------------------------------------------------------------------------

    function test_SetEntryFee() public {
        vm.expectEmit(address(entry));
        emit EntryFeeUpdated(ENTRY_FEE, 20e18);
        vm.prank(admin);
        entry.setEntryFee(20e18);
        assertEq(entry.entryFee(), 20e18);
    }

    function test_SetEntryFee_RevertsOnInvalid() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 0));
        entry.setEntryFee(0);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 1));
        entry.setEntryFee(1);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 10e18 + 1));
        entry.setEntryFee(10e18 + 1);
        uint256 tooBig = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, tooBig));
        entry.setEntryFee(tooBig);
        vm.stopPrank();
    }

    function testFuzz_SetEntryFee_OddAlwaysRejected(uint256 fee) public {
        fee = bound(fee, 0, type(uint128).max / 2) * 2 + 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, fee));
        entry.setEntryFee(fee);
    }

    function test_SetEntryFee_OnlyAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, entry.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        entry.setEntryFee(2e18);
    }

    function test_SetProtocolTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(address(entry));
        emit ProtocolTreasuryUpdated(treasury, newTreasury);
        vm.prank(admin);
        entry.setProtocolTreasury(newTreasury);
        assertEq(entry.protocolTreasury(), newTreasury);

        _enter(alice, "a");
        assertEq(wif.balanceOf(newTreasury), ENTRY_FEE / 2);
        assertEq(wif.balanceOf(treasury), 0);
    }

    function test_SetProtocolTreasury_RevertsOnInvalid() public {
        vm.startPrank(admin);
        vm.expectRevert(SocietyEntry.ZeroAddress.selector);
        entry.setProtocolTreasury(address(0));
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidTreasury.selector, address(vault)));
        entry.setProtocolTreasury(address(vault));
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidTreasury.selector, address(entry)));
        entry.setProtocolTreasury(address(entry));
        vm.stopPrank();
    }

    function test_BurnedShare_IsPermanent() public {
        address burn = entry.BURN_ADDRESS();
        assertFalse(entry.burnsProtocolShare());
        vm.prank(admin);
        entry.setProtocolTreasury(burn);
        assertTrue(entry.burnsProtocolShare());

        // Half of every payment is sent to the dead address, out of anyone's reach.
        _enter(alice, "a");
        assertEq(wif.balanceOf(burn), ENTRY_FEE / 2);
        assertEq(wif.balanceOf(address(vault)), ENTRY_FEE / 2);

        // Once burning, not even the admin can send the share anywhere else.
        vm.prank(admin);
        vm.expectRevert(SocietyEntry.BurnIsPermanent.selector);
        entry.setProtocolTreasury(treasury);
        assertEq(entry.protocolTreasury(), burn);
    }

    function test_BurnedShare_FromDeployment() public {
        SocietyEntry burning =
            new SocietyEntry(IERC20(address(wif)), vault, ENTRY_FEE, EXTRA_LIFE_FEE, entry.BURN_ADDRESS(), admin);
        assertTrue(burning.burnsProtocolShare());
        vm.prank(admin);
        vm.expectRevert(SocietyEntry.BurnIsPermanent.selector);
        burning.setProtocolTreasury(treasury);
    }

    function test_SetProtocolTreasury_OnlyAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, entry.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        entry.setProtocolTreasury(stranger);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function test_Views() public {
        assertEq(entry.currentWeekId(), WEEK0);
        vm.warp(WEEK0_START + 7 days);
        assertEq(entry.currentWeekId(), WEEK0 + 1);
        assertFalse(entry.isEntryUsed(keccak256("nope")));
        (address p, uint64 w, uint128 f) = entry.entries(keccak256("nope"));
        assertEq(p, address(0));
        assertEq(w, 0);
        assertEq(f, 0);
    }

    function testFuzz_ComputeEntryId(address player, bytes32 ref) public view {
        assertEq(entry.computeEntryId(player, ref), keccak256(abi.encode(player, ref)));
    }

    function testFuzz_ComputeEntryId_DiffersPerSender(address a, address b, bytes32 ref) public view {
        vm.assume(a != b);
        assertTrue(entry.computeEntryId(a, ref) != entry.computeEntryId(b, ref));
    }

    // ---------------------------------------------------------------------------------------------
    // Hostile tokens
    // ---------------------------------------------------------------------------------------------

    function test_Enter_RejectsFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        SocietyPrizeVault fotVault = new SocietyPrizeVault(IERC20(address(fot)), IERC20(address(fes)), admin);
        SocietyEntry fotEntry =
            new SocietyEntry(IERC20(address(fot)), fotVault, ENTRY_FEE, EXTRA_LIFE_FEE, treasury, admin);
        bytes32 entryRole = fotVault.ENTRY_ROLE();
        vm.prank(admin);
        fotVault.grantRole(entryRole, address(fotEntry));

        fot.mint(alice, ENTRY_FEE);
        vm.prank(alice);
        fot.approve(address(fotEntry), ENTRY_FEE);

        uint256 received = ENTRY_FEE - ENTRY_FEE * fot.FEE_BPS() / 10_000;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.UnexpectedAmountReceived.selector, ENTRY_FEE, received));
        fotEntry.enter("a", type(uint256).max);
    }

    function _reentrantSetup() internal returns (ReentrantToken token, SocietyEntry rEntry) {
        token = new ReentrantToken();
        SocietyPrizeVault rVault = new SocietyPrizeVault(IERC20(address(token)), IERC20(address(fes)), admin);
        rEntry = new SocietyEntry(IERC20(address(token)), rVault, ENTRY_FEE, EXTRA_LIFE_FEE, treasury, admin);
        bytes32 entryRole = rVault.ENTRY_ROLE();
        vm.prank(admin);
        rVault.grantRole(entryRole, address(rEntry));
        token.mint(alice, 10 * ENTRY_FEE);
        vm.prank(alice);
        token.approve(address(rEntry), type(uint256).max);
    }

    function test_Enter_ReentrancyViaMaliciousTokenFails() public {
        (ReentrantToken token, SocietyEntry rEntry) = _reentrantSetup();
        token.arm(address(rEntry), abi.encodeCall(SocietyEntry.enter, (bytes32("second"), type(uint256).max)));

        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        rEntry.enter("first", type(uint256).max);

        assertFalse(rEntry.isEntryUsed(rEntry.computeEntryId(alice, "first")));
        assertFalse(rEntry.isEntryUsed(rEntry.computeEntryId(address(token), "second")));
        assertEq(token.balanceOf(alice), 10 * ENTRY_FEE);
    }

    function test_EnterWithPermit_ReentrancyViaMaliciousTokenFails() public {
        (ReentrantToken token, SocietyEntry rEntry) = _reentrantSetup();
        token.arm(
            address(rEntry),
            abi.encodeCall(SocietyEntry.enterWithPermit, (bytes32("second"), ENTRY_FEE, 0, 0, bytes32(0), bytes32(0)))
        );
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        rEntry.enterWithPermit("first", ENTRY_FEE, 0, 0, bytes32(0), bytes32(0));
    }

    function test_Enter_RevertsIfEntryLacksEntryRole() public {
        bytes32 entryRole = vault.ENTRY_ROLE();
        vm.prank(admin);
        vault.revokeRole(entryRole, address(entry));
        _fund(alice, ENTRY_FEE);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(entry), entryRole)
        );
        entry.enter("a", type(uint256).max);
    }
}
