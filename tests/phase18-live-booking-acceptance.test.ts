import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { PostgresRateLimitStore, RateLimitUnavailableError, type PgQueryable } from '../server/rateLimit.ts';
import { checkPersistenceHealth, setInjectedPgPoolForTests } from '../server/repositories/postgresRepository.ts';
import { getStudioTodayIso } from '../server/scheduling.ts';

async function startTestServer() {
  const app = createApp({ enableRateLimit: false });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind test server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('Phase 18: PostgresRateLimitStore bootstraps missing rate_limit_buckets (42P01) while keeping real outages and restricted roles fail-closed', async () => {
  let tableCreated = false;
  let insertCount = 0;

  const freshRailwayDb: PgQueryable = {
    async query<T>(sql: string) {
      if (/CREATE TABLE IF NOT EXISTS rate_limit_buckets/i.test(sql)) {
        tableCreated = true;
        return { rows: [] as T[] };
      }
      if (/CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_reset/i.test(sql)) {
        return { rows: [] as T[] };
      }
      if (/INSERT INTO rate_limit_buckets/i.test(sql)) {
        if (!tableCreated) {
          const err = new Error('relation "rate_limit_buckets" does not exist');
          (err as { code?: string }).code = '42P01';
          throw err;
        }
        insertCount += 1;
        return {
          rows: [
            {
              request_count: insertCount,
              reset_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ] as T[],
        };
      }
      return { rows: [] as T[] };
    },
  };

  const store = new PostgresRateLimitStore(freshRailwayDb);
  const res = await store.consume('127.0.0.1:GET:/api/consultations/status', 30, 60_000, {
    failClosed: true,
    endpointGroup: 'consultations:status',
  });
  assert.equal(tableCreated, true, 'Missing rate_limit_buckets table should be bootstrapped idempotently on 42P01');
  assert.equal(res.allowed, true);
  assert.equal(res.remaining, 29);

  // Real DB outage MUST still fail closed (never degrade to in-memory on failClosed: true)
  const outageDb: PgQueryable = {
    async query() {
      const err = new Error('connection refused');
      (err as { code?: string }).code = 'ECONNREFUSED';
      throw err;
    },
  };
  const outageStore = new PostgresRateLimitStore(outageDb);
  await assert.rejects(
    () =>
      outageStore.consume('127.0.0.1:GET:/api/consultations/status', 30, 60_000, {
        failClosed: true,
        endpointGroup: 'consultations:status',
      }),
    RateLimitUnavailableError,
  );

  // Non-superuser role lacking CREATE TABLE privileges MUST still fail closed
  const restrictedRoleDb: PgQueryable = {
    async query(sql: string) {
      if (/CREATE TABLE/i.test(sql)) {
        const err = new Error('permission denied for schema public');
        (err as { code?: string }).code = '42501';
        throw err;
      }
      const err = new Error('relation "rate_limit_buckets" does not exist');
      (err as { code?: string }).code = '42P01';
      throw err;
    },
  };
  const restrictedStore = new PostgresRateLimitStore(restrictedRoleDb);
  await assert.rejects(
    () =>
      restrictedStore.consume('127.0.0.1:GET:/api/consultations/status', 30, 60_000, {
        failClosed: true,
        endpointGroup: 'consultations:status',
      }),
    RateLimitUnavailableError,
  );
});

test('Phase 18: checkPersistenceHealth surfaces PostgreSQL schema migration & rate_limit_buckets diagnostics', async () => {
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;
  process.env.PERSISTENCE_ADAPTER = 'postgres';
  try {
    setInjectedPgPoolForTests({
      async connect() {
        throw new Error('not needed');
      },
      async query(text: string) {
        if (/to_regclass/i.test(text)) {
          return {
            rows: [{ rate_limit_tbl: 'rate_limit_buckets', migrations_tbl: 'schema_migrations' }],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          } as never;
        }
        if (/FROM schema_migrations/i.test(text)) {
          return {
            rows: [{ cnt: 8 }],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          } as never;
        }
        return {
          rows: [{ ok: 1 }],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        } as never;
      },
      async end() {},
    });

    const health = await checkPersistenceHealth();
    assert.equal(health.ready, true);
    assert.equal(health.connected, true);
    assert.deepEqual(health.schema, {
      rateLimitTablePresent: true,
      migrationsTablePresent: true,
      migrationsAppliedCount: 8,
    });
  } finally {
    setInjectedPgPoolForTests(null);
    if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
    else process.env.PERSISTENCE_ADAPTER = prevAdapter;
  }
});

test('Phase 18: getStudioTodayIso resolves Columbia, SC (America/New_York) date without UTC evening drift', () => {
  // 2026-11-20T02:30:00Z is 2026-11-19 21:30:00 EST in Columbia, SC
  const eveningEstMs = Date.parse('2026-11-20T02:30:00.000Z');
  assert.equal(getStudioTodayIso(eveningEstMs), '2026-11-19');

  // 2026-07-05T03:45:00Z is 2026-07-04 23:45:00 EDT in Columbia, SC
  const summerEveningEdtMs = Date.parse('2026-07-05T03:45:00.000Z');
  assert.equal(getStudioTodayIso(summerEveningEdtMs), '2026-07-04');
});

test('Phase 18: Header-based X-Consultation-Token self-service lifecycle + cross-origin CORS preflight', async () => {
  const prevOrigins = process.env.ALLOWED_ORIGINS;
  const prevDataPath = process.env.DATA_FILE_PATH;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-phase18-'));
  process.env.DATA_FILE_PATH = path.join(tmpDir, 'db.json');
  process.env.ALLOWED_ORIGINS = 'https://celebrationsistersdecor.com,https://www.celebrationsistersdecor.com';
  const srv = await startTestServer();

  try {
    // 1. CORS preflight for custom domain allows X-Consultation-Token & Idempotency-Key
    const preflightOk = await fetch(`${srv.baseUrl}/api/consultations/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://celebrationsistersdecor.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Consultation-Token',
      },
    });
    assert.equal(preflightOk.status, 204);
    assert.equal(preflightOk.headers.get('access-control-allow-origin'), 'https://celebrationsistersdecor.com');
    assert.match(preflightOk.headers.get('access-control-allow-headers') || '', /X-Consultation-Token/i);

    // 2. Untrusted origin rejected on preflight
    const preflightBad = await fetch(`${srv.baseUrl}/api/consultations/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil-untrusted.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.equal(preflightBad.status, 403);

    // 3. Fetch real availability and pick two distinct slots
    const availRes = await fetch(`${srv.baseUrl}/api/consultations/availability?days=14&method=video&timezone=America/New_York`);
    assert.equal(availRes.status, 200);
    const availJson = (await availRes.json()) as {
      days: Array<{ slots: Array<{ available: boolean; plannerId: string; startUtc: string }> }>;
    };
    const openSlots = availJson.days.flatMap((d) => d.slots).filter((s) => s.available);
    assert.ok(openSlots.length >= 2, 'Expected at least 2 open consultation slots');
    const slotA = openSlots[0];
    const slotB = openSlots[1];

    // 4. Create consultation booking
    const createRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://celebrationsistersdecor.com',
        'Idempotency-Key': 'phase18-header-token-lifecycle-1',
      },
      body: JSON.stringify({
        eventType: 'Full-Service Wedding Planning & Floral Production',
        eventTitle: 'Phase 18 Header-Token Verification',
        serviceDivisionIds: ['wedding-planning'],
        eventDate: '2027-08-14',
        guestCount: 160,
        budgetRange: '$25,000 – $45,000',
        location: 'Columbia, SC',
        venueName: 'Lace House Gardens',
        consultationStartUtc: slotA.startUtc,
        consultationMethod: 'video',
        plannerId: slotA.plannerId,
        clientTimezone: 'America/New_York',
        clientName: 'Avery Holloway',
        clientEmail: 'avery.holloway.phase18@example.com',
        clientPhone: '(803) 555-0192',
        preferredContactMethod: 'email',
        notes: 'Header token test',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      consultation: { id: string; referenceCode: string };
      accessToken: string;
    };
    assert.ok(created.accessToken.startsWith('csa_'));

    // 5. Status lookup using ONLY X-Consultation-Token header (no accessToken in URL query string)
    const statusRes = await fetch(
      `${srv.baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}`,
      { headers: { 'X-Consultation-Token': created.accessToken } },
    );
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as { consultation: { referenceCode: string; status: string } };
    assert.equal(statusJson.consultation.referenceCode, created.consultation.referenceCode);

    // 6. Client details update using ONLY X-Consultation-Token header
    const patchRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/client-details`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Consultation-Token': created.accessToken,
      },
      body: JSON.stringify({ guestCount: 185, eventTheme: 'Royal Amethyst & Candlelight' }),
    });
    assert.equal(patchRes.status, 200);

    // 7. Reschedule using ONLY X-Consultation-Token header
    const reschedRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/reschedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Consultation-Token': created.accessToken,
      },
      body: JSON.stringify({ newStartUtc: slotB.startUtc, plannerId: slotB.plannerId }),
    });
    assert.equal(reschedRes.status, 200);

    // 8. Cancel using ONLY X-Consultation-Token header
    const cancelRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Consultation-Token': created.accessToken,
      },
      body: JSON.stringify({ reason: 'Phase 18 verification complete' }),
    });
    assert.equal(cancelRes.status, 200);

    // 9. Revoke token via header and verify subsequent lookup returns 403 TOKEN_REVOKED
    const revokeRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/token/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Consultation-Token': created.accessToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(revokeRes.status, 200);

    const revokedStatusRes = await fetch(
      `${srv.baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}`,
      { headers: { 'X-Consultation-Token': created.accessToken } },
    );
    assert.equal(revokedStatusRes.status, 403);
    const revokedJson = (await revokedStatusRes.json()) as { code: string };
    assert.equal(revokedJson.code, 'TOKEN_REVOKED');
  } finally {
    await srv.close();
    if (prevOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = prevOrigins;
    if (prevDataPath === undefined) delete process.env.DATA_FILE_PATH;
    else process.env.DATA_FILE_PATH = prevDataPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 18: Frontend ConsultationModal & deploy-pages.yml security and production-origin contracts', () => {
  const modalSource = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ConsultationModal.tsx'), 'utf8');
  assert.doesNotMatch(
    modalSource,
    /accessToken=\$\{/,
    'ConsultationModal must not leak scoped csa_ verification tokens into URL query strings',
  );
  assert.match(modalSource, /'X-Consultation-Token':\s*trackToken\.trim\(\)/);
  assert.match(modalSource, /Retry Availability/);
  assert.match(modalSource, /Reserving Slot\.\.\./);

  const workflowSource = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/deploy-pages.yml'), 'utf8');
  assert.match(workflowSource, /celebrationsisterseventdecor-production\.up\.railway\.app/);
  assert.match(workflowSource, /::error::VITE_API_BASE_URL must be configured for production booking\./);
  assert.match(workflowSource, /if \[ -z "\$\{VITE_API_BASE_URL:-\}" \]; then/);
  assert.match(workflowSource, /exit 1/);
});
