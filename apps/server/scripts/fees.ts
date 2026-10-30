/**
 * The raw fees to deploy with, for a WIF price:
 *
 *   npm run fees -w @fes/server -- <wif price in dollars> [token decimals, default 18]
 *
 * Prints ENTRY_FEE and EXTRA_LIFE_FEE for $0.10 and $5 (or ENTRY_PRICE_USD / EXTRA_LIFE_PRICE_USD), and the
 * default bounds the deploy script would give the pricer (a tenth to ten times each fee).
 */
import { feeFor } from '../src/services/pricing';

const [price, decimalsArg = '18'] = process.argv.slice(2);
const wifUsd = Number(price);
const decimals = Number(decimalsArg);
if (!(wifUsd > 0) || !Number.isInteger(decimals) || decimals < 0) {
  console.error('usage: npm run fees -w @fes/server -- <wif price in dollars> [token decimals]');
  process.exit(1);
}
const entryUsd = Number(process.env.ENTRY_PRICE_USD ?? 0.1);
const lifeUsd = Number(process.env.EXTRA_LIFE_PRICE_USD ?? 5);
const entry = feeFor(entryUsd, wifUsd, decimals);
const life = feeFor(lifeUsd, wifUsd, decimals);
const even = (x: bigint) => (x % 2n === 0n ? x : x + 1n);
console.log(`# $${entryUsd} a voyage and $${lifeUsd} a bonus life at $${wifUsd} a WIF (${decimals} decimals)`);
console.log(`export ENTRY_FEE=${entry}`);
console.log(`export EXTRA_LIFE_FEE=${life}`);
console.log(`# pricer bounds (the deploy script's defaults): ${even(entry / 10n)}..${entry * 10n} and ${even(life / 10n)}..${life * 10n}`);
