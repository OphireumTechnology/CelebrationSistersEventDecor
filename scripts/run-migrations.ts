import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { buildPostgresSslConfig, type PgClientLike } from '../server/repositories/postgresRepository.ts';

export interface MigrationFileDescriptor {
  version: string;
  filename: string;
  filepath: string;
  sql: string;
  checksumSha256: string;
}

export interface MigrationRunSummary {
  dryRun: boolean;
  totalFiles: number;
  applied: string[];
  skipped: string[];
  pending: string[];
}

export async function loadMigrationFiles(
  migrationsDir = path.resolve(process.cwd(), 'db/migrations'),
): Promise<MigrationFileDescriptor[]> {
  const entries = (await fs.readdir(migrationsDir))
    .filter((f) => /^\d{3}_.+\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  const descriptors: MigrationFileDescriptor[] = [];
  for (const filename of entries) {
    const filepath = path.join(migrationsDir, filename);
    const sql = await fs.readFile(filepath, 'utf8');
    const checksumSha256 = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    const version = filename.replace(/\.sql$/i, '');
    descriptors.push({ version, filename, filepath, sql, checksumSha256 });
  }
  return descriptors;
}

/**
 * Applies PostgreSQL migrations sequentially inside per-file transactions with
 * checksum verification against `public.schema_migrations`.
 * Never disables Row-Level Security or bypasses TLS certificate verification.
 */
export async function runMigrationsOnClient(
  client: PgClientLike,
  options?: {
    migrationsDir?: string;
    dryRun?: boolean;
  },
): Promise<MigrationRunSummary> {
  const dryRun = Boolean(options?.dryRun);
  const files = await loadMigrationFiles(options?.migrationsDir);

  // Dry-run must never create or alter schema_migrations, even on a fresh database.
  // Inspect the catalog first so an absent history table is treated as all pending.
  if (dryRun) {
    const catalog = await client.query<{ migrations_table: string | null }>(
      "SELECT to_regclass('public.schema_migrations') AS migrations_table",
    );
    const hasHistory = Boolean(catalog.rows[0]?.migrations_table);
    const history = hasHistory
      ? await client.query<{ version: string; checksum_sha256: string | null }>(
          'SELECT version, checksum_sha256 FROM public.schema_migrations ORDER BY version ASC',
        )
      : { rows: [] as { version: string; checksum_sha256: string | null }[] };
    const existing = new Map(history.rows.map((row) => [row.version, row.checksum_sha256]));
    const skipped: string[] = [];
    const pending: string[] = [];
    for (const file of files) {
      if (!existing.has(file.version)) {
        pending.push(file.filename);
        continue;
      }
      const checksum = existing.get(file.version);
      if (!checksum || checksum !== file.checksumSha256) {
        throw new Error(
          `MIGRATION_CHECKSUM_MISMATCH: Applied migration "${file.version}" has missing or mismatched checksum in schema_migrations.`,
        );
      }
      skipped.push(file.filename);
    }
    return { dryRun: true, totalFiles: files.length, applied: [], skipped, pending };
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY,
      filename TEXT NOT NULL DEFAULT '',
      checksum_sha256 TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`
    ALTER TABLE public.schema_migrations
      ADD COLUMN IF NOT EXISTS filename TEXT NOT NULL DEFAULT '';
  `);
  await client.query(`
    ALTER TABLE public.schema_migrations
      ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;
  `);

  const existingResult = await client.query<{ version: string; checksum_sha256: string | null }>(
    `SELECT version, checksum_sha256 FROM public.schema_migrations ORDER BY version ASC`,
  );
  const appliedMap = new Map<string, string>();
  for (const row of existingResult.rows) {
    if (row.checksum_sha256) {
      appliedMap.set(row.version, row.checksum_sha256);
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  const pending: string[] = [];

  for (const file of files) {
    const existingChecksum = appliedMap.get(file.version);
    if (existingChecksum) {
      if (existingChecksum !== file.checksumSha256) {
        throw new Error(
          `MIGRATION_CHECKSUM_MISMATCH: Applied migration "${file.version}" has checksum ${existingChecksum.slice(0, 12)}... in schema_migrations, but workspace file has ${file.checksumSha256.slice(0, 12)}...`,
        );
      }
      skipped.push(file.filename);
      continue;
    }

    if (dryRun) {
      pending.push(file.filename);
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(file.sql);
      await client.query(
        `INSERT INTO public.schema_migrations (version, checksum_sha256, filename)
         VALUES ($1, $2, $3)
         ON CONFLICT (version) DO UPDATE
           SET checksum_sha256 = EXCLUDED.checksum_sha256,
               filename = EXCLUDED.filename`,
        [file.version, file.checksumSha256, file.filename],
      );
      await client.query('COMMIT');
      applied.push(file.filename);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`MIGRATION_FAILED (${file.filename}): ${message}`);
    }
  }

  return {
    dryRun,
    totalFiles: files.length,
    applied,
    skipped,
    pending,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const databaseUrl = (process.env.DATABASE_URL || '').trim();

  if (!databaseUrl) {
    if (dryRun) {
      const files = await loadMigrationFiles();
      console.log(
        JSON.stringify(
          {
            mode: 'offline-dry-run',
            totalFiles: files.length,
            migrations: files.map((f) => ({
              version: f.version,
              filename: f.filename,
              checksumSha256: f.checksumSha256,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.error('ERROR: DATABASE_URL is required to run PostgreSQL migrations (or pass --dry-run to inspect migration manifest).');
    process.exit(1);
  }

  const tlsConfig = buildPostgresSslConfig(databaseUrl, process.env);
  const pool = new Pool({
    connectionString: tlsConfig.sanitizedConnectionString,
    ssl: tlsConfig.ssl,
    max: 2,
    connectionTimeoutMillis: 10_000,
  });

  const client = await pool.connect();
  try {
    const summary = await runMigrationsOnClient(client, { dryRun });
    console.log(
      JSON.stringify(
        {
          ok: true,
          tls: tlsConfig.diagnostics,
          ...summary,
        },
        null,
        2,
      ),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
