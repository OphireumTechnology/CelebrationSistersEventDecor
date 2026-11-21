import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../server/app.ts';
import { signSessionToken } from '../server/auth.ts';
import { withTransaction } from '../server/store.ts';

test('production administrator access requires a genuine, confirmed Supabase AAL2 session', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-admin-mfa-'));
  const supabaseUrl = 'https://provider-mfa-test.supabase.co';
  const environment = {
    CS_DB_PATH: path.join(directory, 'db.json'),
    SUPABASE_ADMIN_MFA_REQUIRED: 'true',
    SUPABASE_URL: supabaseUrl,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let server: Server | undefined;

  try {
    const adminSubject = 'fd100000-0000-4000-8000-000000000001';
    const admin = await withTransaction((db) => {
      const account = db.users.find((user) => user.role === 'admin');
      assert.ok(account);
      account.supabaseUserId = adminSubject;
      return { id: account.id, email: account.email };
    });
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const mint = (aal: 'aal1' | 'aal2', issuer = supabaseUrl, subject = adminSubject) =>
      new SignJWT({
        aal,
        email: admin.email,
        session_id: '12000000-0000-4000-8000-000000000001',
        user_metadata: { email_verified: true },
      })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(`${issuer}/auth/v1`)
        .setSubject(subject)
        .setAudience('authenticated')
        .setExpirationTime('5m')
        .sign(privateKey);
    const aal1 = await mint('aal1');
    const aal2 = await mint('aal2');
    let confirmedUser = { id: adminSubject, email_confirmed_at: '2026-01-01T00:00:00Z' };
    const app = createApp({
      enableRateLimit: false,
      providerVerifyOptions: { keyResolver: async () => publicKey },
      supabaseAuthClient: {
        auth: {
          getUser: async () => ({ data: { user: confirmedUser }, error: null }),
          resetPasswordForEmail: async () => ({ data: {}, error: null }),
          signInWithPassword: async () => ({
            data: { session: { access_token: aal1, refresh_token: 'synthetic-refresh-token' } },
            error: null,
          }),
        },
      },
    });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (route: string, token: string, method = 'GET') =>
      fetch(`${baseUrl}${route}`, { method, headers: { Authorization: `Bearer ${token}` } });

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: admin.email, password: 'SyntheticPasswordForTesting!' }),
    });
    assert.equal(loginResponse.status, 200);
    assert.equal(loginResponse.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(loginResponse.headers.get('set-cookie') ?? '', /cs_session=[^;]+/);
    const login = await loginResponse.json() as {
      providerSession: { access_token: string; refresh_token: string };
      providerUrl: string;
      mfaRequired: boolean;
    };
    assert.equal(login.providerSession.access_token, aal1);
    assert.equal(login.providerSession.refresh_token, 'synthetic-refresh-token');
    assert.equal(login.providerUrl, supabaseUrl);
    assert.equal(login.mfaRequired, true);

    const session = await request('/api/auth/session', aal1);
    const sessionData = await session.json() as { user: { role: string }; mfaRequired: boolean };
    assert.equal(sessionData.user.role, 'admin');
    assert.equal(sessionData.mfaRequired, true);

    const adminRoute = '/api/admin/overview';
    assert.equal((await request(adminRoute, aal1)).status, 403);
    const local = signSessionToken({
      jti: 'synthetic-local-session',
      userId: admin.id,
      role: 'admin',
      mfaVerified: true,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    assert.equal((await request(adminRoute, local)).status, 403);
    assert.equal((await request(adminRoute, await mint('aal2', 'https://wrong-project.supabase.co'))).status, 403);
    assert.equal((await request(adminRoute, await mint('aal2', supabaseUrl, 'wrong-subject'))).status, 403);
    assert.equal((await request(adminRoute, aal2)).status, 200);

    confirmedUser = { id: 'wrong-user', email_confirmed_at: '2026-01-01T00:00:00Z' };
    assert.equal((await request(adminRoute, aal2)).status, 403);
    for (const suffix of ['/totp/enroll', '/verify', '/recover', '/totp/revoke']) {
      assert.equal((await request(`/api/auth/mfa${suffix}`, aal1, 'POST')).status, 409);
    }

    confirmedUser = { id: adminSubject, email_confirmed_at: '2026-01-01T00:00:00Z' };
    assert.equal((await request('/api/auth/logout', aal2, 'POST')).status, 200);
    assert.equal((await request(adminRoute, aal2)).status, 403);
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
