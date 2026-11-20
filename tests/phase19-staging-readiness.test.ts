import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SignJWT } from 'jose';
import { verifyStagingRailwayAndResend } from '../scripts/verify-staging-railway-and-resend.ts';
import { createApp } from '../server/app.ts';
import {
  resolveTrustedUserFromClaims,
  verifyProviderAccessToken,
} from '../server/identityProvider.ts';
import {
  PostgresRateLimitStore,
  RateLimitUnavailableError,
  type PgQueryable,
} from '../server/rateLimit.ts';
import type { UserSession } from '../src/types/domain.ts';

test('Phase 19: PostgresRateLimitStore single-flight 42P01 bootstrap prevents spurious 503 under 10-way concurrent cold start', async () => {
  let tableCreated = false;
  let createTableExecutions = 0;
  let insertCount = 0;

  const coldRailwayDb: PgQueryable = {
    async query<T>(sql: string) {
      if (/CREATE TABLE IF NOT EXISTS rate_limit_buckets/i.test(sql)) {
        createTableExecutions += 1;
        // Simulate real network latency so all concurrent waiters pile up on the single-flight promise
        await new Promise((resolve) => setTimeout(resolve, 25));
        tableCreated = true;
        return { rows: [] as T[] };
      }
      if (/CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_reset/i.test(sql)) {
        return { rows: [] as T[] };
      }
      if (/INSERT INTO rate_limit_buckets/i.test(sql)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
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

  const store = new PostgresRateLimitStore(coldRailwayDb);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, idx) =>
      store.consume(`127.0.0.1:GET:/api/consultations/status:${idx}`, 30, 60_000, {
        failClosed: true,
        endpointGroup: 'consultations:status',
      }),
    ),
  );

  assert.equal(createTableExecutions, 1, 'Single-flight DDL bootstrap must execute CREATE TABLE exactly once');
  assert.equal(results.length, 10);
  assert.ok(
    results.every((r) => r.allowed === true),
    'All 10 concurrent cold-start requests must succeed with zero spurious 503 errors',
  );

  // Concurrent 42501 (restricted non-superuser role) MUST fail closed across all concurrent callers
  let restrictedDdlAttempts = 0;
  const restrictedDb: PgQueryable = {
    async query(sql: string) {
      if (/CREATE TABLE/i.test(sql)) {
        restrictedDdlAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        const err = new Error('permission denied for schema public');
        (err as { code?: string }).code = '42501';
        throw err;
      }
      const err = new Error('relation "rate_limit_buckets" does not exist');
      (err as { code?: string }).code = '42P01';
      throw err;
    },
  };
  const restrictedStore = new PostgresRateLimitStore(restrictedDb);
  const restrictedSettled = await Promise.allSettled(
    Array.from({ length: 5 }, (_, idx) =>
      restrictedStore.consume(`127.0.0.1:GET:/api/consultations/status:r${idx}`, 30, 60_000, {
        failClosed: true,
        endpointGroup: 'consultations:status',
      }),
    ),
  );
  assert.equal(restrictedDdlAttempts, 1, 'Restricted-role DDL failure should not storm CREATE TABLE');
  assert.ok(
    restrictedSettled.every(
      (r) => r.status === 'rejected' && r.reason instanceof RateLimitUnavailableError,
    ),
    'All concurrent callers on restricted role lacking table must fail closed with RateLimitUnavailableError',
  );
});

