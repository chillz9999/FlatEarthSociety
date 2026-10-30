# Deployment

## 1. Confirm the network parameters (do not skip)

Public sources at the time of writing (October 2026) give:

| | Mainnet | Testnet |
|---|---|---|
| Chain id | `4663` | `46630` |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Gas token | ETH (Arbitrum Orbit L2) | ETH |

Re‑check every value against the **official Robinhood Chain documentation** before deploying, and use a dedicated RPC provider in production; the public endpoints are rate‑limited. The values are only defaults in `packages/shared/src/chains.ts` and can be overridden by environment variables everywhere. The backend refuses to start if the RPC reports a different chain id than configured, or if there is no contract code at the entry address.

**Token addresses are never guessed.** The $WIF address the project uses on mainnet is `0x5173b8ea6923c2d40267890d45c46a3480954773` (supplied by the project owner; checked on chain 4663 on 29 October 2026: contract code present, name "World is Flat", symbol WIF, 18 decimals). Its pools are listed on DexScreener under the chain id `robinhood` (`DEXSCREENER_CHAIN=robinhood`); the price service reads WIF from either side of a pool. Before deploying, check it yourself:

```bash
export ROBINHOOD_RPC_URL=https://…            # your RPC for chain 4663
export WIF_TOKEN=0x5173b8ea6923c2d40267890d45c46a3480954773
cast chain-id --rpc-url "$ROBINHOOD_RPC_URL"                      # 4663
cast code "$WIF_TOKEN" --rpc-url "$ROBINHOOD_RPC_URL" | head -c 20  # not 0x
cast call "$WIF_TOKEN" 'symbol()(string)' --rpc-url "$ROBINHOOD_RPC_URL"
cast call "$WIF_TOKEN" 'decimals()(uint8)' --rpc-url "$ROBINHOOD_RPC_URL"
```

Also open it on the explorer and confirm it is the token the project means (not a look‑alike), and that it is a plain ERC‑20 (no transfer fee, no rebasing). The deploy script refuses addresses with no code and prints the token's name, symbol and decimals in its dry run.

## 2. Deploy the contracts (Foundry)

Prizes are paid in $WIF: leave `FES_TOKEN` unset and the vault runs *in kind*, with no converter. Work out the starting fees from today's $WIF price (the price service keeps them right afterwards). The script reads the market from DexScreener and prints the lines to paste:

```bash
./scripts/fees-from-market.sh          # $WIF on Robinhood Chain: prices, pool liquidity, and the export line
# or, from a price you supply:
npm run fees -w @fes/server -- <WIF price in dollars> <decimals>
```

Then:

```bash
cd contracts
forge test                                   # must be green
export WIF_TOKEN=0x5173b8ea6923c2d40267890d45c46a3480954773   # verified as above
export ADMIN=0x…                             # Society multisig (admin + pauser roles)
export SETTLER=0x…                           # backend settlement key (SETTLER_ROLE)
export PRICER=0x…                            # backend price key (PRICER_ROLE); defaults to SETTLER
export ENTRY_FEE=…  EXTRA_LIFE_FEE=…         # from `npm run fees`
# Optional: the pricer's bounds (default: a tenth to ten times each starting fee)
# export MIN_ENTRY_FEE=… MAX_ENTRY_FEE=… MIN_EXTRA_LIFE_FEE=… MAX_EXTRA_LIFE_FEE=…
forge script script/Deploy.s.sol:Deploy --rpc-url "$ROBINHOOD_RPC_URL" --account deployer   # dry run: read the token lines
forge script script/Deploy.s.sol:Deploy --rpc-url "$ROBINHOOD_RPC_URL" --account deployer --broadcast --slow
```

The non‑prize half of every payment is burned: the script's default `PROTOCOL_TREASURY` is the dead address `0x…dEaD`, and the contract makes that permanent. The script deploys `SocietyPrizeVault` and `SocietyEntry`, grants `ENTRY_ROLE`, `SETTLER_ROLE` and `PRICER_ROLE`, sets the pricer's bounds, then hands admin to `ADMIN` and renounces the deployer's roles. It writes `deployments/<chainId>.json`, which the API reads. Verify the contracts on the explorer (Blockscout supports `forge verify-contract --verifier blockscout`), commit the deployment file, and fund the `SETTLER` and `PRICER` keys with a little ETH for gas.

**Live on Robinhood Chain mainnet** since block `101217422` (29 October 2026); the record is [`contracts/deployments/4663.json`](../contracts/deployments/4663.json):

