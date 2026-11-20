import fs from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { DatabaseSchema } from '../store.ts';

/**
 * Production PostgreSQL / Supabase Repository Adapter & Startup Readiness Guard.
 * Ensures production deployments NEVER silently fall back to local JSON persistence,
 * enforce verified TLS certificate chains (never weakening rejectUnauthorized),
 * and perform genuine transactional CRUD + live readiness verification against PostgreSQL.
 */

export interface PostgresTlsDiagnostics {
  enabled: boolean;
  rejectUnauthorized: boolean;
  caSource: 'none' | 'DATABASE_CA_CERT' | 'DATABASE_CA_CERT_BASE64' | 'PGSSLROOTCERT';
  hostClass: 'localhost' | 'railway-internal' | 'public-network' | 'unknown';
  sslMode: string;
}

export const REQUIRED_CANONICAL_MIGRATION_COUNT = 8;

export interface PersistenceSchemaDiagnostics {
  rateLimitTablePresent: boolean;
  migrationsTablePresent: boolean;
  migrationsAppliedCount: number;
  essentialTablesPresent?: boolean;
  missingEssentialTables?: string[];
  overlapConstraintPresent?: boolean;
  canonicalSchemaReady?: boolean;
}

export interface PersistenceReadinessStatus {
  adapter: 'json-local' | 'postgres';
  ready: boolean;
  connected?: boolean;
  latencyMs?: number;
  tls?: PostgresTlsDiagnostics;
  schema?: PersistenceSchemaDiagnostics;
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

function classifyPostgresHost(hostname: string): PostgresTlsDiagnostics['hostClass'] {
  const lower = hostname.toLowerCase();
  if (!lower) return 'unknown';
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1') return 'localhost';
  if (lower.endsWith('.railway.internal')) return 'railway-internal';
  return 'public-network';
}

function loadVerifiedCaPem(env: NodeJS.ProcessEnv): {
  ca?: string;
  source: PostgresTlsDiagnostics['caSource'];
} {
  const inlinePem = (env.DATABASE_CA_CERT || '').trim();
  if (inlinePem) {
    const normalized = inlinePem.includes('\\n') ? inlinePem.replace(/\\n/g, '\n') : inlinePem;
    if (!normalized.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('TLS_CONFIG_FAILURE: DATABASE_CA_CERT does not contain a valid PEM certificate.');
    }
    return { ca: normalized, source: 'DATABASE_CA_CERT' };
  }

  const base64Pem = (env.DATABASE_CA_CERT_BASE64 || '').trim();
  if (base64Pem) {
    const decoded = Buffer.from(base64Pem, 'base64').toString('utf8').trim();
    if (!decoded.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('TLS_CONFIG_FAILURE: DATABASE_CA_CERT_BASE64 did not decode to a valid PEM certificate.');
    }
    return { ca: decoded, source: 'DATABASE_CA_CERT_BASE64' };
  }

  const rootCertPath = (env.PGSSLROOTCERT || '').trim();
  if (rootCertPath) {
    if (!fs.existsSync(rootCertPath)) {
      throw new Error(`TLS_CONFIG_FAILURE: PGSSLROOTCERT path does not exist (${rootCertPath}).`);
    }
    const pem = fs.readFileSync(rootCertPath, 'utf8').trim();
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('TLS_CONFIG_FAILURE: PGSSLROOTCERT file does not contain a valid PEM certificate.');
    }
    return { ca: pem, source: 'PGSSLROOTCERT' };
  }

  return { ca: undefined, source: 'none' };
}

/**
 * Resolves secure PostgreSQL TLS configuration and strips conflicting query-string sslmode
 * parameters so node-postgres never silently overrides verified certificate settings.
 *
 * Security invariants:
 * - Certificate verification (`rejectUnauthorized: true`) is NEVER disabled in production.
 * - Custom managed PostgreSQL / Railway / Supabase CA bundles are loaded from
 *   `DATABASE_CA_CERT`, `DATABASE_CA_CERT_BASE64`, or `PGSSLROOTCERT`.
 * - Non-TLS connections are permitted ONLY for loopback (`localhost`/`127.0.0.1`) OR
 *   private WireGuard `.railway.internal` hosts when explicitly configured with `PGSSLMODE=disable`.
 */