test('Phase 19: verifyStagingRailwayAndResend enforces STG-SEC-01 and fail-closed readiness gates', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p19-verifier-'));
  const prevDbPath = process.env.CS_DB_PATH;
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;
  const prevOrigins = process.env.ALLOWED_ORIGINS;
  const prevWebhookSecret = process.env.RESEND_WEBHOOK_SECRET;

  const testSecret = `whsec_${crypto.randomBytes(24).toString('base64')}`;
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
  process.env.PERSISTENCE_ADAPTER = 'json-local';
  process.env.ALLOWED_ORIGINS = 'https://celebrationsistersdecor.com';
  process.env.RESEND_WEBHOOK_SECRET = testSecret;

  const app = createApp({ enableRateLimit: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const addr = server.address();
    assert.ok(typeof addr === 'object' && addr);
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // With unauthenticated guard enabled (no Supabase/Resend required in local JSON mode), all 14 checks pass
    const passReport = await verifyStagingRailwayAndResend({
      apiBaseUrl: baseUrl,
      frontendOrigin: 'https://celebrationsistersdecor.com',
      testRecipientEmail: 'qa-phase19@example.com',
      resendWebhookSecret: testSecret,
      requireHttps: false,
      requirePostgres: false,
      checkUnauthenticatedGuards: true,
    });
    assert.equal(passReport.ok, true, `Expected 14/14 checks to pass: ${JSON.stringify(passReport.checks)}`);
    assert.equal(passReport.checks.length, 14);
    assert.ok(passReport.checks.some((c) => c.id === 'STG-SEC-01' && c.passed));

    // When requireSupabaseAuth & requireResendLive & requireCanonicalMigrations are demanded against unconfigured server, verifier fails closed
    const strictReport = await verifyStagingRailwayAndResend({
      apiBaseUrl: baseUrl,
      frontendOrigin: 'https://celebrationsistersdecor.com',
      testRecipientEmail: 'qa-phase19@example.com',
      requireHttps: false,
      requirePostgres: false,
      requireCanonicalMigrations: true,
      requireSupabaseAuth: true,
      requireResendLive: true,
    });
    assert.equal(strictReport.ok, false, 'Strict staging readiness flags must fail when migrations/auth/Resend are unconfigured');
    assert.equal(strictReport.checks.find((c) => c.id === 'STG-API-02')?.passed, false);
    assert.equal(strictReport.checks.find((c) => c.id === 'STG-AUTH-01')?.passed, false);
    assert.equal(strictReport.checks.find((c) => c.id === 'STG-RES-00')?.passed, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (prevDbPath === undefined) delete process.env.CS_DB_PATH;
    else process.env.CS_DB_PATH = prevDbPath;
    if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
    else process.env.PERSISTENCE_ADAPTER = prevAdapter;
    if (prevOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = prevOrigins;
    if (prevWebhookSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = prevWebhookSecret;
  }
});

test('Phase 19: Supabase JWT verification enforces immutable sub binding, AAL2 admin MFA, and blocks email-based privilege hijacking', async () => {
  const jwtSecret = 'phase19-test-supabase-hs256-secret-minimum-32-bytes';
  const supabaseUrl = 'https://staging-cs.supabase.co';
  const secretKey = new TextEncoder().encode(jwtSecret);

  const registeredUsers: UserSession[] = [
    {
      id: 'user-admin-1',
      supabaseUserId: '11111111-1111-4111-8111-111111111111',
      name: 'Studio Owner',
      email: 'owner@celebrationsistersdecor.com',
      role: 'admin',
      emailVerified: true,
      accountStatus: 'active',
      mfaEnrolled: true,
    },
    {
      id: 'user-staff-unlinked',
      name: 'Unlinked Planner',
      email: 'planner@celebrationsistersdecor.com',
      role: 'staff',
      emailVerified: true,
      accountStatus: 'active',
    },
  ];

  // 1. Valid linked admin with AAL2 -> admin role + mfaVerified=true
  const adminAal2Jwt = await new SignJWT({
    email: 'owner@celebrationsistersdecor.com',
    email_verified: true,
    aal: 'aal2',
    session_id: 'sess-aal2-1',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('11111111-1111-4111-8111-111111111111')
    .setAudience('authenticated')
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setExpirationTime('10m')
    .sign(secretKey);

  const aal2Claims = await verifyProviderAccessToken(adminAal2Jwt, { supabaseUrl, jwtSecret });
  assert.ok(aal2Claims);
  const aal2Resolved = resolveTrustedUserFromClaims(aal2Claims, registeredUsers);
  assert.equal(aal2Resolved.user.role, 'admin');
  assert.equal(aal2Resolved.mfaVerified, true);
  assert.equal(aal2Resolved.emailPrivilegeBindBlocked, false);

  // 2. Valid linked admin with AAL1 only -> mfaVerified=false (admin routes remain blocked until AAL2)
  const adminAal1Jwt = await new SignJWT({
    email: 'owner@celebrationsistersdecor.com',
    email_verified: true,
    aal: 'aal1',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('11111111-1111-4111-8111-111111111111')
    .setAudience('authenticated')
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setExpirationTime('10m')
    .sign(secretKey);

  const aal1Claims = await verifyProviderAccessToken(adminAal1Jwt, { supabaseUrl, jwtSecret });
  assert.ok(aal1Claims);
  const aal1Resolved = resolveTrustedUserFromClaims(aal1Claims, registeredUsers);
  assert.equal(aal1Resolved.user.role, 'admin');
  assert.equal(aal1Resolved.mfaVerified, false);

  // 3. Attacker with unlinked staff email + spoofed user_metadata.role='admin' -> blocked & downgraded to 'client'
  const spoofedJwt = await new SignJWT({
    email: 'planner@celebrationsistersdecor.com',
    email_verified: true,
    aal: 'aal2',
    user_metadata: { role: 'admin', full_name: 'Spoofed Attacker' },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('99999999-9999-4999-8999-999999999999')
    .setAudience('authenticated')
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setExpirationTime('10m')
    .sign(secretKey);

  const spoofedClaims = await verifyProviderAccessToken(spoofedJwt, { supabaseUrl, jwtSecret });
  assert.ok(spoofedClaims);
  const spoofedResolved = resolveTrustedUserFromClaims(spoofedClaims, registeredUsers);
  assert.equal(spoofedResolved.emailPrivilegeBindBlocked, true);
  assert.equal(spoofedResolved.user.role, 'client');

  // 4. Expired or wrong-secret tokens MUST return null
  const expiredJwt = await new SignJWT({ email: 'owner@celebrationsistersdecor.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('11111111-1111-4111-8111-111111111111')
    .setAudience('authenticated')
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(secretKey);
  assert.equal(await verifyProviderAccessToken(expiredJwt, { supabaseUrl, jwtSecret }), null);
  assert.equal(
    await verifyProviderAccessToken(adminAal2Jwt, { supabaseUrl, jwtSecret: 'wrong-secret-key-0000000000000000' }),
    null,
  );
});
