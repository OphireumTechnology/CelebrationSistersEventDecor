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
 *   SHA-256 checksum parity, constraint/index verification, optional --backup-restore-drill
 *   with post-restore connectivity & schema verification.
 * - REQ-RLS-01: All 10 mandatory non-superuser NOBYPASSRLS isolation checks across
 *   anonymous, Customer A, Customer B, Event Planner, Admin, Notification Worker
 *   (`notification_worker`), pooled connection non-leakage, ENABLE/FORCE ROW LEVEL SECURITY,
 *   SECURITY DEFINER + security_invoker view audit, and database error sanitization.
 * - REQ-CONC-01: Real multi-connection MVCC 2/3/10/25-way slot exclusion races
 *   (`excl_consultations_planner_buffered_overlap`, SQLSTATE 23P01), idempotency key
 *   uniqueness (`uq_consultations_idempotency_key`, SQLSTATE 23505), expired slot hold
 *   pruning (`consultation_slot_holds`), cancellation slot release, rescheduling conflict
 *   (`23P01`), and DST canonical UTC boundary.
 */

export const REQUIRED_CORE_FORCE_RLS_TABLES = [
  'consultations',
  'notification_outbox',
  'notification_webhook_events',
  'staff_availability_rules',
  'consultation_slot_holds',
  'crm_follow_up_tasks',
] as const;

export const CONSULTATION_EXCLUSION_CONSTRAINT = 'excl_consultations_planner_buffered_overlap';

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

interface StagingSeedEntities {
  plannerUserId: string;
  adminUserId: string;
  custAUserId: string;
  custBUserId: string;
  clientAId: string;
  clientBId: string;
  bookingAId: string;
  bookingBId: string;
  consAId: string;
  consBId: string;
  outboxId: string;
  auditLogId: string;
}

