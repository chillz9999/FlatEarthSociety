# The Flat Earth Society — contracts

Solidity contracts for the paid-entry weekly arcade competition on **Robinhood Chain**
(Arbitrum Orbit L2 — mainnet chain id `4663`, testnet chain id `46630`).

Players pay an entry fee in **$WIF** for one ranked attempt, and may buy **one bonus life** for
that attempt when their ship is lost. Exactly 50% of every payment is credited to that week's reward
allocation (held by the prize vault) and 50% goes to the protocol treasury, which the deployment sets to the
burn address `0x…dEaD` (permanently: once burning, `setProtocolTreasury` reverts). Both fees are priced in
dollars off-chain ($0.10 and $5) and re-priced in WIF by a pricer key as the market moves, only
within bounds set by the admin and by at most 2x per update; every purchase names the most the buyer
will pay.

The prize is paid **in $WIF itself** when the vault is deployed with the same token for `wif` and
`fes` (*in-kind* mode, the default of the deploy script): every allocation joins the week's pool as
it is and nothing is converted. The top 3 of the week receive 50% / 30% / 20% of the pool. The vault
also supports a second prize token ($FES), with each week's WIF converted through an approved
converter (minimum output + deadline, recorded onchain).

Solidity `0.8.28`, OpenZeppelin Contracts `v5.4.0`, Foundry, `evm_version = cancun`.

## Layout

```
src/
  SocietyEntry.sol                 entry and bonus-life sales, 50/50 split, bounded re-pricing
  SocietyPrizeVault.sol            weekly allocations, (optional) conversion, settlement, claims
  interfaces/ISocietyPrizeVault.sol vault interface, events, WeekView struct
  interfaces/IFesConverter.sol     WIF -> FES converter interface
  libraries/SocietyWeeks.sol       week calendar (Monday 00:00:00 UTC weeks)
  converters/FixedRateConverter.sol  "Society treasury desk": FES inventory at a public, timelocked rate
  converters/UniswapV3Converter.sol  DEX conversion through a SwapRouter02-style router
  mocks/MockSocietyToken.sol       DEMO ONLY: ERC20 + permit, open mint faucet
  mocks/MockSwapRouter.sol         DEMO/TEST ONLY: fake SwapRouter02 at a settable rate
script/
  Deploy.s.sol                     deploys + wires everything, writes deployments/<chainid>.json
  DemoSeed.s.sol                   LOCAL ONLY: mints mock WIF to demo wallets
test/                              unit, fuzz, integration, invariant and deploy-script tests
deployments/                       deployment records (<chainid>.json)
```

## Architecture

```
 pricer ──updatePrices(entry, life)──▶ SocietyEntry   (within the admin's bounds, ≤ 2x per update)
 player ──enter / enterWithPermit / buyExtraLife──▶ SocietyEntry ──50% WIF──▶ protocolTreasury
                                         │
                                         └─50% WIF + notifyEntryAllocation(week, entryId, amount)
                                                    ▼
                                          SocietyPrizeVault ◀── fundWeek (anyone, prize token)
                     in-kind (wif == fes): the WIF joins the week's pool as it is — no conversion
                     otherwise:
 settler ──convertWeek(week, wif, converter, minOut, deadline)──▶ SocietyPrizeVault
                                                    │   ▲
                              WIF (exact amount)    ▼   │  FES (measured balance delta >= minOut)
                                        approved IFesConverter
                                 (FixedRateConverter / UniswapV3Converter)

 settler ──finalizeWeek(week, [1st, 2nd, 3rd], resultsHash)──▶ vault  (50/30/20, empty ranks roll to week+1)
 winner  ──claim(week, rank)──▶ vault ──FES──▶ winner
 anyone  ──claimFor(week, rank)──▶ vault ──FES──▶ recorded winner
```

### Weeks

`weekId = (timestamp - 345600) / 604800`. Week 0 starts Monday 1970-01-05 00:00:00 UTC.
`weekStart(id) = 345600 + id * 604800`, `weekEnd(id) = weekStart(id + 1)` (exclusive). A week runs
Monday 00:00:00 UTC through Sunday 23:59:59 UTC. Example: week `2964` = 2026-10-26 00:00:00 UTC to
2026-11-02 00:00:00 UTC. `currentWeekId()`, `weekIdAt()`, `weekStart()`, `weekEnd()` are exposed on
the vault (and `currentWeekId()` on the entry contract).

