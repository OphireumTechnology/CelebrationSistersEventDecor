import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../server/app.ts';
import { signSessionToken } from '../server/auth.ts';
import { verifyProviderAccessToken } from '../server/identityProvider.ts';
import {
  STAGING_ADMIN_SUBJECT,
  STAGING_AUTH_ISSUER,
  STAGING_AUTH_PROJECT_REF,
} from '../server/stagingExternalAuthPolicy.ts';
import { loadMigrationFiles, runMigrationsOnClient } from '../scripts/run-migrations.ts';
import {
  clearPendingExternalTotpFactor,
  enrollExternalStagingTotp,
  getPendingExternalTotpFactorId,
  resetExternalStagingClientForTests,
  resolveExternalTotpFactorId,
  signOutExternalStagingSession,
  STAGING_EXTERNAL_ADMIN_UUID,
  verifyExternalStagingTotp,
  type ExternalMfaFactorSummary,
  type ExternalStagingSupabaseClientLike,
} from '../src/lib/externalStagingMfa.ts';

const EXTERNAL_STAGING_ENV: Record<string, string> = {
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  STAGING_DB_CONFIRM: 'YES_ISOLATED_STAGING',
  EMAIL_LIVE_DELIVERY_ENABLED: 'false',
  PHASE19_EXTERNAL_AUTH_READ_ONLY: 'YES_EXTERNAL_AUTH_STAGING_ONLY',
  PHASE19_EXTERNAL_AUTH_PROJECT_REF: STAGING_AUTH_PROJECT_REF,
};

function createMemorySessionStorage() {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  };
}

