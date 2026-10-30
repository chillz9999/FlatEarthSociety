import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
  .transform((s) => s as `0x${string}`);

const schema = z.object({
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  /** postgres://… for production; omit to use an embedded PGlite database at PGLITE_DIR (development). */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),
  /** Comma-separated origins allowed to call the API (the web app). */
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  /** Secret used to sign session tokens (≥ 32 characters). Required in production. */
  SESSION_SECRET: z.string().optional(),
  /** `true`, a hop count, or comma-separated proxy addresses/CIDRs whose X-Forwarded-For is trusted. Default: none. */
  TRUST_PROXY: z.string().default('false'),
  SESSION_TTL_HOURS: z.coerce.number().default(24),
  /** Wallets allowed to use the admin endpoints (comma-separated). */
  ADMIN_ADDRESSES: z.string().default(''),

  /** Chain integration. `disabled` runs practice/leaderboards only. */
  CHAIN_MODE: z.enum(['enabled', 'disabled']).default('enabled'),
  CHAIN_ID: z.coerce.number().int().default(46630),
  CHAIN_NAME: z.string().optional(),
  RPC_URL: z.string().optional(),
  EXPLORER_URL: z.string().optional(),
  /** Path to a contracts/deployments/<chainId>.json written by the Deploy script. */
  DEPLOYMENT_FILE: z.string().optional(),
  ENTRY_CONTRACT: hexAddress.optional(),
  VAULT_CONTRACT: hexAddress.optional(),
  CONVERTER_CONTRACT: hexAddress.optional(),
  /** Block to start indexing from (defaults to the deployment block). */
  START_BLOCK: z.coerce.bigint().optional(),
  CONFIRMATIONS: z.coerce.number().int().min(0).default(2),
  INDEXER_INTERVAL_MS: z.coerce.number().int().default(8000),
  /** Private key of the account holding SETTLER_ROLE on the prize vault (convert/finalize/claimFor). */
  SETTLER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  /** Private key of the account holding PRICER_ROLE on the entry contract (defaults to the settler key). */
  PRICER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  /** Dollar price of one ranked voyage, and of its one bonus life. The fees are set in WIF from these. */
  ENTRY_PRICE_USD: z.coerce.number().positive().default(0.1),
  EXTRA_LIFE_PRICE_USD: z.coerce.number().positive().default(5),
  /**
   * Where the price of WIF comes from: `dexscreener` (pairs of the WIF token on this chain), `coingecko`
   * (COINGECKO_ID), `fixed` (WIF_USD), or `off` (the fees are only ever changed by hand).
   */
  PRICE_FEED: z.enum(['dexscreener', 'coingecko', 'fixed', 'off']).default('off'),
  /** DexScreener's id for this chain (e.g. as it appears in dexscreener.com/<chain>/…). Unset: any chain. */
  DEXSCREENER_CHAIN: z.string().optional(),
  /** Pairs thinner than this are ignored (a thin pool is cheap to push around). */
  PRICE_MIN_LIQUIDITY_USD: z.coerce.number().min(0).default(25_000),
  /** Optional CoinGecko id, used as the feed or as a cross-check on DexScreener. */
  COINGECKO_ID: z.string().optional(),
  /** Two sources further apart than this (in basis points) and the fees are left alone. */
  PRICE_MAX_DISAGREEMENT_BPS: z.coerce.number().int().min(0).default(1500),
  /** Fixed WIF price in dollars for PRICE_FEED=fixed. */
  WIF_USD: z.coerce.number().positive().optional(),
  PRICE_UPDATE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(10 * 60_000),
  /** The fees are re-priced onchain only when they are off by more than this (basis points). */
  PRICE_DEVIATION_BPS: z.coerce.number().int().min(0).default(500),
  /** Run conversion → finalization → payouts automatically once a week is closed and unblocked. */
  AUTO_SETTLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Max slippage tolerated when converting WIF → FES, in basis points. */
  CONVERSION_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(2000).default(100),
  DEMO_TOKENS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** Minutes after a week's end during which in-flight runs may still be submitted. */
  CLOSE_GRACE_MINUTES: z.coerce.number().default(40),
  /** How many top places a run with review flags must reach before it is held for admin review. */
  REVIEW_TOP_N: z.coerce.number().int().default(10),
  /** Automatic restorations allowed per player per week (more need an admin). */
  AUTO_RESTORE_PER_WEEK: z.coerce.number().int().default(1),
  LOG_LEVEL: z.string().default('info'),
});