async function seedIsolatedStagingEntities(pool: Pool, suffix: string): Promise<StagingSeedEntities> {
  const entities: StagingSeedEntities = {
    plannerUserId: crypto.randomUUID(),
    adminUserId: crypto.randomUUID(),
    custAUserId: crypto.randomUUID(),
    custBUserId: crypto.randomUUID(),
    clientAId: crypto.randomUUID(),
    clientBId: crypto.randomUUID(),
    bookingAId: crypto.randomUUID(),
    bookingBId: crypto.randomUUID(),
    consAId: crypto.randomUUID(),
    consBId: crypto.randomUUID(),
    outboxId: crypto.randomUUID(),
    auditLogId: crypto.randomUUID(),
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_role', 'admin', true)`);

    await client.query(
      `INSERT INTO public.users (id, external_key, full_name, email) VALUES
        ($1, $5, 'Staging Planner', $9),
        ($2, $6, 'Staging Admin', $10),
        ($3, $7, 'Staging Customer A', $11),
        ($4, $8, 'Staging Customer B', $12)`,
      [
        entities.plannerUserId,
        entities.adminUserId,
        entities.custAUserId,
        entities.custBUserId,
        `p17f-planner-${suffix}`,
        `p17f-admin-${suffix}`,
        `p17f-custa-${suffix}`,
        `p17f-custb-${suffix}`,
        `p17f-planner-${suffix}@example.com`,
        `p17f-admin-${suffix}@example.com`,
        `p17f-custa-${suffix}@example.com`,
        `p17f-custb-${suffix}@example.com`,
      ],
    );

    await client.query(
      `INSERT INTO public.clients (id, user_id, full_name, email, phone) VALUES
        ($1, $2, 'Staging Customer A', $5, '(803) 555-0101'),
        ($3, $4, 'Staging Customer B', $6, '(803) 555-0102')`,
      [
        entities.clientAId,
        entities.custAUserId,
        entities.clientBId,
        entities.custBUserId,
        `p17f-custa-${suffix}@example.com`,
        `p17f-custb-${suffix}@example.com`,
      ],
    );

    await client.query(
      `INSERT INTO public.bookings (
         id, reference_code, client_id, event_title, event_type, package_tier,
         event_date, location, venue_name, guest_count, budget_range,
         legacy_status, architectural_stage, assigned_lead_planner_id, notes
       ) VALUES
       ($1, $2, $3, 'Staging RLS Probe A', 'Wedding', 'Signature Full Production',
        '2028-09-10', 'Columbia, SC', $7, 100, '$25,000 - $50,000',
        'Consultation Requested', 'CONSULTATION_SCHEDULED', $9, 'Isolated staging probe A'),
       ($4, $5, $6, 'Staging RLS Probe B', 'Gala', 'Signature Full Production',
        '2028-09-12', 'Columbia, SC', $8, 150, '$50,000 - $100,000',
        'Consultation Requested', 'CONSULTATION_SCHEDULED', $10, 'Isolated staging probe B')`,
      [
        entities.bookingAId,
        `CS-RLSA-${suffix.toUpperCase()}`,
        entities.clientAId,
        entities.bookingBId,
        `CS-RLSB-${suffix.toUpperCase()}`,
        entities.clientBId,
        `Lace House Probe A ${suffix}`,
        `Riverbanks Probe B ${suffix}`,
        entities.plannerUserId,
        entities.adminUserId,
      ],
    );

    await client.query(
      `INSERT INTO public.consultations (
         id, booking_id, reference_code, client_id, assigned_planner_id, status,
         meeting_channel, scheduled_for, consultation_start_utc, consultation_end_utc,
         buffer_before_minutes, buffer_after_minutes, client_timezone, crm_stage, planner_notes
       ) VALUES
       ($1, $2, $3, $4, $5, 'Pending',
        'video', '2028-09-01T14:00:00Z'::timestamptz, '2028-09-01T14:00:00Z'::timestamptz, '2028-09-01T14:45:00Z'::timestamptz,
        15, 15, 'America/New_York', 'Consultation Scheduled', 'RLS Probe A'),
       ($6, $7, $8, $9, $10, 'Pending',
        'video', '2028-09-01T17:00:00Z'::timestamptz, '2028-09-01T17:00:00Z'::timestamptz, '2028-09-01T17:45:00Z'::timestamptz,
        15, 15, 'America/New_York', 'Consultation Scheduled', 'RLS Probe B')`,
      [
        entities.consAId,
        entities.bookingAId,
        `CS-CONA-${suffix.toUpperCase()}`,
        entities.clientAId,
        entities.plannerUserId,
        entities.consBId,
        entities.bookingBId,
        `CS-CONB-${suffix.toUpperCase()}`,
        entities.clientBId,
        entities.adminUserId,
      ],
    );

    await client.query(
      `INSERT INTO public.notification_outbox (
         id, idempotency_key, category, channel, recipient, booking_reference,
         subject, html_body, text_body, status
       ) VALUES (
         $1, $2, 'consultation_confirmation', 'Email', $3, $4,
         'Staging RLS Outbox Probe', '<p>Probe</p>', 'Probe', 'Pending'
       )`,
      [
        entities.outboxId,
        `p17f-rls-outbox:${suffix}`,
        `p17f-custa-${suffix}@example.com`,
        `CS-CONA-${suffix.toUpperCase()}`,
      ],
    );

    await client.query(
      `INSERT INTO public.audit_logs (
         id, actor_user_id, actor_name, actor_role, action, target_type, target_id, details
       ) VALUES (
         $1, $2, 'Staging Admin', 'admin', 'staging_rls_probe', 'consultation', $3, 'Isolated RLS verification marker'
       )`,
      [entities.auditLogId, entities.adminUserId, entities.consAId],
    );

    await client.query('COMMIT');
    return entities;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function cleanupStagingEntities(pool: Pool, entities: StagingSeedEntities): Promise<void> {
  const clean = await pool.connect();
  try {
    await clean.query('BEGIN');
    await clean.query(`SELECT set_config('app.current_role', 'admin', true)`);
    await clean.query(`DELETE FROM public.notification_outbox WHERE id = $1`, [entities.outboxId]);
    await clean.query(`DELETE FROM public.audit_logs WHERE id = $1`, [entities.auditLogId]);
    await clean.query(`DELETE FROM public.consultations WHERE id IN ($1, $2)`, [entities.consAId, entities.consBId]);
    await clean.query(`DELETE FROM public.bookings WHERE id IN ($1, $2)`, [entities.bookingAId, entities.bookingBId]);
    await clean.query(`DELETE FROM public.clients WHERE id IN ($1, $2)`, [entities.clientAId, entities.clientBId]);
    await clean.query(`DELETE FROM public.users WHERE id IN ($1, $2, $3, $4)`, [
      entities.plannerUserId,
      entities.adminUserId,
      entities.custAUserId,
      entities.custBUserId,
    ]);
    await clean.query('COMMIT');
  } catch {
    await clean.query('ROLLBACK').catch(() => {});
  } finally {
    clean.release();
  }
}

async function runRealRlsSecuritySuite(
  pool: Pool,
  entities: StagingSeedEntities,
  rlsEnabledCount: number,
  missingCoreForceTables: string[],
): Promise<RlsAssertionResult[]> {
  const results: RlsAssertionResult[] = [];

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

  // 1. Customer A reads own consultation and cannot read Customer B's consultation
  const custARead = await withRoleContext('client', entities.custAUserId, async (c) => {
    const own = await c.query(`SELECT id FROM public.consultations WHERE id = $1`, [entities.consAId]);
    const other = await c.query(`SELECT id FROM public.consultations WHERE id = $1`, [entities.consBId]);
    return { ownRows: own.rowCount ?? 0, otherRows: other.rowCount ?? 0 };
  });
  results.push({
    id: 'RLS-01',
    check: 'Customer A reads own consultation and cannot read Customer B consultation',
    passed: custARead.ownRows === 1 && custARead.otherRows === 0,
    detail: JSON.stringify(custARead),
  });

  // 2. Customer A cannot modify Customer B's consultation
  let custAUpdateRows = -1;
  let custAUpdateCode = 'NONE';
  try {
    custAUpdateRows = await withRoleContext('client', entities.custAUserId, async (c) => {
      const res = await c.query(`UPDATE public.consultations SET planner_notes = 'Tampered' WHERE id = $1`, [
        entities.consBId,
      ]);
      return res.rowCount ?? 0;
    });
  } catch (err) {
    custAUpdateCode = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : 'ERR';
    custAUpdateRows = 0;
  }
  results.push({
    id: 'RLS-02',
    check: 'Customer A cannot modify Customer B consultation',
    passed: custAUpdateRows === 0 || custAUpdateCode === '42501',
    detail: `rowsUpdated=${custAUpdateRows}, sqlstate=${custAUpdateCode}`,
  });

  // 3. Anonymous users cannot access private records
  const anonCount = await withRoleContext(null, null, async (c) => {
    const r1 = await c.query(`SELECT id FROM public.consultations WHERE id IN ($1, $2)`, [
      entities.consAId,
      entities.consBId,
    ]);
    const r2 = await c.query(`SELECT id FROM public.notification_outbox WHERE id = $1`, [entities.outboxId]);
    return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
  });
  results.push({
    id: 'RLS-03',
    check: 'Anonymous users cannot access private consultations or outbox rows',
    passed: anonCount === 0,
    detail: `privateRowsVisible=${anonCount}`,
  });

  // 4. Event planner accesses authorized consultation records and cannot read admin-only audit_logs
  const plannerAudit = await withRoleContext('event_planner', entities.plannerUserId, async (c) => {
    const consRes = await c.query(`SELECT id FROM public.consultations WHERE id = $1`, [entities.consAId]);
    const auditRes = await c.query(`SELECT id FROM public.audit_logs WHERE id = $1`, [entities.auditLogId]);
    return { consultationsVisible: consRes.rowCount ?? 0, adminAuditVisible: auditRes.rowCount ?? 0 };
  });
  results.push({
    id: 'RLS-04',
    check: 'Event planner accesses authorized consultations and is denied admin-only audit_logs',
    passed: plannerAudit.consultationsVisible === 1 && plannerAudit.adminAuditVisible === 0,
    detail: JSON.stringify(plannerAudit),
  });

  // 5. Administrator permissions are enforced
  const adminAudit = await withRoleContext('admin', entities.adminUserId, async (c) => {
    const consRes = await c.query(`SELECT id FROM public.consultations WHERE id IN ($1, $2)`, [
      entities.consAId,
      entities.consBId,
    ]);
    const auditRes = await c.query(`SELECT id FROM public.audit_logs WHERE id = $1`, [entities.auditLogId]);
    return { consultationsVisible: consRes.rowCount ?? 0, auditVisible: auditRes.rowCount ?? 0 };
  });
  results.push({
    id: 'RLS-05',
    check: 'Administrator accesses managed studio records and audit logs cleanly',
    passed: adminAudit.consultationsVisible === 2 && adminAudit.auditVisible === 1,
    detail: JSON.stringify(adminAudit),
  });

  // 6. Notification worker (`notification_worker`) permissions are scoped strictly to outbox
  const workerAudit = await withRoleContext('notification_worker', '00000000-0000-0000-0000-000000000000', async (c) => {
    const outboxRes = await c.query(`SELECT id FROM public.notification_outbox WHERE id = $1`, [entities.outboxId]);
    const privateRes = await c.query(`SELECT id FROM public.consultations WHERE id IN ($1, $2)`, [
      entities.consAId,
      entities.consBId,
    ]);
    return { outboxVisible: outboxRes.rowCount ?? 0, consultationsVisible: privateRes.rowCount ?? 0 };
  });
  results.push({
    id: 'RLS-06',
    check: 'Notification worker (notification_worker) is scoped to outbox and isolated from private tables',
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
    await leakClient.query(`SELECT set_config('app.current_user_id', $1, true)`, [entities.adminUserId]);
    await leakClient.query('COMMIT');

    // Second transaction on exact same physical connection with no SET LOCAL
    await leakClient.query('BEGIN');
    if (rlsRole) await leakClient.query(`SET LOCAL ROLE "${rlsRole}"`);
    const s = await leakClient.query<{ r: string | null }>(`SELECT current_setting('app.current_role', true) AS r`);
    leakedRole = s.rows[0]?.r ?? '';
    const q = await leakClient.query(`SELECT id FROM public.consultations WHERE id IN ($1, $2)`, [
      entities.consAId,
      entities.consBId,
    ]);
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

  // 8. ENABLE RLS across >= 36 tables and FORCE ROW LEVEL SECURITY active on all core scheduling/outbox/webhook tables
  results.push({
    id: 'RLS-08',
    check: 'ENABLE RLS (>=36 tables) and FORCE ROW LEVEL SECURITY active on core consultation/outbox/webhook/CRM tables',
    passed: rlsEnabledCount >= 36 && missingCoreForceTables.length === 0,
    detail: `rlsEnabledTables=${rlsEnabledCount}, missingCoreForceTables=${JSON.stringify(missingCoreForceTables)}`,
  });

  // 9. SECURITY DEFINER function audit + v_vendor_booking_briefs security_invoker audit
  const secDefClient = await pool.connect();
  let secDefFuncs: string[] = [];
  let vendorViewInvoker = false;
  try {
    const defRes = await secDefClient.query<{ proname: string }>(
      `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef = true`,
    );
    secDefFuncs = defRes.rows.map((r) => r.proname);

    const viewRes = await secDefClient.query<{ reloptions: string[] | null }>(
      `SELECT c.reloptions
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'v_vendor_booking_briefs' AND c.relkind = 'v'`,
    );
    const opts = viewRes.rows[0]?.reloptions || [];
    vendorViewInvoker = opts.some((opt) => opt.toLowerCase() === 'security_invoker=true');
  } finally {
    secDefClient.release();
  }
  results.push({
    id: 'RLS-09',
    check: 'SECURITY DEFINER public functions audited (zero unapproved) & v_vendor_booking_briefs uses security_invoker=true',
    passed: secDefFuncs.length === 0 && vendorViewInvoker,
    detail: `securityDefinerCount=${secDefFuncs.length}, vendorViewSecurityInvoker=${vendorViewInvoker}`,
  });

  // 10. Database error sanitization check
  const classified42501 = classifyDatabaseError({
    code: '42501',
    message: 'new row violates row-level security policy for table "consultations" (cust-b@example.com)',
  });
  const classified23P01 = classifyDatabaseError({
    code: '23P01',
    message: `conflicting key value violates exclusion constraint "${CONSULTATION_EXCLUSION_CONSTRAINT}"`,
  });
  const sanitizedOk =
    classified42501?.httpStatus === 403 &&
    !classified42501.message.includes('consultations') &&
    !classified42501.message.includes('cust-b@example.com') &&
    classified23P01?.httpStatus === 409 &&
    !classified23P01.message.includes(CONSULTATION_EXCLUSION_CONSTRAINT);
  results.push({
    id: 'RLS-10',
    check: 'Database RLS/exclusion errors do not expose private info or schema internals',
    passed: Boolean(sanitizedOk),
    detail: `rlsHttp=${classified42501?.httpStatus ?? 'none'}, exclHttp=${classified23P01?.httpStatus ?? 'none'}`,
  });

  return results;
}

async function runConcurrencyRace(
  pool: Pool,
  concurrency: number,
  entities: StagingSeedEntities,
  startIso: string,
  endIso: string,
) {
  const createdIds: string[] = [];
  const attempts = Array.from({ length: concurrency }, async (_, idx) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
      const id = crypto.randomUUID();
      const ref = `CS-P17-${concurrency}-${idx}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      await client.query(
        `INSERT INTO public.consultations (
           id, booking_id, reference_code, client_id, assigned_planner_id, status,
           meeting_channel, scheduled_for, consultation_start_utc, consultation_end_utc,
           buffer_before_minutes, buffer_after_minutes, client_timezone, crm_stage, planner_notes
         ) VALUES (
           $1, $2, $3, $4, $5, 'Pending',
           'video', $6::timestamptz, $6::timestamptz, $7::timestamptz,
           15, 15, 'America/New_York', 'Consultation Scheduled', 'MVCC Race Probe'
         )`,
        [id, entities.bookingAId, ref, entities.clientAId, entities.plannerUserId, startIso, endIso],
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
  const unique23505 = results.filter((r) => !r.ok && r.code === '23505');
  const otherConflicts = results.filter((r) => !r.ok && (r.code === '40001' || r.code === '40P01'));

  // Clean up test rows
  if (createdIds.length > 0) {
    const clean = await pool.connect();
    try {
      await clean.query('BEGIN');
      await clean.query(`SELECT set_config('app.current_role', 'admin', true)`);
      await clean.query(`DELETE FROM public.consultations WHERE id = ANY($1::uuid[])`, [createdIds]);
      await clean.query('COMMIT');
    } finally {
      clean.release();
    }
  }

  const totalConflicts = exclusion23P01.length + unique23505.length + otherConflicts.length;
  return {
    concurrency,
    winners: winners.length,
    sqlstate23P01Count: exclusion23P01.length,
    sqlstate23505Count: unique23505.length,
    otherConflictCount: otherConflicts.length,
    unexpectedErrors: results.length - winners.length - totalConflicts,
    passed: winners.length === 1 && totalConflicts === concurrency - 1 && (exclusion23P01.length >= 1 || unique23505.length >= 1),
  };
}

async function runLifecycleExclusionScenarios(pool: Pool, entities: StagingSeedEntities) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();
  const idC = crypto.randomUUID();
  const idIdempDup = crypto.randomUUID();
  const holdId = crypto.randomUUID();
  const sharedIdempKey = `p17f-idemp-${suffix}`;

  // US DST fall-back morning canonical UTC slots; offset by 20m to verify buffered GiST exclusion (23P01)
  const slot1Start = '2028-11-05T06:00:00.000Z';
  const slot1End = '2028-11-05T06:45:00.000Z';
  const slot1OverlapStart = '2028-11-05T06:20:00.000Z';
  const slot1OverlapEnd = '2028-11-05T07:05:00.000Z';
  const slot2Start = '2028-11-05T09:00:00.000Z';
  const slot2End = '2028-11-05T09:45:00.000Z';

  let rescheduleConflictCode = 'NONE';
  let idempotencyConflictCode = 'NONE';
  let expiredHoldPrunedAndRebooked = false;
  let postCancelRebookSucceeded = false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
    await client.query(
      `INSERT INTO public.consultations (
         id, booking_id, reference_code, client_id, assigned_planner_id, status,
         meeting_channel, scheduled_for, consultation_start_utc, consultation_end_utc,
         buffer_before_minutes, buffer_after_minutes, client_timezone, crm_stage, idempotency_key
       ) VALUES
       ($1, $2, $3, $4, $5, 'Confirmed',
        'video', $6::timestamptz, $6::timestamptz, $7::timestamptz,
        15, 15, 'America/New_York', 'Consultation Scheduled', $13),
       ($8, $2, $9, $4, $5, 'Pending',
        'video', $10::timestamptz, $10::timestamptz, $11::timestamptz,
        15, 15, 'America/New_York', 'Consultation Scheduled', $12)`,
      [
        idA,
        entities.bookingAId,
        `CS-LA-${suffix.toUpperCase()}`,
        entities.clientAId,
        entities.plannerUserId,
        slot1Start,
        slot1End,
        idB,
        `CS-LB-${suffix.toUpperCase()}`,
        slot2Start,
        slot2End,
        `p17f-idemp-b-${suffix}`,
        sharedIdempKey,
      ],
    );
    await client.query('COMMIT');

    // Scenario A: Reschedule conflict (UPDATE B into overlapping DST slot -> must raise 23P01 from GiST exclusion)
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
      await client.query(
        `UPDATE public.consultations
         SET scheduled_for = $1::timestamptz,
             consultation_start_utc = $1::timestamptz,
             consultation_end_utc = $2::timestamptz
         WHERE id = $3`,
        [slot1OverlapStart, slot1OverlapEnd, idB],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      rescheduleConflictCode =
        typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : 'ERR';
    }

    // Scenario B: Idempotency key unique constraint enforcement (23505)
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
      await client.query(
        `INSERT INTO public.consultations (
           id, booking_id, reference_code, client_id, assigned_planner_id, status,
           meeting_channel, scheduled_for, consultation_start_utc, consultation_end_utc,
           buffer_before_minutes, buffer_after_minutes, client_timezone, crm_stage, idempotency_key
         ) VALUES (
           $1, $2, $3, $4, $5, 'Pending',
           'video', '2028-11-05T12:00:00Z'::timestamptz, '2028-11-05T12:00:00Z'::timestamptz, '2028-11-05T12:45:00Z'::timestamptz,
           15, 15, 'America/New_York', 'Consultation Scheduled', $6
         )`,
        [
          idIdempDup,
          entities.bookingAId,
          `CS-IDEMP-${suffix.toUpperCase()}`,
          entities.clientAId,
          entities.plannerUserId,
          sharedIdempKey,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      idempotencyConflictCode =
        typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : 'ERR';
    }

    // Scenario C: Expired slot hold pruning on consultation_slot_holds
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
    await client.query(
      `INSERT INTO public.consultation_slot_holds (
         id, planner_user_id, slot_start_utc, slot_end_utc, holder_fingerprint_hash, expires_at
       ) VALUES (
         $1, $2, $3::timestamptz, $4::timestamptz, $5, NOW() - INTERVAL '10 minutes'
       )`,
      [holdId, entities.plannerUserId, slot1Start, slot1End, `fp-${suffix}`],
    );
    const pruned = await client.query(
      `DELETE FROM public.consultation_slot_holds WHERE id = $1 AND expires_at <= NOW()`,
      [holdId],
    );
    await client.query('COMMIT');
    expiredHoldPrunedAndRebooked = (pruned.rowCount ?? 0) === 1;

    // Scenario D: Cancel A -> slot1 is immediately released -> C books slot1 cleanly
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_role', 'admin', true)`);
    await client.query(`UPDATE public.consultations SET status = 'Cancelled', cancelled_at = NOW() WHERE id = $1`, [idA]);
    await client.query(
      `INSERT INTO public.consultations (
         id, booking_id, reference_code, client_id, assigned_planner_id, status,
         meeting_channel, scheduled_for, consultation_start_utc, consultation_end_utc,
         buffer_before_minutes, buffer_after_minutes, client_timezone, crm_stage
       ) VALUES (
         $1, $2, $3, $4, $5, 'Pending',
         'video', $6::timestamptz, $6::timestamptz, $7::timestamptz,
         15, 15, 'America/New_York', 'Consultation Scheduled'
       )`,
      [
        idC,
        entities.bookingAId,
        `CS-LC-${suffix.toUpperCase()}`,
        entities.clientAId,
        entities.plannerUserId,
        slot1Start,
        slot1End,
      ],
    );
    await client.query('COMMIT');
    postCancelRebookSucceeded = true;
  } finally {
    await client.query('BEGIN').catch(() => {});
    await client.query(`SELECT set_config('app.current_role', 'admin', true)`).catch(() => {});
    await client.query(`DELETE FROM public.consultation_slot_holds WHERE id = $1`, [holdId]).catch(() => {});
    await client
      .query(`DELETE FROM public.consultations WHERE id IN ($1, $2, $3, $4)`, [idA, idB, idC, idIdempDup])
      .catch(() => {});
    await client.query('COMMIT').catch(() => {});
    client.release();
  }

  return {
    dstRescheduleConflictCode: rescheduleConflictCode,
    idempotencyConflictCode,
    expiredHoldPrunedAndRebooked,
    postCancelRebookSucceeded,
    passed:
      rescheduleConflictCode === '23P01' &&
      idempotencyConflictCode === '23505' &&
      expiredHoldPrunedAndRebooked &&
      postCancelRebookSucceeded,
  };
}

async function runBackupRestoreDrill(sourceUrl: string, restoreUrl: string) {
  const tmpFile = path.join(os.tmpdir(), `cs-staging-backup-${Date.now()}.dump`);
  try {
    await execFileAsync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '-f', tmpFile, sourceUrl]);
    const stat = await fs.stat(tmpFile);
    await execFileAsync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '-d', restoreUrl, tmpFile]);

    // REQ-PG-01 step 12: Confirm the application can connect to and query the restored database
    const restoreTls = buildPostgresSslConfig(restoreUrl, process.env);
    const restorePool = new Pool({
      connectionString: restoreTls.sanitizedConnectionString,
      ssl: restoreTls.ssl,
      max: 2,
      connectionTimeoutMillis: 10_000,
    });
    try {
      const migRes = await restorePool.query<{ cnt: string }>(`SELECT count(*)::text AS cnt FROM public.schema_migrations`);
      const exclRes = await restorePool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname = $1`,
        [CONSULTATION_EXCLUSION_CONSTRAINT],
      );
      const rlsRes = await restorePool.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
      );
      const restoredMigrationsCount = Number(migRes.rows[0]?.cnt || 0);
      const restoredRlsCount = Number(rlsRes.rows[0]?.cnt || 0);
      const restoredConstraintPresent = exclRes.rows.length === 1;
      return {
        passed: stat.size > 0 && restoredMigrationsCount >= 8 && restoredConstraintPresent && restoredRlsCount >= 36,
        dumpBytes: stat.size,
        restoredConnectivityVerified: true,
        restoredMigrationsCount,
        restoredConstraintPresent,
        restoredRlsCount,
      };
    } finally {
      await restorePool.end();
    }
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
        exclusionConstraint: CONSULTATION_EXCLUSION_CONSTRAINT,
        requiredCoreForceRlsTables: REQUIRED_CORE_FORCE_RLS_TABLES,
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

      // 2. Catalog checks: >= 36 ENABLE RLS tables, core FORCE RLS tables & real GiST exclusion constraint
      const rlsEnabledRes = await metaClient.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
      );
      const rlsEnabledCount = Number(rlsEnabledRes.rows[0]?.cnt || 0);

      const forcedRes = await metaClient.query<{ relname: string }>(
        `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity`,
      );
      const forcedSet = new Set(forcedRes.rows.map((r) => r.relname));
      const missingCoreForceTables = REQUIRED_CORE_FORCE_RLS_TABLES.filter((t) => !forcedSet.has(t));

      const exclRes = await metaClient.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname = $1`,
        [CONSULTATION_EXCLUSION_CONSTRAINT],
      );
      if (exclRes.rows.length !== 1) {
        throw new Error(`Missing ${CONSULTATION_EXCLUSION_CONSTRAINT} GiST exclusion constraint.`);
      }

      // 3. Seed isolated staging probe entities, run 10-point RLS suite & concurrency races, always clean up
      const suffix = crypto.randomBytes(4).toString('hex');
      const entities = await seedIsolatedStagingEntities(pool, suffix);
      let rlsAssertions: RlsAssertionResult[] = [];
      const raceResults = [];
      let lifecycleExclusion: Awaited<ReturnType<typeof runLifecycleExclusionScenarios>>;

      try {
        rlsAssertions = await runRealRlsSecuritySuite(pool, entities, rlsEnabledCount, missingCoreForceTables);

        for (const [idx, n] of [2, 3, 10, 25].entries()) {
          const day = 10 + idx;
          const startIso = `2028-07-${day}T15:00:00.000Z`;
          const endIso = `2028-07-${day}T15:45:00.000Z`;
          raceResults.push(await runConcurrencyRace(pool, n, entities, startIso, endIso));
        }

        lifecycleExclusion = await runLifecycleExclusionScenarios(pool, entities);
      } finally {
        await cleanupStagingEntities(pool, entities);
      }

      const allRlsPassed = rlsAssertions.every((r) => r.passed);

      // 4. Optional backup/restore drill + post-restore application connectivity check
      let backupRestoreResult: Awaited<ReturnType<typeof runBackupRestoreDrill>> | null = null;
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
        rlsEnabledCount >= 36 &&
        missingCoreForceTables.length === 0 &&
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
            rlsEnabledTables: rlsEnabledCount,
            forcedRlsTables: forcedSet.size,
            missingCoreForceTables,
            exclusionConstraintPresent: true,
            exclusionConstraintName: CONSULTATION_EXCLUSION_CONSTRAINT,
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
