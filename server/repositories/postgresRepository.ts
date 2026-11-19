import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { DatabaseSchema } from '../store.ts';

/**
 * Production PostgreSQL / Supabase Repository Adapter & Startup Readiness Guard.
 * Ensures production deployments NEVER silently fall back to local JSON persistence
 * and perform genuine transactional CRUD + live readiness verification against PostgreSQL.
 */

export interface PersistenceReadinessStatus {
  adapter: 'json-local' | 'postgres';
  ready: boolean;
  connected?: boolean;
  latencyMs?: number;
  reason: string;
}

export interface PgClientLike {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

const STATE_KEY = 'primary_v1';

let sharedPool: PgPoolLike | null = null;
let sharedPoolUrl: string | null = null;
let injectedPoolForTests: PgPoolLike | null = null;

export function setInjectedPgPoolForTests(pool: PgPoolLike | null): void {
  injectedPoolForTests = pool;
}

export function getPersistenceAdapterMode(): 'json-local' | 'postgres' {
  const isProd = process.env.NODE_ENV === 'production';
  const adapterPref = (process.env.PERSISTENCE_ADAPTER || (isProd ? 'postgres' : 'json-local')).toLowerCase();
  return adapterPref === 'postgres' ? 'postgres' : 'json-local';
}

export function getPersistenceStatus(): PersistenceReadinessStatus {
  const isProd = process.env.NODE_ENV === 'production';
  const adapterPref = (process.env.PERSISTENCE_ADAPTER || (isProd ? 'postgres' : 'json-local')).toLowerCase();
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0);

  if (adapterPref === 'postgres') {
    if (!hasDatabaseUrl && !injectedPoolForTests) {
      return {
        adapter: 'postgres',
        ready: false,
        connected: false,
        reason: 'PERSISTENCE_ADAPTER=postgres requires DATABASE_URL to be configured.',
      };
    }
    return {
      adapter: 'postgres',
      ready: true,
      reason: 'PostgreSQL connection string configured; migrations 001-004 supported.',
    };
  }

  if (isProd) {
    return {
      adapter: 'json-local',
      ready: false,
      connected: false,
      reason: 'Local JSON persistence is prohibited in production mode. Configure PostgreSQL (DATABASE_URL).',
    };
  }

  return {
    adapter: 'json-local',
    ready: true,
    connected: true,
    reason: 'Isolated local development / test JSON transactional store active.',
  };
}

export function assertPersistenceReady(): void {
  const status = getPersistenceStatus();
  if (!status.ready) {
    throw new Error(`PERSISTENCE_READINESS_FAILURE: ${status.reason}`);
  }
}

export function getPgPool(): PgPoolLike {
  if (injectedPoolForTests) {
    return injectedPoolForTests;
  }

  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured for PostgreSQL persistence.');
  }

  if (sharedPool && sharedPoolUrl === databaseUrl) {
    return sharedPool;
  }

  const useSsl =
    !databaseUrl.includes('localhost') &&
    !databaseUrl.includes('127.0.0.1') &&
    process.env.PGSSLMODE !== 'disable';

  sharedPool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 5_000,
    ssl: useSsl ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
  });
  sharedPoolUrl = databaseUrl;
  return sharedPool;
}

export async function closePgPool(): Promise<void> {
  if (sharedPool) {
    const pool = sharedPool;
    sharedPool = null;
    sharedPoolUrl = null;
    await pool.end();
  }
}

/**
 * Verifies real PostgreSQL database connectivity with SELECT 1 when PostgreSQL adapter is active.
 */
export async function checkPersistenceHealth(): Promise<PersistenceReadinessStatus> {
  const baseStatus = getPersistenceStatus();
  if (!baseStatus.ready || baseStatus.adapter !== 'postgres') {
    return baseStatus;
  }

  const startedAt = Date.now();
  try {
    const pool = getPgPool();
    await pool.query('SELECT 1 AS ok');
    return {
      adapter: 'postgres',
      ready: true,
      connected: true,
      latencyMs: Date.now() - startedAt,
      reason: 'PostgreSQL connection verified via live health query.',
    };
  } catch (err) {
    const code =
      typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'DB_UNREACHABLE';
    return {
      adapter: 'postgres',
      ready: false,
      connected: false,
      latencyMs: Date.now() - startedAt,
      reason: `PostgreSQL connectivity check failed (${code}).`,
    };
  }
}

/**
 * Ensures the transactional state table exists (idempotent safety guard for fresh staging DBs).
 */
async function ensureStateTable(client: PgClientLike): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_state_snapshots (
      state_key TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Reads durable business state from PostgreSQL. Initializes atomically from seed if empty.
 */
export async function readDbFromPostgres(buildSeed: () => DatabaseSchema): Promise<DatabaseSchema> {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await ensureStateTable(client);
    const result = await client.query<{ payload: DatabaseSchema }>(
      'SELECT payload FROM app_state_snapshots WHERE state_key = $1',
      [STATE_KEY],
    );
    if (result.rows[0]?.payload) {
      return result.rows[0].payload;
    }

    const seed = buildSeed();
    const inserted = await client.query<{ payload: DatabaseSchema }>(
      `INSERT INTO app_state_snapshots (state_key, schema_version, payload, updated_at)
       VALUES ($1, 1, $2::jsonb, NOW())
       ON CONFLICT (state_key) DO UPDATE SET state_key = EXCLUDED.state_key
       RETURNING payload`,
      [STATE_KEY, JSON.stringify(seed)],
    );
    return inserted.rows[0]?.payload ?? seed;
  } finally {
    client.release();
  }
}

/**
 * Executes an atomic PostgreSQL transaction with row-level locking (SELECT ... FOR UPDATE),
 * rolling back automatically if any validation, business invariant, or query fails.
 */
export async function runPostgresTransaction<T>(
  buildSeed: () => DatabaseSchema,
  normalize: (raw: DatabaseSchema) => DatabaseSchema,
  fn: (db: DatabaseSchema) => Promise<T> | T,
): Promise<T> {
  const pool = getPgPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureStateTable(client);

    // Ensure row exists before taking FOR UPDATE lock
    await client.query(
      `INSERT INTO app_state_snapshots (state_key, schema_version, payload, updated_at)
       VALUES ($1, 1, $2::jsonb, NOW())
       ON CONFLICT (state_key) DO NOTHING`,
      [STATE_KEY, JSON.stringify(buildSeed())],
    );

    const locked = await client.query<{ payload: DatabaseSchema }>(
      'SELECT payload FROM app_state_snapshots WHERE state_key = $1 FOR UPDATE',
      [STATE_KEY],
    );

    const db = normalize(locked.rows[0]?.payload ?? buildSeed());
    const result = await fn(db);

    await client.query(
      `UPDATE app_state_snapshots
       SET payload = $2::jsonb, updated_at = NOW()
       WHERE state_key = $1`,
      [STATE_KEY, JSON.stringify(db)],
    );

    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve original error
    }
    throw err;
  } finally {
    client.release();
  }
}
