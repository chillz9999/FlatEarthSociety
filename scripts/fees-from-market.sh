#!/usr/bin/env bash
# The starting fees for a deployment, from the market. Fetches the token's pools from DexScreener and prints the
# $WIF price, each pool's liquidity, and the ENTRY_FEE / EXTRA_LIFE_FEE lines to paste before `forge script`.
# Rounding matches the API's price service: three significant figures, made even. After the deployment the API
# keeps the fees at $0.10 and $5 on its own; these are only where they start.
#
#   ./scripts/fees-from-market.sh                  # $WIF on Robinhood Chain
#   ./scripts/fees-from-market.sh <token> <chain>  # DexScreener's chain id, as in dexscreener.com/<chain>/…
set -euo pipefail
TOKEN="${1:-0x5173b8ea6923c2d40267890d45c46a3480954773}"
CHAIN="${2:-robinhood}"
DECIMALS="${DECIMALS:-18}"

curl -fsS "https://api.dexscreener.com/latest/dex/tokens/$TOKEN" | python3 -c '
import json, math, sys
token, chain, decimals = sys.argv[1].lower(), sys.argv[2], int(sys.argv[3])
pools = []
for p in json.load(sys.stdin).get("pairs") or []:
    if p.get("chainId") != chain:
        continue
    usd, native = float(p.get("priceUsd") or 0), float(p.get("priceNative") or 0)
    base, quote = p["baseToken"], p["quoteToken"]
    # DexScreener prices the base token; when ours is the quote token, its price is the base price over the base price in ours.
    if base["address"].lower() == token and usd > 0:
        price, other = usd, quote["symbol"]
    elif quote["address"].lower() == token and usd > 0 and native > 0:
        price, other = usd / native, base["symbol"]
    else:
        continue
    pools.append(((p.get("liquidity") or {}).get("usd") or 0, price, other, p.get("dexId", "?")))
if not pools:
    sys.exit(f"DexScreener lists no pool for {token} on {chain}.")
pools.sort(reverse=True)
for liquidity, price, other, dex in pools:
    print(f"pool with {other} on {dex}: liquidity ${liquidity:,.0f}, price ${price:.6g}")
liquidity, price = pools[0][0], pools[0][1]

def fee(usd):
    tokens = usd / price
    k = math.floor(math.log10(tokens)) - 2
    units = round(tokens / 10 ** k)
    raw = units * 10 ** (decimals + k) if decimals + k >= 0 else units // 10 ** -(decimals + k)
    raw = max(raw, 2)
    return raw if raw % 2 == 0 else raw + 1

entry, life = fee(0.10), fee(5)
print()
print(f"Deepest pool: ${liquidity:,.0f}. Price used: ${price:.6g}.")
print(f"$0.10 = {entry / 10**decimals:g} tokens, $5 = {life / 10**decimals:g} tokens.")
if liquidity < 25000:
    print("Note: under $25,000 of liquidity. The API ignores such pools; run it with PRICE_FEED=fixed and WIF_USD instead.")
print()
print(f"export ENTRY_FEE={entry} EXTRA_LIFE_FEE={life}")
' "$TOKEN" "$CHAIN" "$DECIMALS"
