import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../server/app.ts';
import { withTransaction } from '../server/store.ts';

const TEST_SUPABASE_URL = 'https://cs-demo-auth.supabase.co';

async function startIsolatedIdentityServer() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-identity-test-'));
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'cs-test-kid-1';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const localJwks = createLocalJWKSet({ keys: [publicJwk] });

  const app = createApp({
    enableRateLimit: false,
    providerVerifyOptions: {
      supabaseUrl: TEST_SUPABASE_URL,
      keyResolver: localJwks,
    },
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  async function mintJwt(claims: {
    sub: string;
    email: string;
    email_verified?: boolean;
    aal?: 'aal1' | 'aal2';
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
  }): Promise<string> {
    return new SignJWT({
      email: claims.email,
      email_verified: claims.email_verified ?? true,
      aal: claims.aal ?? 'aal1',
      user_metadata: claims.user_metadata ?? {},
      app_metadata: claims.app_metadata ?? {},
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'cs-test-kid-1' })
      .setSubject(claims.sub)
      .setIssuer(claims.issuer ?? `${TEST_SUPABASE_URL}/auth/v1`)
      .setAudience(claims.audience ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(claims.expiresIn ?? '15m')
      .sign(privateKey);
  }

  return {
    baseUrl,
    mintJwt,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
      delete process.env.CS_DB_PATH;
    },
  };
}

test('verifies RS256 Supabase-style JWTs and prevents user_metadata privilege escalation', async () => {
  const { baseUrl, mintJwt, cleanup } = await startIsolatedIdentityServer();
  try {
    // 1. Valid client JWT maps to existing server user record
    const camilleJwt = await mintJwt({
      sub: 'sb-uuid-camille',
      email: 'camille.mercer@example.com',
    });
    const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${camilleJwt}` },
    });
    assert.equal(sessionRes.status, 200);
    const sessionData = (await sessionRes.json()) as {
      user: { id: string; role: string };
      authMethod: string;
    };
    assert.equal(sessionData.user.id, 'user-client-camille');
    assert.equal(sessionData.user.role, 'client');
    assert.equal(sessionData.authMethod, 'supabase_jwt');

    // 2. Forged user_metadata role claims in a signed JWT MUST NOT grant admin/staff privileges
    const spoofJwt = await mintJwt({
      sub: 'sb-uuid-stranger',
      email: 'stranger@example.com',
      user_metadata: { role: 'admin', is_admin: true, full_name: 'Attacker' },
    });
    const spoofSessionRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${spoofJwt}` },
    });
    const spoofSession = (await spoofSessionRes.json()) as { user: { role: string } };
    assert.equal(spoofSession.user.role, 'client');

    const adminAttempt = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${spoofJwt}` },
    });
    assert.equal(adminAttempt.status, 403);

    const staffAttempt = await fetch(`${baseUrl}/api/staff/checklists`, {
      headers: { Authorization: `Bearer ${spoofJwt}` },
    });
    assert.equal(staffAttempt.status, 403);

    // 3. Expired / wrong-issuer / wrong-audience / tampered JWTs are rejected cleanly
    const expiredJwt = await mintJwt({
      sub: 'sb-uuid-admin',
      email: 'directors@celebrationsisters.example.com',
      aal: 'aal2',
      expiresIn: '-5m',
    });
    const expiredBookings = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${expiredJwt}` },
    });
    assert.equal(expiredBookings.status, 401);

    const wrongAudienceJwt = await mintJwt({
      sub: 'sb-uuid-admin',
      email: 'directors@celebrationsisters.example.com',
      aal: 'aal2',
      audience: 'wrong-audience',
    });
    const wrongAudBookings = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${wrongAudienceJwt}` },
    });
    assert.equal(wrongAudBookings.status, 401);

    const wrongIssuerJwt = await mintJwt({
      sub: 'sb-uuid-admin',
      email: 'directors@celebrationsisters.example.com',
      aal: 'aal2',
      issuer: 'https://evil-auth.example.com/auth/v1',
    });
    const wrongIssBookings = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${wrongIssuerJwt}` },
    });
    assert.equal(wrongIssBookings.status, 401);
  } finally {
    await cleanup();
  }
});

