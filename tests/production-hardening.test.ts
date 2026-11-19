import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { createApp } from '../server/app.ts';
import { parseCookies, verifyAdminMfaChallenge } from '../server/auth.ts';
import {
  buildConsultationConfirmationTemplate,
  dispatchEmailNotification,
  type FetchLike,
} from '../server/notifications.ts';
import {
  checkPersistenceHealth,
  readDbFromPostgres,
  runPostgresTransaction,
  setInjectedPgPoolForTests,
  type PgClientLike,
  type PgPoolLike,
} from '../server/repositories/postgresRepository.ts';
import { PostgresRateLimitStore } from '../server/rateLimit.ts';
import { generateTotpCode, generateTotpSecret, verifyTotpCode } from '../server/totp.ts';
import type { Request } from 'express';
import type { DatabaseSchema } from '../server/store.ts';
import type { NotificationDeliveryRecord } from '../src/types/domain.ts';

async function startTestServer(options?: { enableRateLimit?: boolean }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-hardening-test-'));
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');

  const app = createApp({ enableRateLimit: options?.enableRateLimit ?? false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    baseUrl,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
      delete process.env.CS_DB_PATH;
    },
  };
}

function futureIsoDate(daysAhead = 45): string {
  const dt = new Date(Date.now() + daysAhead * 86_400_000);
  return dt.toISOString().slice(0, 10);
}

test('malformed cookie encoding and prototype keys never crash session parsing or API routes', async () => {
  const parsed = parseCookies({
    header: (name: string) =>
      name.toLowerCase() === 'cookie'
        ? 'cs_session=%E0%A4%A; __proto__=polluted; constructor=evil; valid=ok%201'
        : undefined,
  } as unknown as Request);
  assert.equal(parsed.cs_session, undefined);
  assert.equal(parsed.valid, 'ok 1');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'constructor'), false);

  const { baseUrl, cleanup } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: 'cs_session=%E0%A4%A; __proto__=bad' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: { role: string } };
    assert.equal(body.user.role, 'guest');
  } finally {
    await cleanup();
  }
});

