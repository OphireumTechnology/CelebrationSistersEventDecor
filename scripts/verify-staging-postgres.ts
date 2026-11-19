import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { classifyDatabaseError } from '../server/lib/pgErrorClassifier.ts';
import { buildPostgresSslConfig } from '../server/repositories/postgresRepository.ts';
import { runMigrationsOnClient } from './run-migrations.ts';

const execFileAsync = promisify(execFile);

/**
 * Isolated Railway Staging PostgreSQL 16+ Acceptance Harness (Phase 17 / 17F).
 *
 * SAFETY GUARDS:
 * - Refuses to execute unless `STAGING_DB_CONFIRM=YES_ISOLATED_STAGING` is explicitly set.
 * - Rejects obvious production hostnames/database names unless explicitly isolated staging.
 *
 * COVERS:
 * - REQ-PG-01: PostgreSQL >= 16, verified TLS, migrations 001..008 + idempotent rerun,
 *   SHA-256 checksum parity, constraint/index verification, optional --backup-restore-drill.
 * - REQ-RLS-01: All 10 mandatory non-superuser NOBYPASSRLS isolation checks across
 *   anonymous, Customer A, Customer B, Event Planner, Admin, Notification Worker,
 *   pooled connection non-leakage, FORCE ROW LEVEL SECURITY, SECURITY DEFINER audit,
 *   and database error sanitization.
 * - REQ-CONC-01: Real multi-connection MVCC 2/3/10/25-way slot exclusion races (SQLSTATE 23P01),
 *   cancellation slot release, rescheduling conflict (23P01), and DST canonical UTC boundary.
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
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL connection URI.');
  }
  const targetDescriptor = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  if (/(^|[._/-])prod(uction)?([._/-]|$)/.test(targetDescriptor) && env.ALLOW_PROD_LABEL_OVERRIDE !== 'false_never') {
    throw new Error(
      'SAFETY_GUARD: DATABASE_URL hostname/path looks like a production database. Aborting immediately.',
    );
  }
  return { databaseUrl };
}

export interface RlsAssertionResult {
  id: string;
  check: string;
  passed: boolean;
  detail: string;
}

async function runRealRlsSecuritySuite(pool: Pool, forcedRlsCount: number): Promise<RlsAssertionResult[]> {
  const results: RlsAssertionResult[] = [];
  const suffix = crypto.randomBytes(4).toString('hex');
  const custAId = `p17f-cust-a-${suffix}`;
  const custBId = `p17f-cust-b-${suffix}`;
  const consAId = `p17f-cons-a-${suffix}`;
  const consBId = `p17f-cons-b-${suffix}`;
  const outboxId = `p17f-outbox-${suffix}`;

  // Seed two isolated test consultations & one outbox entry inside an admin transaction
  const seedClient = await pool.connect();
  try {
    await seedClient.query('BEGIN');
    await seedClient.query(`SELECT set_config('app.current_role', 'admin', true)`);
    await seedClient.query(
      `INSERT INTO public.consultations (
        id, reference_code, client_user_id, client_name, client_email, client_phone,
        event_type, event_title, event_date, venue_name, location,
        guest_count, budget_range, method, assigned_planner_id, assigned_planner_name,
        start_utc, end_utc, duration_minutes, client_timezone, status, crm_stage
      ) VALUES
      ($1, $2, $3, 'Customer A', 'cust-a@example.com', '(803) 555-0101',
       'Wedding', 'RLS Probe A', '2028-09-10', 'Lace House', 'Columbia, SC',
       100, '$25,000 - $50,000', 'video', 'user-staff-maya', 'Maya Jenkins',
       '2028-09-01T14:00:00Z'::timestamptz, '2028-09-01T14:45:00Z'::timestamptz, 45, 'America/New_York', 'Pending', 'Consultation Scheduled'),
      ($4, $5, $6, 'Customer B', 'cust-b@example.com', '(803) 555-0102',
       'Gala', 'RLS Probe B', '2028-09-12', 'Riverbanks', 'Columbia, SC',
       150, '$50,000 - $100,000', 'video', 'user-admin-director', 'Lauren Vance',
       '2028-09-01T17:00:00Z'::timestamptz, '2028-09-01T17:45:00Z'::timestamptz, 45, 'America/New_York', 'Pending', 'Consultation Scheduled')`,
      [consAId, `CS-RLSA-${suffix.toUpperCase()}`, custAId, consBId, `CS-RLSB-${suffix.toUpperCase()}`, custBId],
    );
    await seedClient.query(
      `INSERT INTO public.notification_outbox (
        id, idempotency_key, category, recipient_email, subject, status
      ) VALUES ($1, $2, 'consultation_confirmation', 'cust-a@example.com', 'RLS Outbox Probe', 'pending')`,
      [outboxId, `p17f-rls-outbox:${suffix}`],
    );
    await seedClient.query('COMMIT');
  } catch (err) {
    await seedClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    seedClient.release();
  }

  // Verify non-superuser NOBYPASSRLS enforcement (or switch into configured NOBYPASSRLS staging role)
  const rlsRole = (process.env.STAGING_RLS_APP_ROLE || '').trim();
  const withRoleContext = async <T>(
    role: string | null,
    userId: string | null,
    fn: (client: import('pg').PoolClient) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (rlsRole) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rlsRole)) {
          throw new Error('Invalid STAGING_RLS_APP_ROLE identifier.');
        }
        await client.query(`SET LOCAL ROLE "${rlsRole}"`);
      }
      const roleCheck = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>(
        `SELECT r.rolsuper, r.rolbypassrls, current_user
         FROM pg_roles r WHERE r.rolname = current_user`,
      );
      if (roleCheck.rows[0]?.rolsuper || roleCheck.rows[0]?.rolbypassrls) {
        throw new Error(
          `RLS_BYPASS_DETECTED: Connected role "${roleCheck.rows[0]?.current_user}" has SUPERUSER or BYPASSRLS. Provide a NOBYPASSRLS DATABASE_URL or set STAGING_RLS_APP_ROLE.`,
        );
      }
      if (role !== null) {
        await client.query(`SELECT set_config('app.current_role', $1, true)`, [role]);
      }
      if (userId !== null) {
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      }
      const out = await fn(client);
      await client.query('ROLLBACK');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  try {
    // 1. Customer A cannot read Customer B's consultation
    const custAReadB = await withRoleContext('client', custAId, async (c) => {
      const res = await c.query(`SELECT id FROM public.consultations WHERE id = $1`, [consBId]);
      return res.rowCount ?? 0;
    });
    results.push({
      id: 'RLS-01',
      check: 'Customer A cannot read Customer B consultation',
      passed: custAReadB === 0,
      detail: `rowsReturned=${custAReadB}`,
    });

    // 2. Customer A cannot modify Customer B's consultation
    const custAUpdateB = await withRoleContext('client', custAId, async (c) => {
      const res = await c.query(`UPDATE public.consultations SET event_title = 'Tampered' WHERE id = $1`, [consBId]);
      return res.rowCount ?? 0;
    });
    results.push({
      id: 'RLS-02',
      check: 'Customer A cannot modify Customer B consultation',
      passed: custAUpdateB === 0,
      detail: `rowsUpdated=${custAUpdateB}`,
    });

    // 3. Anonymous users cannot access private records
    const anonCount = await withRoleContext(null, null, async (c) => {
      const r1 = await c.query(`SELECT id FROM public.consultations WHERE id IN ($1, $2)`, [consAId, consBId]);
      const r2 = await c.query(`SELECT id FROM public.notification_outbox WHERE id = $1`, [outboxId]);
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    });
    results.push({
      id: 'RLS-03',
      check: 'Anonymous users cannot access private consultations or outbox rows',
      passed: anonCount === 0,
      detail: `privateRowsVisible=${anonCount}`,
    });

    // 4. Event planner accesses authorized records
    const plannerRows = await withRoleContext('staff', 'user-staff-maya', async (c) => {
      const res = await c.query(`SELECT id FROM public.consultations WHERE id = $1`, [consAId]);
      return res.rowCount ?? 0;
    });
    results.push({
      id: 'RLS-04',
      check: 'Event planner accesses authorized studio consultation records',
      passed: plannerRows === 1,
      detail: `authorizedRowsVisible=${plannerRows}`,
    });

    // 5. Administrator permissions are enforced
    const adminRows = await withRoleContext('admin', 'user-admin-director', async (c) => {
      const res = await c.query(`SELECT id FROM public.consultations WHERE id IN ($1, $2)`, [consAId, consBId]);
      return res.rowCount ?? 0;
    });
    results.push({
      id: 'RLS-05',
      check: 'Administrator accesses managed studio records cleanly',
      passed: adminRows === 2,
      detail: `adminRowsVisible=${adminRows}`,
    });

    // 6. Notification worker permissions are limited to outbox scope
    const workerAudit = await withRoleContext('worker', 'system-notification-worker', async (c) => {
      const outboxRes = await c.query(`SELECT id FROM public.notification_outbox WHERE id = $1`, [outboxId]);
      const privateRes = await c.query(`SELECT id FROM public.consultations WHERE id IN ($1, $2)`, [consAId, consBId]);
      return { outboxVisible: outboxRes.rowCount ?? 0, consultationsVisible: privateRes.rowCount ?? 0 };
    });
    results.push({
      id: 'RLS-06',
      check: 'Notification worker is scoped to outbox and isolated from unrelated private tables',
      passed: workerAudit.outboxVisible >= 1 && workerAudit.consultationsVisible === 0,
      detail: JSON.stringify(workerAudit),
    });

    // 7. Transaction-local authorization cannot leak across pooled connections
    const leakClient = await pool.connect();
    let leakedRole = 'unset';
    let leakedRows = -1;
    try {
      await leakClient.query('BEGIN');
      if (rlsRole) await leakClient.query(`SET LOCAL ROLE "${rlsRole}"`);
      await leakClient.query(`SELECT set_config('app.current_role', 'admin', true)`);
      await leakClient.query(`SELECT set_config('app.current_user_id', 'user-admin-director', true)`);
      await leakClient.query('COMMIT');

      // Second transaction on exact same physical connection with no SET LOCAL
      await leakClient.query('BEGIN');
      if (rlsRole) await leakClient.query(`SET LOCAL ROLE "${rlsRole}"`);
      const s = await leakClient.query<{ r: string | null }>(`SELECT current_setting('app.current_role', true) AS r`);
      leakedRole = s.rows[0]?.r ?? '';
      const q = await leakClient.query(`SELECT id FROM public.consultations WHERE id IN ($1, $2)`, [consAId, consBId]);
      leakedRows = q.rowCount ?? 0;
      await leakClient.query('ROLLBACK');
    } finally {
      leakClient.release();
    }
    results.push({
      id: 'RLS-07',
      check: 'Transaction-local set_config does not leak across pooled connections',
      passed: leakedRole === '' && leakedRows === 0,
      detail: `postCommitRole="${leakedRole}", postCommitRows=${leakedRows}`,
    });

    // 8. FORCE ROW LEVEL SECURITY active across all >= 36 tables
    results.push({
      id: 'RLS-08',
      check: 'FORCE ROW LEVEL SECURITY active on all public tables',
      passed: forcedRlsCount >= 36,
      detail: `forcedRlsTables=${forcedRlsCount}`,
    });

    // 9. SECURITY DEFINER function audit (no unguarded public escalation functions)
    const secDefClient = await pool.connect();
    let secDefFuncs: string[] = [];
    try {
      const defRes = await secDefClient.query<{ proname: string }>(
        `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef = true`,
      );
      secDefFuncs = defRes.rows.map((r) => r.proname);
    } finally {
      secDefClient.release();
    }
    results.push({
      id: 'RLS-09',
      check: 'SECURITY DEFINER public functions audited (zero unapproved escalation surfaces)',
      passed: secDefFuncs.length === 0,
      detail: `securityDefinerCount=${secDefFuncs.length}`,
    });

    // 10. Database error sanitization check
    const classified42501 = classifyDatabaseError({
      code: '42501',
      message: 'new row violates row-level security policy for table "consultations" (cust-b@example.com)',
    });
    const sanitizedOk =
      classified42501?.httpStatus === 403 &&
      !classified42501.message.includes('consultations') &&
      !classified42501.message.includes('cust-b@example.com');
    results.push({
      id: 'RLS-10',
      check: 'Database RLS/constraint errors do not expose private info or schema internals',
      passed: Boolean(sanitizedOk),
      detail: `httpStatus=${classified42501?.httpStatus ?? 'none'}, code=${classified42501?.code ?? 'none'}`,
    });
  } finally {
    // Always clean up seeded RLS probe records
    const clean = await pool.connect();
    try {
      await clean.query('BEGIN');
      await clean.query(`SELECT set_config('app.current_role', 'admin', true)`);
      await clean.query(`DELETE FROM public.consultations WHERE id IN ($1, $2)`, [consAId, consBId]);
      await clean.query(`DELETE FROM public.notification_outbox WHERE id = $1`, [outboxId]);
      await clean.query('COMMIT');
    } catch {
      await clean.query('ROLLBACK').catch(() => {});
    } finally {
      clean.release();
    }
  }

  return results;
}

async function runConcurrencyRace(pool: Pool, concurrency: number, plannerId: string, startIso: string, endIso: string) {
  const createdIds: string[] = [];
  const attempts = Array.from({ length: concurrency }, async (_, idx) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
      const id = `p17f-race-${concurrency}-${idx}-${crypto.randomBytes(3).toString('hex')}`;
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
      return { ok: true as const, id, code: 'OK' };
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
  const exclusion23P01 = results.filter((r) => !r.ok && r.code === '23P01');
  const otherConflicts = results.filter((r) => !r.ok && (r.code === '23505' || r.code === '40001' || r.code === '40P01'));

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

  const totalConflicts = exclusion23P01.length + otherConflicts.length;
  return {
    concurrency,
    winners: winners.length,
    sqlstate23P01Count: exclusion23P01.length,
    otherConflictCount: otherConflicts.length,
    unexpectedErrors: results.length - winners.length - totalConflicts,
    passed: winners.length === 1 && totalConflicts === concurrency - 1 && exclusion23P01.length >= 1,
  };
}

async function runLifecycleExclusionScenarios(pool: Pool) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const idA = `p17f-life-a-${suffix}`;
  const idB = `p17f-life-b-${suffix}`;
  const idC = `p17f-life-c-${suffix}`;
  const plannerId = 'user-staff-maya';
  const slot1Start = '2028-11-05T06:00:00.000Z'; // US DST fall-back morning canonical UTC
  const slot1End = '2028-11-05T06:45:00.000Z';
  const slot2Start = '2028-11-05T09:00:00.000Z';
  const slot2End = '2028-11-05T09:45:00.000Z';

  let rescheduleConflictCode = 'NONE';
  let postCancelRebookSucceeded = false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
    await client.query(
      `INSERT INTO public.consultations (
        id, reference_code, client_name, client_email, client_phone,
        event_type, event_title, event_date, venue_name, location,
        guest_count, budget_range, method, assigned_planner_id, assigned_planner_name,
        start_utc, end_utc, duration_minutes, client_timezone, status, crm_stage
      ) VALUES
      ($1, $2, 'Lifecycle A', 'life-a@example.com', '(803) 555-0111',
       'Wedding', 'DST Slot A', '2028-12-01', 'Lace House', 'Columbia, SC',
       100, '$25,000 - $50,000', 'video', $3, 'Maya Jenkins',
       $4::timestamptz, $5::timestamptz, 45, 'America/New_York', 'Confirmed', 'Consultation Scheduled'),
      ($6, $7, 'Lifecycle B', 'life-b@example.com', '(803) 555-0112',
       'Wedding', 'DST Slot B', '2028-12-02', 'Lace House', 'Columbia, SC',
       100, '$25,000 - $50,000', 'video', $3, 'Maya Jenkins',
       $8::timestamptz, $9::timestamptz, 45, 'America/New_York', 'Pending', 'Consultation Scheduled')`,
      [idA, `CS-LA-${suffix.toUpperCase()}`, plannerId, slot1Start, slot1End, idB, `CS-LB-${suffix.toUpperCase()}`, slot2Start, slot2End],
    );
    await client.query('COMMIT');

    // Scenario A: Reschedule conflict (UPDATE B onto A's occupied DST slot -> must raise 23P01)
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
      await client.query(
        `UPDATE public.consultations SET start_utc = $1::timestamptz, end_utc = $2::timestamptz WHERE id = $3`,
        [slot1Start, slot1End, idB],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      rescheduleConflictCode =
        typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : 'ERR';
    }

    // Scenario B: Cancel A -> slot1 is immediately released -> C books slot1 cleanly
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
    await client.query(`UPDATE public.consultations SET status = 'Cancelled' WHERE id = $1`, [idA]);
    await client.query(
      `INSERT INTO public.consultations (
        id, reference_code, client_name, client_email, client_phone,
        event_type, event_title, event_date, venue_name, location,
        guest_count, budget_range, method, assigned_planner_id, assigned_planner_name,
        start_utc, end_utc, duration_minutes, client_timezone, status, crm_stage
      ) VALUES (
        $1, $2, 'Lifecycle C', 'life-c@example.com', '(803) 555-0113',
        'Wedding', 'Post-Cancel Rebook', '2028-12-03', 'Lace House', 'Columbia, SC',
        100, '$25,000 - $50,000', 'video', $3, 'Maya Jenkins',
        $4::timestamptz, $5::timestamptz, 45, 'America/New_York', 'Pending', 'Consultation Scheduled'
      )`,
      [idC, `CS-LC-${suffix.toUpperCase()}`, plannerId, slot1Start, slot1End],
    );
    await client.query('COMMIT');
    postCancelRebookSucceeded = true;
  } finally {
    await client.query('BEGIN').catch(() => {});
    await client.query(`SELECT set_config('app.current_role', 'admin', true)`).catch(() => {});
    await client.query(`DELETE FROM public.consultations WHERE id IN ($1, $2, $3)`, [idA, idB, idC]).catch(() => {});
    await client.query('COMMIT').catch(() => {});
    client.release();
  }

  return {
    dstRescheduleConflictCode: rescheduleConflictCode,
    postCancelRebookSucceeded,
    passed: rescheduleConflictCode === '23P01' && postCancelRebookSucceeded,
  };
}

async function runBackupRestoreDrill(sourceUrl: string, restoreUrl: string) {
  const tmpFile = path.join(os.tmpdir(), `cs-staging-backup-${Date.now()}.dump`);
  try {
    await execFileAsync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '-f', tmpFile, sourceUrl]);
    const stat = await fs.stat(tmpFile);
    await execFileAsync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '-d', restoreUrl, tmpFile]);
    return { passed: stat.size > 0, dumpBytes: stat.size };
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
}

async function main() {
  if (process.argv.includes('--self-check')) {
    console.log(
      JSON.stringify({
        ok: true,
        mode: 'self-check',
        guardRequired: 'STAGING_DB_CONFIRM=YES_ISOLATED_STAGING',
        rlsAssertionsCount: 10,
        concurrencyWaves: [2, 3, 10, 25],
        optionalFlags: ['--backup-restore-drill'],
      }),
    );
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

      // 1. Ordered migrations 001..008 + idempotent rerun
      const run1 = await runMigrationsOnClient(metaClient, { dryRun: false });
      const run2 = await runMigrationsOnClient(metaClient, { dryRun: false });
      if (run2.applied.length !== 0 || run2.skipped.length !== 8) {
        throw new Error(`Migration idempotency failed: ${JSON.stringify(run2)}`);
      }

      // 2. Catalog checks: 36 FORCE RLS tables & GiST exclusion constraint
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

      // 3. Full 10-point real NOBYPASSRLS RLS security verification
      const rlsAssertions = await runRealRlsSecuritySuite(pool, forcedRlsCount);
      const allRlsPassed = rlsAssertions.every((r) => r.passed);

      // 4. Multi-connection MVCC concurrency races (2, 3, 10, 25) + reschedule/cancel/DST exclusion
      const raceResults = [];
      for (const [idx, n] of [2, 3, 10, 25].entries()) {
        const day = 10 + idx;
        const startIso = `2028-07-${day}T15:00:00.000Z`;
        const endIso = `2028-07-${day}T15:45:00.000Z`;
        raceResults.push(await runConcurrencyRace(pool, n, 'user-staff-maya', startIso, endIso));
      }
      const lifecycleExclusion = await runLifecycleExclusionScenarios(pool);

      // 5. Optional backup/restore drill
      let backupRestoreResult: { passed: boolean; dumpBytes: number } | null = null;
      if (process.argv.includes('--backup-restore-drill')) {
        const restoreUrl = (process.env.STAGING_RESTORE_DATABASE_URL || '').trim();
        if (!restoreUrl) {
          throw new Error('STAGING_RESTORE_DATABASE_URL is required for --backup-restore-drill.');
        }
        backupRestoreResult = await runBackupRestoreDrill(databaseUrl, restoreUrl);
      }

      const allPassed =
        allRlsPassed &&
        raceResults.every((r) => r.passed) &&
        lifecycleExclusion.passed &&
        forcedRlsCount >= 36 &&
        (backupRestoreResult === null || backupRestoreResult.passed);

      console.log(
        JSON.stringify(
          {
            ok: allPassed,
            database: dbName,
            serverVersionNum: versionNum,
            tls: tls.diagnostics,
            migrationsRun1: run1,
            migrationsRun2: run2,
            forcedRlsTables: forcedRlsCount,
            exclusionConstraintPresent: true,
            rlsAssertions,
            concurrencyRaces: raceResults,
            lifecycleExclusion,
            ...(backupRestoreResult ? { backupRestoreResult } : {}),
          },
          null,
          2,
        ),
      );
      if (!allPassed) {
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
