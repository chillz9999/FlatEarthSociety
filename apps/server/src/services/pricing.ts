import type { PricingInfo } from '@fes/shared';
import type { ChainGateway, FeeBounds } from '../chain/gateway';
import type { Db } from '../db';

/** The subset of `fetch` the price feed needs (tests pass a fake). */
export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PricingOptions {
  entryUsd: number;
  extraLifeUsd: number;
  feed: 'dexscreener' | 'coingecko' | 'fixed' | 'off';
  dexscreenerChain?: string;
  minLiquidityUsd: number;
  coingeckoId?: string;
  maxDisagreementBps: number;
  fixedWifUsd?: number;
  /** Re-price onchain only when a fee is off its dollar price by more than this (basis points). */
  deviationBps: number;
}

export interface PriceQuote {
  wifUsd: number;
  source: string;
  at: Date;
}

export type PricingOutcome =
  | { updated: true; txHash: string; entryFee: bigint; extraLifeFee: bigint; quote: PriceQuote }
  | { updated: false; reason: string; quote?: PriceQuote };

const TIMEOUT_MS = 8000;

/**
 * Raw token units worth `usd` when one token costs `wifUsd` dollars: rounded to three significant figures
 * (a price people can read) and made even (the contract splits every fee exactly in half).
 */
export function feeFor(usd: number, wifUsd: number, decimals: number): bigint {
  const tokens = usd / wifUsd;
  if (!Number.isFinite(tokens) || tokens <= 0) throw new Error('bad price');
  const step = 10 ** (Math.floor(Math.log10(tokens)) - 2);
  // Work in whole multiples of `step` = 10^k, so the conversion to raw units is exact integer arithmetic.
  const k = Math.round(Math.log10(step));
  const units = BigInt(Math.round(tokens / step));
  const exp = decimals + k;
  let raw = exp >= 0 ? units * 10n ** BigInt(exp) : units / 10n ** BigInt(-exp);
  if (raw < 2n) raw = 2n;
  return raw % 2n === 0n ? raw : raw + 1n;
}

/** Move `current` towards `target` as far as the contract allows: within the bounds and within half / double. */
export function clampFee(target: bigint, current: bigint, min: bigint, max: bigint): bigint {
  const allowed = (x: bigint) => x > 0n && x % 2n === 0n && x >= min && x <= max && x <= current * 2n && x * 2n >= current;
  let fee = target;
  if (fee > current * 2n) fee = current * 2n;
  if (fee * 2n < current) fee = (current + 1n) / 2n;
  if (fee < min) fee = min;
  if (fee > max) fee = max;
  for (const x of [fee, fee + 1n, fee - 1n]) if (allowed(x)) return x;
  return current;
}

function driftBps(target: bigint, current: bigint): bigint {
  if (current === 0n) return 10_000n;
  const diff = target > current ? target - current : current - target;
  return (diff * 10_000n) / current;
}

/**
 * Keeps both fees at their dollar prices as $WIF moves. The price comes from the market: DexScreener pairs of
 * the WIF token itself (thin pools ignored), optionally cross-checked against CoinGecko — two sources that
 * disagree leave the fees alone. The fees are re-priced onchain only when they drift by more than
 * `deviationBps`, and never outside the admin's bounds or by more than 2x at once: the contract enforces both,
 * and this service clamps so its transaction never reverts.
 */
export class PricingService {
  private last: PriceQuote | null = null;
  lastError: string | null = null;
  lastUpdateAt: Date | null = null;

