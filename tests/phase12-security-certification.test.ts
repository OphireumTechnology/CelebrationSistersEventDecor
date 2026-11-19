import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { createApp } from '../server/app.ts';
import {
  setInjectedPgPoolForTests,
  type PgClientLike,
  type PgPoolLike,
} from '../server/repositories/postgresRepository.ts';
import type { DatabaseSchema } from '../server/store.ts';
import { readDb } from '../server/store.ts';
import { generateTotpCode } from '../server/totp.ts';

async function startIsolatedServer(options?: { enableRateLimit?: boolean }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p12-sec-'));
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

function createInMemoryMockPgPool(initialSeed: DatabaseSchema): PgPoolLike {
  let committed: DatabaseSchema = JSON.parse(JSON.stringify(initialSeed)) as DatabaseSchema;
  let staged: DatabaseSchema = JSON.parse(JSON.stringify(initialSeed)) as DatabaseSchema;

  const client: PgClientLike = {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
      const sql = text.trim().replace(/\s+/g, ' ');
      if (sql === 'BEGIN') {
        staged = JSON.parse(JSON.stringify(committed)) as DatabaseSchema;
        return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
      }
      if (sql === 'COMMIT') {
        committed = JSON.parse(JSON.stringify(staged)) as DatabaseSchema;
        return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
      }
      if (sql === 'ROLLBACK') {
        staged = JSON.parse(JSON.stringify(committed)) as DatabaseSchema;
        return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
      }
      if (sql.startsWith('SELECT payload FROM app_state_snapshots')) {
        return {
          rows: [{ payload: staged } as unknown as T],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }
      if (sql.startsWith('UPDATE app_state_snapshots')) {
        staged = JSON.parse(String(values?.[1] ?? '{}')) as DatabaseSchema;
        return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
      }
      return { rows: [{ payload: committed } as unknown as T], rowCount: 1, command: 'OK', oid: 0, fields: [] };
    },
    release() {
      // no-op
    },
  };

  return {
    async connect() {
      return client;
    },
    async query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> {
      return { rows: [{ ok: 1 } as unknown as T], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
    },
    async end() {
      // no-op
    },
  };
}

test('Block 12.11: rejects alg:none JWT, tampered HMAC session tokens, and MFA privilege bypass attempts', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    // 1. Forged alg:none JWT claiming admin + aal2 must be rejected (401)
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'sb-uuid-admin',
        email: 'directors@celebrationsisters.example.com',
        role: 'admin',
        aal: 'aal2',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const unsignedJwt = `${header}.${payload}.`;

    const algNoneBookings = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${unsignedJwt}` },
    });
    assert.equal(algNoneBookings.status, 401);

    const algNoneAdmin = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${unsignedJwt}` },
    });
    assert.equal(algNoneAdmin.status, 403);

    // 2. Tampering a legitimate client token payload to claim admin + mfaVerified:true must fail signature check
    const switchRes = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ userId: 'user-client-camille' }),
    });
    const { token: clientToken } = (await switchRes.json()) as { token: string };
    const [, originalSig] = clientToken.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        userId: 'user-admin-director',
        role: 'admin',
        mfaVerified: true,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    ).toString('base64url');
    const tamperedToken = `${forgedPayload}.${originalSig}`;

    const tamperedAdmin = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });
    assert.equal(tamperedAdmin.status, 403);

    const tamperedSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });
    const tamperedSessionBody = (await tamperedSession.json()) as { user: { role: string } };
    assert.equal(tamperedSessionBody.user.role, 'guest');
  } finally {
    await cleanup();
  }
});