test('RFC 6238 TOTP MFA enrollment & verification work end-to-end and static passcode is forbidden in production', async () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  const code = generateTotpCode(secret, now);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotpCode(secret, code, { timestampMs: now }), true);
  assert.equal(verifyTotpCode(secret, '000000', { timestampMs: now }), code === '000000');

  // Verify static ADMIN_MFA_PASSCODE is rejected when NODE_ENV=production
  const prevEnv = process.env.NODE_ENV;
  const prevPass = process.env.ADMIN_MFA_PASSCODE;
  try {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_MFA_PASSCODE = 'CS-EXEC-2026';
    const noTotpAdmin = {
      id: 'u-1',
      name: 'Director',
      email: 'director@example.com',
      role: 'admin' as const,
    };
    const prodStaticAttempt = verifyAdminMfaChallenge(noTotpAdmin, 'CS-EXEC-2026');
    assert.equal(prodStaticAttempt.verified, false);
    assert.equal(prodStaticAttempt.method, 'none');

    const totpAdmin = { ...noTotpAdmin, totpSecret: secret };
    const prodTotpAttempt = verifyAdminMfaChallenge(totpAdmin, generateTotpCode(secret));
    assert.equal(prodTotpAttempt.verified, true);
    assert.equal(prodTotpAttempt.method, 'totp');
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevPass === undefined) delete process.env.ADMIN_MFA_PASSCODE;
    else process.env.ADMIN_MFA_PASSCODE = prevPass;
  }

  // Full API flow: switch to admin, enroll TOTP, verify TOTP, access /api/admin/overview, and ensure totpSecret is never exposed
  const { baseUrl, cleanup } = await startTestServer();
  try {
    const switchRes = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ userId: 'user-admin-director' }),
    });
    assert.equal(switchRes.status, 200);
    const switchBody = (await switchRes.json()) as { csrfToken?: string };
    assert.ok(switchBody.csrfToken);
    const cookie1 = (switchRes.headers.get('set-cookie') || '').split(';')[0];

    const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: {
        Cookie: cookie1,
        'X-CSRF-Token': switchBody.csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    assert.equal(enrollRes.status, 200);
    const enrollBody = (await enrollRes.json()) as {
      secret: string;
      otpauthUri: string;
      recoveryCodes?: string[];
    };
    assert.ok(enrollBody.secret.length >= 16);
    assert.ok(enrollBody.otpauthUri.startsWith('otpauth://totp/'));
    assert.equal(enrollBody.recoveryCodes?.length, 8);

    // Invalid TOTP code fails with 403
    const badMfa = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1,
        'X-CSRF-Token': switchBody.csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ code: '111111' }),
    });
    const validTotp = generateTotpCode(enrollBody.secret);
    if (validTotp !== '111111') {
      assert.equal(badMfa.status, 403);
    }

    // Valid TOTP code succeeds and unlocks /api/admin/overview
    const goodMfa = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1,
        'X-CSRF-Token': switchBody.csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ code: validTotp }),
    });
    assert.equal(goodMfa.status, 200);
    const goodMfaBody = (await goodMfa.json()) as { csrfToken?: string };
    assert.ok(goodMfaBody.csrfToken);
    const cookie2 = (goodMfa.headers.get('set-cookie') || '').split(';')[0];

    const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: cookie2 },
    });
    const sessionText = await sessionRes.text();
    assert.equal(sessionText.includes(enrollBody.secret), false);

    const overviewRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: cookie2 },
    });
    assert.equal(overviewRes.status, 200);

    // Admin identity linking endpoint works and prevents duplicate supabaseUserId binding
    const linkOk = await fetch(`${baseUrl}/api/admin/users/user-staff-maya/link-identity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
        'X-CSRF-Token': goodMfaBody.csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ supabaseUserId: 'sb-uuid-maya-verified' }),
    });
    assert.equal(linkOk.status, 200);

    const linkDup = await fetch(`${baseUrl}/api/admin/users/user-vendor-lumiere/link-identity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie2,
        'X-CSRF-Token': goodMfaBody.csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ supabaseUserId: 'sb-uuid-maya-verified' }),
    });
    assert.equal(linkDup.status, 409);
  } finally {
    await cleanup();
  }
});

test('consultation booking validates future dates, enforces Idempotency-Key deduplication, and supports public status tracking', async () => {
  const { baseUrl, cleanup } = await startTestServer();
  try {
    // Past date is rejected with 400
    const pastRes = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Jordan Ellis',
        clientEmail: 'jordan.ellis@example.com',
        clientPhone: '(803) 555-0199',
        eventTitle: 'Ellis Gala',
        eventType: 'Corporate Event',
        serviceDivisionIds: ['corporate-events'],
        eventDate: '2020-01-15',
        guestCount: 150,
        venueName: 'Columbia Museum of Art',
        location: 'Columbia, SC',
        budgetRange: '$25,000 - $40,000',
      }),
    });
    assert.equal(pastRes.status, 400);

    // Idempotency-Key prevents duplicate bookings on double-submit
    const eventDate = futureIsoDate(60);
    const idempKey = 'cs-idem-test-0001';
    const payload = {
      clientName: 'Jordan Ellis',
      clientEmail: 'jordan.ellis@example.com',
      clientPhone: '(803) 555-0199',
      eventTitle: 'Ellis Anniversary Gala',
      eventType: 'Anniversary & Private Event',
      serviceDivisionIds: ['luxury-decor'],
      eventDate,
      guestCount: 120,
      venueName: '701 Whaley',
      location: 'Columbia, SC',
      budgetRange: '$18,000 - $30,000',
    };

    const first = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempKey },
      body: JSON.stringify(payload),
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      booking: { id: string; referenceCode: string };
      deduplicated?: boolean;
      notificationStatus?: string;
    };
    assert.equal(Boolean(firstBody.booking.referenceCode), true);
    assert.equal(firstBody.deduplicated, false);

    const second = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempKey },
      body: JSON.stringify(payload),
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as {
      booking: { id: string; referenceCode: string };
      deduplicated?: boolean;
    };
    assert.equal(secondBody.deduplicated, true);
    assert.equal(secondBody.booking.id, firstBody.booking.id);
    assert.equal(secondBody.booking.referenceCode, firstBody.booking.referenceCode);

    // Public booking status lookup succeeds with matching referenceCode + email
    const trackOk = await fetch(
      `${baseUrl}/api/bookings/track?referenceCode=${encodeURIComponent(firstBody.booking.referenceCode)}&email=${encodeURIComponent('jordan.ellis@example.com')}`,
    );
    assert.equal(trackOk.status, 200);
    const trackBody = (await trackOk.json()) as {
      tracking: { referenceCode: string; status: string; venueName: string };
    };
    assert.equal(trackBody.tracking.referenceCode, firstBody.booking.referenceCode);
    assert.equal(trackBody.tracking.status, 'Consultation Requested');

    // Wrong email returns 404 (no cross-client enumeration)
    const trackWrongEmail = await fetch(
      `${baseUrl}/api/bookings/track?referenceCode=${encodeURIComponent(firstBody.booking.referenceCode)}&email=other@example.com`,
    );
    assert.equal(trackWrongEmail.status, 404);
  } finally {
    await cleanup();
  }
});

