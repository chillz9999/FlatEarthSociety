import type { ChainGateway } from '../chain/gateway';
import type { Db } from '../db';
import type { AttemptService } from './attempts';
import type { EventHub } from './events';

const CURSOR_KEY = 'indexer:lastBlock';
const MAX_RANGE = 5_000n;

/**
 * Follows EntryPurchased and ExtraLifePurchased events onchain and records
 * every payment, so an entry or a bonus life is never lost because a browser
 * closed before reporting its transaction. Re-processing is harmless
 * (payments and bonus lives are keyed by entry id).
 */
export class PaymentIndexer {
  lastRunAt: Date | null = null;

  constructor(
    private readonly db: Db,
    private readonly chain: ChainGateway,
    private readonly attempts: AttemptService,
    private readonly events: EventHub,
  ) {}

  async cursor(): Promise<bigint | null> {
    const { rows } = await this.db.query<{ value: string }>('select value from kv where key = $1', [CURSOR_KEY]);
    return rows[0] ? BigInt(rows[0].value) : null;
  }

  private async setCursor(block: bigint): Promise<void> {
    await this.db.query('insert into kv (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [CURSOR_KEY, block.toString()]);
  }

  /** Index up to the confirmed head. Returns the number of newly credited attempts. */
  async run(): Promise<number> {
    if (!this.chain.enabled) return 0;
    const safe = await this.chain.safeBlock();
    let last = (await this.cursor()) ?? this.chain.startBlock - 1n;
    let credited = 0;
    const weeks = new Set<number>();
    while (last < safe) {
      const from = last + 1n;
      const to = from + MAX_RANGE - 1n < safe ? from + MAX_RANGE - 1n : safe;
      const logs = await this.chain.entryLogs(from, to);
      for (const p of logs) {
        const r = await this.attempts.recordPayment(p, 'indexer');
        if (r.credited) credited++;
        weeks.add(p.weekId);
      }
      for (const life of await this.chain.extraLifeLogs(from, to)) {
        if (await this.attempts.recordLifePayment(life, 'indexer')) weeks.add(life.weekId);
      }
      await this.setCursor(to);
      last = to;
    }
    this.lastRunAt = new Date();
    for (const w of weeks) this.events.publish('competition', { weekId: w });
    return credited;
  }
}