| | Address |
|---|---|
| `SocietyEntry` | `0xe4E85eC1741c607b140CDC4af943b890d1bAFfdc` |
| `SocietyPrizeVault` | `0x47E5708ce5626cB02b6383764f284B8EF72E23c2` |
| Admin (deployer, kept its roles) | `0x0f8874096f16FAf01cE498b0dFAce5ee68B78733` |
| Settler and pricer (the API's key) | `0x37E69994724a338e46Dc1a5348023522EB4a37d8` |

Prizes are paid in $WIF itself (no converter); the non‑prize half is burned. Starting fees: 87.8 WIF a voyage and 4,390 WIF a bonus life ($0.10 and $5 at $0.001139).

The bounds are the pricer's hard limits: a compromised pricer key can move the fees anywhere between them (one halving or doubling per transaction), and they stop the price service once $WIF moves beyond them. Choose them so that either end is acceptable, and widen them with `setFeeBounds` from the multisig when the market calls for it; the admin console shows when the service is held at a bound.

For a **testnet or local demo**: `DEPLOY_MOCK_TOKENS=true` deploys an open‑faucet mock $WIF, surfaced in the UI as "Demo network: mint test $WIF". `./scripts/local-chain.sh` does this on anvil. A second prize token ($FES, with the fixed‑rate desk) remains available with `FES_TOKEN=…` (or `MOCK_FES=true` for mocks); see [Economy](ECONOMY.md#a-second-prize-token-optional).

## 3. Run the API

```bash
npm ci
npm run build -w @fes/server
cd apps/server && cp .env.example .env    # then edit
node dist/index.js
```

Required in production:

- `DATABASE_URL` pointing at PostgreSQL 14+. Migrations run automatically at start.
- `SESSION_SECRET`, at least 32 random characters (`openssl rand -hex 32`). There is no default: without it, development servers use a random per‑process secret, and production refuses to start.
- `TRUST_PROXY`, set to your reverse proxy's address(es) or hop count, so per‑IP rate limits see the real client address. Leave it `false` when the API is not behind a proxy; `X-Forwarded-For` is otherwise client‑controlled.
- `WEB_ORIGIN`, the exact site origin(s). It is used for CORS **and** to validate the Sign‑In with Ethereum domain.
- `CHAIN_MODE=enabled`, `CHAIN_ID`, `RPC_URL`, `EXPLORER_URL`, and `DEPLOYMENT_FILE` (or `ENTRY_CONTRACT` / `VAULT_CONTRACT` / `START_BLOCK`).
- `SETTLER_PRIVATE_KEY` and, if the pricer is a different key, `PRICER_PRIVATE_KEY`, from a secret manager.
- `ADMIN_ADDRESSES`, the wallets allowed into `/admin`.

Pricing (see [Economy](ECONOMY.md#pricing-in-dollars-paid-in-wif)):

| Variable | Default | Meaning |
|---|---|---|
| `ENTRY_PRICE_USD` / `EXTRA_LIFE_PRICE_USD` | `0.1` / `5` | the dollar prices |
| `PRICE_FEED` | `off` | `dexscreener`, `coingecko` (needs `COINGECKO_ID`), `fixed` (needs `WIF_USD`) or `off` |
| `DEXSCREENER_CHAIN` | any | DexScreener's id for Robinhood Chain (as in `dexscreener.com/<chain>/…`), so only pools on this chain count |
| `PRICE_MIN_LIQUIDITY_USD` | `25000` | thinner pools are ignored |
| `COINGECKO_ID` | — | optional cross‑check on DexScreener |
| `PRICE_MAX_DISAGREEMENT_BPS` | `1500` | two sources further apart and nothing changes |
| `PRICE_DEVIATION_BPS` | `500` | re‑price only when a fee is this far off |
| `PRICE_UPDATE_INTERVAL_MS` | `600000` | how often the market is read |

Before switching the feed on, check on dexscreener.com that the WIF token above has a real pool on Robinhood Chain; until it has, use `PRICE_FEED=fixed` with a `WIF_USD` you maintain, or `off`. `POST /api/admin/pricing/run` re‑prices at once, and the admin console shows the last price and any error.

The API is stateless apart from Postgres. Run **one instance with background jobs** (indexer, pricing, week transitions, abandoned‑run sweep, optional `AUTO_SETTLE`). Additional API replicas are safe, because the jobs are idempotent. Put it behind HTTPS. Server‑sent events (`/api/events`) need proxy buffering disabled.

Health check: `GET /api/health`.

### On Railway

The live API runs on Railway (project `flat-earth-society-api`): a `Postgres` service and an `api` service built from this repository.

- **Build command:** `npm run build -w @fes/server` (Railpack installs the workspace from the repository root).
- **Start command:** `node apps/server/dist/index.js`. **Health check:** `/api/health`.
- **Variables:** `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `SESSION_SECRET` (random, 64 hex characters), `NODE_ENV=production`, `NPM_CONFIG_INCLUDE=dev` (the build needs dev dependencies), `TRUST_PROXY=1`, `WEB_ORIGIN` (every origin the site is served from, comma‑separated). Until the contracts are deployed: `CHAIN_ID=46630` and `CHAIN_MODE=disabled`. With the chain disabled, sign‑in, names, practice recording and the leaderboards work, and ranked play shows as not open.
- **Going live on mainnet**, add or change: `CHAIN_MODE=enabled`, `CHAIN_ID=4663`, `RPC_URL`, `EXPLORER_URL`, `ENTRY_CONTRACT`, `VAULT_CONTRACT`, `START_BLOCK` (the `entry`, `prizeVault` and `deployBlock` of `deployments/4663.json`), `SETTLER_PRIVATE_KEY` (and `PRICER_PRIVATE_KEY` if separate), `ADMIN_ADDRESSES`, `CONFIRMATIONS=2`, `AUTO_SETTLE=true` if wanted, and the pricing variables above. Then redeploy (`railway up --service api`).
- The website's `NEXT_PUBLIC_API_URL` points at the service's public Railway domain.
- A new site domain must be added to `WEB_ORIGIN`, or sign‑in will be refused for it.

## 4. Build and host the website

```bash
cd apps/web && cp .env.example .env.local    # NEXT_PUBLIC_API_URL, NEXT_PUBLIC_CHAIN_ID, NEXT_PUBLIC_RPC_URL, NEXT_PUBLIC_EXPLORER_URL
npm run build -w @fes/web && npm run start -w @fes/web
```

Every page is statically prerendered, and all data is fetched from the API in the browser. Any Next.js host works. The site lives at **https://www.flatearthsociety.xyz** (the bare domain redirects there; `wif-web.vercel.app` still serves it), the address printed on every record card and shared score (`NEXT_PUBLIC_SITE_URL` overrides it). Every address the site is served from must be in the API's `WEB_ORIGIN` (now `https://flatearthsociety.xyz,https://www.flatearthsociety.xyz,https://wif-web.vercel.app`), or sign‑in fails there. On Vercel (project `wif-web`), going live on mainnet means `NEXT_PUBLIC_CHAIN_ID=4663` plus `NEXT_PUBLIC_RPC_URL` and `NEXT_PUBLIC_EXPLORER_URL`, then a redeploy (they are baked in at build time).

## 5. Weekly operations

- The competition rolls over automatically on Monday 00:00 UTC.
- After the grace period the week is **closed** and its rankings locked.
- Review any flagged runs in `/admin`. Settlement will not finalize while a flagged run could change the top three.
- **Finalize → Pay prizes** from `/admin`, or set `AUTO_SETTLE=true` to run these automatically once a week is closed and unblocked.
- Every action and its transaction hash is recorded in the audit log and published on `/leaderboard` (this week's figures, the rules and the past winners).
- Keep an eye on the price service in `/admin`: an error (sources disagree, no liquid pool) or a fee held at its bound needs a person.

## 6. Launch checklist (live value)

- [ ] Network parameters and the $WIF address verified against official sources (section 1)
- [ ] Independent audit of `contracts/src`; no unaudited contract holds meaningful value
- [ ] Admin roles held by a multisig; settler and pricer keys in a secret manager, with minimal ETH
- [ ] Starting fees match $0.10 and $5 at today's price; the pricer's bounds chosen deliberately
- [ ] Price feed checked against a real, liquid $WIF pool on Robinhood Chain (or a maintained fixed price)
- [ ] Jurisdiction‑specific legal review of the paid‑entry prize competition (including the paid bonus life); eligibility restrictions (geo / age / KYC) implemented if required
- [ ] Terms and rules page reviewed (the rules on `/leaderboard`, and the settlement rules served at `/api/treasury`)
- [ ] Monitoring on `/api/health`, indexer lag and the price service (admin console), and the settler / pricer balances
- [ ] Postgres backups
