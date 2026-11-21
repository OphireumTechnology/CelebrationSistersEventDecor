import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { verifyDeploymentAndRollback } from '../scripts/verify-deployment-and-rollback.ts';
import { validateMigrationsDirectory } from '../scripts/verify-migrations.ts';
import { createApp, type SupabaseAuthClientLike } from '../server/app.ts';
import { dispatchEmailNotification, isReservedPlaceholderEmail } from '../server/notifications.ts';
import { PostgresNormalizedRepository } from '../server/repositories/normalizedRepository.ts';
import {
  checkPersistenceHealth,
  setInjectedPgPoolForTests,
  type PgClientLike,
  type PgPoolLike,
} from '../server/repositories/postgresRepository.ts';
import { getStudioTodayIso } from '../server/scheduling.ts';
import { readDb, withTransaction } from '../server/store.ts';
import { generateTotpCode } from '../server/totp.ts';

function signSvixWebhook(secret: string, id: string, ts: string, rawBody: string): string {
  const keyBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'utf8');
  const sig = crypto
    .createHmac('sha256', keyBytes)
    .update(`${id}.${ts}.${rawBody}`, 'utf8')
    .digest('base64');
  return `v1,${sig}`;
}

async function startTestServer(app: ReturnType<typeof createApp>) {
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('Final Deficiency Remediation — 5 Prioritized Production Systems', () => {
  const jwtSecret = 'test-supabase-jwt-secret-32-chars-minimum!';
  const supabaseUrl = 'https://test-project.supabase.co';
  let server: http.Server;
  let baseUrl: string;
  let nextMockJwt: string | null = null;
  let nextLoginError: string | null = null;
  const resetProviderError = 'Provider-only diagnostic';
  let nextResetError: string | null = null;
  const resetCalls: Array<{ email: string; redirectTo?: string }> = [];

  async function mintSupabaseJwt(params: {
    sub: string;
    email: string;
    emailVerified?: boolean;
    aal?: 'aal1' | 'aal2';
    userMetadata?: Record<string, unknown>;
  }) {
    return new SignJWT({
      email: params.email,
      email_verified: params.emailVerified ?? true,
      aal: params.aal ?? 'aal1',
      user_metadata: params.userMetadata ?? {},
      session_id: `sb-sess-${crypto.randomUUID().slice(0, 8)}`,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(params.sub)
      .setIssuer(`${supabaseUrl}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(jwtSecret));
  }

  const mockSupabaseAuthClient: SupabaseAuthClientLike = {
    auth: {
      signInWithPassword: async () => {
        if (nextLoginError || !nextMockJwt) {
          return { data: { session: null }, error: { message: nextLoginError || 'Invalid login credentials' } };
        }
        return { data: { session: { access_token: nextMockJwt } }, error: null };
      },
      resetPasswordForEmail: async (email, options) => {
        resetCalls.push({ email, redirectTo: options?.redirectTo });
        return { data: {}, error: nextResetError ? { message: nextResetError } : null };
      },
    },
  };

  let tmpDir: string;
  let prevDbPath: string | undefined;

  before(async () => {
    prevDbPath = process.env.CS_DB_PATH;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-remediation-'));
    process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
    process.env.ADMIN_MFA_PASSCODE = '654321';
    const app = createApp({
      enableRateLimit: false,
      providerVerifyOptions: { supabaseUrl, jwtSecret },
      supabaseAuthClient: mockSupabaseAuthClient,
    });
    const started = await startTestServer(app);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevDbPath === undefined) delete process.env.CS_DB_PATH;
    else process.env.CS_DB_PATH = prevDbPath;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    const dbFile = path.join(tmpDir, `db-${crypto.randomUUID().slice(0, 8)}.json`);
    process.env.CS_DB_PATH = dbFile;
    nextMockJwt = null;
    nextLoginError = null;
    nextResetError = null;
    resetCalls.length = 0;
  });

  // =========================================================================
  // SYSTEM 1: DATABASE
  // =========================================================================
  it('System 1 (Database): validates canonical migrations 001-008 including FORCE RLS write policies', async () => {
    const result = await validateMigrationsDirectory('db/migrations');
    assert.equal(result.passed, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.files.length, 8);
    assert.equal(result.files[7], '008_phase15_token_lifecycle_and_webhook_audit.sql');
  });

  it('System 1 (Database): uses COUNT(DISTINCT ...) migration version deduplication in checkPersistenceHealth', async () => {
    let observedMigrationSql = '';
    const fakePool = {
      query: async (sql: string) => {
        if (/SELECT 1/i.test(sql)) return { rows: [{ '?column?': 1 }] };
        if (/to_regclass/i.test(sql)) {
          return {
            rows: [
              {
                rate_limit_tbl: 'rate_limit_buckets',
                migrations_tbl: 'schema_migrations',
                consultations_tbl: 'consultations',
                holds_tbl: 'consultation_slot_holds',
                outbox_tbl: 'notification_outbox',
                webhooks_tbl: 'notification_webhook_events',
                crm_tasks_tbl: 'crm_follow_up_tasks',
              },
            ],
          };
        }
        if (/FROM schema_migrations/i.test(sql)) {
          observedMigrationSql = sql;
          return { rows: [{ cnt: 8 }] };
        }
        if (/pg_constraint/i.test(sql)) {
          return { rows: [{ present: true }] };
        }
        return { rows: [] };
      },
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    } as unknown as PgPoolLike;

    const prevAdapter = process.env.PERSISTENCE_ADAPTER;
    const prevDbUrl = process.env.DATABASE_URL;
    process.env.PERSISTENCE_ADAPTER = 'postgres';
    process.env.DATABASE_URL = 'postgres://user:pass@127.0.0.1:5432/testdb';
    setInjectedPgPoolForTests(fakePool);
    try {
      const health = await checkPersistenceHealth();
      assert.equal(health.connected, true);
      assert.equal(health.schema?.migrationsAppliedCount, 8);
      assert.match(observedMigrationSql, /COUNT\(DISTINCT/i);
    } finally {
      setInjectedPgPoolForTests(null);
      if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
      else process.env.PERSISTENCE_ADAPTER = prevAdapter;
      if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDbUrl;
    }
  });

  it('System 1 (Database): applies SET LOCAL RLS actor context inside PostgresNormalizedRepository atomic writes', async () => {
    const executedSql: Array<{ text: string; params?: unknown[] }> = [];
    const fakeClient = {
      query: async (text: string, params?: unknown[]) => {
        executedSql.push({ text, params });
        if (/INSERT INTO bookings/i.test(text)) {
          return {
            rows: [
              {
                id: 'bkg-1',
                reference_code: 'CS-2027-0101',
                client_id: 'user-client-camille',
                event_title: 'Spring Gala',
                event_type: 'Galas & Corporate',
                package_tier: 'Executive Full-Service',
                event_date: '2027-05-15',
                location: 'Columbia, SC',
                venue_name: 'Columbia Museum of Art',
                guest_count: 150,
                budget_range: '$25,000 – $45,000',
                legacy_status: 'Inquiry',
                architectural_stage: 'INQUIRY',
                notes: 'Floral centerpiece installation',
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {},
    } as unknown as PgClientLike;
    const fakePool = {
      connect: async () => fakeClient,
      query: async () => ({ rows: [] }),
      end: async () => {},
    } as unknown as PgPoolLike;
    const repo = new PostgresNormalizedRepository(fakePool);

    await repo.createBookingAtomic({
      clientId: 'user-client-camille',
      eventTitle: 'Spring Gala',
      eventType: 'Galas & Corporate',
      packageTier: 'Executive Full-Service',
      eventDate: '2027-05-15',
      venueName: 'Columbia Museum of Art',
      location: 'Columbia, SC',
      guestCount: 150,
      budgetRange: '$25,000 – $45,000',
      notes: 'Floral centerpiece installation',
      legacyStatus: 'Inquiry',
      architecturalStage: 'INQUIRY',
      actor: { role: 'event_planner', userId: 'user-planner-maya' },
    });

    const userIdSettingIdx = executedSql.findIndex((q) => /set_config\('app\.current_user_id'/i.test(q.text));
    const roleSettingIdx = executedSql.findIndex((q) => /set_config\('app\.current_role'/i.test(q.text));
    const insertIdx = executedSql.findIndex((q) => /INSERT INTO bookings/i.test(q.text));
    assert.ok(userIdSettingIdx > -1, 'Expected SET LOCAL app.current_user_id before INSERT');
    assert.ok(roleSettingIdx > -1, 'Expected SET LOCAL app.current_role before INSERT');
    assert.ok(insertIdx > roleSettingIdx, 'Expected INSERT after actor context config');
    assert.deepEqual(executedSql[userIdSettingIdx].params, ['user-planner-maya']);
    assert.deepEqual(executedSql[roleSettingIdx].params, ['event_planner']);
  });

  // =========================================================================
  // SYSTEM 2: BOOKING
  // =========================================================================
  it('System 2 (Booking): immediately releases a held slot via DELETE /api/consultations/holds', async () => {
    const availRes = await fetch(
      `${baseUrl}/api/consultations/availability?days=10&timezone=America/New_York&method=video`,
    );
    assert.equal(availRes.status, 200);
    const availData = (await availRes.json()) as {
      days: Array<{ slots: Array<{ available: boolean; plannerId: string; startUtc: string }> }>;
    };
    const slot = availData.days.flatMap((d) => d.slots).find((s) => s.available);
    assert.ok(slot, 'Expected at least one available consultation slot');

    // Client A places hold
    const holdA = await fetch(`${baseUrl}/api/consultations/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plannerId: slot.plannerId,
        startUtc: slot.startUtc,
        method: 'video',
        holderKey: 'client-a-holder-key-1234',
      }),
    });
    assert.equal(holdA.status, 201);

    // Client B is blocked (409) while Client A holds slot
    const holdBBlocked = await fetch(`${baseUrl}/api/consultations/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plannerId: slot.plannerId,
        startUtc: slot.startUtc,
        method: 'video',
        holderKey: 'client-b-holder-key-5678',
      }),
    });
    assert.equal(holdBBlocked.status, 409);

    // Client A releases hold immediately
    const releaseA = await fetch(`${baseUrl}/api/consultations/holds`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holderKey: 'client-a-holder-key-1234' }),
    });
    assert.equal(releaseA.status, 200);
    const releaseJson = (await releaseA.json()) as { ok: boolean; releasedCount: number };
    assert.equal(releaseJson.ok, true);
    assert.equal(releaseJson.releasedCount, 1);

    // Client B can now reserve the slot immediately
    const holdBSuccess = await fetch(`${baseUrl}/api/consultations/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plannerId: slot.plannerId,
        startUtc: slot.startUtc,
        method: 'video',
        holderKey: 'client-b-holder-key-5678',
      }),
    });
    assert.equal(holdBSuccess.status, 201);
  });

  it('System 2 (Booking): accepts Columbia ET today on POST /api/bookings and rejects past ET dates', async () => {
    const studioToday = getStudioTodayIso();
    const resToday = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Lauren Mitchell',
        clientEmail: 'lauren@celebrationsistersdecor.com',
        clientPhone: '803-555-0144',
        eventTitle: 'Same-Day Evening Showcase',
        eventType: 'Corporate Galas',
        serviceDivisionIds: ['corporate-galas'],
        eventDate: studioToday,
        location: 'Columbia, SC',
        venueName: 'The Lace House',
        guestCount: 80,
        budgetRange: '$15,000 – $25,000',
        notes: 'Testing Columbia ET today boundary',
      }),
    });
    assert.equal(resToday.status, 201);

    const resPast = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Lauren Mitchell',
        clientEmail: 'lauren@celebrationsistersdecor.com',
        clientPhone: '803-555-0144',
        eventTitle: 'Past Event Attempt',
        eventType: 'Corporate Galas',
        serviceDivisionIds: ['corporate-galas'],
        eventDate: '2020-01-01',
        location: 'Columbia, SC',
        venueName: 'The Lace House',
        guestCount: 80,
        budgetRange: '$15,000 – $25,000',
        notes: 'Should fail validation',
      }),
    });
    assert.equal(resPast.status, 400);
  });

  // =========================================================================
  // SYSTEM 3: SECURITY
  // =========================================================================
  it('System 3 (Security): returns 503 AUTH_PROVIDER_NOT_CONFIGURED on login and password-reset when unconfigured', async () => {
    const unconfiguredApp = createApp({ enableRateLimit: false, supabaseAuthClient: null });
    const { server: srv, baseUrl: url } = await startTestServer(unconfiguredApp);
    try {
      const loginRes = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'client@celebrationsistersdecor.com', password: 'Password123!' }),
      });
      assert.equal(loginRes.status, 503);
      const loginBody = (await loginRes.json()) as { code: string };
      assert.equal(loginBody.code, 'AUTH_PROVIDER_NOT_CONFIGURED');

      const resetRes = await fetch(`${url}/api/auth/password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'client@celebrationsistersdecor.com' }),
      });
      assert.equal(resetRes.status, 503);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('System 3 (Security): authenticates via /api/auth/login, blocks spoofed user_metadata role, enforces admin MFA, and revokes superseded aal1 JTI', async () => {
    // 1. New Supabase client with forged user_metadata.role='admin' strictly receives 'client'
    nextMockJwt = await mintSupabaseJwt({
      sub: 'sb-uid-client-9001',
      email: 'newclient@celebrationsistersdecor.com',
      emailVerified: true,
      aal: 'aal1',
      userMetadata: { role: 'admin', full_name: 'Nadia Sterling' },
    });

    const clientLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newclient@celebrationsistersdecor.com', password: 'StrongPassword1!' }),
    });
    assert.equal(clientLogin.status, 200);
    const clientData = (await clientLogin.json()) as {
      user: { id: string; role: string };
      token: string;
      mfaRequired: boolean;
    };
    assert.equal(clientData.user.role, 'client');
    assert.equal(clientData.mfaRequired, false);

    // Subsequent session check resolves persisted client
    const sessionCheck = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${clientData.token}` },
    });
    const sessionBody = (await sessionCheck.json()) as { user: { id: string; role: string } };
    assert.equal(sessionBody.user.role, 'client');
    assert.equal(sessionBody.user.id, 'sb:sb-uid-client-9001');

    // 2. Unverified email rejected with 403 EMAIL_NOT_VERIFIED
    nextMockJwt = await mintSupabaseJwt({
      sub: 'sb-uid-unverified-1',
      email: 'unverified@celebrationsistersdecor.com',
      emailVerified: false,
    });
    const unverifiedRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unverified@celebrationsistersdecor.com', password: 'StrongPassword1!' }),
    });
    assert.equal(unverifiedRes.status, 403);
    assert.equal(((await unverifiedRes.json()) as { code: string }).code, 'EMAIL_NOT_VERIFIED');

    // 3. Bound admin signing in at aal1 requires MFA, then upgrading to aal2 revokes superseded aal1 JTI
    const adminSub = 'sb-uid-director-immutable-01';
    await withTransaction((db) => {
      const admin = db.users.find((u) => u.role === 'admin');
      if (admin) {
        admin.supabaseUserId = adminSub;
      }
    });

    nextMockJwt = await mintSupabaseJwt({
      sub: adminSub,
      email: 'director@celebrationsistersdecor.com',
      emailVerified: true,
      aal: 'aal1',
    });
    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'director@celebrationsistersdecor.com', password: 'DirectorPassword1!' }),
    });
    assert.equal(adminLogin.status, 200);
    const adminData = (await adminLogin.json()) as {
      user: { role: string };
      token: string;
      mfaRequired: boolean;
    };
    assert.equal(adminData.user.role, 'admin');
    assert.equal(adminData.mfaRequired, true);

    const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminData.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(enrollRes.status, 200);
    const enrolled = (await enrollRes.json()) as { secret: string; recoveryCodes: string[] };
    const totpCode = generateTotpCode(enrolled.secret);

    const mfaVerify = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminData.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: `${totpCode.slice(0, 3)} ${totpCode.slice(3)}` }),
    });
    assert.equal(mfaVerify.status, 200);
    const upgraded = (await mfaVerify.json()) as { token: string; mfaVerified: boolean };
    assert.equal(upgraded.mfaVerified, true);

    // Replaying the superseded aal1 token MUST fail closed (401 on /api/bookings)
    const replayOldAal1 = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${adminData.token}` },
    });
    assert.equal(replayOldAal1.status, 401);

    // Upgraded aal2 token unlocks /api/admin/overview
    const overviewOk = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${upgraded.token}` },
    });
    assert.equal(overviewOk.status, 200);

    // Password reset dispatches via Supabase auth client with uniform 200
    const resetRes = await fetch(`${baseUrl}/api/auth/password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'director@celebrationsistersdecor.com' }),
    });
    assert.equal(resetRes.status, 200);
    assert.deepEqual(resetCalls, [{
      email: 'director@celebrationsistersdecor.com',
      redirectTo: new URL('/?auth=recovery', process.env.FRONTEND_PUBLIC_URL || 'https://celebrationsistersdecor.com').href,
    }]);

    nextResetError = resetProviderError;
    const deliveryFailure = await fetch(`${baseUrl}/api/auth/password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'director@celebrationsistersdecor.com' }),
    });
    assert.equal(deliveryFailure.status, 200);
    assert.deepEqual(await deliveryFailure.json(), await resetRes.json());
    const recoveryEvents = (await readDb()).authSecurityEvents
      .filter((entry) => entry.eventType === 'PASSWORD_RESET_REQUESTED');
    assert.deepEqual(recoveryEvents.map((entry) => entry.outcome), ['denied', 'allowed']);
    assert.ok(recoveryEvents.every((entry) => !entry.details?.includes(resetProviderError)));
  });

  // =========================================================================
  // SYSTEM 4: EMAIL
  // =========================================================================
  it('System 4 (Email): blocks live production Resend dispatch to RFC 2606 placeholder domains', async () => {
    assert.equal(isReservedPlaceholderEmail('directors@celebrationsisters.example.com'), true);
    assert.equal(isReservedPlaceholderEmail('client@demo.invalid'), true);
    assert.equal(isReservedPlaceholderEmail('events@celebrationsistersdecor.com'), false);

    const prevEnv = {
      NODE_ENV: process.env.NODE_ENV,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      EMAIL_FROM: process.env.EMAIL_FROM,
      EMAIL_LIVE_DELIVERY_ENABLED: process.env.EMAIL_LIVE_DELIVERY_ENABLED,
    };
    let fetchCalled = 0;

    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = ['re', 'test', 'guard', 'placeholder'].join('_');
    process.env.EMAIL_FROM = 'concierge@celebrationsistersdecor.com';
    process.env.EMAIL_LIVE_DELIVERY_ENABLED = 'true';

    try {
      const { record } = await dispatchEmailNotification(
        {
          idempotencyKey: 'placeholder-guard-key-1',
          category: 'staff_new_booking_alert',
          recipient: 'directors@celebrationsisters.example.com',
          bookingReference: 'CS-2027-0200',
          subject: 'Test Alert',
          htmlBody: '<p>Test</p>',
          textBody: 'Test',
        },
        [],
        {
          fetchImpl: async () => {
            fetchCalled += 1;
            return new Response(JSON.stringify({ id: 'should-not-send' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        },
      );
      assert.equal(fetchCalled, 0);
      assert.equal(record.status, 'Skipped (Unconfigured)');
      assert.match(record.lastError || '', /placeholder/i);
    } finally {
      if (prevEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv.NODE_ENV;
      if (prevEnv.RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevEnv.RESEND_API_KEY;
      if (prevEnv.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = prevEnv.EMAIL_FROM;
      if (prevEnv.EMAIL_LIVE_DELIVERY_ENABLED === undefined) delete process.env.EMAIL_LIVE_DELIVERY_ENABLED;
      else process.env.EMAIL_LIVE_DELIVERY_ENABLED = prevEnv.EMAIL_LIVE_DELIVERY_ENABLED;
    }
  });

  it('System 4 (Email): reconciles signed Resend email.delivery_delayed and email.failed webhooks atomically', async () => {
    const secret = 'whsec_' + Buffer.from('phase35-webhook-signing-secret-key').toString('base64');
    const prevSecret = process.env.RESEND_WEBHOOK_SECRET;
    process.env.RESEND_WEBHOOK_SECRET = secret;

    try {
      await withTransaction((db) => {
        db.notificationOutbox.push({
          id: 'outbox-wh-test-1',
          idempotencyKey: 'wh-test-key-1',
          category: 'consultation_confirmation',
          channel: 'Email',
          recipient: 'client@celebrationsistersdecor.com',
          bookingReference: 'CS-2027-0301',
          subject: 'Confirmation',
          htmlBody: '<p>Confirmed</p>',
          textBody: 'Confirmed',
          status: 'ProviderAccepted',
          providerMessageId: 're_msg_delay_fail_01',
          attempts: 1,
          maxAttempts: 5,
          nextAttemptAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });

      const ts = String(Math.floor(Date.now() / 1000));

      const delayPayload = JSON.stringify({
        type: 'email.delivery_delayed',
        data: { email_id: 're_msg_delay_fail_01' },
      });
      const delayRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': 'msg_delay_001',
          'svix-timestamp': ts,
          'svix-signature': signSvixWebhook(secret, 'msg_delay_001', ts, delayPayload),
        },
        body: delayPayload,
      });
      assert.equal(delayRes.status, 200);
      let db = await readDb();
      let job = db.notificationOutbox.find((j) => j.id === 'outbox-wh-test-1');
      assert.equal(job?.status, 'ProviderAccepted');
      assert.match(job?.lastError || '', /email\.delivery_delayed/i);

      const failPayload = JSON.stringify({
        type: 'email.failed',
        data: { email_id: 're_msg_delay_fail_01' },
      });
      const failRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': 'msg_fail_002',
          'svix-timestamp': ts,
          'svix-signature': signSvixWebhook(secret, 'msg_fail_002', ts, failPayload),
        },
        body: failPayload,
      });
      assert.equal(failRes.status, 200);
      db = await readDb();
      job = db.notificationOutbox.find((j) => j.id === 'outbox-wh-test-1');
      assert.equal(job?.status, 'DeadLetter');
      assert.match(job?.lastError || '', /email\.failed/i);
    } finally {
      if (prevSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
      else process.env.RESEND_WEBHOOK_SECRET = prevSecret;
    }
  });

  // =========================================================================
  // SYSTEM 5: OPERATIONS
  // =========================================================================
  it('System 5 (Operations): returns enriched readiness & scheduling diagnostics on GET /api/admin/metrics without secrets', async () => {
    const switchRes = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-admin-director' }),
    });
    const switched = (await switchRes.json()) as { token: string };

    const mfaRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${switched.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '654321' }),
    });
    const verified = (await mfaRes.json()) as { token: string };

    const metricsRes = await fetch(`${baseUrl}/api/admin/metrics`, {
      headers: { Authorization: `Bearer ${verified.token}` },
    });
    assert.equal(metricsRes.status, 200);
    const body = (await metricsRes.json()) as {
      outbox: { queueDepth: number; deadLetterCount: number };
      scheduling: { activeSlotHolds: number; totalConsultations: number };
      readiness: {
        status: string;
        productionReady: boolean;
        checks: Record<string, boolean>;
        blockingReasons: string[];
        worker: { workerId: string; healthy: boolean };
        email: { provider: string; configured: boolean };
      };
    };
    assert.equal(typeof body.scheduling.activeSlotHolds, 'number');
    assert.equal(typeof body.readiness.productionReady, 'boolean');
    assert.equal('database' in body.readiness.checks, true);
    assert.equal('worker' in body.readiness.checks, true);
    assert.ok(body.readiness.worker.workerId.length > 0);
    assert.equal(JSON.stringify(body).includes(jwtSecret), false);
  });

  it('System 5 (Operations): verifyDeploymentAndRollback passes all 8 operational & rollback checks against live server', async () => {
    const report = await verifyDeploymentAndRollback({
      targetUrl: baseUrl,
      allowedOrigin: 'http://localhost:3000',
      strictProduction: false,
    });
    assert.equal(report.checks.length, 8);
    for (const check of report.checks) {
      assert.equal(check.passed, true, `${check.id}: ${check.detail}`);
    }
    assert.equal(report.passed, true);
  });
});
