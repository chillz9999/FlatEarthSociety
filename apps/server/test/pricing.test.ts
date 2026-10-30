import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampFee, feeFor, PricingService, type Fetcher, type PricingOptions } from '../src/services/pricing';
import { setup, type Harness } from './helpers';

const E18 = 10n ** 18n;
const WIF = '0x0000000000000000000000000000000000000a01';

describe('fee arithmetic', () => {
  it('turns dollars into raw WIF at three significant figures, always even', () => {
    expect(feeFor(0.1, 0.5, 18)).toBe(2n * 10n ** 17n);
    expect(feeFor(5, 0.5, 18)).toBe(10n * E18);
    // $0.10 at $3 a token is 0.0333… WIF: 0.0333 at six decimals.
    expect(feeFor(0.1, 3, 6)).toBe(33_300n);
    // $5 at $0.0000123 a token: 406 504 WIF, read as 407 000.
    expect(feeFor(5, 0.0000123, 18)).toBe(407_000n * E18);
  });

  it('never moves a fee outside the bounds or by more than 2x', () => {
    expect(clampFee(100n, 10n, 2n, 1000n)).toBe(20n);
    expect(clampFee(1n, 10n, 2n, 1000n)).toBe(6n);
    expect(clampFee(500n, 300n, 2n, 400n)).toBe(400n);
    expect(clampFee(13n, 10n, 2n, 1000n)).toBe(14n);
  });
});