### Money flow and rounding

- Entry fee or bonus-life fee `F` (must be non-zero and even): `rewardShare = F / 2` to the vault,
  `protocolShare = F - rewardShare` to the treasury. Because `F` is even the split is exactly 50/50.
- A bonus life is credited to the week in which it is paid (normally the week of its entry).
- In-kind, an allocation of `A` WIF adds `A` to the week's `wifAllocated`, `wifConverted` and pool at
  once, and the vault checks it holds `A` more WIF than it already owes (`totalFesLiabilities`).
- Settlement of a pool `P`: `first = P * 5000 / 10000`, `second = P * 3000 / 10000`,
  `third = P - first - second`. The three amounts always sum to `P` (no dust).
- If a week has fewer than 3 winners, the shares of the empty ranks are added to week `weekId + 1`'s pool
  (`PoolRolledOver`). This reverts if week `weekId + 1` is already finalized, so settle weeks in order.

## Roles

| Contract | Role | Holder | Can |
| --- | --- | --- | --- |
| SocietyEntry | `DEFAULT_ADMIN_ROLE` | admin multisig | `setEntryFee`, `setExtraLifeFee`, `setFeeBounds`, `setProtocolTreasury`, grant/revoke roles |
| SocietyEntry | `PRICER_ROLE` | backend price key | `updatePrices` — within the bounds, at most 2x up or down per update |
| SocietyEntry | `PAUSER_ROLE` | admin (or a guardian) | `pause` / `unpause` entries and bonus lives |
| SocietyPrizeVault | `DEFAULT_ADMIN_ROLE` | admin multisig | `setConverter`, `rescueToken` (never WIF/FES), grant/revoke roles |
| SocietyPrizeVault | `ENTRY_ROLE` | SocietyEntry contract | `notifyEntryAllocation` |
| SocietyPrizeVault | `SETTLER_ROLE` | backend settlement key | `convertWeek`, `finalizeWeek` |
| SocietyPrizeVault | `PAUSER_ROLE` | admin (or a guardian) | `pause` / `unpause` claims |
| FixedRateConverter | `DEFAULT_ADMIN_ROLE` | admin multisig | `setAuthorizedCaller`, `setWifSink`, `withdrawInventory` |
| FixedRateConverter | `RATE_MANAGER_ROLE` | admin | `proposeRate`, `activateRate` (after 24h), `cancelRateProposal` |
| UniswapV3Converter | `DEFAULT_ADMIN_ROLE` | admin multisig | `setAuthorizedCaller`, `rescueToken` |

Role ids: `keccak256("PAUSER_ROLE")`, `keccak256("ENTRY_ROLE")`, `keccak256("SETTLER_ROLE")`,
`keccak256("PRICER_ROLE")` (`0xc6823861…07fd8a`), `keccak256("RATE_MANAGER_ROLE")`; `DEFAULT_ADMIN_ROLE = 0x00`.

## Flows

1. **Entry.** The frontend asks the backend for an `attemptRef` (any `bytes32`, e.g. a random nonce
   tied to the game attempt). The player approves `entryFee` WIF to `SocietyEntry` and calls
   `enter(attemptRef, maxFee)` — or calls `enterWithPermit(attemptRef, maxFee, deadline, v, r, s)`
   with an EIP-2612 permit for `maxFee` (the permit is try/caught, so a front-run permit cannot grief
   the entry). `maxFee` is the fee the player was shown: if the pricer re-prices while the transaction
   is pending, it reverts (`FeeAboveMax`) instead of charging more.
   `entryId = keccak256(abi.encode(player, attemptRef))`; each id can be bought once. Because
   the id is bound to `msg.sender`, copying someone's `attemptRef` from the mempool is useless.
   The backend indexes `EntryPurchased` and grants the ranked attempt for `entryId`.
   **Bonus life.** When the ship is lost the player may call `buyExtraLife(entryId, maxFee)` for their
   own entry, once (`ExtraLifePurchased`); the backend lets the voyage carry on once it has seen it.