  constructor(
    private readonly db: Db,
    private readonly chain: ChainGateway,
    private readonly opts: PricingOptions,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {}

  info(): PricingInfo {
    return {
      entryUsd: this.opts.entryUsd,
      extraLifeUsd: this.opts.extraLifeUsd,
      wifUsd: this.last?.wifUsd ?? null,
      source: this.last?.source ?? null,
      updatedAt: this.last?.at.toISOString() ?? null,
    };
  }

  private async getJson(url: string): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetcher(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** The WIF price from the deepest DexScreener pair holding the token, whichever side of the pair it is on. */
  private async dexscreener(token: string): Promise<number> {
    const body = (await this.getJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`)) as {
      pairs?:
        | {
            chainId?: string;
            baseToken?: { address?: string };
            quoteToken?: { address?: string };
            priceUsd?: string;
            priceNative?: string;
            liquidity?: { usd?: number };
          }[]
        | null;
    };
    const wif = token.toLowerCase();
    // DexScreener prices a pair's base token. When WIF is the quote token, its dollar price is the base's dollar
    // price divided by the base's price in WIF.
    const priced = (body.pairs ?? []).flatMap((p) => {
      const liquidity = p.liquidity?.usd ?? 0;
      if ((this.opts.dexscreenerChain && p.chainId !== this.opts.dexscreenerChain) || liquidity < this.opts.minLiquidityUsd) return [];
      const usd = Number(p.priceUsd);
      const native = Number(p.priceNative);
      if (p.baseToken?.address?.toLowerCase() === wif && usd > 0) return [{ price: usd, liquidity }];
      if (p.quoteToken?.address?.toLowerCase() === wif && usd > 0 && native > 0) return [{ price: usd / native, liquidity }];
      return [];
    });
    if (priced.length === 0) throw new Error('DexScreener lists no pair for the token with enough liquidity');
    priced.sort((a, b) => b.liquidity - a.liquidity);
    return priced[0].price;
  }

  private async coingecko(id: string): Promise<number> {
    const body = (await this.getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`)) as Record<string, { usd?: number }>;
    const usd = body[id]?.usd;
    if (!usd || !(usd > 0)) throw new Error(`CoinGecko has no price for ${id}`);
    return usd;
  }

  /** The current market price of one WIF in dollars. */
  async price(): Promise<PriceQuote> {
    const o = this.opts;
    const at = new Date();
    if (o.feed === 'fixed') return { wifUsd: o.fixedWifUsd!, source: 'fixed', at };
    if (o.feed === 'coingecko') return { wifUsd: await this.coingecko(o.coingeckoId!), source: 'coingecko', at };
    if (o.feed !== 'dexscreener') throw new Error('No price feed configured');
    const tokens = await this.chain.tokens();
    if (!tokens) throw new Error('The WIF token address is not known (chain disabled)');
    const [dex, gecko] = await Promise.allSettled([this.dexscreener(tokens.wif.address), o.coingeckoId ? this.coingecko(o.coingeckoId) : Promise.reject(new Error('none'))]);
    if (dex.status === 'fulfilled' && gecko.status === 'fulfilled') {
      const spread = Math.abs(dex.value - gecko.value) / Math.min(dex.value, gecko.value);
      if (spread * 10_000 > o.maxDisagreementBps) {
        throw new Error(`Price sources disagree: DexScreener $${dex.value}, CoinGecko $${gecko.value}`);
      }
      return { wifUsd: dex.value, source: 'dexscreener+coingecko', at };
    }
    if (dex.status === 'fulfilled') return { wifUsd: dex.value, source: 'dexscreener', at };
    throw dex.reason instanceof Error ? dex.reason : new Error(String(dex.reason));
  }

  /** Read the market and, when the fees have drifted, re-price them onchain. Safe to call repeatedly. */
  async run(): Promise<PricingOutcome> {
    if (this.opts.feed === 'off') return { updated: false, reason: 'feed_off' };
    let quote: PriceQuote;
    try {
      quote = await this.price();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { updated: false, reason: this.lastError };
    }
    this.last = quote;
    this.lastError = null;
    if (!this.chain.enabled || !this.chain.pricerAddress) return { updated: false, reason: 'no_pricer', quote };

    const [tokens, entryFee, lifeFee, bounds] = await Promise.all([this.chain.tokens(), this.chain.entryFee(), this.chain.extraLifeFee(), this.chain.feeBounds()]);
    if (!tokens || entryFee === null || lifeFee === null || !bounds) return { updated: false, reason: 'chain_unavailable', quote };
    const decimals = tokens.wif.decimals;
    const targetEntry = feeFor(this.opts.entryUsd, quote.wifUsd, decimals);
    const targetLife = feeFor(this.opts.extraLifeUsd, quote.wifUsd, decimals);
    const threshold = BigInt(this.opts.deviationBps);
    if (driftBps(targetEntry, entryFee) <= threshold && driftBps(targetLife, lifeFee) <= threshold) {
      return { updated: false, reason: 'within_tolerance', quote };
    }
    const next = this.clamp(targetEntry, targetLife, entryFee, lifeFee, bounds);
    if (!next) {
      this.lastError = 'The fees are at the edge of the bounds set on the contract; an administrator must widen them.';
      return { updated: false, reason: 'at_bounds', quote };
    }
    const { txHash } = await this.chain.updatePrices(next.entry, next.life);
    await this.db.query('insert into price_updates (wif_usd, source, entry_fee, extra_life_fee, tx_hash) values ($1, $2, $3, $4, $5)', [
      String(quote.wifUsd),
      quote.source,
      next.entry.toString(),
      next.life.toString(),
      txHash.toLowerCase(),
    ]);
    await this.db.query('insert into audit_log (actor, action, detail) values ($1, $2, $3)', [
      this.chain.pricerAddress.toLowerCase(),
      'fees_repriced',
      JSON.stringify({ wifUsd: quote.wifUsd, source: quote.source, entryFee: next.entry.toString(), extraLifeFee: next.life.toString(), txHash }),
    ]);
    this.lastUpdateAt = new Date();
    return { updated: true, txHash, entryFee: next.entry, extraLifeFee: next.life, quote };
  }

  private clamp(targetEntry: bigint, targetLife: bigint, entryFee: bigint, lifeFee: bigint, b: FeeBounds): { entry: bigint; life: bigint } | null {
    if (b.maxEntryFee === 0n || b.maxExtraLifeFee === 0n) return null;
    const entry = clampFee(targetEntry, entryFee, b.minEntryFee, b.maxEntryFee);
    const life = clampFee(targetLife, lifeFee, b.minExtraLifeFee, b.maxExtraLifeFee);
    if (entry === entryFee && life === lifeFee) return null;
    return { entry, life };
  }
}
