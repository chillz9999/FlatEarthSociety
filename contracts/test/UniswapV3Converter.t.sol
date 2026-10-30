// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {UniswapV3Converter, ISwapRouter02ExactInputSingle} from "../src/converters/UniswapV3Converter.sol";
import {SocietyPrizeVault} from "../src/SocietyPrizeVault.sol";
import {ISocietyPrizeVault} from "../src/interfaces/ISocietyPrizeVault.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {MockSocietyToken} from "../src/mocks/MockSocietyToken.sol";
import {BadSwapRouter} from "./mocks/BadSwapRouter.sol";
import {SocietyFixture} from "./utils/SocietyFixture.sol";

contract UniswapV3ConverterTest is SocietyFixture {
    event Swapped(uint256 wifIn, uint256 fesOut);
    event CallerAuthorizationUpdated(address indexed caller, bool authorized);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    uint24 internal constant POOL_FEE = 3000;

    MockSwapRouter internal router;
    UniswapV3Converter internal uni;
    bytes32 internal ADMIN_ROLE;

    function setUp() public override {
        super.setUp();
        router = new MockSwapRouter(15e17, POOL_FEE); // 1 WIF = 1.5 FES
        fes.mint(address(router), 1_000_000e18);
        uni = new UniswapV3Converter(
            IERC20(address(wif)), IERC20(address(fes)), ISwapRouter02ExactInputSingle(address(router)), POOL_FEE, admin
        );
        ADMIN_ROLE = uni.DEFAULT_ADMIN_ROLE();
        vm.startPrank(admin);
        uni.setAuthorizedCaller(address(vault), true);
        vault.setConverter(address(uni), true);
        vm.stopPrank();
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role);
    }

    function test_Constructor() public {
        assertEq(address(uni.wif()), address(wif));
        assertEq(address(uni.fes()), address(fes));
        assertEq(address(uni.router()), address(router));
        assertEq(uni.poolFee(), POOL_FEE);
        assertTrue(uni.hasRole(ADMIN_ROLE, admin));

        ISwapRouter02ExactInputSingle r = ISwapRouter02ExactInputSingle(address(router));
        IERC20 w = IERC20(address(wif));
        IERC20 f = IERC20(address(fes));
        vm.expectRevert(UniswapV3Converter.ZeroAddress.selector);
        new UniswapV3Converter(IERC20(address(0)), f, r, POOL_FEE, admin);
        vm.expectRevert(UniswapV3Converter.ZeroAddress.selector);
        new UniswapV3Converter(w, IERC20(address(0)), r, POOL_FEE, admin);
        vm.expectRevert(UniswapV3Converter.ZeroAddress.selector);
        new UniswapV3Converter(w, f, ISwapRouter02ExactInputSingle(address(0)), POOL_FEE, admin);
        vm.expectRevert(UniswapV3Converter.ZeroAddress.selector);
        new UniswapV3Converter(w, f, r, POOL_FEE, address(0));
        vm.expectRevert(UniswapV3Converter.IdenticalTokens.selector);
        new UniswapV3Converter(w, w, r, POOL_FEE, admin);
    }

    function test_ConvertThroughVault() public {
        _enterMany(alice, 4, 1); // 20 WIF allocated
        vm.expectEmit(address(uni));
        emit Swapped(20e18, 30e18);
        vm.prank(settler);
        uint256 out = vault.convertWeek(WEEK0, 20e18, address(uni), 29e18, block.timestamp);
        assertEq(out, 30e18);
        assertEq(vault.getWeek(WEEK0).fesPool, 30e18);
        assertEq(wif.balanceOf(address(router)), 20e18);
        assertEq(wif.balanceOf(address(uni)), 0);
        assertEq(fes.balanceOf(address(uni)), 0);
        assertEq(wif.allowance(address(uni), address(router)), 0);
        assertEq(wif.allowance(address(vault), address(uni)), 0);

        (
            address tokenIn,
            address tokenOut,
            uint24 fee,
            address recipient,
            uint256 amountIn,
            uint256 amountOutMinimum,
            uint160 sqrtPriceLimitX96
        ) = router.lastParams();
        assertEq(tokenIn, address(wif));
        assertEq(tokenOut, address(fes));
        assertEq(fee, POOL_FEE);
        assertEq(recipient, address(vault));
        assertEq(amountIn, 20e18);
        assertEq(amountOutMinimum, 29e18);
        assertEq(sqrtPriceLimitX96, 0);
    }

    function test_SlippageRevertsInRouter() public {
        _enterMany(alice, 2, 1);
        vm.prank(settler);
        vm.expectRevert(MockSwapRouter.TooLittleReceived.selector);
        vault.convertWeek(WEEK0, 10e18, address(uni), 15e18 + 1, block.timestamp);
        // Price moved against us before execution.
        router.setRate(1e18);
        vm.prank(settler);
        vm.expectRevert(MockSwapRouter.TooLittleReceived.selector);
        vault.convertWeek(WEEK0, 10e18, address(uni), 14e18, block.timestamp);
    }

    function test_DeadlineEnforcedByVault() public {
        _enterMany(alice, 2, 1);
        uint256 deadline = block.timestamp;
        vm.warp(block.timestamp + 1);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(SocietyPrizeVault.DeadlineExpired.selector, deadline));
        vault.convertWeek(WEEK0, 10e18, address(uni), 1, deadline);
    }

    function test_RouterUnderDeliveringReverts() public {
        BadSwapRouter bad = new BadSwapRouter();
        fes.mint(address(bad), 1_000e18);
        UniswapV3Converter c = new UniswapV3Converter(
            IERC20(address(wif)), IERC20(address(fes)), ISwapRouter02ExactInputSingle(address(bad)), POOL_FEE, admin
        );
        address fakeVault = makeAddr("fakeVault");
        vm.prank(admin);
        c.setAuthorizedCaller(fakeVault, true);
        wif.mint(fakeVault, 100e18);
        vm.prank(fakeVault);
        wif.approve(address(c), type(uint256).max);

        bad.setMode(BadSwapRouter.Mode.UnderDeliver);
        vm.prank(fakeVault);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Converter.InsufficientOutput.selector, 5e18, 10e18));
        c.convert(10e18, 10e18, fakeVault);

        bad.setMode(BadSwapRouter.Mode.PullLess);
        vm.prank(fakeVault);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Converter.UnexpectedWifSpent.selector, 10e18, 10e18 - 1));
        c.convert(10e18, 1, fakeVault);
    }

    function test_Convert_Reverts() public {
        address fakeVault = makeAddr("fakeVault");
        vm.prank(fakeVault);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Converter.UnauthorizedCaller.selector, fakeVault));
        uni.convert(1e18, 1, fakeVault);

        vm.startPrank(address(vault));
        vm.expectRevert(UniswapV3Converter.ZeroAmount.selector);
        uni.convert(0, 1, address(vault));
        vm.expectRevert(UniswapV3Converter.ZeroMinOutput.selector);
        uni.convert(1e18, 0, address(vault));
        vm.expectRevert(UniswapV3Converter.ZeroAddress.selector);
        uni.convert(1e18, 1, address(0));
        vm.stopPrank();
    }

    function test_WrongPoolFeeReverts() public {
        UniswapV3Converter c = new UniswapV3Converter(
            IERC20(address(wif)), IERC20(address(fes)), ISwapRouter02ExactInputSingle(address(router)), 500, admin
        );
        vm.prank(admin);
        c.setAuthorizedCaller(address(this), true);
        wif.mint(address(this), 1e18);
        wif.approve(address(c), 1e18);
        vm.expectRevert(MockSwapRouter.UnknownPool.selector);
        c.convert(1e18, 1, address(this));
    }

    function test_SetAuthorizedCaller() public {
        vm.expectEmit(address(uni));
        emit CallerAuthorizationUpdated(stranger, true);
        vm.prank(admin);
        uni.setAuthorizedCaller(stranger, true);
        assertTrue(uni.authorizedCaller(stranger));

        vm.prank(admin);
        vm.expectRevert(UniswapV3Converter.ZeroAddress.selector);
        uni.setAuthorizedCaller(address(0), true);

        vm.expectRevert(_unauthorized(stranger, ADMIN_ROLE));
        vm.prank(stranger);
        uni.setAuthorizedCaller(stranger, true);
    }

    function test_RescueToken() public {
        wif.mint(address(uni), 3e18);
        vm.expectEmit(address(uni));
        emit TokenRescued(address(wif), admin, 3e18);
        vm.prank(admin);
        uni.rescueToken(address(wif), admin, 3e18);
        assertEq(wif.balanceOf(admin), 3e18);

        vm.prank(admin);
        vm.expectRevert(UniswapV3Converter.ZeroAddress.selector);
        uni.rescueToken(address(wif), address(0), 1);

        vm.expectRevert(_unauthorized(stranger, ADMIN_ROLE));
        vm.prank(stranger);
        uni.rescueToken(address(wif), stranger, 1);
    }

    function testFuzz_ConvertMatchesRouterRate(uint256 wifIn, uint256 rate_) public {
        wifIn = bound(wifIn, 1e9, 1e27);
        rate_ = bound(rate_, 1e9, 1e24);
        router.setRate(rate_);
        uint256 expected = wifIn * rate_ / 1e18; // >= 1
        fes.mint(address(router), expected);
        vm.prank(admin);
        uni.setAuthorizedCaller(address(this), true);
        wif.mint(address(this), wifIn);
        wif.approve(address(uni), wifIn);
        uint256 out = uni.convert(wifIn, expected, recipientOf());
        assertEq(out, expected);
        assertEq(fes.balanceOf(recipientOf()), expected);
    }

    function recipientOf() internal pure returns (address) {
        return address(0xBEEF);
    }

    function test_MockTokenPermitAndDecimals() public {
        MockSocietyToken t = new MockSocietyToken("Six", "SIX", 6);
        assertEq(t.decimals(), 6);
        t.mint(alice, 1e6);
        assertEq(t.balanceOf(alice), 1e6);
        assertEq(t.name(), "Six");
        assertTrue(t.DOMAIN_SEPARATOR() != bytes32(0));
    }

    function test_GetWeekAfterDexConversion() public {
        _enterMany(bob, 2, 7);
        vm.prank(settler);
        vault.convertWeek(WEEK0, 10e18, address(uni), 15e18, block.timestamp);
        ISocietyPrizeVault.WeekView memory w = vault.getWeek(WEEK0);
        assertEq(w.wifConverted, 10e18);
        assertEq(w.fesPool, 15e18);
    }
}
