// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {SocietyEntry} from "../src/SocietyEntry.sol";
import {SocietyPrizeVault} from "../src/SocietyPrizeVault.sol";
import {FixedRateConverter} from "../src/converters/FixedRateConverter.sol";
import {MockSocietyToken} from "../src/mocks/MockSocietyToken.sol";

/// @title Deploy
/// @notice Deploys SocietyPrizeVault and SocietyEntry (plus a FixedRateConverter when prizes are paid in
///         a second token), wires their roles and writes `deployments/<chainid>.json`.
/// @dev Environment variables:
///      - `WIF_TOKEN`               the $WIF token (required unless `DEPLOY_MOCK_TOKENS=true`).
///                                  Never guess it; copy it from an authoritative source.
///      - `FES_TOKEN`               optional prize token. Unset (or equal to WIF_TOKEN): prizes are paid in
///                                  WIF itself, with no conversion and no converter.
///      - `DEPLOY_MOCK_TOKENS`      `true` deploys "Mock WIF" (and "Mock FES" when `MOCK_FES=true`),
///                                  18 decimals, open faucet. Refused on Robinhood Chain mainnet (4663).
///      - `ADMIN`                   admin of all contracts (default: deployer).
///      - `SETTLER`                 backend settlement key (default: deployer).
///      - `PRICER`                  backend key that re-prices the fees as WIF moves (default: SETTLER).
///      - `PROTOCOL_TREASURY`       receives 50% of every payment (default: the burn address 0x…dEaD, which
///                                  burns it; once burning, it can never be changed).
///      - `WIF_SINK`                receives WIF paid into the fixed-rate desk (default: ADMIN).
///      - `ENTRY_FEE`               raw WIF units, even (default: 10e18).
///      - `EXTRA_LIFE_FEE`          raw WIF units, even (default: 500e18).
///      - `MIN_ENTRY_FEE`, `MAX_ENTRY_FEE`, `MIN_EXTRA_LIFE_FEE`, `MAX_EXTRA_LIFE_FEE`
///                                  bounds of the pricer (default: a tenth to ten times the initial fee).
///      - `FIXED_RATE`              raw FES per 1e18 raw WIF (default: 1e18; second prize token only).
///      - `FES_INVENTORY`           mock FES minted into the desk when mocks are deployed (default: 0).
///      - `PRIVATE_KEY`             optional; otherwise use forge's `--account` / `--ledger` / `--private-key`.
///      - `DEPLOYMENT_OUT`          optional output path (default: `deployments/<chainid>.json`).
contract Deploy is Script {
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    /// @dev Same as `SocietyEntry.BURN_ADDRESS`: the default destination of the non-prize half.
    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Deployment parameters.
    struct Config {
        address wif;
        address fes;
        bool deployMocks;
        bool mockFes;
        address admin;
        address settler;
        address pricer;
        address protocolTreasury;
        address wifSink;
        uint256 entryFee;
        uint256 extraLifeFee;
        uint256[4] feeBounds;
        uint256 fixedRate;
        uint256 fesInventory;
    }

    /// @notice Deployed addresses.
    struct Deployment {
        uint256 chainId;
        uint256 deployBlock;
        address deployer;
        address wif;
        address fes;
        address vault;
        address entry;
        address fixedRateConverter;
        address admin;
        address settler;
        address pricer;
        address protocolTreasury;
        address wifSink;
        uint256 entryFee;
        uint256 extraLifeFee;
        uint256 fixedRate;
        bool prizeInWif;
        bool mockTokens;
    }

    /// @notice Entry point for `forge script script/Deploy.s.sol --broadcast`.
    /// @return d The deployment.
    function run() external returns (Deployment memory d) {
        uint256 startBlock = _chainHeadBlock();
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        address deployer = _broadcaster();
        d = _deploy(loadConfig(deployer), deployer);
        vm.stopBroadcast();

        d.deployBlock = startBlock;
        string memory path =
            vm.envOr("DEPLOYMENT_OUT", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        writeDeployment(d, path);
        _log(d, path);
    }

    /// @notice Builds the config from environment variables.
    /// @param deployer The broadcasting address (default for ADMIN and SETTLER).
    /// @return cfg The config.
    function loadConfig(address deployer) public view returns (Config memory cfg) {
        cfg.deployMocks = vm.envOr("DEPLOY_MOCK_TOKENS", false);
        cfg.mockFes = vm.envOr("MOCK_FES", false);
        cfg.wif = vm.envOr("WIF_TOKEN", address(0));
        cfg.fes = vm.envOr("FES_TOKEN", address(0));
        cfg.admin = vm.envOr("ADMIN", deployer);
        cfg.settler = vm.envOr("SETTLER", deployer);
        cfg.pricer = vm.envOr("PRICER", cfg.settler);
        cfg.protocolTreasury = vm.envOr("PROTOCOL_TREASURY", BURN_ADDRESS);
        cfg.wifSink = vm.envOr("WIF_SINK", cfg.admin);
        cfg.entryFee = vm.envOr("ENTRY_FEE", uint256(10e18));
        cfg.extraLifeFee = vm.envOr("EXTRA_LIFE_FEE", uint256(500e18));
        cfg.feeBounds = [
            vm.envOr("MIN_ENTRY_FEE", cfg.entryFee / 10),
            vm.envOr("MAX_ENTRY_FEE", cfg.entryFee * 10),
            vm.envOr("MIN_EXTRA_LIFE_FEE", cfg.extraLifeFee / 10),
            vm.envOr("MAX_EXTRA_LIFE_FEE", cfg.extraLifeFee * 10)
        ];
        cfg.fixedRate = vm.envOr("FIXED_RATE", uint256(1e18));
        cfg.fesInventory = vm.envOr("FES_INVENTORY", uint256(0));
    }

    /// @notice Deploys with an explicit config, broadcasting from forge's default sender (used by tests).
    /// @param cfg The config.
    /// @return d The deployment (with `deployBlock` set to the current block).
    function deploy(Config memory cfg) public returns (Deployment memory d) {
        uint256 startBlock = _chainHeadBlock();
        vm.startBroadcast();
        address deployer = _broadcaster();
        d = _deploy(cfg, deployer);
        vm.stopBroadcast();
        d.deployBlock = startBlock;
    }

    /// @notice Writes the deployment JSON consumed by the backend / frontend.
    /// @dev Large integers are written as decimal strings to stay exact in JavaScript.
    /// @param d The deployment.
    /// @param path Output path (must be under ./deployments).
    function writeDeployment(Deployment memory d, string memory path) public {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", d.chainId);
        vm.serializeUint(k, "deployBlock", d.deployBlock);
        vm.serializeAddress(k, "deployer", d.deployer);
        vm.serializeAddress(k, "wifToken", d.wif);
        vm.serializeAddress(k, "fesToken", d.fes);
        vm.serializeAddress(k, "prizeVault", d.vault);
        vm.serializeAddress(k, "entry", d.entry);
        vm.serializeAddress(k, "fixedRateConverter", d.fixedRateConverter);
        vm.serializeAddress(k, "admin", d.admin);
        vm.serializeAddress(k, "settler", d.settler);
        vm.serializeAddress(k, "pricer", d.pricer);
        vm.serializeAddress(k, "protocolTreasury", d.protocolTreasury);
        vm.serializeAddress(k, "wifSink", d.wifSink);
        vm.serializeString(k, "entryFee", vm.toString(d.entryFee));
        vm.serializeString(k, "extraLifeFee", vm.toString(d.extraLifeFee));
        vm.serializeString(k, "fixedRate", vm.toString(d.fixedRate));
        vm.serializeBool(k, "prizeInWif", d.prizeInWif);
        string memory json = vm.serializeBool(k, "mockTokens", d.mockTokens);
        vm.createDir("deployments", true);
        vm.writeJson(json, path);
    }

    function _deploy(Config memory cfg, address deployer) internal returns (Deployment memory d) {
        require(cfg.admin != address(0) && cfg.settler != address(0), "Deploy: zero admin/settler");
        require(cfg.pricer != address(0), "Deploy: zero pricer");
        require(cfg.protocolTreasury != address(0) && cfg.wifSink != address(0), "Deploy: zero treasury/sink");

        if (cfg.deployMocks) {
            require(block.chainid != ROBINHOOD_MAINNET_CHAIN_ID, "Deploy: mock tokens are not allowed on mainnet");
            cfg.wif = address(new MockSocietyToken("Mock WIF", "mWIF", 18));
            cfg.fes = cfg.mockFes ? address(new MockSocietyToken("Mock FES", "mFES", 18)) : cfg.wif;
        } else {
            require(cfg.wif != address(0), "Deploy: WIF_TOKEN is required");
            require(cfg.wif.code.length > 0, "Deploy: WIF_TOKEN has no code on this chain");
            _logToken("WIF_TOKEN", cfg.wif);
            if (cfg.fes == address(0)) cfg.fes = cfg.wif;
            require(cfg.fes.code.length > 0, "Deploy: FES_TOKEN has no code on this chain");
            if (cfg.fes != cfg.wif) _logToken("FES_TOKEN", cfg.fes);
            if (cfg.fesInventory != 0) console2.log("FES_INVENTORY ignored: only used with DEPLOY_MOCK_TOKENS=true");
        }
        bool prizeInWif = cfg.fes == cfg.wif;

        // Deploy with the deployer as temporary admin so it can wire roles, then hand over.
        SocietyPrizeVault vault = new SocietyPrizeVault(IERC20(cfg.wif), IERC20(cfg.fes), deployer);
        SocietyEntry entry =
            new SocietyEntry(IERC20(cfg.wif), vault, cfg.entryFee, cfg.extraLifeFee, cfg.protocolTreasury, deployer);

        vault.grantRole(vault.ENTRY_ROLE(), address(entry));
        vault.grantRole(vault.SETTLER_ROLE(), cfg.settler);
        entry.grantRole(entry.PRICER_ROLE(), cfg.pricer);
        entry.setFeeBounds(cfg.feeBounds[0], cfg.feeBounds[1], cfg.feeBounds[2], cfg.feeBounds[3]);

        // A second prize token needs a converter (the treasury desk); WIF prizes need none.
        FixedRateConverter desk;
        if (!prizeInWif) {
            desk = new FixedRateConverter(IERC20(cfg.wif), IERC20(cfg.fes), cfg.fixedRate, cfg.wifSink, deployer);
            vault.setConverter(address(desk), true);
            desk.setAuthorizedCaller(address(vault), true);
            if (cfg.deployMocks && cfg.fesInventory != 0) {
                MockSocietyToken(cfg.fes).mint(address(desk), cfg.fesInventory);
            }
        }

        if (cfg.admin != deployer) {
            _handOver(address(vault), vault.PAUSER_ROLE(), cfg.admin, deployer);
            _handOver(address(entry), entry.PAUSER_ROLE(), cfg.admin, deployer);
            if (!prizeInWif) _handOver(address(desk), desk.RATE_MANAGER_ROLE(), cfg.admin, deployer);
        }

        d.chainId = block.chainid;
        d.deployer = deployer;
        d.wif = cfg.wif;
        d.fes = cfg.fes;
        d.vault = address(vault);
        d.entry = address(entry);
        d.fixedRateConverter = address(desk);
        d.admin = cfg.admin;
        d.settler = cfg.settler;
        d.pricer = cfg.pricer;
        d.protocolTreasury = cfg.protocolTreasury;
        d.wifSink = cfg.wifSink;
        d.entryFee = cfg.entryFee;
        d.extraLifeFee = cfg.extraLifeFee;
        d.fixedRate = prizeInWif ? 0 : cfg.fixedRate;
        d.prizeInWif = prizeInWif;
        d.mockTokens = cfg.deployMocks;
    }

    /// @dev Prints a token's name, symbol and decimals, so the operator can check them in the dry run before
    ///      broadcasting. Reverts if the token does not answer `decimals()` (the fees are set in its units).
    function _logToken(string memory label, address token) internal view {
        console2.log(label, token);
        try IERC20Metadata(token).name() returns (string memory name) {
            console2.log("  name    ", name);
        } catch {
            console2.log("  name     (none)");
        }
        try IERC20Metadata(token).symbol() returns (string memory symbol) {
            console2.log("  symbol  ", symbol);
        } catch {
            console2.log("  symbol   (none)");
        }
        try IERC20Metadata(token).decimals() returns (uint8 decimals) {
            console2.log("  decimals", decimals);
        } catch {
            revert("Deploy: token does not report decimals()");
        }
    }

    /// @dev Grants DEFAULT_ADMIN_ROLE + `operatorRole` to `admin`, then renounces both for `deployer`.
    function _handOver(address target, bytes32 operatorRole, address admin, address deployer) internal {
        IAccessControlLike ac = IAccessControlLike(target);
        bytes32 adminRole = 0x00;
        ac.grantRole(operatorRole, admin);
        ac.grantRole(adminRole, admin);
        ac.renounceRole(operatorRole, deployer);
        ac.renounceRole(adminRole, deployer);
    }

    /// @dev Address of the active broadcast (must be called between start/stopBroadcast).
    function _broadcaster() internal view returns (address) {
        (, address msgSender,) = vm.readCallers();
        return msgSender;
    }

    /// @dev Current chain head. Uses `eth_blockNumber` when running against an RPC because on
    ///      Arbitrum-based chains `block.number` may report the parent-chain block number. Falls
    ///      back to `block.number` in local simulations. The deployment happens at or after this
    ///      block, so it is a safe start block for event indexers.
    function _chainHeadBlock() internal returns (uint256) {
        try vm.rpc("eth_blockNumber", "[]") returns (bytes memory raw) {
            if (raw.length == 0 || raw.length > 32) return block.number;
            // `raw` is 1..32 big-endian bytes: left-align into a word, then shift down.
            // forge-lint: disable-next-line(unsafe-typecast)
            return uint256(bytes32(raw)) >> (8 * (32 - raw.length));
        } catch {
            return block.number;
        }
    }

    function _log(Deployment memory d, string memory path) internal pure {
        console2.log("chainId           ", d.chainId);
        console2.log("deployBlock       ", d.deployBlock);
        console2.log("WIF token         ", d.wif);
        console2.log("FES token         ", d.fes);
        console2.log("SocietyPrizeVault ", d.vault);
        console2.log("SocietyEntry      ", d.entry);
        console2.log("FixedRateConverter", d.fixedRateConverter);
        console2.log("admin             ", d.admin);
        console2.log("settler           ", d.settler);
        console2.log("pricer            ", d.pricer);
        console2.log("protocolTreasury  ", d.protocolTreasury, d.protocolTreasury == BURN_ADDRESS ? "(burned)" : "");
        console2.log("entryFee (raw)    ", d.entryFee);
        console2.log("extraLifeFee (raw)", d.extraLifeFee);
        console2.log("prizes paid in WIF", d.prizeInWif);
        console2.log("written to        ", path);
    }
}

/// @dev Minimal AccessControl surface used for the admin hand-over.
interface IAccessControlLike {
    function grantRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address callerConfirmation) external;
}