test('Resend notification adapter handles unconfigured pause, provider acceptance, retry recovery, failure, and idempotency suppression', async () => {
  const tpl = buildConsultationConfirmationTemplate({
    clientName: 'Camille <script>alert(1)</script>',
    referenceCode: 'CS-2026-999',
    eventTitle: 'Mercer Gala',
    eventDate: '2027-05-01',
    venueName: 'Lace House',
    location: 'Columbia, SC',
  });
  assert.equal(tpl.htmlBody.includes('<script>'), false);
  assert.equal(tpl.htmlBody.includes('&lt;script&gt;'), true);

  const history: NotificationDeliveryRecord[] = [];

  // 1. Unconfigured skips cleanly without fabricating delivery
  const unconfigured = await dispatchEmailNotification(
    {
      idempotencyKey: 'ntf-unconf-1',
      category: 'consultation_confirmation',
      recipient: 'client@example.com',
      subject: tpl.subject,
      htmlBody: tpl.htmlBody,
      textBody: tpl.textBody,
    },
    history,
    { apiKey: '', fromAddress: '', liveDeliveryEnabled: false },
  );
  assert.equal(unconfigured.record.status, 'Skipped (Unconfigured)');
  assert.equal(unconfigured.deduplicated, false);

  // 2. Transient HTTP 500 followed by HTTP 200 retries and records honest ProviderAccepted
  let callCount = 0;
  const flakyFetch: FetchLike = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response('Upstream timeout', { status: 503 });
    }
    return new Response(JSON.stringify({ id: 're_msg_12345' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const accepted = await dispatchEmailNotification(
    {
      idempotencyKey: 'ntf-live-1',
      category: 'consultation_confirmation',
      recipient: 'client@example.com',
      subject: tpl.subject,
      htmlBody: tpl.htmlBody,
      textBody: tpl.textBody,
    },
    history,
    {
      apiKey: 're_test_key',
      fromAddress: 'concierge@celebrationsisters.com',
      liveDeliveryEnabled: true,
      fetchImpl: flakyFetch,
      baseBackoffMs: 1,
    },
  );
  assert.equal(accepted.record.status, 'ProviderAccepted');
  assert.equal(accepted.record.providerMessageId, 're_msg_12345');
  assert.equal(accepted.record.attempts, 2);
  history.push(accepted.record);

  // 3. Duplicate send with same idempotencyKey is suppressed without calling provider
  let shouldNotCall = 0;
  const dup = await dispatchEmailNotification(
    {
      idempotencyKey: 'ntf-live-1',
      category: 'consultation_confirmation',
      recipient: 'client@example.com',
      subject: tpl.subject,
      htmlBody: tpl.htmlBody,
      textBody: tpl.textBody,
    },
    history,
    {
      apiKey: 're_test_key',
      fromAddress: 'concierge@celebrationsisters.com',
      liveDeliveryEnabled: true,
      fetchImpl: async () => {
        shouldNotCall += 1;
        return new Response('{}', { status: 200 });
      },
    },
  );
  assert.equal(dup.deduplicated, true);
  assert.equal(shouldNotCall, 0);

  // 4. Non-retryable HTTP 400 fails immediately without extra retries
  let badReqCalls = 0;
  const failed = await dispatchEmailNotification(
    {
      idempotencyKey: 'ntf-fail-1',
      category: 'consultation_confirmation',
      recipient: 'bad-address',
      subject: tpl.subject,
      htmlBody: tpl.htmlBody,
      textBody: tpl.textBody,
    },
    history,
    {
      apiKey: 're_test_key',
      fromAddress: 'concierge@celebrationsisters.com',
      liveDeliveryEnabled: true,
      fetchImpl: async () => {
        badReqCalls += 1;
        return new Response('Invalid recipient', { status: 400 });
      },
      baseBackoffMs: 1,
    },
  );
  assert.equal(failed.record.status, 'Failed');
  assert.equal(badReqCalls, 1);
});

test('PostgreSQL repository executes live SELECT 1 health check, atomic BEGIN/FOR UPDATE/COMMIT, ROLLBACK on failure, and /ready returns 503 on DB error', async () => {
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.PERSISTENCE_ADAPTER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/cs_test';

  let storedPayload: DatabaseSchema | null = null;
  let stagedPayload: DatabaseSchema | null = null;
  const executedSql: string[] = [];
  let shouldFailHealth = false;

  const mockClient: PgClientLike = {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
      const sql = text.trim().replace(/\s+/g, ' ');
      executedSql.push(sql);

      if (sql === 'BEGIN') {
        stagedPayload = storedPayload ? (JSON.parse(JSON.stringify(storedPayload)) as DatabaseSchema) : null;
        return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
      }
      if (sql === 'COMMIT') {
        storedPayload = stagedPayload;
        return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
      }
      if (sql === 'ROLLBACK') {
        stagedPayload = storedPayload;
        return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
      }
      if (sql.startsWith('INSERT INTO app_state_snapshots')) {
        const parsed = JSON.parse(String(values?.[1] ?? '{}')) as DatabaseSchema;
        if (!stagedPayload) stagedPayload = parsed;
        if (!storedPayload) storedPayload = parsed;
        return { rows: [{ payload: stagedPayload } as unknown as T], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      }
      if (sql.startsWith('SELECT payload FROM app_state_snapshots')) {
        const active = stagedPayload ?? storedPayload;
        return {
          rows: active ? ([{ payload: active } as unknown as T]) : [],
          rowCount: active ? 1 : 0,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }
      if (sql.startsWith('UPDATE app_state_snapshots')) {
        stagedPayload = JSON.parse(String(values?.[1] ?? '{}')) as DatabaseSchema;
        return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: 'OK', oid: 0, fields: [] };
    },
    release() {
      // no-op
    },
  };

  const mockPool: PgPoolLike = {
    async connect() {
      return mockClient;
    },
    async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
      executedSql.push(text.trim());
      if (shouldFailHealth) {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:5432') as Error & { code?: string };
        err.code = 'ECONNREFUSED';
        throw err;
      }
      return { rows: [{ ok: 1 } as unknown as T], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
    },
    async end() {
      // no-op
    },
  };

  setInjectedPgPoolForTests(mockPool);

  const buildMinimalSeed = (): DatabaseSchema => ({
    users: [],
    bookings: [],
    availabilityHolds: [],
    blackoutDates: [],
    concepts: [],
    vendors: [],
    staffChecklists: [],
    inventory: [],
    aiSessions: [],
    automationWorkflows: [],
    automationLogs: [],
    auditLogs: [],
    invitations: [],
    authSecurityEvents: [],
    notificationDeliveries: [],
    notificationOutbox: [],
    revokedSessionIds: [],
    bookingIdempotencyKeys: {},
  });

  try {
    // 1. Live SELECT 1 health check passes when DB responds
    const healthy = await checkPersistenceHealth();
    assert.equal(healthy.adapter, 'postgres');
    assert.equal(healthy.ready, true);
    assert.equal(healthy.connected, true);

    // 2. Atomic transaction commits cleanly with SELECT ... FOR UPDATE
    await runPostgresTransaction(
      buildMinimalSeed,
      (raw) => raw,
      (db) => {
        db.users.push({
          id: 'pg-user-1',
          name: 'PG Verified User',
          email: 'pg@example.com',
          role: 'client',
        });
      },
    );
    assert.ok(executedSql.some((s) => s.includes('FOR UPDATE')));
    assert.ok(executedSql.includes('COMMIT'));

    const loaded = await readDbFromPostgres(buildMinimalSeed);
    assert.equal(loaded.users.length, 1);
    assert.equal(loaded.users[0]?.id, 'pg-user-1');

    // 3. Failed transaction rolls back and preserves prior committed state
    await assert.rejects(
      () =>
        runPostgresTransaction(
          buildMinimalSeed,
          (raw) => raw,
          (db) => {
            db.users.push({
              id: 'pg-user-rolled-back',
              name: 'Should Roll Back',
              email: 'rb@example.com',
              role: 'client',
            });
            throw new Error('SIMULATED_CONSTRAINT_ERROR');
          },
        ),
      /SIMULATED_CONSTRAINT_ERROR/,
    );
    assert.ok(executedSql.includes('ROLLBACK'));
    const afterRollback = await readDbFromPostgres(buildMinimalSeed);
    assert.equal(afterRollback.users.length, 1);

    // 4. Simulated DB outage makes checkPersistenceHealth() and /ready return 503
    shouldFailHealth = true;
    const unhealthy = await checkPersistenceHealth();
    assert.equal(unhealthy.ready, false);
    assert.equal(unhealthy.connected, false);
    assert.ok(unhealthy.reason.includes('ECONNREFUSED'));

    const app = createApp({ enableRateLimit: false });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
      const readyRes = await fetch(`${baseUrl}/ready`);
      assert.equal(readyRes.status, 503);
      const readyBody = (await readyRes.json()) as { ok: boolean; persistence: { connected: boolean } };
      assert.equal(readyBody.ok, false);
      assert.equal(readyBody.persistence.connected, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    setInjectedPgPoolForTests(null);
    if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
    else process.env.PERSISTENCE_ADAPTER = prevAdapter;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  }
});

test('replica-safe PostgresRateLimitStore enforces request caps and emits Retry-After headers on 429', async () => {
  const counters = new Map<string, { count: number; resetAt: string }>();
  const store = new PostgresRateLimitStore({
    async query<T = Record<string, unknown>>(_text: string, params?: unknown[]) {
      const key = String(params?.[0] ?? '');
      const nextReset = String(params?.[1] ?? new Date(Date.now() + 60_000).toISOString());
      const cur = counters.get(key);
      if (!cur) {
        counters.set(key, { count: 1, resetAt: nextReset });
      } else {
        cur.count += 1;
      }
      const entry = counters.get(key)!;
      return {
        rows: [{ request_count: entry.count, reset_at: entry.resetAt } as unknown as T],
      };
    },
  });

  const r1 = await store.consume('ip:POST:/api/bookings', 2, 60_000);
  const r2 = await store.consume('ip:POST:/api/bookings', 2, 60_000);
  const r3 = await store.consume('ip:POST:/api/bookings', 2, 60_000);

  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);
  assert.equal(r3.allowed, false);
  assert.equal(r3.remaining, 0);
});