export type ServerConfig = Omit<z.infer<typeof schema>, 'SESSION_SECRET'> & {
  SESSION_SECRET: string;
  trustProxy: boolean | number | string[];
  adminAddresses: Set<string>;
  webOrigins: string[];
  deployment: Deployment | null;
};

export interface Deployment {
  chainId: number;
  deployBlock: number;
  entry: `0x${string}`;
  prizeVault: `0x${string}`;
  /** Null when the prizes are paid in WIF (nothing to convert). */
  fixedRateConverter: `0x${string}` | null;
  wifToken: `0x${string}`;
  fesToken: `0x${string}`;
  mockTokens?: boolean;
}

const ZERO = /^0x0{40}$/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const c = parsed.data;
  let deployment: Deployment | null = null;
  if (c.DEPLOYMENT_FILE) {
    const raw = JSON.parse(readFileSync(c.DEPLOYMENT_FILE, 'utf8')) as Record<string, unknown>;
    deployment = {
      chainId: Number(raw.chainId),
      deployBlock: Number(raw.deployBlock ?? 0),
      entry: raw.entry as `0x${string}`,
      prizeVault: raw.prizeVault as `0x${string}`,
      fixedRateConverter: typeof raw.fixedRateConverter === 'string' && !ZERO.test(raw.fixedRateConverter) ? (raw.fixedRateConverter as `0x${string}`) : null,
      wifToken: raw.wifToken as `0x${string}`,
      fesToken: raw.fesToken as `0x${string}`,
      mockTokens: Boolean(raw.mockTokens),
    };
    if (deployment.chainId !== c.CHAIN_ID) {
      throw new Error(`Deployment file is for chain ${deployment.chainId} but CHAIN_ID is ${c.CHAIN_ID}`);
    }
  }
  const placeholders = ['change-me-to-a-long-random-string', 'development-only-secret-change-me'];
  let secret = c.SESSION_SECRET?.trim() || '';
  if (secret && (secret.length < 32 || placeholders.includes(secret))) {
    throw new Error('SESSION_SECRET must be a random string of at least 32 characters (not the example value)');
  }
  if (c.PRICE_FEED === 'fixed' && !c.WIF_USD) throw new Error('PRICE_FEED=fixed needs WIF_USD');
  if (c.PRICE_FEED === 'coingecko' && !c.COINGECKO_ID) throw new Error('PRICE_FEED=coingecko needs COINGECKO_ID');
  if (!secret) {
    if ((env.NODE_ENV ?? process.env.NODE_ENV) === 'production') throw new Error('SESSION_SECRET must be set in production');
    // Development: a random per-process secret (sessions end when the server restarts). Never a public default.
    secret = randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET not set: using a random secret for this process. Set it to keep sessions across restarts.');
  }
  const tp = c.TRUST_PROXY.trim();
  const trustProxy = tp === 'true' ? true : tp === 'false' || tp === '' ? false : /^\d+$/.test(tp) ? Number(tp) : tp.split(',').map((x) => x.trim());
  return {
    ...c,
    SESSION_SECRET: secret,
    trustProxy,
    adminAddresses: new Set(
      c.ADMIN_ADDRESSES.split(',')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
    ),
    webOrigins: c.WEB_ORIGIN.split(',').map((o) => o.trim()),
    deployment,
  };
}