test('enforces immutable supabaseUserId binding for privileged accounts, blocks email-only privilege escalation, enforces admin aal2 MFA, and blocks suspended accounts', async () => {
  const { baseUrl, mintJwt, cleanup } = await startIsolatedIdentityServer();
  try {
    // 1. An unlinked JWT claiming the admin's email MUST NOT bind to the privileged admin record!
    const unlinkedAdminEmailJwt = await mintJwt({
      sub: 'sb-uuid-impostor-admin',
      email: 'directors@celebrationsisters.example.com',
      aal: 'aal2',
    });
    const unlinkedSessionRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${unlinkedAdminEmailJwt}` },
    });
    assert.equal(unlinkedSessionRes.status, 200);
    const unlinkedSession = (await unlinkedSessionRes.json()) as { user: { id: string; role: string } };
    assert.equal(unlinkedSession.user.role, 'client');
    assert.notEqual(unlinkedSession.user.id, 'user-admin-director');

    const blockedOverview = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${unlinkedAdminEmailJwt}` },
    });
    assert.equal(blockedOverview.status, 403);

    // 2. Explicitly bind verified immutable supabaseUserId to the admin account
    await withTransaction((db) => {
      const admin = db.users.find((u) => u.id === 'user-admin-director');
      if (admin) admin.supabaseUserId = 'sb-uuid-admin';
    });

    // Admin with aal1 is denied admin overview (403 MFA_REQUIRED)
    const adminAal1 = await mintJwt({
      sub: 'sb-uuid-admin',
      email: 'directors@celebrationsisters.example.com',
      aal: 'aal1',
    });
    const deniedAdmin = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${adminAal1}` },
    });
    assert.equal(deniedAdmin.status, 403);
    const deniedBody = (await deniedAdmin.json()) as { code: string; mfaRequired: boolean };
    assert.equal(deniedBody.code, 'MFA_REQUIRED');
    assert.equal(deniedBody.mfaRequired, true);

    // Admin with aal2 is permitted executive overview
    const adminAal2 = await mintJwt({
      sub: 'sb-uuid-admin',
      email: 'directors@celebrationsisters.example.com',
      aal: 'aal2',
    });
    const allowedAdmin = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${adminAal2}` },
    });
    assert.equal(allowedAdmin.status, 200);

    // Suspended user is blocked on protected endpoints even with a valid JWT
    await withTransaction((db) => {
      const target = db.users.find((u) => u.id === 'user-client-camille');
      if (target) target.accountStatus = 'suspended';
    });

    const camilleJwt = await mintJwt({
      sub: 'sb-uuid-camille',
      email: 'camille.mercer@example.com',
    });
    const suspendedRes = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${camilleJwt}` },
    });
    assert.equal(suspendedRes.status, 403);
    const suspendedBody = (await suspendedRes.json()) as { code: string };
    assert.equal(suspendedBody.code, 'ACCOUNT_SUSPENDED');
  } finally {
    await cleanup();
  }
});

test('enforces event_planner operational permissions while reserving executive controls for MFA admin', async () => {
  const { baseUrl, mintJwt, cleanup } = await startIsolatedIdentityServer();
  try {
    await withTransaction((db) => {
      db.users.push({
        id: 'user-planner-sienna',
        supabaseUserId: 'sb-uuid-planner',
        name: 'Sienna Brooks',
        email: 'sienna.planner@celebrationsisters.example.com',
        role: 'event_planner',
        emailVerified: true,
        accountStatus: 'active',
      });
    });

    const plannerJwt = await mintJwt({
      sub: 'sb-uuid-planner',
      email: 'sienna.planner@celebrationsisters.example.com',
    });

    const checklistRes = await fetch(`${baseUrl}/api/staff/checklists`, {
      headers: { Authorization: `Bearer ${plannerJwt}` },
    });
    assert.equal(checklistRes.status, 200);

    const quoteRes = await fetch(`${baseUrl}/api/bookings/bkg-101/quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${plannerJwt}`,
      },
      body: JSON.stringify({
        items: [{ description: 'Drapery extension', division: 'Luxury Decor', quantity: 1, unitPrice: 1200 }],
        discountAmount: 200,
      }),
    });
    assert.equal(quoteRes.status, 200);
    const quoteBody = (await quoteRes.json()) as { booking: { quotations: { discountApproved: boolean }[] } };
    const latest = quoteBody.booking.quotations[quoteBody.booking.quotations.length - 1];
    assert.equal(latest.discountApproved, false);

    // Event planner cannot access Executive Admin overview
    const adminAttempt = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${plannerJwt}` },
    });
    assert.equal(adminAttempt.status, 403);
  } finally {
    await cleanup();
  }
});

