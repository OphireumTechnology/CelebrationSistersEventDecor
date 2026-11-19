import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import {
  dispatchEmailNotification,
  getEmailProviderStatus,
  getEmailRuntimeConfig,
} from '../server/notifications.ts';
import { enqueueOutboxNotification, NotificationOutboxWorker } from '../server/outbox.ts';
import { PostgresNormalizedRepository } from '../server/repositories/normalizedRepository.ts';
import {
  setInjectedPgPoolForTests,
  type PgClientLike,
  type PgPoolLike,
} from '../server/repositories/postgresRepository.ts';
import {
  computeConsultationAvailability,
  generateConsultationAccessToken,
  localDateTimeToUtc,
  meetsConsultationNotice,
  MIN_CONSULTATION_NOTICE_MINUTES,
  STUDIO_TIMEZONE,
  validateRequestedConsultationSlot,
} from '../server/scheduling.ts';
import { readDb, withTransaction } from '../server/store.ts';
import { generateTotpCode } from '../server/totp.ts';
import { validateMigrationsDirectory } from '../scripts/verify-migrations.ts';
import type {
  BlackoutDate,
  ConsultationAppointment,
  StaffAvailabilityRule,
  UserSession,
} from '../src/types/domain.ts';

function buildSignedWebhookHeaders(rawBody: string, svixId: string, webhookSecret: string, timestampSec?: number) {
  const ts = String(timestampSec ?? Math.floor(Date.now() / 1000));
  const cleanSecret = webhookSecret.startsWith('whsec_')
    ? webhookSecret.slice('whsec_'.length)
    : webhookSecret;
  const sig = crypto
    .createHmac('sha256', Buffer.from(cleanSecret, 'base64'))
    .update(`${svixId}.${ts}.${rawBody}`, 'utf8')
    .digest('base64');
  return {
    'svix-id': svixId,
    'svix-timestamp': ts,
    'svix-signature': `v1,${sig}`,
  };
}

function futureIsoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