2. **Allocation.** Inside the same transaction, `SocietyEntry` transfers `fee / 2` WIF to the vault
   and calls `notifyEntryAllocation(weekId, entryId, amount)`; the vault only accepts the current
   week and checks that it actually holds the WIF (`AllocationRecorded`).
3. **Conversion (second prize token only).** The settler calls `convertWeek(weekId, wifAmount, converter, minFesOut, deadline)`
   one or more times (partial conversions limit price impact). The converter must be approved,
   `minFesOut > 0`, and `block.timestamp <= deadline`. The vault approves exactly `wifAmount`,
   resets the approval to 0, requires that exactly `wifAmount` WIF left, and credits the *measured*
   FES balance increase (never the converter's return value) to the week (`WeekConverted`). For the
   fixed-rate desk use `minFesOut = FixedRateConverter.quote(wifAmount)`.
4. **Top-ups (optional).** Anyone may add FES to an unfinalized week with `fundWeek` (`WeekFunded`).
5. **Finalize.** After `weekEnd(weekId)` and once `wifConverted == wifAllocated`, the settler calls
   `finalizeWeek(weekId, [first, second, third], resultsHash)`. Non-zero winners must come first,
   then zero addresses for empty ranks; winners must be distinct. `resultsHash` should commit to the
   off-chain leaderboard snapshot (e.g. `keccak256` of the canonical results JSON) so anyone can
   audit the settlement. A week can be finalized only once.
6. **Claim.** Winners call `claim(weekId, rank)` (rank 0/1/2), or anyone (e.g. the backend) calls
   `claimFor(weekId, rank)` to push the FES to the recorded winner (`RewardClaimed`). Each rank can be
   paid once. Rewards never expire.

## Events (exact signatures)

```solidity
// SocietyEntry
event EntryPurchased(bytes32 indexed entryId, address indexed player, uint256 indexed weekId, bytes32 attemptRef, uint256 fee, uint256 rewardShare, uint256 protocolShare);
event ExtraLifePurchased(bytes32 indexed entryId, address indexed player, uint256 indexed weekId, uint256 fee, uint256 rewardShare, uint256 protocolShare);
event EntryFeeUpdated(uint256 previousFee, uint256 newFee);
event ExtraLifeFeeUpdated(uint256 previousFee, uint256 newFee);
event FeeBoundsUpdated(uint256 minEntryFee, uint256 maxEntryFee, uint256 minExtraLifeFee, uint256 maxExtraLifeFee);
event ProtocolTreasuryUpdated(address previousTreasury, address newTreasury);

// SocietyPrizeVault
event AllocationRecorded(uint256 indexed weekId, bytes32 indexed entryId, uint256 wifAmount);
event ConverterApproved(address indexed converter, bool approved);
event WeekConverted(uint256 indexed weekId, address indexed converter, uint256 wifIn, uint256 fesOut);
event WeekFunded(uint256 indexed weekId, address indexed funder, uint256 fesAmount);
event PoolRolledOver(uint256 indexed fromWeek, uint256 indexed toWeek, uint256 amount);
event WeekFinalized(uint256 indexed weekId, address[3] winners, uint256[3] amounts, bytes32 resultsHash);
event RewardClaimed(uint256 indexed weekId, uint8 indexed rank, address indexed winner, uint256 amount);
event TokenRescued(address indexed token, address indexed to, uint256 amount);

// FixedRateConverter
event RateProposed(uint256 newRate, uint256 effectiveAt);
event RateActivated(uint256 previousRate, uint256 newRate);
event RateProposalCancelled(uint256 cancelledRate);
event WifSinkUpdated(address previousSink, address newSink);
event CallerAuthorizationUpdated(address indexed caller, bool authorized);
event Converted(address indexed caller, address indexed recipient, uint256 wifIn, uint256 fesOut, uint256 rate);
event InventoryWithdrawn(address indexed to, uint256 amount);

// UniswapV3Converter
event Swapped(uint256 wifIn, uint256 fesOut);
event CallerAuthorizationUpdated(address indexed caller, bool authorized);
event TokenRescued(address indexed token, address indexed to, uint256 amount);
```

Plus OpenZeppelin's `RoleGranted`, `RoleRevoked`, `RoleAdminChanged`, `Paused`, `Unpaused`.

| Event | topic0 |
| --- | --- |
| `EntryPurchased(bytes32,address,uint256,bytes32,uint256,uint256,uint256)` | `0x6cb42eaf2117a43b082b43c9d66385b9fefdf6cb477524e5690f66607fa93c3d` |
| `ExtraLifePurchased(bytes32,address,uint256,uint256,uint256,uint256)` | `0xdadd5283618fc49eed1182a085f8539642a595d7f751b8aa8961df016ab39f72` |
| `ExtraLifeFeeUpdated(uint256,uint256)` | `0xb41dcdce76f43a7c5f021d667ca17742052fa299b9a357017b704deeb1c5f404` |
| `FeeBoundsUpdated(uint256,uint256,uint256,uint256)` | `0x293dd71f6e76525f9b12f2123dd7d755694563096e3a4926f2110dc21681054e` |
| `AllocationRecorded(uint256,bytes32,uint256)` | `0xdba343df362670bcc760be493b477399e060c011fe4184726ee47493a3806b54` |
| `WeekConverted(uint256,address,uint256,uint256)` | `0xb9ffa08aa99665554f3cafc1f4a316e3749f7a98664a3525ed5835afd41475b3` |
| `WeekFunded(uint256,address,uint256)` | `0xb3aeb4efad42a259d35487317914c6d5f3cd4e23e99bb61d58974db71ad2bd5d` |
| `PoolRolledOver(uint256,uint256,uint256)` | `0xdb0436d5f117e8f1e692d4f9b682459e8d3c302c3f5996e4b515099ffc7f8963` |
| `WeekFinalized(uint256,address[3],uint256[3],bytes32)` | `0x2577a0a8342ac637d2d356aa1ce19bea81f33a848d9fefcf4233fe391a6aa61b` |
| `RewardClaimed(uint256,uint8,address,uint256)` | `0xc8928dbe7d0b8fc30a1b55eaf126f1ef8f9953d827240ab5e44ebc3564d2a3c8` |
| `Converted(address,address,uint256,uint256,uint256)` | `0xecba9465f76fb3d7a25126f1750f58dbfbe90aceef0338d496a5f6dcef0fbd0c` |

Full ABIs are in `out/<File>.sol/<Contract>.json` after `forge build`.

## Build and test

```bash
cd contracts
forge install          # fetches lib/forge-std and lib/openzeppelin-contracts (git submodules)
forge build
forge test             # unit + fuzz (512 runs) + invariant (256 runs x depth 64) + deploy-script tests
forge fmt --check
```

`foundry.toml` pins `solc_version = "0.8.28"`. In sandboxes that cannot download solc, point
`FOUNDRY_SOLC` at a local solc 0.8.28 binary instead of editing `foundry.toml`.

## Deployment

### Environment variables (`script/Deploy.s.sol`)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `WIF_TOKEN` | yes, unless mocks | — | $WIF token address on the target chain |
| `FES_TOKEN` | no | `WIF_TOKEN` | a second prize token; unset, the prizes are paid in WIF and no converter is deployed |
| `DEPLOY_MOCK_TOKENS` | no | `false` | `true` deploys "Mock WIF" (18 decimals, open faucet). Refused on chain 4663 |
| `MOCK_FES` | no | `false` | with mocks: also deploy "Mock FES" as a second prize token, with the fixed-rate desk |
| `ADMIN` | no | deployer | admin of all contracts (use a multisig) |
| `SETTLER` | no | deployer | backend settlement key (`SETTLER_ROLE`) |
| `PRICER` | no | `SETTLER` | backend price key (`PRICER_ROLE`) |
| `PROTOCOL_TREASURY` | no | `0x…dEaD` | receives 50% of every payment; the default burns it, permanently |
| `WIF_SINK` | no | `ADMIN` | receives WIF paid into the fixed-rate desk |
| `ENTRY_FEE` | no | `10e18` | raw WIF units, must be even (`npm run fees -w @fes/server -- <price>` computes it) |
| `EXTRA_LIFE_FEE` | no | `500e18` | raw WIF units, must be even |
| `MIN_ENTRY_FEE` / `MAX_ENTRY_FEE` | no | fee / 10, fee × 10 | the pricer's bounds for the entry fee |
| `MIN_EXTRA_LIFE_FEE` / `MAX_EXTRA_LIFE_FEE` | no | fee / 10, fee × 10 | the pricer's bounds for the bonus life |
| `FIXED_RATE` | no | `1e18` | second prize token only: raw FES per 1e18 raw WIF |
| `FES_INVENTORY` | no | `0` | mock FES minted into the desk (mocks only) |
| `PRIVATE_KEY` | no | — | otherwise pass `--account` / `--ledger` / `--private-key` to forge |
| `DEPLOYMENT_OUT` | no | `deployments/<chainid>.json` | output path (must be under `deployments/`) |
| `ROBINHOOD_RPC_URL` / `ROBINHOOD_TESTNET_RPC_URL` | for live deploys | — | used by the `robinhood` / `robinhood_testnet` aliases in `foundry.toml` |

**Never guess token addresses.** Copy `WIF_TOKEN` / `FES_TOKEN` from an authoritative source
(the token issuers / official Robinhood Chain documentation) and double-check them on the explorer.
The script refuses token addresses that have no code on the target chain, and prints each token's
name, symbol and decimals in the dry run (before `--broadcast`) so you can check them.

The RPC URLs and the block explorer are **not** hardcoded: take them from the official Robinhood
Chain documentation, put them in your environment, and verify the chain id before broadcasting
(`cast chain-id --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"` must print `46630`; mainnet must print `4663`).

The deployer is used as temporary admin to wire the roles, then (if `ADMIN` differs) grants
`DEFAULT_ADMIN_ROLE` + `PAUSER_ROLE` / `RATE_MANAGER_ROLE` to `ADMIN` and renounces its own roles.
The script wires: `ENTRY_ROLE` -> SocietyEntry, `SETTLER_ROLE` -> `SETTLER`, `PRICER_ROLE` -> `PRICER`,
the fee bounds, and (second prize token only) the desk approved in the vault and the vault authorized on the desk.

`deployments/<chainid>.json` contains `chainId`, `deployBlock`, `deployer`, `wifToken`, `fesToken`,
`prizeVault`, `entry`, `fixedRateConverter` (zero when prizes are paid in WIF), `admin`, `settler`,
`pricer`, `protocolTreasury`, `wifSink`, `entryFee`, `extraLifeFee` and `fixedRate` (decimal strings,
exact for JavaScript), `prizeInWif` and `mockTokens`. `deployBlock` is
the chain head (`eth_blockNumber`) when the script started; the contracts were deployed at or after it,
so it is a safe start block for event indexers. (On Arbitrum-based chains the EVM `block.number`
can be the parent-chain block number, which is why the script asks the RPC directly.)

### Robinhood Chain testnet (46630)

```bash
export ROBINHOOD_TESTNET_RPC_URL=...   # from the official Robinhood Chain docs
export WIF_TOKEN=0x...                 # verified testnet $WIF address
export FES_TOKEN=0x...                 # verified testnet $FES address
export ADMIN=0x... SETTLER=0x...   # the non-prize half is burned unless PROTOCOL_TREASURY is set
cast chain-id --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"   # must print 46630

forge script script/Deploy.s.sol --rpc-url robinhood_testnet --account deployer --broadcast
# Optional source verification: use the verifier the official explorer documents, e.g. for a
# Blockscout explorer: --verify --verifier blockscout --verifier-url "$ROBINHOOD_TESTNET_EXPLORER_API_URL"
```

If no testnet tokens exist yet, a demo deployment can use `DEPLOY_MOCK_TOKENS=true` (anyone can mint
the mock tokens; they are worthless and must not be presented as real $WIF/$FES).

### Robinhood Chain mainnet (4663)

Same as testnet with `--rpc-url robinhood` and `ROBINHOOD_RPC_URL`; mocks are refused. Leave
`FES_TOKEN` unset to pay prizes in WIF. Step by step: [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md). Checklist:

- [ ] `cast chain-id --rpc-url "$ROBINHOOD_RPC_URL"` prints `4663`.
- [ ] `WIF_TOKEN` verified against official sources and on the explorer (the dry run prints its name, symbol and decimals); it is not a fee-on-transfer or rebasing token.
- [ ] `ADMIN` is a multisig; `SETTLER` / `PRICER` are dedicated keys holding only their roles.
- [ ] `ENTRY_FEE` / `EXTRA_LIFE_FEE` are even, in raw WIF units, and worth $0.10 / $5 at today's price (`npm run fees -w @fes/server -- <price> <decimals>`).
- [ ] The pricer's bounds are wide enough for the market and narrow enough to be safe.
- [ ] Commit `deployments/4663.json`; give it (or `prizeVault`, `entry` and `deployBlock`) to the backend.

### Local anvil demo

```bash
anvil
DEPLOY_MOCK_TOKENS=true \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key <anvil dev key>
DEMO_RECIPIENTS=0xabc...,0xdef... \
  forge script script/DemoSeed.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key <anvil dev key>
```

## Security notes

### What admins can do

- **Entry admin:** change either fee (future purchases only; must stay even; `EntryFeeUpdated`,
  `ExtraLifeFeeUpdated`), set the pricer's bounds (`FeeBoundsUpdated`; a maximum of zero stops
  re-pricing), change the protocol treasury (`ProtocolTreasuryUpdated`) unless it is the burn address
  (burning is permanent: `BurnIsPermanent`), pause/unpause entries.