test('enforces explicit CORS allowlist, cookie CSRF Origin policy, and safe /api/auth/config disclosure', async () => {
  const priorAllowed = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://ophireumtechnology.github.io,http://localhost:3000';

  const { baseUrl, cleanup } = await startIsolatedIdentityServer();
  try {
    // Allowed CORS preflight
    const allowedPreflight = await fetch(`${baseUrl}/api/auth/config`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://ophireumtechnology.github.io' },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(
      allowedPreflight.headers.get('access-control-allow-origin'),
      'https://ophireumtechnology.github.io',
    );
    assert.equal(allowedPreflight.headers.get('access-control-allow-credentials'), 'true');

    // Untrusted origin denied on OPTIONS preflight
    const blockedPreflight = await fetch(`${baseUrl}/api/auth/config`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(blockedPreflight.status, 403);
    assert.equal(blockedPreflight.headers.get('access-control-allow-origin'), null);

    // Cookie-authenticated mutation with forged Origin rejected with CSRF_ORIGIN_REJECTED
    const switchRes = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-client-camille' }),
    });
    const setCookie = switchRes.headers.get('set-cookie') || '';
    const cookiePair = setCookie.split(';')[0];
    assert.ok(cookiePair.startsWith('cs_session='));

    const csrfAttack = await fetch(`${baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookiePair,
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ text: 'Forged cross-site message' }),
    });
    assert.equal(csrfAttack.status, 403);
    const csrfBody = (await csrfAttack.json()) as { code: string };
    assert.equal(csrfBody.code, 'CSRF_ORIGIN_REJECTED');

    // Cookie-authenticated mutation with missing Origin/Referer AND missing X-Requested-With is rejected
    const missingOriginAttack = await fetch(`${baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookiePair,
      },
      body: JSON.stringify({ text: 'Originless form CSRF attempt' }),
    });
    assert.equal(missingOriginAttack.status, 403);
    const missingOriginBody = (await missingOriginAttack.json()) as { code: string };
    assert.equal(missingOriginBody.code, 'CSRF_ORIGIN_REJECTED');

    // Allowed same-origin/allowlisted origin with cookie succeeds
    const validCookiePost = await fetch(`${baseUrl}/api/bookings/bkg-101/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookiePair,
        Origin: 'https://ophireumtechnology.github.io',
      },
      body: JSON.stringify({ text: 'Confirmed floral table note from client.' }),
    });
    assert.equal(validCookiePost.status, 200);

    // Auth config endpoint never leaks secret values
    const configRes = await fetch(`${baseUrl}/api/auth/config`);
    assert.equal(configRes.status, 200);
    const configText = await configRes.text();
    assert.equal(configText.includes('SERVICE_ROLE'), false);
    assert.equal(configText.includes('JWT_SECRET'), false);
  } finally {
    await cleanup();
    if (priorAllowed === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = priorAllowed;
  }
});
