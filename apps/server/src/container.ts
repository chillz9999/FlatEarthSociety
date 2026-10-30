import { ROBINHOOD_MAINNET_ID } from '@fes/shared';
import { createPublicClient, http } from 'viem';
import { buildApp } from './app';
import { DisabledChain, type ChainGateway } from './chain/gateway';
import { ViemChainGateway } from './chain/viem-gateway';
import type { ServerConfig } from './config';
import { openDatabase, type Db } from './db';
import { DEFAULT_POLICY, AttemptService } from './services/attempts';
import { AuthService } from './services/auth';
import { CompetitionService } from './services/competition';
import { EventHub } from './services/events';
import { PaymentIndexer } from './services/indexer';
import { LeaderboardService, PRACTICE_BOARD } from './services/leaderboard';
import { PracticeService } from './services/practice';
import { PricingService } from './services/pricing';
import { SettlementService } from './services/settlement';

export function createChain(cfg: ServerConfig): ChainGateway {
  if (cfg.CHAIN_MODE === 'disabled') return new DisabledChain(cfg.CHAIN_ID, cfg.CHAIN_NAME ?? `Chain ${cfg.CHAIN_ID}`);
  const entry = cfg.ENTRY_CONTRACT ?? cfg.deployment?.entry;
  const vault = cfg.VAULT_CONTRACT ?? cfg.deployment?.prizeVault;
  if (!entry || !vault) {
    throw new Error('CHAIN_MODE=enabled requires ENTRY_CONTRACT and VAULT_CONTRACT (or DEPLOYMENT_FILE). Set CHAIN_MODE=disabled to run without the chain.');
  }
  if (cfg.CHAIN_ID === ROBINHOOD_MAINNET_ID && cfg.deployment?.mockTokens) throw new Error('Refusing to run mainnet with mock tokens');
  return new ViemChainGateway({
    chainId: cfg.CHAIN_ID,
    chainName: cfg.CHAIN_NAME,
    rpcUrl: cfg.RPC_URL,
    explorerUrl: cfg.EXPLORER_URL,
    entry,
    vault,
    converter: cfg.CONVERTER_CONTRACT ?? cfg.deployment?.fixedRateConverter ?? null,
    startBlock: cfg.START_BLOCK ?? BigInt(cfg.deployment?.deployBlock ?? 0),
    confirmations: cfg.CONFIRMATIONS,
    settlerKey: cfg.SETTLER_PRIVATE_KEY as `0x${string}` | undefined,
    pricerKey: (cfg.PRICER_PRIVATE_KEY ?? cfg.SETTLER_PRIVATE_KEY) as `0x${string}` | undefined,
  });
}

export interface Services {
  db: Db;
  chain: ChainGateway;
  events: EventHub;
  board: LeaderboardService;
  practiceBoard: LeaderboardService;
  competitions: CompetitionService;
  attempts: AttemptService;
  practice: PracticeService;
  settlement: SettlementService;
  indexer: PaymentIndexer;
  pricing: PricingService;
  auth: AuthService;
}

export async function createServices(cfg: ServerConfig, overrides: { db?: Db; chain?: ChainGateway; pricing?: PricingService } = {}): Promise<Services> {
  const db = overrides.db ?? (await openDatabase({ url: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR }));
  const chain = overrides.chain ?? createChain(cfg);
  const events = new EventHub();
  const board = new LeaderboardService(db);
  const competitions = new CompetitionService(db, chain, board);
  const attempts = new AttemptService(db, chain, board, competitions, events, {
    ...DEFAULT_POLICY,
    reviewTopN: cfg.REVIEW_TOP_N,
    autoRestorePerWeek: cfg.AUTO_RESTORE_PER_WEEK,
  });
  const practiceBoard = new LeaderboardService(db, PRACTICE_BOARD);
  const practice = new PracticeService(db, practiceBoard, competitions, events);
  const settlement = new SettlementService(db, chain, board, competitions, attempts, events, {
    closeGraceMinutes: cfg.CLOSE_GRACE_MINUTES,
    slippageBps: cfg.CONVERSION_SLIPPAGE_BPS,
  });
  const indexer = new PaymentIndexer(db, chain, attempts, events);
  const pricing =
    overrides.pricing ??
    new PricingService(db, chain, {
      entryUsd: cfg.ENTRY_PRICE_USD,
      extraLifeUsd: cfg.EXTRA_LIFE_PRICE_USD,
      feed: cfg.PRICE_FEED,
      dexscreenerChain: cfg.DEXSCREENER_CHAIN,
      minLiquidityUsd: cfg.PRICE_MIN_LIQUIDITY_USD,
      coingeckoId: cfg.COINGECKO_ID,
      maxDisagreementBps: cfg.PRICE_MAX_DISAGREEMENT_BPS,
      fixedWifUsd: cfg.WIF_USD,
      deviationBps: cfg.PRICE_DEVIATION_BPS,
    });
  const rpc = cfg.RPC_URL;
  // Smart-contract wallets (ERC-1271 / ERC-6492) are verified through the chain when an RPC is available.
  const verifier =
    chain.enabled && rpc
      ? (() => {
          const client = createPublicClient({ transport: http(rpc) });
          return (args: { address: `0x${string}`; message: string; signature: `0x${string}` }) => client.verifyMessage(args);
        })()
      : undefined;
  const auth = new AuthService(db, {
    secret: cfg.SESSION_SECRET,
    ttlHours: cfg.SESSION_TTL_HOURS,
    chainId: cfg.CHAIN_ID,
    admins: cfg.adminAddresses,
    allowedDomains: cfg.webOrigins.map((o) => {
      try {
        return new URL(o).host;
      } catch {
        return o;
      }
    }),
    verifier,
  });
  return { db, chain, events, board, practiceBoard, competitions, attempts, practice, settlement, indexer, pricing, auth };
}

export async function createServer(cfg: ServerConfig, services: Services) {
  return buildApp({
    ...services,
    webOrigins: cfg.webOrigins,
    confirmations: cfg.CONFIRMATIONS,
    demoTokens: cfg.DEMO_TOKENS || Boolean(cfg.deployment?.mockTokens),
    logLevel: cfg.LOG_LEVEL,
    trustProxy: cfg.trustProxy,
  });
}

/** Background work: index payments, keep the fees at their dollar prices, close weeks, sweep abandoned runs, optionally settle. */
export function startJobs(cfg: ServerConfig, s: Services, log: (msg: string, err?: unknown) => void): () => void {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await fn();
      } catch (err) {
        log(`job ${name} failed`, err);
      } finally {
        running = false;
      }
    };
    void tick();
    timers.push(setInterval(tick, ms));
  };
  if (s.chain.enabled) every(cfg.INDEXER_INTERVAL_MS, 'indexer', () => s.indexer.run());
  if (cfg.PRICE_FEED !== 'off') every(cfg.PRICE_UPDATE_INTERVAL_MS, 'pricing', () => s.pricing.run());
  every(30_000, 'weeks', () => s.settlement.advanceWeeks());
  every(60_000, 'abandoned', () => s.attempts.sweepAbandoned());
  every(15 * 60_000, 'practice', () => s.practice.sweepAbandoned());
  if (cfg.AUTO_SETTLE && s.chain.enabled) every(5 * 60_000, 'settle', () => s.settlement.autoSettle());
  return () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
  };
}
