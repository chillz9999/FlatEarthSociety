import { ROBINHOOD_MAINNET_ID, type PublicConfig } from '@fes/shared';
import { formatUnits } from 'viem';
import { CHAIN } from './env';
import { formatToken } from './format';

/**
 * Uniswap's swap page, ETH → $WIF on Robinhood Chain. With `need`, it asks for that much $WIF, rounded up to two
 * significant figures. Only on mainnet: elsewhere there is no market to buy from. (Parameters as Uniswap's own links
 * write them: `chain=robinhood`, `NATIVE` for ETH, `field=output` to fix the amount received.)
 */
export function swapUrl(token: string | null | undefined, opts: { need?: bigint | null; decimals?: number } = {}): string | null {
  if (!token || CHAIN.id !== ROBINHOOD_MAINNET_ID) return null;
  const q = new URLSearchParams({ chain: 'robinhood', inputCurrency: 'NATIVE', outputCurrency: token });
  if (opts.need && opts.need > 0n) {
    const n = Number(opts.need) / 10 ** (opts.decimals ?? 18);
    const step = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
    q.set('value', String(Math.ceil(n / step) * step));
    q.set('field', 'output');
  }
  return `https://app.uniswap.org/swap?${q}`;
}

/**
 * Open a swap in a small window of its own over the game. Uniswap refuses to be shown inside another site, and in its
 * own window it reaches the explorer's wallet as usual. The game's balance refreshes when the explorer comes back.
 */
export function openSwap(url: string): void {
  const w = 480;
  const h = Math.min(780, window.screen.availHeight - 40);
  const left = Math.round(window.screenX + Math.max(0, (window.outerWidth - w) / 2));
  const top = Math.round(window.screenY + Math.max(0, (window.outerHeight - h) / 2));
  const win = window.open(url, 'fes-buy-wif', `popup,width=${w},height=${h},left=${left},top=${top}`);
  if (win) win.opener = null;
  // A blocked pop-up: a plain new tab instead.
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** The token prizes are paid in: $WIF itself, or a second prize token when one is configured. */
export function prizeToken(cfg: PublicConfig | null | undefined): {
  symbol: string;
  decimals: number;
} {
  if (!cfg?.fes || cfg.prizeInWif) return { symbol: '$WIF', decimals: cfg?.wif?.decimals ?? 18 };
  return { symbol: `$${cfg.fes.symbol}`, decimals: cfg.fes.decimals };
}

/** "$5", "$0.10", and below a cent two significant figures ("$0.0083"). */
export function formatUsd(n: number): string {
  if (Number.isInteger(n)) return `$${n}`;
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${Number(n.toPrecision(2))}`;
}

/** A small amount keeps three significant figures (0.0333), a large one two decimals at most (12.5, 1,250). */
export function formatFee(raw: string | bigint | null | undefined, decimals = 18): string {
  if (raw === null || raw === undefined || raw === '') return '—';
  const v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const [int, frac = ''] = formatUnits(v, decimals).split('.');
  if (int !== '0') return formatToken(v, decimals, 2);
  const lead = frac.search(/[1-9]/);
  return formatToken(v, decimals, lead < 0 ? 2 : lead + 3);
}

export interface Price {
  /** What it costs in dollars, e.g. "$0.10". */
  usd: string;
  /** What it costs today in $WIF, e.g. "12.5 $WIF" (null until the chain is read). */
  wif: string | null;
  raw: bigint | null;
}

/** A fee as people read it: its dollar price, and the exact $WIF the contract charges for it today. */
export function priceOf(cfg: PublicConfig | null | undefined, kind: 'entry' | 'life'): Price {
  const raw = kind === 'entry' ? cfg?.entryFee : cfg?.extraLifeFee;
  // An API from before the price service sends no `pricing`: fall back to the published prices.
  const usd = kind === 'entry' ? (cfg?.pricing?.entryUsd ?? 0.1) : (cfg?.pricing?.extraLifeUsd ?? 5);
  return {
    usd: formatUsd(usd),
    wif: raw ? `${formatFee(raw, cfg?.wif?.decimals ?? 18)} $WIF` : null,
    raw: raw ? BigInt(raw) : null,
  };
}