- **Pricer:** move both fees within the bounds, by at most half or double per update. Every purchase
  carries the buyer's `maxFee`, so a re-price can make a pending purchase fail but never cost more.
- **Vault admin:** approve/revoke converters (`ConverterApproved`), grant/revoke roles (including
  `SETTLER_ROLE` and `ENTRY_ROLE`), pause/unpause claims, rescue tokens *other than* WIF and FES that
  were sent to the vault by mistake.
- **Settler:** choose when and through which approved converter a week's WIF is converted and with
  which `minFesOut`; choose the winners and the `resultsHash` at settlement. The winners list is
  trusted input from the backend — the `resultsHash` lets anyone check it against the published
  leaderboard.
- **Desk admin / rate manager:** propose a new fixed rate (public, activatable only after 24 hours),
  activate or cancel it, change the WIF sink, withdraw FES inventory, (de)authorize callers.

### What admins cannot do

- Withdraw WIF or FES from the vault — `rescueToken` reverts for both; there is no other exit path for
  prize funds than conversions (WIF out, FES in, measured) and claims to recorded winners.
- Move WIF allocated to one week into another week, or convert more than a week's allocation.
- Finalize a week before it ends, finalize it twice, change winners/amounts after finalization, or
  finalize while part of the week's WIF allocation is unconverted.