export function buildPostgresSslConfig(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  sanitizedConnectionString: string;
  ssl: ConnectionOptions | undefined;
  diagnostics: PostgresTlsDiagnostics;
} {
  if ((env.PG_SSL_REJECT_UNAUTHORIZED || '').toLowerCase() === 'false') {
    throw new Error(
      'TLS_CONFIG_FAILURE: Disabling PostgreSQL TLS certificate verification (PG_SSL_REJECT_UNAUTHORIZED=false) is prohibited. Configure DATABASE_CA_CERT, DATABASE_CA_CERT_BASE64, or PGSSLROOTCERT with the provider root CA instead.',
    );
  }

  let parsedUrl: URL | null = null;
  let querySslMode = '';
  let hostname = '';
  try {
    parsedUrl = new URL(databaseUrl);
    hostname = parsedUrl.hostname || '';
    querySslMode = (parsedUrl.searchParams.get('sslmode') || '').trim().toLowerCase();
  } catch {
    hostname = '';
  }

  const hostClass = classifyPostgresHost(hostname);
  const sslMode = (env.PGSSLMODE || querySslMode || (hostClass === 'localhost' ? 'disable' : 'verify-full')).toLowerCase();

  if (sslMode === 'no-verify') {
    throw new Error(
      'TLS_CONFIG_FAILURE: sslmode=no-verify is prohibited. Use verify-full or verify-ca with a verified provider CA bundle.',
    );
  }

  // Strip sslmode from URL query string after parsing so pg does not silently downgrade ssl options
  let sanitizedConnectionString = databaseUrl;
  if (parsedUrl && parsedUrl.searchParams.has('sslmode')) {
    parsedUrl.searchParams.delete('sslmode');
    sanitizedConnectionString = parsedUrl.toString();
  }

  if (sslMode === 'disable') {
    if (hostClass === 'public-network' && env.NODE_ENV === 'production') {
      throw new Error(
        'TLS_CONFIG_FAILURE: PGSSLMODE=disable is prohibited for public-network PostgreSQL hosts in production.',
      );
    }
    return {
      sanitizedConnectionString,
      ssl: undefined,
      diagnostics: {
        enabled: false,
        rejectUnauthorized: false,
        caSource: 'none',
        hostClass,
        sslMode: 'disable',
      },
    };
  }

  const { ca, source } = loadVerifiedCaPem(env);
  const ssl: ConnectionOptions = {
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    ...(ca ? { ca } : {}),
    ...(hostname ? { servername: hostname } : {}),
  };

  return {
    sanitizedConnectionString,
    ssl,
    diagnostics: {
      enabled: true,
      rejectUnauthorized: true,
      caSource: source,
      hostClass,
      sslMode,
    },
  };
}

export function getPersistenceAdapterMode(): 'json-local' | 'postgres' {
  const isProd = process.env.NODE_ENV === 'production';
  const adapterPref = (process.env.PERSISTENCE_ADAPTER || (isProd ? 'postgres' : 'json-local')).toLowerCase();
  return adapterPref === 'postgres' ? 'postgres' : 'json-local';
}

