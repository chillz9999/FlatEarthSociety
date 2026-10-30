// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {DemoSeed} from "../script/DemoSeed.s.sol";
import {SocietyEntry} from "../src/SocietyEntry.sol";
import {SocietyPrizeVault} from "../src/SocietyPrizeVault.sol";
import {FixedRateConverter} from "../src/converters/FixedRateConverter.sol";
import {MockSocietyToken} from "../src/mocks/MockSocietyToken.sol";

contract DeployScriptTest is Test {
    /// @dev Anvil's first well-known dev key (never use for anything real).
    uint256 internal constant ANVIL_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    Deploy internal script;

    address internal admin = makeAddr("admin");
    address internal settler = makeAddr("settler");
    address internal treasury = makeAddr("treasury");
    address internal sink = makeAddr("sink");
    address internal pricer = makeAddr("pricer");

    function setUp() public {
        vm.warp(1_792_972_800 + 1 hours);
        vm.roll(1234);
        script = new Deploy();
    }

    function _mockConfig() internal view returns (Deploy.Config memory cfg) {
        cfg.deployMocks = true;
        cfg.mockFes = true;
        cfg.admin = admin;
        cfg.settler = settler;
        cfg.pricer = pricer;
        cfg.protocolTreasury = treasury;
        cfg.wifSink = sink;
        cfg.entryFee = 10e18;
        cfg.extraLifeFee = 500e18;
        cfg.feeBounds = [uint256(1e18), 100e18, 50e18, 5_000e18];
        cfg.fixedRate = 1e18;
        cfg.fesInventory = 1_000e18;
    }

    function _assertWiring(Deploy.Deployment memory d, address expectedAdmin, address deployer) internal view {
        SocietyPrizeVault vault = SocietyPrizeVault(d.vault);
        SocietyEntry entry = SocietyEntry(d.entry);

        assertEq(address(vault.wif()), d.wif);
        assertEq(address(vault.fes()), d.fes);
        assertEq(vault.inKind(), d.prizeInWif);
        assertEq(address(entry.wif()), d.wif);
        assertEq(address(entry.vault()), d.vault);

        assertTrue(vault.hasRole(vault.ENTRY_ROLE(), d.entry));
        assertTrue(vault.hasRole(vault.SETTLER_ROLE(), d.settler));
        assertTrue(entry.hasRole(entry.PRICER_ROLE(), d.pricer));

        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), expectedAdmin));
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), expectedAdmin));
        assertTrue(entry.hasRole(entry.DEFAULT_ADMIN_ROLE(), expectedAdmin));
        assertTrue(entry.hasRole(entry.PAUSER_ROLE(), expectedAdmin));

        if (expectedAdmin != deployer) {
            assertFalse(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), deployer));
            assertFalse(vault.hasRole(vault.PAUSER_ROLE(), deployer));
            assertFalse(entry.hasRole(entry.DEFAULT_ADMIN_ROLE(), deployer));
            assertFalse(entry.hasRole(entry.PAUSER_ROLE(), deployer));
        }

        assertEq(entry.entryFee(), d.entryFee);
        assertEq(entry.extraLifeFee(), d.extraLifeFee);
        assertEq(entry.protocolTreasury(), d.protocolTreasury);

        if (d.prizeInWif) {
            assertEq(d.fixedRateConverter, address(0));
            return;
        }
        FixedRateConverter desk = FixedRateConverter(d.fixedRateConverter);
        assertEq(address(desk.wif()), d.wif);
        assertEq(address(desk.fes()), d.fes);
        assertTrue(vault.isApprovedConverter(d.fixedRateConverter));
        assertTrue(desk.authorizedCaller(d.vault));
        assertTrue(desk.hasRole(desk.DEFAULT_ADMIN_ROLE(), expectedAdmin));
        assertTrue(desk.hasRole(desk.RATE_MANAGER_ROLE(), expectedAdmin));
        if (expectedAdmin != deployer) {
            assertFalse(desk.hasRole(desk.DEFAULT_ADMIN_ROLE(), deployer));
            assertFalse(desk.hasRole(desk.RATE_MANAGER_ROLE(), deployer));
        }
        assertEq(desk.rate(), d.fixedRate);
        assertEq(desk.wifSink(), d.wifSink);
    }

    function test_Deploy_WithMocks() public {
        Deploy.Deployment memory d = script.deploy(_mockConfig());

        assertEq(d.chainId, block.chainid);
        assertEq(d.deployBlock, 1234);
        assertTrue(d.mockTokens);
        assertEq(MockSocietyToken(d.wif).symbol(), "mWIF");
        assertEq(MockSocietyToken(d.fes).symbol(), "mFES");
        assertEq(MockSocietyToken(d.wif).name(), "Mock WIF");
        assertEq(MockSocietyToken(d.fes).name(), "Mock FES");
        assertEq(MockSocietyToken(d.wif).decimals(), 18);
        assertEq(MockSocietyToken(d.fes).balanceOf(d.fixedRateConverter), 1_000e18);
        _assertWiring(d, admin, d.deployer);

        // Smoke test the deployed system end to end.
        address player = makeAddr("player");
        MockSocietyToken(d.wif).mint(player, 10e18);
        vm.startPrank(player);
        MockSocietyToken(d.wif).approve(d.entry, 10e18);
        SocietyEntry(d.entry).enter("smoke", type(uint256).max);
        vm.stopPrank();
        assertEq(MockSocietyToken(d.wif).balanceOf(treasury), 5e18);

        SocietyPrizeVault vault = SocietyPrizeVault(d.vault);
        uint256 week = vault.currentWeekId();
        vm.prank(settler);
        vault.convertWeek(week, 5e18, d.fixedRateConverter, 5e18, block.timestamp);
        assertEq(MockSocietyToken(d.wif).balanceOf(sink), 5e18);
        vm.warp(vault.weekEnd(week));
        vm.prank(settler);
        vault.finalizeWeek(week, [player, address(0), address(0)], keccak256("smoke"));
        vault.claimFor(week, 0);
        assertEq(MockSocietyToken(d.fes).balanceOf(player), 2.5e18);
        assertEq(vault.getWeek(week + 1).fesPool, 2.5e18);
    }

    function test_Deploy_AdminIsDeployerKeepsRoles() public {
        Deploy.Config memory cfg = _mockConfig();
        cfg.admin = tx.origin; // forge's default sender broadcasts in tests
        Deploy.Deployment memory d = script.deploy(cfg);
        assertEq(d.deployer, tx.origin);
        _assertWiring(d, tx.origin, tx.origin);
    }

    function test_Deploy_WithExistingTokens() public {
        MockSocietyToken w = new MockSocietyToken("Real-ish WIF", "WIF", 6);
        MockSocietyToken f = new MockSocietyToken("Real-ish FES", "FES", 8);
        Deploy.Config memory cfg = _mockConfig();
        cfg.deployMocks = false;
        cfg.wif = address(w);
        cfg.fes = address(f);
        cfg.entryFee = 10e6;
        cfg.fesInventory = 5; // ignored without mocks
        Deploy.Deployment memory d = script.deploy(cfg);
        assertEq(d.wif, address(w));
        assertEq(d.fes, address(f));
        assertFalse(d.mockTokens);
        assertEq(f.balanceOf(d.fixedRateConverter), 0);
        _assertWiring(d, admin, d.deployer);
    }

    function test_Deploy_PrizesInWif() public {
        vm.chainId(4663);
        MockSocietyToken w = new MockSocietyToken("Real-ish WIF", "WIF", 6);
        Deploy.Config memory cfg = _mockConfig();
        cfg.deployMocks = false;
        cfg.wif = address(w);
        cfg.fes = address(0);
        cfg.entryFee = 10e6;
        cfg.extraLifeFee = 500e6;
        cfg.feeBounds = [uint256(1e6), 100e6, 50e6, 5_000e6];
        Deploy.Deployment memory d = script.deploy(cfg);
        assertTrue(d.prizeInWif);
        assertEq(d.fes, address(w));
        assertEq(d.fixedRate, 0);
        _assertWiring(d, admin, d.deployer);

        SocietyEntry entry = SocietyEntry(d.entry);
        assertEq(entry.minEntryFee(), 1e6);
        assertEq(entry.maxExtraLifeFee(), 5_000e6);

        // A paid voyage and its bonus life fund the week's pool in WIF; the winner is paid in WIF.
        address player = makeAddr("player");
        w.mint(player, 510e6);
        vm.startPrank(player);
        w.approve(d.entry, 510e6);
        bytes32 id = entry.enter("smoke", 10e6);
        entry.buyExtraLife(id, 500e6);
        vm.stopPrank();
        assertEq(w.balanceOf(treasury), 255e6);

        SocietyPrizeVault vault = SocietyPrizeVault(d.vault);
        uint256 week = vault.currentWeekId();
        assertEq(vault.getWeek(week).fesPool, 255e6);
        vm.warp(vault.weekEnd(week));
        vm.prank(settler);
        vault.finalizeWeek(week, [player, address(0), address(0)], keccak256("smoke"));
        vault.claimFor(week, 0);
        assertEq(w.balanceOf(player), 127.5e6);

        // The pricer can follow the market, within the bounds.
        vm.prank(pricer);
        entry.updatePrices(20e6, 400e6);
        assertEq(entry.entryFee(), 20e6);
        assertEq(entry.extraLifeFee(), 400e6);
    }

    function test_Deploy_BurnsTheProtocolShareByDefault() public {
        // The script's default treasury is the burn address; with it, half of every payment is burned for good.
        Deploy.Config memory cfg = _mockConfig();
        cfg.protocolTreasury = 0x000000000000000000000000000000000000dEaD;
        Deploy.Deployment memory d = script.deploy(cfg);
        SocietyEntry entry = SocietyEntry(d.entry);
        assertTrue(entry.burnsProtocolShare());
        address player = makeAddr("player");
        MockSocietyToken(d.wif).mint(player, 10e18);
        vm.startPrank(player);
        MockSocietyToken(d.wif).approve(d.entry, 10e18);
        entry.enter("burn", 10e18);
        vm.stopPrank();
        assertEq(MockSocietyToken(d.wif).balanceOf(entry.BURN_ADDRESS()), 5e18);
    }

    function test_Deploy_RevertsWithoutTokens() public {
        Deploy.Config memory cfg = _mockConfig();
        cfg.deployMocks = false;
        vm.expectRevert(bytes("Deploy: WIF_TOKEN is required"));
        script.deploy(cfg);
    }

    function test_Deploy_RevertsForTokenWithoutCode() public {
        Deploy.Config memory cfg = _mockConfig();
        cfg.deployMocks = false;
        cfg.wif = makeAddr("eoaWif");
        cfg.fes = address(new MockSocietyToken("F", "F", 18));
        vm.expectRevert(bytes("Deploy: WIF_TOKEN has no code on this chain"));
        script.deploy(cfg);
    }

    function test_Deploy_RefusesMocksOnMainnet() public {
        vm.chainId(4663);
        vm.expectRevert(bytes("Deploy: mock tokens are not allowed on mainnet"));
        script.deploy(_mockConfig());
    }

    function test_Deploy_RevertsOnInvalidFee() public {
        Deploy.Config memory cfg = _mockConfig();
        cfg.entryFee = 3;
        vm.expectRevert(abi.encodeWithSelector(SocietyEntry.InvalidEntryFee.selector, 3));
        script.deploy(cfg);
    }

    /// @dev The only test that touches process environment variables (tests run in parallel).
    function test_RunFromEnv_WritesDeploymentJsonAndSeeds() public {
        string memory out = "deployments/test-deploy-run.json";
        vm.setEnv("PRIVATE_KEY", vm.toString(ANVIL_PK));
        vm.setEnv("DEPLOY_MOCK_TOKENS", "true");
        vm.setEnv("MOCK_FES", "true");
        vm.setEnv("ADMIN", vm.toString(admin));
        vm.setEnv("SETTLER", vm.toString(settler));
        vm.setEnv("PRICER", vm.toString(pricer));
        vm.setEnv("EXTRA_LIFE_FEE", "1000000000000000000000");
        vm.setEnv("PROTOCOL_TREASURY", vm.toString(treasury));
        vm.setEnv("WIF_SINK", vm.toString(sink));
        vm.setEnv("ENTRY_FEE", "20000000000000000000");
        vm.setEnv("FIXED_RATE", "2000000000000000000");
        vm.setEnv("FES_INVENTORY", "5000000000000000000000");
        vm.setEnv("DEPLOYMENT_OUT", out);

        Deploy.Deployment memory d = script.run();
        address deployer = vm.addr(ANVIL_PK);
        assertEq(d.deployer, deployer);
        assertEq(d.entryFee, 20e18);
        assertEq(d.extraLifeFee, 1_000e18);
        assertEq(SocietyEntry(d.entry).minEntryFee(), 2e18);
        assertEq(SocietyEntry(d.entry).maxEntryFee(), 200e18);
        assertEq(SocietyEntry(d.entry).minExtraLifeFee(), 100e18);
        assertEq(SocietyEntry(d.entry).maxExtraLifeFee(), 10_000e18);
        assertEq(d.fixedRate, 2e18);
        assertEq(MockSocietyToken(d.fes).balanceOf(d.fixedRateConverter), 5_000e18);
        _assertWiring(d, admin, deployer);

        string memory json = vm.readFile(out);
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonUint(json, ".deployBlock"), 1234);
        assertEq(vm.parseJsonAddress(json, ".deployer"), deployer);
        assertEq(vm.parseJsonAddress(json, ".wifToken"), d.wif);
        assertEq(vm.parseJsonAddress(json, ".fesToken"), d.fes);
        assertEq(vm.parseJsonAddress(json, ".prizeVault"), d.vault);
        assertEq(vm.parseJsonAddress(json, ".entry"), d.entry);
        assertEq(vm.parseJsonAddress(json, ".fixedRateConverter"), d.fixedRateConverter);
        assertEq(vm.parseJsonAddress(json, ".admin"), admin);
        assertEq(vm.parseJsonAddress(json, ".settler"), settler);
        assertEq(vm.parseJsonAddress(json, ".pricer"), pricer);
        assertEq(vm.parseJsonString(json, ".extraLifeFee"), "1000000000000000000000");
        assertFalse(vm.parseJsonBool(json, ".prizeInWif"));
        assertEq(vm.parseJsonAddress(json, ".protocolTreasury"), treasury);
        assertEq(vm.parseJsonAddress(json, ".wifSink"), sink);
        assertEq(vm.parseJsonString(json, ".entryFee"), "20000000000000000000");
        assertEq(vm.parseJsonString(json, ".fixedRate"), "2000000000000000000");
        assertTrue(vm.parseJsonBool(json, ".mockTokens"));
        vm.removeFile(out);

        // DemoSeed: mint mock WIF to demo wallets.
        address p1 = makeAddr("demo1");
        address p2 = makeAddr("demo2");
        vm.setEnv("WIF_TOKEN", vm.toString(d.wif));
        vm.setEnv("DEMO_RECIPIENTS", string.concat(vm.toString(p1), ",", vm.toString(p2)));
        vm.setEnv("DEMO_AMOUNT", "42");
        new DemoSeed().run();
        assertEq(MockSocietyToken(d.wif).balanceOf(p1), 42);
        assertEq(MockSocietyToken(d.wif).balanceOf(p2), 42);
    }

    function test_DemoSeed_RefusesMainnet() public {
        Deploy.Deployment memory d = script.deploy(_mockConfig());
        DemoSeed seeder = new DemoSeed();
        address[] memory r = new address[](1);
        r[0] = makeAddr("x");
        vm.chainId(4663);
        vm.expectRevert(bytes("DemoSeed: not allowed on mainnet"));
        seeder.seed(d.wif, r, 1);
    }
}
