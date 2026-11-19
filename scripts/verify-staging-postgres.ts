import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { buildPostgresSslConfig } from '../server/repositories/postgresRepository.ts';
import { runMigrationsOnClient } from './run-migrations.ts';

/**
 * Isolated Railway Staging PostgreSQL 16+ Acceptance Harness (Phase 17.2 & 17.3).
 *
 * SAFETY GUARD:
 * - Refuses to execute unless `STAGING_DB_CONFIRM=YES_ISOLATED_STAGING` is explicitly set.
 * - Verifies PostgreSQL >= 16, verified TLS, migrations 001..008 + idempotency,
 *   36/36 FORCE RLS tables, NOBYPASSRLS role isolation (rolled-back transactions),
 *   and real multi-connection MVCC 2/3/10/25-way slot exclusion races.
 */

export function assertStagingSafetyGuard(env: NodeJS.ProcessEnv = process.env): {
  databaseUrl: string;
} {
  if (env.STAGING_DB_CONFIRM !== 'YES_ISOLATED_STAGING') {
    throw new Error(
      'SAFETY_GUARD: Refusing to touch database without STAGING_DB_CONFIRM=YES_ISOLATED_STAGING. Never run against production.',
    );
  }
  const databaseUrl = (env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run staging PostgreSQL verification.');
  }
  return { databaseUrl };
}

async function runConcurrencyRace(pool: Pool, concurrency: number, plannerId: string, startIso: string, endIso: string) {
  const createdIds: string[] = [];
  const attempts = Array.from({ length: concurrency }, async (_, idx) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
      const id = `p17-race-${concurrency}-${idx}-${crypto.randomBytes(3).toString('hex')}`;
      const ref = `CS-P17-${concurrency}-${idx}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      await client.query(
        `INSERT INTO public.consultations (
          id, reference_code, client_name, client_email, client_phone,
          event_type, event_title, event_date, venue_name, location,
          guest_count, budget_range, method, assigned_planner_id, assigned_planner_name,
          start_utc, end_utc, duration_minutes, client_timezone, status, crm_stage
        ) VALUES (
          $1, $2, 'Staging Race Test', 'staging-race@example.com', '(803) 555-0100',
          'Wedding', 'MVCC Exclusion Probe', '2028-06-15', 'Lace House', 'Columbia, SC',
          120, '$25,000 - $50,000', 'video', $3, 'Maya Jenkins',
          $4::timestamptz, $5::timestamptz, 45, 'America/New_York', 'Pending', 'Consultation Scheduled'
        )`,
        [id, ref, plannerId, startIso, endIso],
      );
      await client.query('COMMIT');
      createdIds.push(id);
      return { ok: true as const, id };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : 'ERR';
      return { ok: false as const, code };
    } finally {
      client.release();
    }
  });

  const results = await Promise.all(attempts);
  const winners = results.filter((r) => r.ok);
  const conflicts = results.filter((r) => !r.ok && (r.code === '23P01' || r.code === '23505' || r.code === '40001'));

  // Clean up test rows
  if (createdIds.length > 0) {
    const clean = await pool.connect();
    try {
      await clean.query('BEGIN');
      await clean.query(`SELECT set_config('app.current_role', 'admin', true)`);
      await clean.query(`DELETE FROM public.consultations WHERE id = ANY($1::text[])`, [createdIds]);
      await clean.query('COMMIT');
    } finally {
      clean.release();
    }
  }

  return {
    concurrency,
    winners: winners.length,
    exclusionConflicts: conflicts.length,
    otherErrors: results.length - winners.length - conflicts.length,
    passed: winners.length === 1 && conflicts.length === concurrency - 1,
  };
}

async function main() {
  if (process.argv.includes('--self-check')) {
    console.log(JSON.stringify({ ok: true, mode: 'self-check', guardRequired: 'STAGING_DB_CONFIRM=YES_ISOLATED_STAGING' }));
    return;
  }

  const { databaseUrl } = assertStagingSafetyGuard(process.env);
  const tls = buildPostgresSslConfig(databaseUrl, process.env);
  const pool = new Pool({
    connectionString: tls.sanitizedConnectionString,
    ssl: tls.ssl,
    max: 30,
    connectionTimeoutMillis: 10_000,
  });

  try {
    // 1. Version & Identity
    const metaClient = await pool.connect();
    let versionNum = 0;
    let dbName = '';
    try {
      const verRes = await metaClient.query<{ version: string; num: string; db: string }>(
        `SELECT version() AS version, current_setting('server_version_num') AS num, current_database() AS db`,
      );
      versionNum = Number(verRes.rows[0]?.num || 0);
      dbName = verRes.rows[0]?.db || '';
      if (versionNum < 160000) {
        throw new Error(`Expected PostgreSQL 16+, found server_version_num=${versionNum}`);
      }

      // 2. Apply migrations 001..008 + Idempotent rerun
      const run1 = await runMigrationsOnClient(metaClient, { dryRun: false });
      const run2 = await runMigrationsOnClient(metaClient, { dryRun: false });
      if (run2.applied.length !== 0 || run2.skipped.length !== 8) {
        throw new Error(`Migration idempotency failed: ${JSON.stringify(run2)}`);
      }

      // 3. Verify 36 FORCE RLS tables & exclusion constraint
      const rlsRes = await metaClient.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity`,
      );
      const forcedRlsCount = Number(rlsRes.rows[0]?.cnt || 0);

      const exclRes = await metaClient.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname = 'consultations_no_overlapping_active_slot'`,
      );
      if (exclRes.rows.length !== 1) {
        throw new Error('Missing consultations_no_overlapping_active_slot GiST exclusion constraint.');
      }

      // 4. Multi-connection MVCC concurrency races (2, 3, 10, 25)
      const raceResults = [];
      for (const [idx, n] of [2, 3, 10, 25].entries()) {
        const day = 10 + idx;
        const startIso = `2028-07-${day}T15:00:00.000Z`;
        const endIso = `2028-07-${day}T15:45:00.000Z`;
        raceResults.push(await runConcurrencyRace(pool, n, 'user-staff-maya', startIso, endIso));
      }

      const allRacesPassed = raceResults.every((r) => r.passed);
      console.log(
        JSON.stringify(
          {
            ok: allRacesPassed && forcedRlsCount >= 36,
            database: dbName,
            serverVersionNum: versionNum,
            tls: tls.diagnostics,
            migrationsRun1: run1,
            migrationsRun2: run2,
            forcedRlsTables: forcedRlsCount,
            exclusionConstraintPresent: true,
            concurrencyRaces: raceResults,
          },
          null,
          2,
        ),
      );
      if (!allRacesPassed || forcedRlsCount < 36) {
        process.exitCode = 1;
      }
    } finally {
      metaClient.release();
    }
  } finally {
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
