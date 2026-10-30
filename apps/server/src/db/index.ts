import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Run `fn` inside a transaction (BEGIN … COMMIT, ROLLBACK on error). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Production: node-postgres pool. */
export async function connectPostgres(url: string): Promise<Db> {
  const pg = await import('pg');
  // Return int8/numeric as strings (exact); timestamps as Date.
  const pool = new pg.default.Pool({ connectionString: url, max: 10 });
  return {
    query: (sql, params) => pool.query(sql, params as unknown[]) as never,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn({ query: (sql, params) => client.query(sql, params as unknown[]) as never });
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Development and tests: embedded Postgres (PGlite, WASM). `dataDir` undefined ⇒ in-memory. */
export async function connectPglite(dataDir?: string): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir, {
    // Match node-postgres: numeric and int8 as strings.
    parsers: { [types.NUMERIC]: (v: string) => v, [types.INT8]: (v: string) => v },
  });
  await db.waitReady;
  // PGlite runs one statement at a time; serialise transactions so they never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    query: (sql, params) => serial(() => db.query(sql, params as unknown[]) as never),
    tx: (fn) => serial(() => db.transaction((t) => fn({ query: (sql, params) => t.query(sql, params as unknown[]) as never }))),
    close: () => db.close(),
  };
}

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', '..', 'migrations'), join(here, 'migrations'), join(here, '..', 'migrations')]) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations directory not found');
}

/** Apply pending SQL migrations in filename order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const applied = new Set((await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await db.tx(async (q) => {
      for (const statement of splitSql(sql)) await q.query(statement);
      await q.query('insert into schema_migrations (name) values ($1)', [f]);
    });
    ran.push(f);
  }
  return ran;
}

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function openDatabase(opts: { url?: string; pgliteDir?: string }): Promise<Db> {
  const db = opts.url ? await connectPostgres(opts.url) : await connectPglite(opts.pgliteDir);
  await migrate(db);
  return db;
}
