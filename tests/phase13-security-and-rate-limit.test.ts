import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { QueryResult, QueryResultRow } from 'pg';
import { createApp } from '../server/app.ts';
import { signSessionToken } from '../server/auth.ts';
import {
  setInjectedPgPoolForTests,
  type PgClientLike,
  type PgPoolLike,
} from '../server/repositories/postgresRepository.ts';
import {
  createRateLimiter,
  PostgresRateLimitStore,
  resolveTrustedClientIp,
} from '../server/rateLimit.ts';
import { readDb } from '../server/store.ts';
import { generateTotpCode } from '../server/totp.ts';
import type { Request } from 'express';

async function startServer(options?: {
  enableRateLimit?: boolean;
  trustProxy?: boolean | number | string;
}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p13-sec-'));
  const dbPath = path.join(tmpDir, 'db.json');
  process.env.CS_DB_PATH = dbPath;

  const app = createApp({
    enableRateLimit: options?.enableRateLimit ?? false,
    trustProxy: options?.trustProxy,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    app,
    baseUrl,
    dbPath,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
      delete process.env.CS_DB_PATH;
    },
  };
}

function extractCookiePair(setCookieHeader: string | null, name: string): string {
  if (!setCookieHeader) return '';
  const match = setCookieHeader.match(new RegExp(`${name}=[^;,\\s]+`));
  return match ? match[0] : '';
}