- Take more or less than 50% of an entry fee or bonus life: the split is fixed in code and the fees must be even.
- Charge a buyer more than the `maxFee` they signed for.
- Pay a reward to anyone but the recorded winner (`claimFor` always pays the winner).
- Change the fixed rate without a public 24-hour notice.

### Trust assumptions and residual risks

- The admin can pause claims indefinitely and can approve a converter; the settler controls
  conversion pricing via `minFesOut`. Mitigations: multisig admin, a settler key with only
  `SETTLER_ROLE`, and the fact that every conversion (`WeekConverted`, `Converted`), approval and pause
  is an onchain event. Consider putting the admin behind a timelock.
- The fees can change between a player's approval and inclusion of their transaction; `maxFee` caps
  what is taken, and frontends should approve exactly the fee they show.
- The pricer is trusted to follow the market within its bounds; a compromised pricer key can move the
  fees to either bound (one doubling or halving per transaction). Keep the bounds tight enough that
  either end is acceptable, and revoke `PRICER_ROLE` if the key is lost.
- Fee-on-transfer and rebasing tokens are unsupported (transfers are balance-checked and revert).
  A FES token with a blocklist could block payouts to a blocked winner.
- Tokens sent directly to the vault (instead of through `fundWeek` / entries) are not part of any pool
  and cannot be recovered if they are WIF or FES.
- With fewer than 3 winners the rollover targets `weekId + 1`; settle weeks in order, otherwise the
  earlier week can only be finalized with a full podium.
- Timestamps come from the Robinhood Chain sequencer; the weekly boundaries are coarse enough that
  small drift does not matter.
- All state-changing external functions that move tokens are `nonReentrant`; the vault measures every
  token movement with balance deltas and resets converter allowances to zero.
- `MockSocietyToken` and `MockSwapRouter` are for local/testnet demos only (open mint, no access control).