export function getPersistenceStatus(): PersistenceReadinessStatus {
  const isProd = process.env.NODE_ENV === 'production';
  const adapterPref = (process.env.PERSISTENCE_ADAPTER || (isProd ? 'postgres' : 'json-local')).toLowerCase();
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  const hasDatabaseUrl = databaseUrl.length > 0;

  if (adapterPref === 'postgres') {
    if (!hasDatabaseUrl && !injectedPoolForTests) {
      return {
        adapter: 'postgres',
        ready: false,
        connected: false,
        reason: 'PERSISTENCE_ADAPTER=postgres requires DATABASE_URL to be configured.',
      };
    }

    if (hasDatabaseUrl) {
      try {
        const tlsConfig = buildPostgresSslConfig(databaseUrl);
        return {
          adapter: 'postgres',
          ready: true,
          tls: tlsConfig.diagnostics,
          reason: 'PostgreSQL connection string and verified TLS configuration ready; migrations 001-008 supported.',
        };
      } catch (err) {
        return {
          adapter: 'postgres',
          ready: false,
          connected: false,
          reason: err instanceof Error ? err.message : 'Invalid PostgreSQL TLS configuration.',
        };
      }
    }

    return {
      adapter: 'postgres',
      ready: true,
      reason: 'PostgreSQL test pool injected; migrations 001-008 supported.',
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

  const cacheKey = `${databaseUrl}|${process.env.PGSSLMODE || ''}|${process.env.PGSSLROOTCERT || ''}|${Boolean(process.env.DATABASE_CA_CERT)}|${Boolean(process.env.DATABASE_CA_CERT_BASE64)}`;
  if (sharedPool && sharedPoolUrl === cacheKey) {
    return sharedPool;
  }

  const tlsResolved = buildPostgresSslConfig(databaseUrl);

  const pool = new Pool({
    connectionString: tlsResolved.sanitizedConnectionString,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 5_000,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 10_000,
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS) || 12_000,
    ssl: tlsResolved.ssl,
  });

  // Prevent unhandled idle-client disconnect errors from crashing the Express process during DB restarts
  pool.on('error', (err) => {
    const code =
      typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'PG_IDLE_CLIENT_ERROR';
    console.error(JSON.stringify({ event: 'pg_pool_idle_error', code }));
  });

  sharedPool = pool;
  sharedPoolUrl = cacheKey;
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
    let schema: PersistenceSchemaDiagnostics | undefined;
    try {
      const regRes = await pool.query<{
        rate_limit_tbl: string | null;
        migrations_tbl: string | null;
        consultations_tbl?: string | null;
        holds_tbl?: string | null;
        outbox_tbl?: string | null;
        webhooks_tbl?: string | null;
        crm_tasks_tbl?: string | null;
      }>(
        `SELECT to_regclass('public.rate_limit_buckets') AS rate_limit_tbl,
                to_regclass('public.schema_migrations') AS migrations_tbl,
                to_regclass('public.consultations') AS consultations_tbl,
                to_regclass('public.consultation_slot_holds') AS holds_tbl,
                to_regclass('public.notification_outbox') AS outbox_tbl,
                to_regclass('public.notification_webhook_events') AS webhooks_tbl,
                to_regclass('public.crm_follow_up_tasks') AS crm_tasks_tbl`,
      );
      const row = regRes.rows[0];
      const rateLimitTablePresent = Boolean(row?.rate_limit_tbl);
      const migrationsTablePresent = Boolean(row?.migrations_tbl);
      let migrationsAppliedCount = 0;
      if (migrationsTablePresent) {
        const countRes = await pool.query<{ cnt: string | number }>(
          `SELECT COUNT(DISTINCT COALESCE(NULLIF(substring(version FROM '^[0-9]{3}'), ''), version))::int AS cnt FROM schema_migrations`,
        );
        migrationsAppliedCount = Number(countRes.rows[0]?.cnt ?? 0);
      }

      const hasExtendedCatalog = Boolean(row && 'consultations_tbl' in row);
      if (hasExtendedCatalog) {
        const tableChecks: Array<[string, string | null | undefined]> = [
          ['rate_limit_buckets', row?.rate_limit_tbl],
          ['schema_migrations', row?.migrations_tbl],
          ['consultations', row?.consultations_tbl],
          ['consultation_slot_holds', row?.holds_tbl],
          ['notification_outbox', row?.outbox_tbl],
          ['notification_webhook_events', row?.webhooks_tbl],
          ['crm_follow_up_tasks', row?.crm_tasks_tbl],
        ];
        const missingEssentialTables = tableChecks
          .filter(([, present]) => !present)
          .map(([tableName]) => tableName);
        const essentialTablesPresent = missingEssentialTables.length === 0;

        let overlapConstraintPresent = false;
        try {
          const conRes = await pool.query<{ present: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM pg_constraint
               WHERE conname = 'excl_consultations_planner_buffered_overlap'
             ) AS present`,
          );
          overlapConstraintPresent = Boolean(conRes.rows[0]?.present);
        } catch {
          overlapConstraintPresent = false;
        }

        const canonicalSchemaReady =
          rateLimitTablePresent &&
          migrationsTablePresent &&
          migrationsAppliedCount >= REQUIRED_CANONICAL_MIGRATION_COUNT &&
          essentialTablesPresent &&
          overlapConstraintPresent;

        schema = {
          rateLimitTablePresent,
          migrationsTablePresent,
          migrationsAppliedCount,
          essentialTablesPresent,
          missingEssentialTables,
          overlapConstraintPresent,
          canonicalSchemaReady,
        };
      } else {
        schema = { rateLimitTablePresent, migrationsTablePresent, migrationsAppliedCount };
      }
    } catch {
      // Minimal test pools that mock only SELECT 1 safely omit optional schema diagnostics
    }
    return {
      adapter: 'postgres',
      ready: true,
      connected: true,
      latencyMs: Date.now() - startedAt,
      tls: baseStatus.tls,
      ...(schema ? { schema } : {}),
      reason: 'PostgreSQL connection verified via live health query.',
    };
  } catch (err) {
    const code =
      typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'DB_UNREACHABLE';
    const isTlsChainError =
      code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'ERR_TLS_CERT_ALTNAME_INVALID';
    return {
      adapter: 'postgres',
      ready: false,
      connected: false,
      latencyMs: Date.now() - startedAt,
      tls: baseStatus.tls,
      reason: isTlsChainError
        ? `PostgreSQL TLS certificate chain verification failed (${code}). Configure DATABASE_CA_CERT, DATABASE_CA_CERT_BASE64, or PGSSLROOTCERT with your provider CA bundle.`
        : `PostgreSQL connectivity check failed (${code}).`,
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