test('Block 12.11: enforces token rotation on MFA elevation (anti-session-fixation) and cookie clearing on logout', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    const switchRes = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ userId: 'user-admin-director' }),
    });
    const { token: preMfaToken } = (await switchRes.json()) as { token: string };

    const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${preMfaToken}` },
    });
    const { secret } = (await enrollRes.json()) as { secret: string };

    const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preMfaToken}` },
      body: JSON.stringify({ code: generateTotpCode(secret) }),
    });
    assert.equal(verifyRes.status, 200);
    const { token: postMfaToken } = (await verifyRes.json()) as { token: string };

    // Token MUST rotate on privilege elevation; pre-MFA token remains denied on executive routes
    assert.notEqual(postMfaToken, preMfaToken);
    const preMfaReplay = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${preMfaToken}` },
    });
    assert.equal(preMfaReplay.status, 403);

    const postMfaOverview = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${postMfaToken}` },
    });
    assert.equal(postMfaOverview.status, 200);

    // Logout clears session cookie with Max-Age=0
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${postMfaToken}` },
    });
    assert.equal(logoutRes.status, 200);
    const clearedCookie = logoutRes.headers.get('set-cookie') || '';
    assert.ok(clearedCookie.includes('cs_session='));
    assert.ok(clearedCookie.includes('Max-Age=0'));
  } finally {
    await cleanup();
  }
});

test('Block 12.11: enforces HTTP 429 RATE_LIMIT_EXCEEDED with RateLimit-* and Retry-After headers when rate limiter is active', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer({ enableRateLimit: true });
  try {
    // /api/auth/mfa/totp/enroll is rate-limited to 5 requests per 60s
    let hit429 = false;
    for (let i = 0; i < 7; i += 1) {
      const res = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
        method: 'POST',
      });
      if (res.status === 429) {
        hit429 = true;
        const body = (await res.json()) as { code: string };
        assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
        assert.equal(res.headers.get('ratelimit-limit'), '5');
        assert.equal(res.headers.get('ratelimit-remaining'), '0');
        const retryAfter = Number(res.headers.get('retry-after') || '0');
        assert.ok(retryAfter >= 1);
        break;
      }
    }
    assert.equal(hit429, true, 'Expected rate limiter to trigger HTTP 429 after 5 attempts');
  } finally {
    await cleanup();
  }
});

test('Block 12.10 & 12.11: blocks production client payment self-marking with HTTP 501 PAYMENT_PROVIDER_NOT_INTEGRATED when PostgreSQL is live', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p12-pay-'));
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
  const seed = await readDb();
  const mockPool = createInMemoryMockPgPool(seed);

  const prevEnv = process.env.NODE_ENV;
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;
  const prevSecret = process.env.SESSION_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;

  const { signSessionToken } = await import('../server/auth.ts');

  setInjectedPgPoolForTests(mockPool);
  process.env.NODE_ENV = 'production';
  process.env.PERSISTENCE_ADAPTER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://staging:test@127.0.0.1:5432/cs_staging';
  process.env.SESSION_SECRET = 'phase-12-verified-production-test-secret-key-2026';

  const app = createApp({ enableRateLimit: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  try {
    const prodClientToken = signSessionToken({
      userId: 'user-client-camille',
      role: 'client',
      mfaVerified: true,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    const targetBooking = seed.bookings.find((b) => b.clientId === 'user-client-camille');
    assert.ok(targetBooking);
    const pendingMilestone = targetBooking.payments.find((p) => p.status !== 'Paid') ?? targetBooking.payments[0];
    assert.ok(pendingMilestone);

    // 1. Production client self-marking payment MUST fail closed with 501 PAYMENT_PROVIDER_NOT_INTEGRATED
    const payRes = await fetch(
      `${baseUrl}/api/bookings/${targetBooking.id}/payments/${pendingMilestone.id}/pay`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${prodClientToken}` },
      },
    );
    assert.equal(payRes.status, 501);
    const payBody = (await payRes.json()) as { code: string; liveProcessorVerified: boolean };
    assert.equal(payBody.code, 'PAYMENT_PROVIDER_NOT_INTEGRATED');
    assert.equal(payBody.liveProcessorVerified, false);

    // 2. Client attempting to bypass payment by forcing status to Confirmed via PATCH MUST be rejected (403)
    const statusBypass = await fetch(`${baseUrl}/api/bookings/${targetBooking.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prodClientToken}` },
      body: JSON.stringify({ status: 'Confirmed' }),
    });
    assert.equal(statusBypass.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setInjectedPgPoolForTests(null);
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
    else process.env.PERSISTENCE_ADAPTER = prevAdapter;
    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.CS_DB_PATH;
  }
});