function createMockExternalSupabaseClient(config?: {
  userId?: string;
  initialFactors?: ExternalMfaFactorSummary[];
  validCode?: string;
  postVerifyAal?: 'aal1' | 'aal2';
  rejectEnroll?: boolean;
}) {
  const userId = config?.userId ?? STAGING_EXTERNAL_ADMIN_UUID;
  const validCode = config?.validCode ?? '654321';
  const postVerifyAal = config?.postVerifyAal ?? 'aal2';
  const factors: ExternalMfaFactorSummary[] = [...(config?.initialFactors ?? [])];
  let currentAal: 'aal1' | 'aal2' = factors.some((f) => f.status === 'verified') ? 'aal1' : 'aal1';
  let enrollCount = 0;
  let signedOut = false;
  let refreshedCount = 0;
  const unenrolledIds: string[] = [];

  const client: ExternalStagingSupabaseClientLike = {
    auth: {
      getUser: async () => ({
        data: { user: signedOut ? null : { id: userId } },
        error: null,
      }),
      getSession: async () => ({
        data: {
          session: signedOut
            ? null
            : {
                access_token: currentAal === 'aal2' ? 'jwt-aal2-initial' : 'jwt-aal1-initial',
                user: { id: userId },
              },
        },
        error: null,
      }),
      refreshSession: async () => {
        refreshedCount += 1;
        return {
          data: {
            session: signedOut
              ? null
              : {
                  access_token: currentAal === 'aal2' ? `jwt-aal2-refreshed-${refreshedCount}` : 'jwt-aal1-refreshed',
                  user: { id: userId },
                },
          },
          error: null,
        };
      },
      signOut: async () => {
        signedOut = true;
        return { error: null };
      },
      mfa: {
        listFactors: async () => ({
          data: {
            totp: factors.filter((f) => f.factor_type === 'totp' && f.status === 'verified'),
            all: [...factors],
          },
          error: null,
        }),
        enroll: async ({ friendlyName }) => {
          if (config?.rejectEnroll) {
            return { data: null, error: new Error('Enrollment rejected by provider') };
          }
          enrollCount += 1;
          const id = `factor-totp-${enrollCount}`;
          factors.push({
            id,
            factor_type: 'totp',
            status: 'unverified',
            friendly_name: friendlyName,
          });
          return {
            data: {
              id,
              totp: {
                qr_code: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"></svg>',
                secret: 'JBSWY3DPEHPK3PXP',
                uri: 'otpauth://totp/CelebrationSisters:admin?secret=JBSWY3DPEHPK3PXP&issuer=CelebrationSisters',
              },
            },
            error: null,
          };
        },
        unenroll: async ({ factorId }) => {
          unenrolledIds.push(factorId);
          const idx = factors.findIndex((f) => f.id === factorId);
          if (idx >= 0) factors.splice(idx, 1);
          return { data: { id: factorId }, error: null };
        },
        challengeAndVerify: async ({ factorId, code }) => {
          const matched = factors.find((f) => f.id === factorId);
          if (!matched) {
            return { data: null, error: new Error('Factor not found') };
          }
          if (code !== validCode) {
            return { data: null, error: new Error('Invalid TOTP code') };
          }
          matched.status = 'verified';
          currentAal = postVerifyAal;
          return { data: { factorId }, error: null };
        },
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: currentAal, nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
  };

  return {
    client,
    getState: () => ({ factors, currentAal, signedOut, refreshedCount, unenrolledIds, enrollCount }),
  };
}

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function startIsolatedExternalStagingServer(
  keyResolver: (header: { kid?: string; alg?: string }) => Promise<CryptoKey>,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-phase21-30-'));
  const dbPath = path.join(tmpDir, 'db.json');

  const seededApp = createApp({ enableRateLimit: false });
  void seededApp;

  const envCleanup = await withEnv(
    {
      ...EXTERNAL_STAGING_ENV,
      CS_DB_PATH: dbPath,
      SUPABASE_JWT_SECRET: 'unused-legacy-hs256-secret-must-never-break-es256-jwks',
    },
    async () => {
      // Seed initial db.json and bind the single pinned staging admin UUID to the active admin row
      const { withTransaction } = await import('../server/store.ts');
      await withTransaction((db) => {
        const admin = db.users.find((u) => u.role === 'admin');
        if (admin) {
          admin.supabaseUserId = STAGING_ADMIN_SUBJECT;
          admin.accountStatus = 'active';
          admin.emailVerified = true;
        }
      });
      return true;
    },
  );
  assert.equal(envCleanup, true);

  const app = createApp({
    enableRateLimit: false,
    providerVerifyOptions: { keyResolver },
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    baseUrl,
    dbPath,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

test('Phase 21-30: ES256 JWKS verification + key rotation succeeds even when SUPABASE_JWT_SECRET is set, and rejects HS256/none in useJwksOnly mode', async () => {
  const kp1 = await generateKeyPair('ES256');
  const kp2 = await generateKeyPair('ES256');
  const keysByKid: Record<string, CryptoKey> = {
    'kid-rot-1': kp1.publicKey,
    'kid-rot-2': kp2.publicKey,
  };
  const keyResolver = async (header: { kid?: string }) => {
    const key = header.kid ? keysByKid[header.kid] : undefined;
    if (!key) throw new Error('Unknown kid');
    return key;
  };

  await withEnv(
    {
      SUPABASE_JWT_SECRET: 'legacy-hs256-secret-present-in-railway-env',
      SUPABASE_URL: 'https://diasvulceaahmorucoro.supabase.co',
    },
    async () => {
      const es256K1 = await new SignJWT({
        email: 'admin@celebrationsisters.example.com',
        email_verified: true,
        aal: 'aal2',
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'kid-rot-1' })
        .setSubject(STAGING_ADMIN_SUBJECT)
        .setIssuer(STAGING_AUTH_ISSUER)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(kp1.privateKey);

      const es256K2 = await new SignJWT({
        email: 'admin@celebrationsisters.example.com',
        email_verified: true,
        aal: 'aal2',
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'kid-rot-2' })
        .setSubject(STAGING_ADMIN_SUBJECT)
        .setIssuer(STAGING_AUTH_ISSUER)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(kp2.privateKey);

      const verified1 = await verifyProviderAccessToken(es256K1, {
        supabaseUrl: `https://${STAGING_AUTH_PROJECT_REF}.supabase.co`,
        useJwksOnly: true,
        keyResolver,
      });
      assert.ok(verified1);
      assert.equal(verified1.sub, STAGING_ADMIN_SUBJECT);
      assert.equal(verified1.aal, 'aal2');

      const verified2 = await verifyProviderAccessToken(es256K2, {
        supabaseUrl: `https://${STAGING_AUTH_PROJECT_REF}.supabase.co`,
        useJwksOnly: true,
        keyResolver,
      });
      assert.ok(verified2);
      assert.equal(verified2.sub, STAGING_ADMIN_SUBJECT);

      // HS256 forged with SUPABASE_JWT_SECRET must be rejected when useJwksOnly is true
      const hs256Token = await new SignJWT({
        email: 'admin@celebrationsisters.example.com',
        aal: 'aal2',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(STAGING_ADMIN_SUBJECT)
        .setIssuer(STAGING_AUTH_ISSUER)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode('legacy-hs256-secret-present-in-railway-env'));

      assert.equal(
        await verifyProviderAccessToken(hs256Token, {
          supabaseUrl: `https://${STAGING_AUTH_PROJECT_REF}.supabase.co`,
          useJwksOnly: true,
          keyResolver,
        }),
        null,
      );

      // alg: none unsigned token must always be rejected
      const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const nonePayload = Buffer.from(
        JSON.stringify({
          sub: STAGING_ADMIN_SUBJECT,
          iss: STAGING_AUTH_ISSUER,
          aud: 'authenticated',
          aal: 'aal2',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString('base64url');
      assert.equal(
        await verifyProviderAccessToken(`${noneHeader}.${nonePayload}.`, {
          supabaseUrl: `https://${STAGING_AUTH_PROJECT_REF}.supabase.co`,
          useJwksOnly: true,
          keyResolver,
        }),
        null,
      );
    },
  );
});

test('Phase 21-30: non-mutating external staging MFA handoff preserves non-secret factor ID across reload, blocks duplicate verified factors, and clears on verify/logout', async () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const mem = createMemorySessionStorage();
  (globalThis as Record<string, unknown>).window = { sessionStorage: mem.storage };
  resetExternalStagingClientForTests();

  try {
    const mock = createMockExternalSupabaseClient({ validCode: '123456' });

    // 1. Enrollment captures factor ID and NEVER writes TOTP secret or otpauth URI to storage
    const enrolled = await enrollExternalStagingTotp({ clientOverride: mock.client });
    assert.equal(enrolled.factorId, 'factor-totp-1');
    assert.ok(enrolled.qr.startsWith('data:image/'));
    assert.equal(getPendingExternalTotpFactorId(STAGING_EXTERNAL_ADMIN_UUID), 'factor-totp-1');

    const serializedStorage = Array.from(mem.store.values()).join(' ');
    assert.equal(serializedStorage.includes(enrolled.secret), false, 'TOTP secret must NEVER be persisted in sessionStorage');
    assert.equal(serializedStorage.includes('otpauth://'), false, 'otpauth URI must NEVER be persisted in sessionStorage');
    assert.equal(serializedStorage.includes('factor-totp-1'), true);

    // 2. Simulate full browser reload (reset in-memory module cache while keeping sessionStorage)
    const savedStorageCopy = new Map(mem.store);
    resetExternalStagingClientForTests();
    for (const [k, v] of savedStorageCopy.entries()) mem.store.set(k, v);

    const recoveredFactorId = await resolveExternalTotpFactorId(mock.client);
    assert.equal(recoveredFactorId, 'factor-totp-1');

    // 3. Invalid / malformed / wrong codes fail closed without clearing pending handoff
    await assert.rejects(
      () => verifyExternalStagingTotp(recoveredFactorId!, '12ab56', mock.client),
      /6-digit/,
    );
    await assert.rejects(
      () => verifyExternalStagingTotp(recoveredFactorId!, '000000', mock.client),
      /Invalid TOTP code/,
    );
    assert.equal(getPendingExternalTotpFactorId(STAGING_EXTERNAL_ADMIN_UUID), 'factor-totp-1');

    // 4. Valid 6-digit code with whitespace succeeds, refreshes session to AAL2, and clears pending factor
    const verified = await verifyExternalStagingTotp(recoveredFactorId!, ' 123 456 ', mock.client);
    assert.equal(verified.aal, 'aal2');
    assert.equal(verified.userId, STAGING_EXTERNAL_ADMIN_UUID);
    assert.ok(verified.accessToken.startsWith('jwt-aal2-refreshed-'));
    assert.equal(getPendingExternalTotpFactorId(), null);
    assert.equal(mem.store.size, 0);

    // 5. Duplicate enrollment prevented once a verified TOTP factor already exists
    await assert.rejects(
      () => enrollExternalStagingTotp({ clientOverride: mock.client }),
      /already enrolled/i,
    );

    // 6. Explicit replacement of stale unverified factor cleans up only unverified factors
    const staleMock = createMockExternalSupabaseClient({
      initialFactors: [{ id: 'stale-unverified-1', factor_type: 'totp', status: 'unverified' }],
    });
    const replaced = await enrollExternalStagingTotp({
      replaceUnverified: true,
      clientOverride: staleMock.client,
    });
    assert.deepEqual(staleMock.getState().unenrolledIds, ['stale-unverified-1']);
    assert.equal(replaced.factorId, 'factor-totp-1');

    // 7. Logout clears pending factor and calls provider signOut
    await signOutExternalStagingSession(staleMock.client);
    assert.equal(getPendingExternalTotpFactorId(), null);
    assert.equal(staleMock.getState().signedOut, true);

    // 8. Wrong user UUID is strictly rejected
    const wrongUserMock = createMockExternalSupabaseClient({
      userId: '43d8d6ae-a4a3-41a0-a099-a19f10c0be72',
    });
    await assert.rejects(
      () => enrollExternalStagingTotp({ clientOverride: wrongUserMock.client }),
      /staging administrator session required/i,
    );

    // 9. Provider returning AAL1 after verify fails closed
    const aal1StuckMock = createMockExternalSupabaseClient({
      validCode: '654321',
      postVerifyAal: 'aal1',
      initialFactors: [{ id: 'f-stuck', factor_type: 'totp', status: 'unverified' }],
    });
    await assert.rejects(
      () => verifyExternalStagingTotp('f-stuck', '654321', aal1StuckMock.client),
      /AAL2 verification did not complete/i,
    );
  } finally {
    clearPendingExternalTotpFactor();
    resetExternalStagingClientForTests();
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  }
});

test('Phase 21-30: external staging HTTP privilege boundary closes all alternate admin/MFA bypass paths while supporting AAL1 reload gate and AAL2 unlock', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const resolver = async () => publicKey;

  const { baseUrl, dbPath, cleanup } = await startIsolatedExternalStagingServer(resolver);
  try {
    await withEnv(
      {
        ...EXTERNAL_STAGING_ENV,
        CS_DB_PATH: dbPath,
        SUPABASE_JWT_SECRET: 'unused-legacy-hs256-secret-must-never-break-es256-jwks',
      },
      async () => {
        const makeAdminJwt = (aal: 'aal1' | 'aal2', sub = STAGING_ADMIN_SUBJECT) =>
          new SignJWT({
            email: 'admin@celebrationsisters.example.com',
            email_verified: true,
            aal,
            session_id: `sess-${aal}`,
          })
            .setProtectedHeader({ alg: 'ES256', kid: 'staging-k1' })
            .setSubject(sub)
            .setIssuer(STAGING_AUTH_ISSUER)
            .setAudience('authenticated')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);

        const aal1Token = await makeAdminJwt('aal1');
        const aal2Token = await makeAdminJwt('aal2');
        const otherSubjectAal2 = await makeAdminJwt('aal2', '43d8d6ae-a4a3-41a0-a099-a19f10c0be72');

        // AAL1 pinned admin can inspect /api/auth/session (to restore MFA gate on reload) with no csrfToken
        const aal1SessionRes = await fetch(`${baseUrl}/api/auth/session`, {
          headers: { Authorization: `Bearer ${aal1Token}` },
        });
        assert.equal(aal1SessionRes.status, 200);
        const aal1Session = (await aal1SessionRes.json()) as {
          user: { role: string };
          mfaRequired: boolean;
          mfaVerified: boolean;
          aal: string;
          csrfToken?: string;
          externalStagingAuth?: boolean;
        };
        assert.equal(aal1Session.user.role, 'admin');
        assert.equal(aal1Session.mfaRequired, true);
        assert.equal(aal1Session.mfaVerified, false);
        assert.equal(aal1Session.aal, 'aal1');
        assert.equal(aal1Session.csrfToken, undefined);
        assert.equal(aal1Session.externalStagingAuth, true);

        // AAL1 admin is denied on ALL protected endpoints
        for (const protectedPath of [
          '/api/admin/overview',
          '/api/bookings',
          '/api/consultations',
          '/api/staff/checklists',
          '/api/inventory',
        ]) {
          const deniedRes = await fetch(`${baseUrl}${protectedPath}`, {
            headers: { Authorization: `Bearer ${aal1Token}` },
          });
          assert.ok(
            deniedRes.status === 401 || deniedRes.status === 403,
            `AAL1 admin must be denied on ${protectedPath} (got ${deniedRes.status})`,
          );
        }

        // All local MFA mutation and external password-reset routes are closed (409)
        for (const [endpoint, body] of [
          ['/api/auth/mfa/totp/enroll', {}],
          ['/api/auth/mfa/verify', { code: '123456' }],
          ['/api/auth/mfa/recover', { recoveryCode: 'TEST-RECOVERY' }],
          ['/api/auth/mfa/totp/revoke', { code: '123456' }],
          ['/api/auth/password-reset', { email: 'admin@celebrationsisters.example.com' }],
        ] as const) {
          const blockedRes = await fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${aal2Token}`,
            },
            body: JSON.stringify(body),
          });
          assert.equal(blockedRes.status, 409, `${endpoint} must return 409 in external staging mode`);
        }

        // Forged local HMAC admin cookie (even with mfaVerified: true) is rejected in external staging mode
        const forgedLocalAdminToken = signSessionToken({
          userId: 'user-admin-director',
          role: 'admin',
          mfaVerified: true,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 3_600_000,
        });
        const forgedCookieRes = await fetch(`${baseUrl}/api/admin/overview`, {
          headers: { Authorization: `Bearer ${forgedLocalAdminToken}` },
        });
        assert.equal(forgedCookieRes.status, 403);

        // Non-pinned subject with AAL2 cannot access admin endpoints
        const otherSubRes = await fetch(`${baseUrl}/api/admin/overview`, {
          headers: { Authorization: `Bearer ${otherSubjectAal2}` },
        });
        assert.equal(otherSubRes.status, 403);

        // Pinned staging admin UUID with genuine ES256 AAL2 succeeds on /api/auth/session and /api/admin/overview
        const aal2SessionRes = await fetch(`${baseUrl}/api/auth/session`, {
          headers: { Authorization: `Bearer ${aal2Token}` },
        });
        assert.equal(aal2SessionRes.status, 200);
        const aal2Session = (await aal2SessionRes.json()) as {
          mfaVerified: boolean;
          aal: string;
          mfaRequired: boolean;
        };
        assert.equal(aal2Session.mfaVerified, true);
        assert.equal(aal2Session.aal, 'aal2');
        assert.equal(aal2Session.mfaRequired, false);

        const adminOverviewRes = await fetch(`${baseUrl}/api/admin/overview`, {
          headers: { Authorization: `Bearer ${aal2Token}` },
        });
        assert.equal(adminOverviewRes.status, 200);
      },
    );
  } finally {
    await cleanup();
  }
});

test('Phase 21-30: strict Customer A vs Customer B isolation across consultations (including shared-email bound clientId), bookings, concepts, staff, inventory, and admin routes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-phase25-iso-'));
  const dbPath = path.join(tmpDir, 'db.json');

  await withEnv({ CS_DB_PATH: dbPath }, async () => {
    const app = createApp({ enableRateLimit: false });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

    try {
      const switchUser = async (userId: string) => {
        const res = await fetch(`${baseUrl}/api/auth/switch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        assert.equal(res.status, 200);
        const data = (await res.json()) as { token: string };
        return data.token;
      };

      const clientAToken = await switchUser('user-client-camille');
      const clientBToken = await switchUser('user-client-elena');

      // Seed a consultation owned by Customer B that happens to share Customer A's email
      // to verify bound clientId records NEVER leak across accounts by email alone.
      const { withTransaction } = await import('../server/store.ts');
      await withTransaction((db) => {
        const clientA = db.users.find((u) => u.id === 'user-client-camille');
        db.consultations.push({
          id: 'con-bound-client-b',
          referenceCode: 'CONS-ISO-9999',
          bookingId: 'bkg-102',
          clientId: 'user-client-elena',
          clientName: 'Elena Bound Record',
          clientEmail: clientA?.email || 'camille@example.com',
          clientPhone: '404-555-0199',
          preferredContactMethod: 'email',
          eventTitle: 'Private Gala',
          eventCategory: 'Corporate Gala',
          eventDate: '2027-09-10',
          eventLocation: 'Atlanta, GA',
          venueName: 'The Biltmore Ballrooms',
          guestCount: 150,
          budgetRange: '$15,000 - $30,000',
          serviceDivisionIds: ['div-luxury-decor'],
          consultationNotes: 'Confidential Client B notes',
          method: 'video',
          status: 'Confirmed',
          crmStage: 'Consultation Scheduled',
          assignedPlannerId: 'user-admin-director',
          assignedPlannerName: 'Maya Jenkins',
          startUtc: '2027-08-10T15:00:00.000Z',
          endUtc: '2027-08-10T16:00:00.000Z',
          durationMinutes: 60,
          bufferBeforeMinutes: 15,
          bufferAfterMinutes: 15,
          clientTimezone: 'America/New_York',
          privacyConsentAccepted: true,
          privacyConsentAt: new Date().toISOString(),
          privacyConsentVersion: '2026-01',
          accessTokenHash: '0'.repeat(64),
          rescheduleCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });

      // Customer A must NEVER see Customer B's bound consultation
      const conARes = await fetch(`${baseUrl}/api/consultations`, {
        headers: { Authorization: `Bearer ${clientAToken}` },
      });
      assert.equal(conARes.status, 200);
      const conAData = (await conARes.json()) as { consultations: { id: string }[] };
      assert.equal(
        conAData.consultations.some((c) => c.id === 'con-bound-client-b'),
        false,
        'Customer A must never see a consultation bound to Customer B clientId',
      );

      // Customer B CAN see her own bound consultation
      const conBRes = await fetch(`${baseUrl}/api/consultations`, {
        headers: { Authorization: `Bearer ${clientBToken}` },
      });
      assert.equal(conBRes.status, 200);
      const conBData = (await conBRes.json()) as { consultations: { id: string }[] };
      assert.equal(
        conBData.consultations.some((c) => c.id === 'con-bound-client-b'),
        true,
      );

      // Customer A denied on all privileged / operational / cross-tenant endpoints
      const forbiddenChecks: Array<{ method: string; url: string; body?: unknown; allow404?: boolean }> = [
        { method: 'GET', url: '/api/admin/overview' },
        { method: 'GET', url: '/api/staff/checklists' },
        { method: 'GET', url: '/api/inventory' },
        { method: 'GET', url: '/api/vendors' },
        { method: 'POST', url: '/api/bookings/bkg-102/contract/sign', body: { signatureName: 'Spoof' } },
        { method: 'POST', url: '/api/bookings/bkg-102/messages', body: { text: 'Cross-tenant injection' }, allow404: true },
        {
          method: 'POST',
          url: '/api/bookings/bkg-102/quotes',
          body: { description: 'Tamper', unitPrice: 1, quantity: 1 },
        },
        { method: 'PATCH', url: '/api/bookings/bkg-102/status', body: { status: 'Confirmed' } },
        { method: 'PATCH', url: '/api/bookings/bkg-102/assignments', body: { vendorIds: [] } },
        { method: 'PATCH', url: '/api/bookings/bkg-102/milestones/ms-1', body: { status: 'Completed' }, allow404: true },
      ];
      for (const check of forbiddenChecks) {
        const res = await fetch(`${baseUrl}${check.url}`, {
          method: check.method,
          headers: {
            Authorization: `Bearer ${clientAToken}`,
            ...(check.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: check.body ? JSON.stringify(check.body) : undefined,
        });
        const expectedOk = check.allow404 ? res.status === 403 || res.status === 404 : res.status === 403;
        assert.equal(
          expectedOk,
          true,
          `Customer A must be denied on ${check.method} ${check.url} (got ${res.status})`,
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('Phase 21-30: migration runner enforces advisory lock contention, rollback on SQL failure, null-checksum fail-closed, and idempotent rerun', async () => {
  const files = await loadMigrationFiles();
  assert.ok(files.length >= 8);

  // 1. Concurrent advisory lock contention aborts cleanly before any DDL
  const lockClient = {
    async query(sql: string) {
      if (/pg_try_advisory_lock/i.test(sql)) {
        return { rows: [{ acquired: false }] };
      }
      throw new Error(`Unexpected query when advisory lock not acquired: ${sql}`);
    },
  };
  await assert.rejects(
    () => runMigrationsOnClient(lockClient as never, { dryRun: false }),
    /MIGRATION_LOCK_CONTENTION/,
  );

  // 2. Null checksum on an already-recorded migration fails closed in apply mode and unlocks advisory lock
  let unlockedAfterDrift = false;
  const nullChecksumClient = {
    async query(sql: string) {
      if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ acquired: true }] };
      if (/pg_advisory_unlock/i.test(sql)) {
        unlockedAfterDrift = true;
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (/CREATE TABLE IF NOT EXISTS public\.schema_migrations/i.test(sql)) return { rows: [] };
      if (/ALTER TABLE public\.schema_migrations/i.test(sql)) return { rows: [] };
      if (/SELECT version, checksum_sha256 FROM public\.schema_migrations/i.test(sql)) {
        return { rows: [{ version: files[0].version, checksum_sha256: null }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  await assert.rejects(
    () => runMigrationsOnClient(nullChecksumClient as never, { dryRun: false }),
    /MIGRATION_CHECKSUM_MISMATCH/,
  );
  assert.equal(unlockedAfterDrift, true);

  // 3. SQL execution error rolls back transaction and releases advisory lock
  const executedSql: string[] = [];
  const failingApplyClient = {
    async query(sql: string) {
      executedSql.push(sql.trim());
      if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ acquired: true }] };
      if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ pg_advisory_unlock: true }] };
      if (/CREATE TABLE IF NOT EXISTS public\.schema_migrations/i.test(sql)) return { rows: [] };
      if (/ALTER TABLE public\.schema_migrations/i.test(sql)) return { rows: [] };
      if (/SELECT version, checksum_sha256 FROM public\.schema_migrations/i.test(sql)) return { rows: [] };
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error('SIMULATED_DDL_FAILURE');
    },
  };
  await assert.rejects(
    () => runMigrationsOnClient(failingApplyClient as never, { dryRun: false }),
    /SIMULATED_DDL_FAILURE/,
  );
  assert.ok(executedSql.includes('BEGIN'));
  assert.ok(executedSql.includes('ROLLBACK'));
  assert.ok(executedSql.some((s) => /pg_advisory_unlock/i.test(s)));

  // 4. Full apply followed by idempotent rerun applies once then skips all on second run
  const recorded = new Map<string, string>();
  const memoryPgClient = {
    async query(sql: string, params?: unknown[]) {
      if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ acquired: true }] };
      if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ pg_advisory_unlock: true }] };
      if (/CREATE TABLE IF NOT EXISTS public\.schema_migrations/i.test(sql)) return { rows: [] };
      if (/ALTER TABLE public\.schema_migrations/i.test(sql)) return { rows: [] };
      if (/SELECT version, checksum_sha256 FROM public\.schema_migrations/i.test(sql)) {
        return {
          rows: Array.from(recorded.entries()).map(([version, checksum_sha256]) => ({
            version,
            checksum_sha256,
          })),
        };
      }
      if (/INSERT INTO public\.schema_migrations/i.test(sql) && Array.isArray(params)) {
        recorded.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const firstRun = await runMigrationsOnClient(memoryPgClient as never, { dryRun: false });
  assert.equal(firstRun.applied.length, files.length);
  assert.equal(firstRun.skipped.length, 0);

  const secondRun = await runMigrationsOnClient(memoryPgClient as never, { dryRun: false });
  assert.equal(secondRun.applied.length, 0);
  assert.equal(secondRun.skipped.length, files.length);
});
