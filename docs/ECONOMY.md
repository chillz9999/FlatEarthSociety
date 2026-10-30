# Economy, pricing & settlement

Practice is free. A **ranked voyage costs $0.10**, and a voyage whose ship is lost may buy **one bonus life for $5**. Both are paid in **$WIF** on Robinhood Chain. Exactly **50 %** of everything paid is the week's prize, paid **in $WIF** to the top three (**50 / 30 / 20**). The other 50 % is **burned**: sent to the dead address `0x000000000000000000000000000000000000dEaD`, where no one can ever move it. The contracts enforce all of this.

## Flow of funds

```
Player ──$0.10 in WIF──▶ SocietyEntry.enter(attemptRef, maxFee)
                           ├── 50 % ──▶ SocietyPrizeVault   (credited to the week the payment was mined)
                           └── 50 % ──▶ burned (0x…dEaD)
Ship lost:
Player ──$5 in WIF──▶ SocietyEntry.buyExtraLife(entryId, maxFee)       (once per entry, by its player)
                           ├── 50 % ──▶ SocietyPrizeVault
                           └── 50 % ──▶ burned (0x…dEaD)
After the week closes:
SocietyPrizeVault.finalizeWeek(top 3) → 50 % / 30 % / 20 % of the week's WIF pool
SocietyPrizeVault.claimFor(rank) / claim(rank) ── $WIF ──▶ winner
```

| Rule | Where it is enforced |
|---|---|
| Fees paid in $WIF only, at the current `entryFee` / `extraLifeFee` | `SocietyEntry._collect` (balance‑delta checked, so fee‑on‑transfer tokens are rejected) |
| Never more than the price shown | Every purchase carries `maxFee`; a fee re‑priced above it reverts with `FeeAboveMax` |
| Exactly 50 % to the prize, 50 % burned | `rewardShare = fee / 2`, `protocolShare = fee − rewardShare`; fees must be even and non‑zero. The protocol share goes to `BURN_ADDRESS` (`0x…dEaD`) |
| Burning is permanent | Once `protocolTreasury` is the burn address, `setProtocolTreasury` reverts (`BurnIsPermanent`), for the admin too |
| One payment ⇒ one attempt | `entryId = keccak256(player, attemptRef)` can be used once onchain. Offchain, `attempts.payment_entry_id` is unique |
| One bonus life per entry, only for its player | `extraLifeBought[entryId]`; `buyExtraLife` reverts for anyone but the entry's player |
| Allocation belongs to the week of payment | `weekId = (block.timestamp − 345600) / 604800`. The vault only accepts allocations for the current week |
| The prize is the $WIF itself | The vault is deployed *in kind* (`wif == fes`): each allocation joins the week's pool as it is. Nothing is converted |
| 50 / 30 / 20 with no dust lost | `first = pool·5000/10000`, `second = pool·3000/10000`, `third = pool − first − second` |
| Fewer than three winners | The unassigned shares roll into next week's pool (`PoolRolledOver` event) |
| No replayed settlement, no double payout | `finalizeWeek` runs once per week; each rank has a claimed bit |
| Admins cannot take prize funds | `rescueToken` reverts for the prize token; there is no withdraw path for allocations or pools |

## Pricing in dollars, paid in $WIF

The prices are set in dollars (`ENTRY_PRICE_USD`, default 0.10; `EXTRA_LIFE_PRICE_USD`, default 5) and charged in $WIF. The API's price service keeps the onchain fees at those prices as $WIF moves:

1. **Market price.** Every `PRICE_UPDATE_INTERVAL_MS` (10 minutes) it reads the price of the $WIF token itself from DexScreener, using the deepest pool that has at least `PRICE_MIN_LIQUIDITY_USD` ($25,000) of liquidity, optionally only on `DEXSCREENER_CHAIN`. If `COINGECKO_ID` is set, CoinGecko's price is a cross‑check. If the two disagree by more than `PRICE_MAX_DISAGREEMENT_BPS` (15 %), nothing changes. `PRICE_FEED=fixed` with `WIF_USD` sets the price by hand.
2. **Fees.** $0.10 and $5 at that price, rounded to three significant figures and made even.
3. **Re‑pricing.** Only when a fee has drifted more than `PRICE_DEVIATION_BPS` (5 %) from its target does the pricer key call `SocietyEntry.updatePrices(entryFee, extraLifeFee)`.
   - The contract accepts a new fee only within the **bounds the admin set** (`setFeeBounds`), and at most **double or half** the current fee per update. The service clamps to the same rules, so its transaction never reverts.
   - A crash of the market (or a bad reading) therefore moves the fees one step per interval, never past the bounds.
   - Each update is recorded in `price_updates` and the audit log.