test('Block 13.2: rate limiter ignores spoofed X-Forwarded-For, shares PostgreSQL buckets across instances, and fails closed (503) on auth/MFA DB outage', async () => {
  // 1. resolveTrustedClientIp ignores raw x-forwarded-for when Express trust proxy is disabled
  const fakeReq = {
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '203.0.113.99' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
  assert.equal(resolveTrustedClientIp(fakeReq), '127.0.0.1');

  // 2. Spoofed X-Forwarded-For across requests MUST NOT bypass the rate limit
  const srv = await startServer({ enableRateLimit: true, trustProxy: false });
  try {
    let hit429 = false;
    for (let i = 0; i < 7; i += 1) {
      const res = await fetch(`${srv.baseUrl}/api/auth/mfa/totp/enroll`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': `198.51.100.${i + 10}` },
      });
      if (res.status === 429) {
        hit429 = true;
        const body = (await res.json()) as { code: string };
        assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
        break;
      }
    }
    assert.equal(hit429, true, 'Spoofed X-Forwarded-For must not bypass rate limits');
  } finally {
    await srv.cleanup();
  }

  // 3. Multi-instance shared PostgreSQL rate-limit store coordinates counts across two instances
  const sharedBuckets = new Map<string, { count: number; resetAt: string }>();
  const sharedPool = {
    async query<T = Record<string, unknown>>(_text: string, params?: unknown[]) {
      const key = String(params?.[0] ?? '');
      const nextReset = String(params?.[1] ?? new Date(Date.now() + 60_000).toISOString());
      const cur = sharedBuckets.get(key);
      if (!cur) sharedBuckets.set(key, { count: 1, resetAt: nextReset });
      else cur.count += 1;
      const entry = sharedBuckets.get(key)!;
      return { rows: [{ request_count: entry.count, reset_at: entry.resetAt } as unknown as T] };
    },
  };
  const instanceA = new PostgresRateLimitStore(sharedPool);
  const instanceB = new PostgresRateLimitStore(sharedPool);
  assert.equal((await instanceA.consume('ip:shared-key', 2, 60_000)).allowed, true);
  assert.equal((await instanceB.consume('ip:shared-key', 2, 60_000)).allowed, true);
  assert.equal((await instanceA.consume('ip:shared-key', 2, 60_000)).allowed, false);

  // 4. Slow PostgreSQL query trips queryTimeoutMs without hanging
  const hangingStore = new PostgresRateLimitStore(
    {
      async query() {
        return new Promise(() => {
          // Never resolves
        });
      },
    },
    { queryTimeoutMs: 25 },
  );
  await assert.rejects(
    () => hangingStore.consume('ip:timeout-key', 5, 60_000, { failClosed: true }),
    /RateLimitUnavailableError/,
  );

  // 5. Protected auth/MFA endpoints fail CLOSED (HTTP 503 RATE_LIMITER_UNAVAILABLE) on DB outage,
  //    never leaking raw DB errors; noncritical endpoints safely fall back in-memory
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;
  const prevDbUrl = process.env.DATABASE_URL;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p13-rl-outage-'));
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
  const seed = await readDb();

  const failingPool: PgPoolLike = {
    async connect(): Promise<PgClientLike> {
      throw new Error('PG_SENSITIVE_CONN_STRING_SECRET: connection refused');
    },
    async query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> {
      throw new Error('PG_SENSITIVE_CONN_STRING_SECRET: connection refused');
    },
    async end() {
      // no-op
    },
  };

  let server: ReturnType<ReturnType<typeof createApp>['listen']> | null = null;
  try {
    setInjectedPgPoolForTests(failingPool);
    process.env.PERSISTENCE_ADAPTER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://staging:secret@127.0.0.1:5432/cs_test';

    const app = createApp({ enableRateLimit: true, trustProxy: 1 });
    assert.equal(app.get('trust proxy'), 1);
    server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    const outageUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    const authRes = await fetch(`${outageUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    assert.equal(authRes.status, 503);
    assert.ok(Number(authRes.headers.get('retry-after') || '0') >= 1);
    const authText = await authRes.text();
    assert.equal(authText.includes('PG_SENSITIVE_CONN_STRING_SECRET'), false);
    const authJson = JSON.parse(authText) as { code: string };
    assert.equal(authJson.code, 'RATE_LIMITER_UNAVAILABLE');

    // Noncritical limiter with failClosed: false falls back cleanly rather than returning 503
    const nonCriticalStore = new PostgresRateLimitStore({
      async query() {
        throw new Error('DB temporarily unreachable');
      },
    });
    const nonCriticalMw = createRateLimiter(nonCriticalStore, true)(2, 60_000, {
      endpointGroup: 'noncrit',
      failClosed: false,
    });
    let nextCalled = 0;
    const mockReq = {
      ip: '127.0.0.1',
      method: 'GET',
      path: '/api/test/noncritical',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const mockRes = {
      setHeader() {
        // no-op
      },
      status() {
        return this;
      },
      json() {
        return this;
      },
    };
    await new Promise<void>((resolve) => {
      nonCriticalMw(mockReq, mockRes as never, () => {
        nextCalled += 1;
        resolve();
      });
    });
    assert.equal(nextCalled, 1);
    assert.ok(seed.bookings.length >= 1);
  } finally {
    if (server) {
      const activeServer = server;
      await new Promise<void>((resolve) => activeServer.close(() => resolve()));
    }
    setInjectedPgPoolForTests(null);
    if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
    else process.env.PERSISTENCE_ADAPTER = prevAdapter;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    delete process.env.CS_DB_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Block 13.3: full 10-scenario CSRF protection, origin enforcement, cryptographic token validation, and server-side logout session revocation', async () => {
  const prevAllowed = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://ophireumtechnology.github.io,http://localhost:3000';
  const srv = await startServer();

  try {
    // Obtain cookie session + cryptographic CSRF token
    const switchRes = await fetch(`${srv.baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-client-camille' }),
    });
    assert.equal(switchRes.status, 200);
    const { token: bearerToken, csrfToken } = (await switchRes.json()) as {
      token: string;
      csrfToken: string;
    };
    assert.ok(csrfToken && csrfToken.length >= 32);

    const setCookie = switchRes.headers.get('set-cookie') || '';
    const sessionCookie = extractCookiePair(setCookie, 'cs_session');
    const csrfCookie = extractCookiePair(setCookie, 'cs_csrf');
    assert.ok(sessionCookie.startsWith('cs_session='));
    assert.ok(csrfCookie.startsWith('cs_csrf='));

    // Scenario 1: Same-origin authorized request succeeds
    const s1 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${sessionCookie}; ${csrfCookie}`,
        Origin: srv.baseUrl,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ text: 'Same-origin authorized note.' }),
    });
    assert.equal(s1.status, 200);

    // Scenario 2: Approved cross-origin request succeeds
    const s2 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${sessionCookie}; ${csrfCookie}`,
        Origin: 'https://ophireumtechnology.github.io',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ text: 'Approved cross-origin note.' }),
    });
    assert.equal(s2.status, 200);

    // Scenario 3: Unapproved cross-origin request fails (403 CSRF_ORIGIN_REJECTED)
    const s3 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        Origin: 'https://attacker.example.com',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ text: 'Evil cross-origin attack.' }),
    });
    assert.equal(s3.status, 403);
    assert.equal(((await s3.json()) as { code: string }).code, 'CSRF_ORIGIN_REJECTED');

    // Scenario 4: Missing Origin + missing Referer fails even with X-Requested-With (no insecure bypass!)
    const s4 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ text: 'Originless X-Requested-With bypass attempt.' }),
    });
    assert.equal(s4.status, 403);
    assert.equal(((await s4.json()) as { code: string }).code, 'CSRF_ORIGIN_REJECTED');

    // Scenario 5: Forged X-CSRF-Token header fails even with approved Origin
    const s5 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        Origin: 'https://ophireumtechnology.github.io',
        'X-CSRF-Token': 'forged-invalid-csrf-token-value',
      },
      body: JSON.stringify({ text: 'Forged CSRF token attempt.' }),
    });
    assert.equal(s5.status, 403);
    assert.equal(((await s5.json()) as { code: string }).code, 'CSRF_TOKEN_INVALID');

    // Scenario 6: Missing Origin + valid cryptographic X-CSRF-Token bound to session succeeds
    const s6 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ text: 'Non-browser client with valid cryptographic CSRF token.' }),
    });
    assert.equal(s6.status, 200);

    // Scenario 7: Expired session rejected cleanly on protected endpoints
    const expiredToken = signSessionToken({
      userId: 'user-client-camille',
      role: 'client',
      mfaVerified: true,
      issuedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1_000,
    });
    const s7 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `cs_session=${expiredToken}`,
        Origin: srv.baseUrl,
      },
      body: JSON.stringify({ text: 'Expired session attempt.' }),
    });
    assert.equal(s7.status, 401);

    // Scenario 8: Cross-site form submission (Origin: null + application/x-www-form-urlencoded) rejected
    const s8 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: sessionCookie,
        Origin: 'null',
      },
      body: 'text=Cross-site+HTML+form+CSRF',
    });
    assert.equal(s8.status, 403);
    assert.equal(((await s8.json()) as { code: string }).code, 'CSRF_ORIGIN_REJECTED');

    // Scenario 9: Cross-site credentialed fetch with evil Referer rejected
    const s9 = await fetch(`${srv.baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        Referer: 'https://evil-phishing.example.com/form',
      },
      body: JSON.stringify({ text: 'Cross-site referer attempt.' }),
    });
    assert.equal(s9.status, 403);
    assert.equal(((await s9.json()) as { code: string }).code, 'CSRF_ORIGIN_REJECTED');

    // Scenario 10: Logout revokes session server-side; reusing prior cookie OR Bearer token is denied!
    const logoutRes = await fetch(`${srv.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        Origin: srv.baseUrl,
        'X-CSRF-Token': csrfToken,
      },
    });
    assert.equal(logoutRes.status, 200);
    const logoutSetCookie = logoutRes.headers.get('set-cookie') || '';
    assert.ok(logoutSetCookie.includes('cs_session='));
    assert.ok(logoutSetCookie.includes('cs_csrf='));

    const replayCookie = await fetch(`${srv.baseUrl}/api/bookings`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(replayCookie.status, 401);

    const replayBearer = await fetch(`${srv.baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    assert.equal(replayBearer.status, 401);
  } finally {
    await srv.cleanup();
    if (prevAllowed === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = prevAllowed;
  }
});

test('Block 13.4: enforces admin MFA step-up for TOTP rotation, single-use recovery codes, MFA revocation, account suspension, and JWT exp requirement', async () => {
  const srv = await startServer();
  try {
    // 1. Login as admin and enroll initial TOTP factor + 8 single-use recovery codes
    const sw = await fetch(`${srv.baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-admin-director' }),
    });
    const { token: adminAal1 } = (await sw.json()) as { token: string };

    const enroll1 = await fetch(`${srv.baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminAal1}` },
    });
    assert.equal(enroll1.status, 200);
    const { secret: secret1, recoveryCodes } = (await enroll1.json()) as {
      secret: string;
      recoveryCodes: string[];
    };
    assert.equal(recoveryCodes.length, 8);

    // 2. Attempting to overwrite/re-enroll an existing TOTP factor WITHOUT aal2 step-up MUST FAIL (403 STEP_UP_MFA_REQUIRED)
    const unauthorizedRotate = await fetch(`${srv.baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminAal1}` },
    });
    assert.equal(unauthorizedRotate.status, 403);
    assert.equal(((await unauthorizedRotate.json()) as { code: string }).code, 'STEP_UP_MFA_REQUIRED');

    // 3. Recovery code works ONCE to elevate to aal2, then replay of the same code is rejected (403)
    const recoverOk = await fetch(`${srv.baseUrl}/api/auth/mfa/recover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminAal1}`,
      },
      body: JSON.stringify({ recoveryCode: recoveryCodes[0] }),
    });
    assert.equal(recoverOk.status, 200);
    const { token: adminAal2, remainingRecoveryCodes } = (await recoverOk.json()) as {
      token: string;
      remainingRecoveryCodes: number;
    };
    assert.equal(remainingRecoveryCodes, 7);

    const recoverReplay = await fetch(`${srv.baseUrl}/api/auth/mfa/recover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminAal1}`,
      },
      body: JSON.stringify({ recoveryCode: recoveryCodes[0] }),
    });
    assert.equal(recoverReplay.status, 403);

    // 4. Verified aal2 admin CAN rotate TOTP factor cleanly
    const rotateOk = await fetch(`${srv.baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminAal2}` },
    });
    assert.equal(rotateOk.status, 200);
    const { secret: secret2 } = (await rotateOk.json()) as { secret: string };
    assert.notEqual(secret2, secret1);

    // 5. Verify session & admin overview never leak totpSecret or recovery code hashes
    const sessionRes = await fetch(`${srv.baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${adminAal2}` },
    });
    const sessionText = await sessionRes.text();
    assert.equal(sessionText.includes(secret2), false);
    assert.equal(sessionText.includes('mfaRecoveryCodeHashes'), false);

    // 6. Admin account status governance: suspend client with active session, block self-suspension
    const camilleSw = await fetch(`${srv.baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-client-camille' }),
    });
    assert.equal(camilleSw.status, 200);
    const { token: camilleToken } = (await camilleSw.json()) as { token: string };
    assert.ok(camilleToken);

    const selfSuspend = await fetch(`${srv.baseUrl}/api/admin/users/user-admin-director/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAal2}` },
      body: JSON.stringify({ accountStatus: 'suspended' }),
    });
    assert.equal(selfSuspend.status, 400);

    const suspendClient = await fetch(`${srv.baseUrl}/api/admin/users/user-client-camille/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAal2}` },
      body: JSON.stringify({ accountStatus: 'suspended', reason: 'Security audit hold' }),
    });
    assert.equal(suspendClient.status, 200);

    const camilleBlocked = await fetch(`${srv.baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${camilleToken}` },
    });
    assert.equal(camilleBlocked.status, 403);
    assert.equal(((await camilleBlocked.json()) as { code: string }).code, 'ACCOUNT_SUSPENDED');

    // 7. MFA factor revocation requires aal2 and revokes active session immediately
    const revokeNoMfa = await fetch(`${srv.baseUrl}/api/auth/mfa/totp/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminAal1}` },
    });
    assert.equal(revokeNoMfa.status, 403);

    const revokeOk = await fetch(`${srv.baseUrl}/api/auth/mfa/totp/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminAal2}` },
    });
    assert.equal(revokeOk.status, 200);
    const afterRevoke = await fetch(`${srv.baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${adminAal2}` },
    });
    assert.ok(afterRevoke.status === 401 || afterRevoke.status === 403);

    // 8. Re-verify fresh TOTP login works cleanly after re-enrollment
    const freshAdmin = await fetch(`${srv.baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-admin-director' }),
    });
    const { token: freshPre } = (await freshAdmin.json()) as { token: string };
    const reEnroll = await fetch(`${srv.baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshPre}` },
    });
    assert.equal(reEnroll.status, 200);
    const { secret: secret3 } = (await reEnroll.json()) as { secret: string };
    const reVerify = await fetch(`${srv.baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshPre}` },
      body: JSON.stringify({ code: generateTotpCode(secret3) }),
    });
    assert.equal(reVerify.status, 200);
  } finally {
    await srv.cleanup();
  }

  // 9. Supabase JWT missing exp claim MUST be rejected
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p13-jwt-exp-'));
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  const app = createApp({
    enableRateLimit: false,
    providerVerifyOptions: {
      supabaseUrl: 'https://cs-demo-auth.supabase.co',
      keyResolver: createLocalJWKSet({ keys: [jwk] }),
    },
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const jwtUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  try {
    const noExpJwt = await new SignJWT({ email: 'camille.mercer@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('sb-no-exp')
      .setIssuer('https://cs-demo-auth.supabase.co/auth/v1')
      .setAudience('authenticated')
      .setIssuedAt()
      .sign(privateKey);

    const res = await fetch(`${jwtUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${noExpJwt}` },
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.CS_DB_PATH;
  }
});

test('Block 13.1 & 13.13: Dockerfile uses glibc bookworm-slim base, non-root user, and zero-dependency Node HEALTHCHECK', async () => {
  const dockerfile = await fs.readFile(path.resolve(process.cwd(), 'Dockerfile'), 'utf-8');
  assert.ok(dockerfile.includes('FROM node:22-bookworm-slim AS builder'));
  assert.ok(dockerfile.includes('FROM node:22-bookworm-slim AS runner'));
  assert.equal(dockerfile.includes('alpine'), false);
  assert.equal(dockerfile.includes('wget'), false);
  assert.ok(dockerfile.includes('USER node'));
  assert.ok(dockerfile.includes("http').get('http://127.0.0.1:'"));
});
