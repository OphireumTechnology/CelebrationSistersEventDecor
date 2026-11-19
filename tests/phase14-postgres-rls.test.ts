import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  PostgresNormalizedRepository,
  type NormalizedConsultationRow,
} from '../server/repositories/normalizedRepository.ts';
import type { PgClientLike, PgPoolLike } from '../server/repositories/postgresRepository.ts';

test('Phase 14 Database: migration 007 enforces Railway PG RLS reconciliation, buffered exclusion constraint, and least-privilege policies', async () => {
  const migrationPath = path.resolve(process.cwd(), 'db/migrations/007_consultation_scheduling_and_railway_rls.sql');
  const sql = await fs.readFile(migrationPath, 'utf8');

  // Railway PostgreSQL safe auth.uid() compatibility (fails closed without disabling RLS)
  assert.match(sql, /to_regprocedure\('auth\.uid\(\)'\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_resolve_provider_uid\(\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_current_user_id\(\)/);
  assert.match(sql, /DROP POLICY IF EXISTS users_self_or_admin_select ON users;/);

  // Concurrency double-booking prevention at database engine layer
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS btree_gist;/);
  assert.match(sql, /excl_consultations_planner_buffered_overlap/);
  assert.match(sql, /uq_consultations_idempotency_key/);
  assert.match(sql, /uq_consultations_reference_code/);
  assert.match(sql, /uq_consultations_active_planner_slot/);

  // New tables + RLS enabled on all of them
  for (const table of ['staff_availability_rules', 'consultation_slot_holds', 'crm_follow_up_tasks']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
  }

  // Schema version tracked
  assert.match(sql, /INSERT INTO schema_migrations \(version, filename\)\s+VALUES \('007'/);
});

test('Phase 14 Database: PostgresNormalizedRepository enforces atomic consultation locking, idempotency, conflict rollback, and SET LOCAL RLS actor context', async () => {
  const sqlLog: string[] = [];
  const storedConsultations: Array<NormalizedConsultationRow & { idempotency_key: string | null; buffer_before_minutes: number; buffer_after_minutes: number }> = [];
  const outboxKeys = new Set<string>();
  let activeActorId = '';
  let activeActorRole = '';

  const mockClient: PgClientLike = {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
      const sql = text.trim().replace(/\s+/g, ' ');
      sqlLog.push(sql);

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 } as unknown as QueryResult<T>;
      }

      if (sql.includes("set_config('app.current_user_id'")) {
        activeActorId = String(values?.[0] ?? '');
        return { rows: [], rowCount: 0 } as unknown as QueryResult<T>;
      }

      if (sql.includes("set_config('app.current_role'")) {
        activeActorRole = String(values?.[0] ?? '');
        return { rows: [], rowCount: 0 } as unknown as QueryResult<T>;
      }

      if (sql.startsWith('SELECT * FROM consultations WHERE idempotency_key = $1')) {
        const key = String(values?.[0] ?? '');
        const match = storedConsultations.filter((c) => c.idempotency_key === key);
        return { rows: match as unknown as T[], rowCount: match.length } as unknown as QueryResult<T>;
      }

      if (sql.startsWith('SELECT id FROM consultations') && sql.includes('FOR UPDATE')) {
        const plannerId = String(values?.[0] ?? '');
        const reqStartMs = new Date(String(values?.[1])).getTime();
        const reqEndMs = new Date(String(values?.[2])).getTime();
        const bufBefore = Number(values?.[3] ?? 15);
        const bufAfter = Number(values?.[4] ?? 15);

        const conflicts = storedConsultations.filter((c) => {
          if (c.assigned_planner_id !== plannerId) return false;
          if (!['Pending', 'Confirmed', 'Rescheduled'].includes(c.status)) return false;
          const cCoreStart = new Date(c.consultation_start_utc).getTime();
          const cCoreEnd = new Date(c.consultation_end_utc).getTime();
          const cBufStart = cCoreStart - c.buffer_before_minutes * 60_000;
          const cBufEnd = cCoreEnd + c.buffer_after_minutes * 60_000;
          const rBufStart = reqStartMs - bufBefore * 60_000;
          const rBufEnd = reqEndMs + bufAfter * 60_000;
          return (reqStartMs < cBufEnd && cBufStart < reqEndMs) || (cCoreStart < rBufEnd && rBufStart < cCoreEnd);
        });
        return {
          rows: conflicts.map((c) => ({ id: c.id })) as unknown as T[],
          rowCount: conflicts.length,
        } as unknown as QueryResult<T>;
      }

      if (sql.startsWith('INSERT INTO consultations')) {
        const row: NormalizedConsultationRow & { idempotency_key: string | null; buffer_before_minutes: number; buffer_after_minutes: number } = {
          id: `con-pg-${storedConsultations.length + 1}`,
          reference_code: String(values?.[0]),
          booking_id: String(values?.[1]),
          client_id: String(values?.[2]),
          assigned_planner_id: String(values?.[3]),
          status: 'Pending',
          meeting_channel: String(values?.[4]),
          consultation_start_utc: String(values?.[5]),
          consultation_end_utc: String(values?.[6]),
          buffer_before_minutes: Number(values?.[7]),
          buffer_after_minutes: Number(values?.[8]),
          client_timezone: String(values?.[9]),
          crm_stage: 'Consultation Scheduled',
          idempotency_key: (values?.[14] as string | null) ?? null,
        };
        storedConsultations.push(row);
        return { rows: [row] as unknown as T[], rowCount: 1 } as unknown as QueryResult<T>;
      }

      if (sql.startsWith('INSERT INTO notification_outbox')) {
        outboxKeys.add(String(values?.[0]));
        return { rows: [], rowCount: 1 } as unknown as QueryResult<T>;
      }

      if (sql.startsWith('SELECT * FROM consultations ORDER BY')) {
        const visible = ['admin', 'staff', 'event_planner'].includes(activeActorRole) ? storedConsultations : [];
        return { rows: visible as unknown as T[], rowCount: visible.length } as unknown as QueryResult<T>;
      }

      if (sql.startsWith('SELECT con.* FROM consultations con')) {
        const userId = String(values?.[0] ?? '');
        const visible = storedConsultations.filter((c) => c.client_id === userId && activeActorId === userId);
        return { rows: visible as unknown as T[], rowCount: visible.length } as unknown as QueryResult<T>;
      }

      return { rows: [], rowCount: 0 } as unknown as QueryResult<T>;
    },
    release() {},
  };

  const mockPool: PgPoolLike = {
    async connect() {
      return mockClient;
    },
    async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      return mockClient.query<T>(text, values);
    },
    async end() {},
  };

  const repo = new PostgresNormalizedRepository(mockPool);
  const nowIso = new Date().toISOString();

  // 1. Atomic creation succeeds and writes outbox atomically
  const first = await repo.createConsultationAtomic({
    bookingId: 'bkg-pg-1',
    clientId: 'user-client-ava',
    referenceCode: 'CS-2026-0901',
    assignedPlannerId: 'user-staff-maya',
    method: 'video',
    startUtc: '2026-11-10T15:00:00.000Z',
    endUtc: '2026-11-10T15:45:00.000Z',
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    clientTimezone: 'America/New_York',
    preferredContactMethod: 'email',
    privacyConsentAt: nowIso,
    privacyConsentVersion: '2026-04-v1',
    accessTokenHash: 'hash-1',
    idempotencyKey: 'pg-consult-idem-1',
    plannerNotes: 'Crystal centerpiece brief',
    outboxJobs: [
      {
        idempotencyKey: 'outbox-pg-1',
        category: 'consultation_confirmation',
        recipient: 'ava@example.com',
        subject: 'Confirmed',
        htmlBody: '<p>Confirmed</p>',
        textBody: 'Confirmed',
      },
    ],
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.consultation.reference_code, 'CS-2026-0901');
  assert.equal(outboxKeys.has('outbox-pg-1'), true);

  // 2. Idempotent replay returns same consultation without conflict
  const replay = await repo.createConsultationAtomic({
    bookingId: 'bkg-pg-1',
    clientId: 'user-client-ava',
    referenceCode: 'CS-2026-0901',
    assignedPlannerId: 'user-staff-maya',
    method: 'video',
    startUtc: '2026-11-10T15:00:00.000Z',
    endUtc: '2026-11-10T15:45:00.000Z',
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    clientTimezone: 'America/New_York',
    preferredContactMethod: 'email',
    privacyConsentAt: nowIso,
    privacyConsentVersion: '2026-04-v1',
    accessTokenHash: 'hash-1',
    idempotencyKey: 'pg-consult-idem-1',
    plannerNotes: 'Crystal centerpiece brief',
    outboxJobs: [],
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.consultation.id, first.consultation.id);

  // 3. Overlapping slot inside 15-min buffer throws SLOT_CONFLICT and triggers ROLLBACK
  await assert.rejects(
    () =>
      repo.createConsultationAtomic({
        bookingId: 'bkg-pg-2',
        clientId: 'user-client-other',
        referenceCode: 'CS-2026-0902',
        assignedPlannerId: 'user-staff-maya',
        method: 'video',
        startUtc: '2026-11-10T15:50:00.000Z',
        endUtc: '2026-11-10T16:35:00.000Z',
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 15,
        clientTimezone: 'America/New_York',
        preferredContactMethod: 'email',
        privacyConsentAt: nowIso,
        privacyConsentVersion: '2026-04-v1',
        accessTokenHash: 'hash-2',
        idempotencyKey: 'pg-consult-idem-2',
        plannerNotes: 'Should collide with buffer',
        outboxJobs: [],
      }),
    /SLOT_CONFLICT/,
  );
  assert.ok(sqlLog.includes('ROLLBACK'), 'Slot conflict must trigger explicit transaction ROLLBACK');

  // 4. RLS actor isolation via SET LOCAL app.current_user_id / app.current_role
  const otherClientRows = await repo.listConsultationsForActor({
    userId: 'user-client-stranger',
    role: 'client',
  });
  assert.equal(otherClientRows.length, 0);

  const ownerRows = await repo.listConsultationsForActor({
    userId: 'user-client-ava',
    role: 'client',
  });
  assert.equal(ownerRows.length, 1);

  const plannerRows = await repo.listConsultationsForActor({
    userId: 'user-staff-maya',
    role: 'staff',
  });
  assert.equal(plannerRows.length, 1);
});