describe('the price feed', () => {
  let h: Harness;
  let market: { dex: unknown; gecko: unknown; calls: string[] };
  const fetcher: Fetcher = async (url) => {
    market.calls.push(url);
    const body = url.includes('dexscreener') ? market.dex : market.gecko;
    return { ok: body !== undefined, status: body === undefined ? 503 : 200, json: async () => body };
  };
  const service = (over: Partial<PricingOptions> = {}) =>
    new PricingService(
      h.services.db,
      h.chain,
      { entryUsd: 0.1, extraLifeUsd: 5, feed: 'dexscreener', minLiquidityUsd: 25_000, maxDisagreementBps: 1500, deviationBps: 500, ...over },
      fetcher,
    );
  const pairs = (...p: { price: string; liquidity: number; base?: string; chainId?: string }[]) => ({
    pairs: p.map((x) => ({ chainId: x.chainId ?? 'robinhood', baseToken: { address: x.base ?? WIF }, priceUsd: x.price, liquidity: { usd: x.liquidity } })),
  });

  beforeEach(async () => {
    h = await setup();
    market = { dex: undefined, gecko: undefined, calls: [] };
    // Fees as deployed: 10 WIF a voyage, 500 WIF a bonus life (WIF at $0.01).
  });
  afterEach(async () => {
    await h.close();
  });

  it('re-prices both fees from the deepest pool of the token itself', async () => {
    // WIF at $0.008: $0.10 is 12.5 WIF, $5 is 625 WIF. A thin pool and a pair quoting another token are ignored.
    market.dex = pairs({ price: '0.008', liquidity: 400_000 }, { price: '0.5', liquidity: 900 }, { price: '9', liquidity: 1_000_000, base: '0x00000000000000000000000000000000000000ff' });
    const out = await service().run();
    expect(out.updated).toBe(true);
    expect(h.chain.fee).toBe(125n * 10n ** 17n);
    expect(h.chain.lifeFee).toBe(625n * E18);
    const rows = (await h.services.db.query<{ wif_usd: string; source: string }>('select wif_usd, source from price_updates')).rows;
    expect(rows).toEqual([{ wif_usd: '0.008', source: 'dexscreener' }]);

    // A small move stays within tolerance: nothing is sent.
    market.dex = pairs({ price: '0.0081', liquidity: 400_000 });
    expect(await service().run()).toMatchObject({ updated: false, reason: 'within_tolerance' });
    expect(h.chain.priceUpdates).toHaveLength(1);
  });

  it('also reads a pool that lists WIF second (its price is the other token\'s price in WIF)', async () => {
    // WETH at $3,000 and 375,000 WIF to the WETH: WIF is $0.008, so $0.10 is 12.5 WIF and $5 is 625 WIF.
    const WETH = '0x00000000000000000000000000000000000000ee';
    market.dex = {
      pairs: [{ chainId: 'robinhood', baseToken: { address: WETH }, quoteToken: { address: WIF }, priceUsd: '3000', priceNative: '375000', liquidity: { usd: 400_000 } }],
    };
    const out = await service().run();
    expect(out.updated).toBe(true);
    expect(h.chain.fee).toBe(125n * 10n ** 17n);
    expect(h.chain.lifeFee).toBe(625n * E18);
  });

  it('moves at most 2x per update, and never past the bounds set on the contract', async () => {
    // WIF crashes 100x: the fees should be 100x more WIF, but each update may only double them.
    market.dex = pairs({ price: '0.0001', liquidity: 400_000 });
    const s = service();
    await s.run();
    expect(h.chain.fee).toBe(20n * E18);
    expect(h.chain.lifeFee).toBe(1000n * E18);
    await s.run();
    await s.run();
    await s.run();
    // The bounds stop them: 100 WIF a voyage, 5 000 WIF a bonus life.
    expect(h.chain.fee).toBe(100n * E18);
    expect(h.chain.lifeFee).toBe(5000n * E18);
    expect(await s.run()).toMatchObject({ updated: false, reason: 'at_bounds' });
    expect(s.lastError).toMatch(/bounds/);
  });

  it('leaves the fees alone when two sources disagree', async () => {
    market.dex = pairs({ price: '0.008', liquidity: 400_000 });
    market.gecko = { dogwifcoin: { usd: 0.02 } };
    const s = service({ coingeckoId: 'dogwifcoin' });
    const out = await s.run();
    expect(out.updated).toBe(false);
    expect(s.lastError).toMatch(/disagree/);
    expect(h.chain.priceUpdates).toHaveLength(0);

    market.gecko = { dogwifcoin: { usd: 0.0082 } };
    expect((await s.run()).updated).toBe(true);
    expect(s.info().source).toBe('dexscreener+coingecko');
  });

  it('does nothing without a usable price', async () => {
    market.dex = pairs({ price: '0.008', liquidity: 1_000 });
    const s = service();
    expect((await s.run()).updated).toBe(false);
    expect(s.lastError).toMatch(/liquidity/);
    expect(await service({ feed: 'off' }).run()).toMatchObject({ updated: false, reason: 'feed_off' });
    expect(market.calls.filter((u) => u.includes('dexscreener'))).toHaveLength(1);
    expect(h.chain.priceUpdates).toHaveLength(0);
  });

  it('shows the price without re-pricing when no pricer key is configured', async () => {
    h.chain.pricerAddress = null;
    const s = service({ feed: 'fixed', fixedWifUsd: 0.008 });
    expect(await s.run()).toMatchObject({ updated: false, reason: 'no_pricer' });
    expect(s.info()).toMatchObject({ wifUsd: 0.008, entryUsd: 0.1, extraLifeUsd: 5, source: 'fixed' });
  });

  it('publishes the prices in the public config', async () => {
    h.chain.inKind = true;
    const cfg = (await h.app.inject({ method: 'GET', url: '/api/config' })).json();
    expect(cfg.extraLifeFee).toBe((500n * E18).toString());
    expect(cfg.prizeInWif).toBe(true);
    expect(cfg.protocolShareBurned).toBe(true);
    const rules: string[] = (await h.app.inject({ method: 'GET', url: '/api/treasury' })).json().disclosure.settlementRules;
    expect(rules[0]).toMatch(/50% burned/);
    expect(cfg.pricing).toMatchObject({ entryUsd: 0.1, extraLifeUsd: 5 });
  });
});