The website shows the dollar price and the exact $WIF it costs today ("$0.10 · 12.5 $WIF"). The wallet is asked to approve exactly that amount, and the purchase carries it as `maxFee`. With `PRICE_FEED=off` the fees change only when the admin sets them.

## The bonus life

When a ranked voyage's ship is lost (by a hazard or over the Edge, not when the 30‑minute examination ends), the site offers the bonus life for 20 seconds. Paying puts the ship back on the water where it sank, at rest, at least 80 units inside the Edge. It is shielded from hazards for 2.5 seconds, and for as long after that as its hull still touches one (at most 6 seconds); the Edge is never shielded. The voyage carries on from the same tick and keeps its score. See [Fair play](FAIR_PLAY.md#the-bonus-life) for how the server checks it.

## Weekly settlement

Weeks run **Monday 00:00:00 UTC to Sunday 23:59:59 UTC**. The same arithmetic runs onchain (`SocietyWeeks.sol`) and offchain (`packages/shared/src/weeks.ts`).

| Status | Meaning |
|---|---|
| `open` | Attempts can be started; scores enter the Registry as they are verified. |
| `closing` | The week has ended. No new attempts start in it; runs already in progress may still be submitted during a grace period (`CLOSE_GRACE_MINUTES`, default 40, longer than the 30‑minute maximum run). |
| `closed` | Rankings are locked. Runs never submitted are scored at their last checkpoint. |
| `finalized` | Top three recorded onchain with `resultsHash` (a hash of the top‑100 table). |
| `settled` | Every prize has been paid. |

Settlement is triggered from the admin console (Close → Finalize → Pay prizes), or automatically with `AUTO_SETTLE=true`. **It refuses to finalize while any flagged run could change the top three.** Those runs must be reviewed first. Winners may also call `claim` on the vault themselves at any time after finalization. Gas for settlement and payouts is paid by the Society's settlement account and is **never deducted from prizes**.

### Ties and eligibility

Each wallet's **single best verified score** counts. Ties are won by the score **verified first**, then by wallet address as a deterministic fallback. Paid entries are credits: an attempt counts toward the week in which it is **started**. A credit unused at the end of a week rolls forward, while its $WIF stays in the week it was paid. This keeps the onchain accounting final the moment a week ends.

### Optional top‑ups

`fundWeek(weekId, amount)` lets anyone add the prize token to an unfinalized week, for example a Society sponsorship of week one. Top‑ups are additive, evented (`WeekFunded`) and visible in the week's figures. They never reduce the 50 % allocation.

## Disclosures (on `/leaderboard`, and in full at `/api/treasury`)

- On the page: the prices, the prize pool, this week's $WIF paid, sent to the prize and burned, the rules, the contract addresses and the past winners.
- From the API: the $WIF price and where it comes from (`/api/config`); every week's figures, settlement transactions and the full settlement rules (`/api/treasury`).

## Roles (who can do what)

| Role | Holder | Powers | Cannot |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Society multisig | set either fee (even, > 0), set the pricer's bounds, grant roles, rescue *unrelated* tokens | withdraw $WIF allocations or prize pools; change a finalized result; stop the burn |
| `PRICER_ROLE` | Backend price key | `updatePrices`, within the bounds, at most 2x up or down per update | charge more than a buyer's `maxFee`; leave the bounds |
| `SETTLER_ROLE` | Backend settlement key | `finalizeWeek` (once, after the week ends) | pay anyone except the recorded winners; finalize twice |
| `PAUSER_ROLE` | Society multisig | pause new entries and bonus lives / claims in an emergency | move funds |

## A second prize token (optional)

The vault can also pay prizes in a token other than $WIF ($FES). Deploy with `FES_TOKEN` set and each week's $WIF allocation must be converted before the week can be finalized: `convertWeek` through an approved converter, with a **minimum output** and a **deadline**, both legs measured by balance difference (`WeekConverted`).

- **`FixedRateConverter`** (a Society treasury desk) buys the $WIF at a published rate from its own inventory. Rate changes are timelocked by 24 hours (`RateProposed` → `RateActivated`).
- **`UniswapV3Converter`** swaps through a Uniswap V3 pool, bounded by the vault's `minFesOut` (derived from `CONVERSION_SLIPPAGE_BPS`, default 1 %).

The live deployment does not use this: prizes are paid in $WIF.

See [`contracts/README.md`](../contracts/README.md) for the full event list and security notes.