async function startIsolatedServer(
  dbPath: string,
  options?: {
    enableRateLimit?: boolean;
    env?: Record<string, string | undefined>;
  },
) {
  const envKeys = [
    'CS_DB_PATH',
    'PERSISTENCE_ADAPTER',
    'RESEND_API_KEY',
    'EMAIL_FROM',
    'EMAIL_LIVE_DELIVERY_ENABLED',
    'RESEND_WEBHOOK_SECRET',
    'STAFF_NOTIFICATION_EMAIL',
  ] as const;
  const prev: Record<string, string | undefined> = {};
  for (const k of envKeys) prev[k] = process.env[k];

  process.env.CS_DB_PATH = dbPath;
  process.env.PERSISTENCE_ADAPTER = 'json-local';
  if (options?.env) {
    for (const [k, v] of Object.entries(options.env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const app = createApp({ enableRateLimit: options?.enableRateLimit ?? false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setInjectedPgPoolForTests(null);
      for (const k of envKeys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    },
  };
}

async function loginAs(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ userId }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function loginAdminWithMfa(baseUrl: string): Promise<string> {
  const preToken = await loginAs(baseUrl, 'user-admin-director');
  const setupRes = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${preToken}` },
  });
  assert.equal(setupRes.status, 200);
  const setup = (await setupRes.json()) as { secret: string };
  const code = generateTotpCode(setup.secret);
  const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preToken}` },
    body: JSON.stringify({ code }),
  });
  assert.equal(verifyRes.status, 200);
  const verified = (await verifyRes.json()) as { token: string };
  return verified.token;
}

async function getNextAvailableSlot(baseUrl: string, method = 'video', days = 14) {
  const startDate = futureIsoDate(3);
  const res = await fetch(
    `${baseUrl}/api/consultations/availability?startDate=${startDate}&days=${days}&timezone=America/New_York&method=${method}`,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    days: Array<{
      date: string;
      slots: Array<{ startUtc: string; endUtc: string; plannerId: string; available: boolean }>;
    }>;
  };
  const slots = body.days.flatMap((d) => d.slots.filter((s) => s.available));
  assert.ok(slots.length >= 2, 'Expected at least 2 available consultation slots');
  return slots;
}

// ============================================================================
// REPAIR 01 — Controlled-Clock 2-Hour Cutoff & Availability/Booking Agreement
// ============================================================================

test('REPAIR 01: 120-minute notice boundary (30m, 60m, 90m, 119m rejected; 120m, 121m accepted) & full rule enforcement', () => {
  assert.equal(MIN_CONSULTATION_NOTICE_MINUTES, 120);

  // Anchor controlled clock on a regular Tuesday in Columbia, SC (2027-03-16, EDT UTC-4)
  const testDate = '2027-03-16';
  const plannerId = 'user-admin-director';
  const rules: StaffAvailabilityRule[] = [
    {
      id: 'rule-tue',
      plannerId,
      plannerName: 'Maya Sterling',
      dayOfWeek: 2, // Tuesday
      startTimeLocal: '09:00',
      endTimeLocal: '17:00',
      timezone: STUDIO_TIMEZONE,
      slotDurationMinutes: 45,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
      allowedMethods: ['video', 'phone', 'in_person_columbia'],
      isActive: true,
    },
  ];
  const users: UserSession[] = [
    {
      id: plannerId,
      name: 'Maya Sterling',
      email: 'maya@celebrationsisters.example.com',
      role: 'admin',
    },
  ];

  // Pick the 12:00 PM studio slot on 2027-03-16
  const noonSlotUtc = localDateTimeToUtc(testDate, '12:00', STUDIO_TIMEZONE);
  const noonIso = noonSlotUtc.toISOString();

  // Reject 30, 60, 90, 119 minutes before slot start in BOTH availability and validation
  for (const minutesAhead of [30, 60, 90, 119]) {
    const controlledNowMs = noonSlotUtc.getTime() - minutesAhead * 60_000;
    assert.equal(
      meetsConsultationNotice(noonIso, controlledNowMs),
      false,
      `meetsConsultationNotice should reject ${minutesAhead}m notice`,
    );

    const avail = computeConsultationAvailability({
      startDate: testDate,
      days: 1,
      clientTimezone: STUDIO_TIMEZONE,
      method: 'video',
      rules,
      consultations: [],
      slotHolds: [],
      blackoutDates: [],
      users,
      nowMs: controlledNowMs,
    });
    const slotEntry = avail[0].slots.find((s) => s.startUtc === noonIso);
    assert.ok(slotEntry, 'Expected 12:00 slot to exist in schedule');
    assert.equal(slotEntry.available, false, `Availability must hide/disable ${minutesAhead}m slot`);
    assert.match(slotEntry.unavailableReason || '', /2-hour/i);

    const validation = validateRequestedConsultationSlot({
      plannerId,
      startUtc: noonIso,
      method: 'video',
      rules,
      consultations: [],
      slotHolds: [],
      blackoutDates: [],
      nowMs: controlledNowMs,
    });
    assert.equal(validation.valid, false, `Validation must reject ${minutesAhead}m slot`);
    assert.equal(validation.errorCode, 'INVALID_TIME');
    assert.match(validation.error || '', /2 hours/i);
  }

  // Accept 120 minutes (exact cutoff) and 121 minutes ahead in BOTH availability and validation
  for (const minutesAhead of [120, 121]) {
    const controlledNowMs = noonSlotUtc.getTime() - minutesAhead * 60_000;
    assert.equal(
      meetsConsultationNotice(noonIso, controlledNowMs),
      true,
      `meetsConsultationNotice should accept ${minutesAhead}m notice`,
    );

    const avail = computeConsultationAvailability({
      startDate: testDate,
      days: 1,
      clientTimezone: STUDIO_TIMEZONE,
      method: 'video',
      rules,
      consultations: [],
      slotHolds: [],
      blackoutDates: [],
      users,
      nowMs: controlledNowMs,
    });
    const slotEntry = avail[0].slots.find((s) => s.startUtc === noonIso);
    assert.ok(slotEntry);
    assert.equal(slotEntry.available, true, `Availability must accept ${minutesAhead}m slot`);

    const validation = validateRequestedConsultationSlot({
      plannerId,
      startUtc: noonIso,
      method: 'video',
      rules,
      consultations: [],
      slotHolds: [],
      blackoutDates: [],
      nowMs: controlledNowMs,
    });
    assert.equal(validation.valid, true, `Validation must accept ${minutesAhead}m slot`);
  }

  // Reject studio holiday (Christmas Day 2027-12-25) & custom blackout date
  const farBeforeMs = Date.UTC(2027, 0, 1, 0, 0, 0);
  const christmasNoon = localDateTimeToUtc('2027-12-25', '12:00', STUDIO_TIMEZONE).toISOString();
  const holidayValidation = validateRequestedConsultationSlot({
    plannerId,
    startUtc: christmasNoon,
    method: 'video',
    rules: [{ ...rules[0], dayOfWeek: 6 }], // Saturday rule to ensure holiday blocks even if weekday rule exists
    consultations: [],
    slotHolds: [],
    blackoutDates: [],
    nowMs: farBeforeMs,
  });
  assert.equal(holidayValidation.valid, false);
  assert.equal(holidayValidation.errorCode, 'BLACKOUT');

  const customBlackouts: BlackoutDate[] = [
    { id: 'blk-1', date: testDate, reason: 'Private Gala Installation', createdBy: plannerId, createdAt: '2027-01-01T00:00:00.000Z' },
  ];
  const blackoutValidation = validateRequestedConsultationSlot({
    plannerId,
    startUtc: noonIso,
    method: 'video',
    rules,
    consultations: [],
    slotHolds: [],
    blackoutDates: customBlackouts,
    nowMs: farBeforeMs,
  });
  assert.equal(blackoutValidation.valid, false);
  assert.equal(blackoutValidation.errorCode, 'BLACKOUT');

  // Reject overlapping appointment AND planner preparation buffer overlap
  const existingAppointment: ConsultationAppointment = {
    id: 'con-existing',
    bookingId: 'bk-existing',
    referenceCode: 'CS-2027-1001',
    clientId: 'cli-1',
    clientName: 'Existing Client',
    clientEmail: 'existing@example.com',
    clientPhone: '803-555-0100',
    preferredContactMethod: 'email',
    eventTitle: 'Existing Gala',
    eventCategory: 'Corporate Gala',
    serviceDivisionIds: ['div-1'],
    eventDate: '2027-08-20',
    venueName: 'Columbia Museum',
    eventLocation: 'Columbia, SC',
    guestCount: 120,
    budgetRange: '$25,000 - $50,000',
    consultationNotes: 'Notes',
    method: 'video',
    status: 'Confirmed',
    assignedPlannerId: plannerId,
    assignedPlannerName: 'Maya Sterling',
    startUtc: noonIso,
    endUtc: new Date(noonSlotUtc.getTime() + 45 * 60_000).toISOString(),
    durationMinutes: 45,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    clientTimezone: STUDIO_TIMEZONE,
    privacyConsentAccepted: true,
    privacyConsentAt: '2027-01-01T00:00:00.000Z',
    privacyConsentVersion: '2026-11-v1',
    accessTokenHash: 'hash',
    crmStage: 'Consultation Scheduled',
    rescheduleCount: 0,
    createdAt: '2027-01-01T00:00:00.000Z',
    updatedAt: '2027-01-01T00:00:00.000Z',
  };

  // Exact overlap at 12:00 rejected
  const overlapRes = validateRequestedConsultationSlot({
    plannerId,
    startUtc: noonIso,
    method: 'video',
    rules,
    consultations: [existingAppointment],
    slotHolds: [],
    blackoutDates: [],
    nowMs: farBeforeMs,
  });
  assert.equal(overlapRes.valid, false);
  assert.equal(overlapRes.errorCode, 'SLOT_CONFLICT');

  // 12:50 starts inside the 15-minute post-appointment buffer (12:45..13:00) -> rejected
  const bufferStart = localDateTimeToUtc(testDate, '12:50', STUDIO_TIMEZONE).toISOString();
  const bufferRes = validateRequestedConsultationSlot({
    plannerId,
    startUtc: bufferStart,
    method: 'video',
    rules,
    consultations: [existingAppointment],
    slotHolds: [],
    blackoutDates: [],
    nowMs: farBeforeMs,
  });
  assert.equal(bufferRes.valid, false);
  assert.equal(bufferRes.errorCode, 'SLOT_CONFLICT');
});

test('REPAIR 01 (HTTP): POST /api/consultations and /holds reject 90-minute lead-time slot with 2-hour cutoff error', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-15r-cutoff-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const srv = await startIsolatedServer(dbPath);
  try {
    const ninetyMinFromNow = new Date(Date.now() + 90 * 60_000).toISOString();
    const holdRes = await fetch(`${srv.baseUrl}/api/consultations/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plannerId: 'user-admin-director',
        startUtc: ninetyMinFromNow,
        method: 'video',
        holderKey: 'cutoff-probe-holder-1',
      }),
    });
    assert.equal(holdRes.status, 400);
    const holdErr = (await holdRes.json()) as { code?: string; error?: string };
    assert.equal(holdErr.code, 'INVALID_TIME');
    assert.match(holdErr.error || '', /2 hours/i);

    const bookRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Cutoff Probe',
        clientEmail: 'cutoff@example.com',
        clientPhone: '(803) 555-0199',
        preferredContactMethod: 'email',
        eventType: 'Luxury Wedding',
        serviceDivisionIds: ['div-event-decor'],
        eventDate: futureIsoDate(40),
        venueName: 'Lace House',
        location: 'Columbia, SC',
        guestCount: 80,
        budgetRange: '$25,000 - $50,000',
        consultationMethod: 'video',
        consultationStartUtc: ninetyMinFromNow,
        plannerId: 'user-admin-director',
        clientTimezone: 'America/New_York',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(bookRes.status, 400);
    const bookErr = (await bookRes.json()) as { code?: string; error?: string };
    assert.equal(bookErr.code, 'INVALID_TIME');
    assert.match(bookErr.error || '', /2 hours/i);
  } finally {
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// REPAIR 02 — Resend Configuration Consistency, Fail-Closed & Delivery Honesty
// ============================================================================

test('REPAIR 02: Resend configuration scenarios, canonical env contract, and zero frontend credential exposure', async () => {
  // 1. Missing RESEND_API_KEY
  const statusNoKey = getEmailProviderStatus({
    EMAIL_FROM: 'concierge@celebrationsistersdecor.com',
    EMAIL_LIVE_DELIVERY_ENABLED: 'true',
  });
  assert.equal(statusNoKey.configured, false);
  assert.equal(statusNoKey.provider, 'unconfigured');
  const dispNoKey = await dispatchEmailNotification(
    {
      idempotencyKey: 'k-no-key',
      category: 'consultation_confirmation',
      recipient: 'client@example.com',
      subject: 'Test',
      htmlBody: '<p>Test</p>',
      textBody: 'Test',
    },
    [],
    { apiKey: '', fromAddress: 'concierge@celebrationsistersdecor.com', liveDeliveryEnabled: true },
  );
  assert.equal(dispNoKey.record.status, 'Skipped (Unconfigured)');

  // 2. Missing EMAIL_FROM
  const statusNoFrom = getEmailProviderStatus({
    RESEND_API_KEY: 'test_api_key_placeholder',
    EMAIL_LIVE_DELIVERY_ENABLED: 'true',
  });
  assert.equal(statusNoFrom.configured, false);
  const dispNoFrom = await dispatchEmailNotification(
    {
      idempotencyKey: 'k-no-from',
      category: 'consultation_confirmation',
      recipient: 'client@example.com',
      subject: 'Test',
      htmlBody: '<p>Test</p>',
      textBody: 'Test',
    },
    [],
    { apiKey: 'test_api_key_placeholder', fromAddress: '', liveDeliveryEnabled: true },
  );
  assert.equal(dispNoFrom.record.status, 'Skipped (Unconfigured)');

  // 3. EMAIL_LIVE_DELIVERY_ENABLED=false pauses outbound sends safely
  let networkCalled = false;
  const statusPaused = getEmailProviderStatus({
    RESEND_API_KEY: 'test_api_key_placeholder',
    EMAIL_FROM: 'concierge@celebrationsistersdecor.com',
    EMAIL_LIVE_DELIVERY_ENABLED: 'false',
    STAFF_NOTIFICATION_EMAIL: 'studio@celebrationsistersdecor.com',
  });
  assert.equal(statusPaused.configured, true);
  assert.equal(statusPaused.liveDeliveryEnabled, false);
  assert.equal(statusPaused.staffRecipientConfigured, true);
  const dispPaused = await dispatchEmailNotification(
    {
      idempotencyKey: 'k-paused',
      category: 'consultation_confirmation',
      recipient: 'client@example.com',
      subject: 'Test',
      htmlBody: '<p>Test</p>',
      textBody: 'Test',
    },
    [],
    {
      apiKey: 'test_api_key_placeholder',
      fromAddress: 'concierge@celebrationsistersdecor.com',
      liveDeliveryEnabled: false,
      fetchImpl: async () => {
        networkCalled = true;
        return new Response('{}', { status: 200 });
      },
    },
  );
  assert.equal(dispPaused.record.status, 'Skipped (Unauthorized)');
  assert.equal(networkCalled, false);

  // 4. Valid test config -> HTTP 200 yields ProviderAccepted (NEVER fabricated as Delivered)
  const runtimeCfg = getEmailRuntimeConfig({
    RESEND_API_KEY: 'test_api_key_placeholder',
    EMAIL_FROM: 'concierge@celebrationsistersdecor.com',
    EMAIL_LIVE_DELIVERY_ENABLED: 'true',
    RESEND_WEBHOOK_SECRET: 'whsec_dGVzdA==',
    STAFF_NOTIFICATION_EMAIL: 'studio@celebrationsistersdecor.com',
  });
  assert.equal(runtimeCfg.liveDeliveryEnabled, true);
  assert.equal(runtimeCfg.fromAddress, 'concierge@celebrationsistersdecor.com');
  assert.equal(runtimeCfg.staffNotificationEmail, 'studio@celebrationsistersdecor.com');

  const dispAccepted = await dispatchEmailNotification(
    {
      idempotencyKey: 'k-accepted',
      category: 'consultation_confirmation',
      recipient: 'client@example.com',
      subject: 'Test',
      htmlBody: '<p>Test</p>',
      textBody: 'Test',
    },
    [],
    {
      apiKey: 'test_api_key_placeholder',
      fromAddress: 'concierge@celebrationsistersdecor.com',
      liveDeliveryEnabled: true,
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 'resend-msg-accepted-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    },
  );
  assert.equal(dispAccepted.record.status, 'ProviderAccepted');
  assert.equal(dispAccepted.record.providerMessageId, 'resend-msg-accepted-1');

  // 5. Missing RESEND_WEBHOOK_SECRET returns 503; invalid signature returns 401
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-15r-resend-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const srvNoSecret = await startIsolatedServer(dbPath, {
    env: { RESEND_WEBHOOK_SECRET: undefined },
  });
  try {
    const res503 = await fetch(`${srvNoSecret.baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg-1' } }),
    });
    assert.equal(res503.status, 503);
    const body503 = (await res503.json()) as { code?: string };
    assert.equal(body503.code, 'WEBHOOK_NOT_CONFIGURED');
  } finally {
    await srvNoSecret.close();
  }

  const webhookSecret = `whsec_${Buffer.from('phase15r-webhook-test-key').toString('base64')}`;
  const srvWithSecret = await startIsolatedServer(dbPath, {
    env: { RESEND_WEBHOOK_SECRET: webhookSecret },
  });
  try {
    const badSigRes = await fetch(`${srvWithSecret.baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': 'msg_bad_sig',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,invalidSignatureBase64==',
      },
      body: JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg-1' } }),
    });
    assert.equal(badSigRes.status, 401);
  } finally {
    await srvWithSecret.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // 6. Static check: zero Resend env vars or secrets referenced in frontend /src
  async function walkTsFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walkTsFiles(full)));
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const srcFiles = await walkTsFiles(path.resolve(process.cwd(), 'src'));
  assert.ok(srcFiles.length > 5);
  for (const f of srcFiles) {
    const content = await fs.readFile(f, 'utf8');
    assert.doesNotMatch(
      content,
      /\b(RESEND_API_KEY|RESEND_WEBHOOK_SECRET|VITE_RESEND|EMAIL_LIVE_DELIVERY_ENABLED)\b/,
      `Frontend file ${f} must never reference Resend credentials or server email flags`,
    );
  }

  // 7. Docs consistency check: zero stale EMAIL_FROM_ADDRESS or ENABLE_LIVE_EMAIL_DELIVERY in Phase 15 docs
  for (const docRel of [
    'docs/phase15/04_EMAIL_DELIVERY_READINESS.md',
    'docs/phase15/11_PRODUCTION_READINESS.md',
  ]) {
    const docText = await fs.readFile(path.resolve(process.cwd(), docRel), 'utf8');
    assert.doesNotMatch(docText, /\bEMAIL_FROM_ADDRESS\b/);
    assert.doesNotMatch(docText, /\bENABLE_LIVE_EMAIL_DELIVERY\b/);
  }
});

// ============================================================================
// REPAIR 03 — Migration 001–008 Static Validation & Worker SET LOCAL RLS Scoping
// ============================================================================

test('REPAIR 03: Migrations 001-008 have zero unconditional auth.uid() calls & worker uses transaction-local SET LOCAL role', async () => {
  const migrationCheck = await validateMigrationsDirectory();
  assert.equal(
    migrationCheck.passed,
    true,
    `Migration validation failed: ${migrationCheck.errors.join('; ')}`,
  );
  assert.equal(migrationCheck.files.length, 8);
  assert.equal(migrationCheck.rlsTablesChecked, 36);

  // Verify PostgresNormalizedRepository.claimDueOutboxJobs() sets transaction-local notification_worker RLS context
  const executedSql: Array<{ text: string; values?: unknown[] }> = [];
  const mockClient: PgClientLike = {
    query: (async <T = Record<string, unknown>>(text: string, values?: unknown[]) => {
      executedSql.push({ text, values });
      return { rows: [] as T[], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    }) as PgClientLike['query'],
    release: () => {},
  };
  const mockPool: PgPoolLike = {
    query: mockClient.query,
    connect: async () => mockClient,
    end: async () => {},
  };

  const repo = new PostgresNormalizedRepository(mockPool);
  await repo.claimDueOutboxJobs('worker-phase15r', 5, 60);

  assert.equal(executedSql[0]?.text, 'BEGIN');
  assert.match(executedSql[1]?.text || '', /set_config\('app\.current_user_id', \$1, true\)/);
  assert.deepEqual(executedSql[2]?.values, ['notification_worker']);
  assert.match(executedSql[2]?.text || '', /set_config\('app\.current_role', \$1, true\)/);
  assert.match(executedSql[3]?.text || '', /FOR UPDATE SKIP LOCKED/);
  assert.equal(executedSql[4]?.text, 'COMMIT');
});

// ============================================================================
// REPAIR 04 — Concurrency Races, Token Lifecycle Security & Atomic Webhook Replay
// ============================================================================

test('REPAIR 04A: Concurrent booking race allows exactly 1 winner, 0 duplicate bookings, 0 orphaned holds, outbox only for winner', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-15r-race-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const srv = await startIsolatedServer(dbPath);
  try {
    const slots = await getNextAvailableSlot(srv.baseUrl);
    const target = slots[0];
    const eventDate = futureIsoDate(60);

    // Caller A acquires a temporary hold first
    const holdRes = await fetch(`${srv.baseUrl}/api/consultations/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plannerId: target.plannerId,
        startUtc: target.startUtc,
        method: 'video',
        holderKey: 'caller-a-fingerprint',
      }),
    });
    assert.equal(holdRes.status, 201);

    const makeBooking = (label: string, holderKey: string) =>
      fetch(`${srv.baseUrl}/api/consultations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: `Race Client ${label}`,
          clientEmail: `race-${label.toLowerCase()}@example.com`,
          clientPhone: '(803) 555-0142',
          preferredContactMethod: 'email',
          eventType: 'Luxury Wedding',
          eventTitle: `Race Gala ${label}`,
          serviceDivisionIds: ['div-event-decor'],
          eventDate,
          venueName: `Venue ${label}`,
          location: 'Columbia, SC',
          guestCount: 110,
          budgetRange: '$25,000 - $50,000',
          consultationMethod: 'video',
          consultationStartUtc: target.startUtc,
          plannerId: target.plannerId,
          holderKey,
          clientTimezone: 'America/New_York',
          privacyConsentAccepted: true,
        }),
      });

    // Fire 3 concurrent requests for the exact same planner + slot
    const responses = await Promise.all([
      makeBooking('A', 'caller-a-fingerprint'),
      makeBooking('B', 'caller-b-fingerprint'),
      makeBooking('C', 'caller-c-fingerprint'),
    ]);

    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409, 409], `Expected [201, 409, 409], got ${JSON.stringify(statuses)}`);

    const winningResponse = responses.find((r) => r.status === 201);
    assert.ok(winningResponse);
    const winningBody = (await winningResponse.json()) as {
      consultation: { id: string; referenceCode: string };
    };

    const db = await readDb();
    const bookedAtSlot = db.consultations.filter(
      (c) => c.assignedPlannerId === target.plannerId && c.startUtc === target.startUtc,
    );
    assert.equal(bookedAtSlot.length, 1, 'Exactly one consultation may exist for the contested slot');

    // Zero orphaned holds for that slot
    const remainingSlotHolds = db.consultationSlotHolds.filter(
      (h) => h.plannerId === target.plannerId && h.slotStartUtc === target.startUtc,
    );
    assert.equal(remainingSlotHolds.length, 0, 'Zero orphaned holds may remain after winning booking');

    // Outbox jobs must exist ONLY for the winning consultation (never for rejected 409 losers)
    const winnerOutbox = db.notificationOutbox.filter(
      (j) => j.bookingReference === winningBody.consultation.referenceCode,
    );
    assert.ok(winnerOutbox.length >= 1, 'Winner must have confirmation outbox notification');
    const loserOutbox = db.notificationOutbox.filter(
      (j) => j.recipient === 'race-b@example.com' || j.recipient === 'race-c@example.com',
    );
    assert.equal(loserOutbox.length, 0, 'Rejected 409 callers must NOT enqueue outbox notifications');
  } finally {
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('REPAIR 04B: Consultation access token security (256-bit, SHA-256 only, expiry, isolated revocation, restart persistence, rate-limit, zero log leak)', async () => {
  // 256-bit token entropy verification (32 bytes -> 43 base64url chars + 'csa_' prefix)
  const generated = generateConsultationAccessToken();
  assert.ok(generated.token.startsWith('csa_'));
  assert.equal(generated.token.length, 4 + 43);
  assert.equal(generated.hash.length, 64);
  assert.notEqual(generated.token, generated.hash);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-15r-token-'));
  const dbPath = path.join(tmpDir, 'db.json');

  // Capture stdout/stderr logs to prove raw verification tokens are NEVER logged
  const capturedLogs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(' '));
  };

  let srv = await startIsolatedServer(dbPath);
  let tokenA = '';
  let refA = '';
  let idA = '';
  let tokenB = '';
  let refB = '';
  let adminToken = '';

  try {
    const slots = await getNextAvailableSlot(srv.baseUrl);

    const createBooking = async (slot: { plannerId: string; startUtc: string }, label: string) => {
      const res = await fetch(`${srv.baseUrl}/api/consultations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: `Token Client ${label}`,
          clientEmail: `token-${label.toLowerCase()}@example.com`,
          clientPhone: '(803) 555-0155',
          preferredContactMethod: 'email',
          eventType: 'Luxury Wedding',
          eventTitle: `Token Event ${label}`,
          serviceDivisionIds: ['div-event-decor'],
          eventDate: futureIsoDate(70 + (label === 'A' ? 1 : 2)),
          venueName: `Estate ${label}`,
          location: 'Columbia, SC',
          guestCount: 90,
          budgetRange: '$25,000 - $50,000',
          consultationMethod: 'video',
          consultationStartUtc: slot.startUtc,
          plannerId: slot.plannerId,
          clientTimezone: 'America/New_York',
          privacyConsentAccepted: true,
        }),
      });
      assert.equal(res.status, 201);
      return (await res.json()) as {
        consultation: { id: string; referenceCode: string };
        accessToken: string;
      };
    };

    const bookingA = await createBooking(slots[0], 'A');
    const bookingB = await createBooking(slots[1], 'B');
    tokenA = bookingA.accessToken;
    refA = bookingA.consultation.referenceCode;
    idA = bookingA.consultation.id;
    tokenB = bookingB.accessToken;
    refB = bookingB.consultation.referenceCode;

    // Only SHA-256 hash stored on disk; raw tokens NEVER appear in persisted JSON DB
    const rawDiskDb = await fs.readFile(dbPath, 'utf8');
    assert.equal(rawDiskDb.includes(tokenA), false, 'Raw token A must never be persisted to disk');
    assert.equal(rawDiskDb.includes(tokenB), false, 'Raw token B must never be persisted to disk');

    const lookupStatus = (baseUrl: string, refCode: string, token: string) =>
      fetch(`${baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(refCode)}`, {
        method: 'GET',
        headers: { 'X-Consultation-Token': token },
      });

    // Cross-client isolation: Token A cannot access Booking B (403 INVALID_CONSULTATION_TOKEN, zero data leak)
    const crossRes = await lookupStatus(srv.baseUrl, refB, tokenA);
    assert.equal(crossRes.status, 403);
    const crossBody = (await crossRes.json()) as { code?: string; consultation?: unknown };
    assert.equal(crossBody.code, 'INVALID_CONSULTATION_TOKEN');
    assert.equal(crossBody.consultation, undefined);

    // Revoke Token A using authenticated MFA admin session
    adminToken = await loginAdminWithMfa(srv.baseUrl);
    const revokeRes = await fetch(`${srv.baseUrl}/api/consultations/${idA}/token/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ reason: 'Security audit revocation test' }),
    });
    assert.equal(revokeRes.status, 200);

    // Revoked Token A fails with 403 TOKEN_REVOKED
    const lookupRevoked = await lookupStatus(srv.baseUrl, refA, tokenA);
    assert.equal(lookupRevoked.status, 403);
    const revBody = (await lookupRevoked.json()) as { code?: string };
    assert.equal(revBody.code, 'TOKEN_REVOKED');

    // Revoking Token A does NOT revoke Token B AND does NOT break authenticated admin session
    const lookupB = await lookupStatus(srv.baseUrl, refB, tokenB);
    assert.equal(lookupB.status, 200);

    const adminStillValid = await fetch(`${srv.baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminStillValid.status, 200);

    // Expiration check: set Booking B's token expiry in the past and verify 403 TOKEN_EXPIRED
    await withTransaction((db) => {
      const targetB = db.consultations.find((c) => c.referenceCode === refB);
      assert.ok(targetB);
      targetB.accessTokenExpiresAt = new Date(Date.now() - 60_000).toISOString();
    });
    const lookupExpired = await lookupStatus(srv.baseUrl, refB, tokenB);
    assert.equal(lookupExpired.status, 403);
    const expBody = (await lookupExpired.json()) as { code?: string };
    assert.equal(expBody.code, 'TOKEN_EXPIRED');

    // Verify ZERO raw token disclosure in captured structured logs
    const joinedLogs = capturedLogs.join('\n');
    assert.equal(joinedLogs.includes(tokenA), false, 'Token A must never appear in server logs');
    assert.equal(joinedLogs.includes(tokenB), false, 'Token B must never appear in server logs');

    // Full server restart: revoked Token A remains revoked after restart!
    await srv.close();
    srv = await startIsolatedServer(dbPath, { enableRateLimit: true });

    const lookupAfterRestart = await lookupStatus(srv.baseUrl, refA, tokenA);
    assert.equal(lookupAfterRestart.status, 403);
    const afterRestartBody = (await lookupAfterRestart.json()) as { code?: string };
    assert.equal(afterRestartBody.code, 'TOKEN_REVOKED');

    // Rate limiting check on status lookup endpoint (limit is 30/min) -> triggers 429
    let saw429 = false;
    for (let i = 0; i < 35; i += 1) {
      const r = await lookupStatus(srv.baseUrl, refA, 'csa_invalid_probe');
      if (r.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.equal(saw429, true, 'Status lookup endpoint must enforce HTTP 429 rate limiting');
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('REPAIR 04C: Resend webhook atomic replay protection, unknown message isolation, expired timestamp & out-of-order safety', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-15r-webhook-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const webhookSecret = `whsec_${Buffer.from('phase15r-atomic-webhook-secret').toString('base64')}`;
  const srv = await startIsolatedServer(dbPath, {
    env: {
      RESEND_API_KEY: 'test_api_key_placeholder',
      EMAIL_FROM: 'concierge@celebrationsistersdecor.com',
      EMAIL_LIVE_DELIVERY_ENABLED: 'true',
      RESEND_WEBHOOK_SECRET: webhookSecret,
    },
  });

  try {
    // Seed 2 outbox jobs and dispatch them through mocked Resend -> ProviderAccepted
    await withTransaction((db) => {
      enqueueOutboxNotification(db, {
        idempotencyKey: 'whk-job-1',
        category: 'consultation_confirmation',
        recipient: 'alpha@example.com',
        bookingReference: 'CS-2027-7001',
        subject: 'Alpha Confirmation',
        htmlBody: '<p>Alpha</p>',
        textBody: 'Alpha',
      });
      enqueueOutboxNotification(db, {
        idempotencyKey: 'whk-job-2',
        category: 'consultation_confirmation',
        recipient: 'beta@example.com',
        bookingReference: 'CS-2027-7002',
        subject: 'Beta Confirmation',
        htmlBody: '<p>Beta</p>',
        textBody: 'Beta',
      });
    });

    let msgSeq = 0;
    const worker = new NotificationOutboxWorker({
      fetchImpl: async () => {
        msgSeq += 1;
        return new Response(JSON.stringify({ id: `resend-msg-atomic-${msgSeq}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const summary = await worker.processOnce();
    assert.equal(summary.accepted, 2);

    const dbBefore = await readDb();
    const jobAlpha = dbBefore.notificationOutbox.find((j) => j.idempotencyKey === 'whk-job-1');
    const jobBeta = dbBefore.notificationOutbox.find((j) => j.idempotencyKey === 'whk-job-2');
    assert.ok(jobAlpha?.providerMessageId);
    assert.ok(jobBeta?.providerMessageId);
    assert.equal(jobAlpha.status, 'ProviderAccepted');
    assert.equal(jobBeta.status, 'ProviderAccepted');

    // 1. Expired timestamp (> 300s old) -> 401
    const expiredBody = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: jobAlpha.providerMessageId },
    });
    const expiredRes = await fetch(`${srv.baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildSignedWebhookHeaders(
          expiredBody,
          'svix_expired_1',
          webhookSecret,
          Math.floor(Date.now() / 1000) - 600,
        ),
      },
      body: expiredBody,
    });
    assert.equal(expiredRes.status, 401);

    // 2. Unknown providerMessageId -> 200, reconciled: false, ZERO mutation of Alpha or Beta
    const unknownBody = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'resend-msg-unknown-999' },
    });
    const unknownRes = await fetch(`${srv.baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildSignedWebhookHeaders(unknownBody, 'svix_unknown_1', webhookSecret),
      },
      body: unknownBody,
    });
    assert.equal(unknownRes.status, 200);
    const unknownJson = (await unknownRes.json()) as { reconciled: boolean; deduplicated: boolean };
    assert.equal(unknownJson.reconciled, false);
    assert.equal(unknownJson.deduplicated, false);

    const dbAfterUnknown = await readDb();
    assert.equal(
      dbAfterUnknown.notificationOutbox.find((j) => j.id === jobAlpha.id)?.status,
      'ProviderAccepted',
    );
    assert.equal(
      dbAfterUnknown.notificationOutbox.find((j) => j.id === jobBeta.id)?.status,
      'ProviderAccepted',
    );

    // 3. Concurrent webhook replay (5 simultaneous identical signed requests with same svix-id)
    const deliveredBody = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: jobAlpha.providerMessageId },
    });
    const deliveredHeaders = buildSignedWebhookHeaders(deliveredBody, 'svix_concurrent_alpha', webhookSecret);
    const replayResponses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${srv.baseUrl}/api/webhooks/resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...deliveredHeaders },
          body: deliveredBody,
        }).then((r) => r.json() as Promise<{ deduplicated: boolean; reconciled: boolean }>),
      ),
    );
    const processedCount = replayResponses.filter((r) => !r.deduplicated && r.reconciled).length;
    const dedupedCount = replayResponses.filter((r) => r.deduplicated && !r.reconciled).length;
    assert.equal(processedCount, 1, 'Exactly 1 concurrent webhook replay may reconcile the job');
    assert.equal(dedupedCount, 4, 'All 4 duplicate concurrent replays must be deduplicated');

    // 4. Out-of-order late event (`email.sent`) arriving after `Delivered` must NOT downgrade status
    const lateSentBody = JSON.stringify({
      type: 'email.sent',
      data: { email_id: jobAlpha.providerMessageId },
    });
    const lateSentRes = await fetch(`${srv.baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildSignedWebhookHeaders(lateSentBody, 'svix_late_sent_alpha', webhookSecret),
      },
      body: lateSentBody,
    });
    assert.equal(lateSentRes.status, 200);
    const lateJson = (await lateSentRes.json()) as { reconciled: boolean };
    assert.equal(lateJson.reconciled, false);

    const dbFinal = await readDb();
    assert.equal(
      dbFinal.notificationOutbox.find((j) => j.id === jobAlpha.id)?.status,
      'Delivered',
      'Out-of-order email.sent must never downgrade Delivered status',
    );
    assert.equal(
      dbFinal.notificationOutbox.find((j) => j.id === jobBeta.id)?.status,
      'ProviderAccepted',
      'Unrelated job Beta must remain untouched',
    );
    const alphaAuditRows = dbFinal.notificationWebhookEvents.filter(
      (e) => e.svixId === 'svix_concurrent_alpha',
    );
    assert.equal(alphaAuditRows.length, 1, 'Strictly one audit record per unique svix-id');
  } finally {
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
