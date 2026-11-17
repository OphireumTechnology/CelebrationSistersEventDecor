import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signSessionToken } from '../server/auth.ts';
import { createApp } from '../server/app.ts';

async function startIsolatedServer() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-auth-test-'));
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
  const app = createApp({ enableRateLimit: false });
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

async function loginAs(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { token: string };
  assert.ok(data.token);
  return data.token;
}

test('rejects unauthenticated requests and forged raw x-user-id / x-user-role headers', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    const guestRes = await fetch(`${baseUrl}/api/bookings`);
    assert.equal(guestRes.status, 401);

    const spoofRes = await fetch(`${baseUrl}/api/bookings`, {
      headers: {
        'x-user-id': 'user-admin-director',
        'x-user-role': 'admin',
      },
    });
    assert.equal(spoofRes.status, 401);

    const spoofAdminRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: {
        'x-user-id': 'user-admin-director',
        'x-user-role': 'admin',
      },
    });
    assert.equal(spoofAdminRes.status, 403);
  } finally {
    await cleanup();
  }
});

test('enforces strict Client A vs Client B record isolation and blocks customer admin access', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    const camilleToken = await loginAs(baseUrl, 'user-client-camille');
    const res = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${camilleToken}` },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { bookings: { id: string; clientId: string }[] };
    assert.ok(data.bookings.length >= 1);
    assert.ok(data.bookings.every((b) => b.clientId === 'user-client-camille'));
    assert.equal(data.bookings.some((b) => b.id === 'bkg-102'), false);

    // Client cannot sign Client B contract
    const crossSignRes = await fetch(`${baseUrl}/api/bookings/bkg-102/contract/sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${camilleToken}`,
      },
      body: JSON.stringify({ signatureName: 'Camille Mercer' }),
    });
    assert.equal(crossSignRes.status, 403);

    // Client cannot access Executive Admin dashboard
    const adminRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${camilleToken}` },
    });
    assert.equal(adminRes.status, 403);
  } finally {
    await cleanup();
  }
});

test('enforces vendor assignment scoping and redacts financial fields', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    const vendorToken = await loginAs(baseUrl, 'user-vendor-floral');
    const res = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${vendorToken}` },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      bookings: { id: string; budgetRange: string; quotations: unknown[]; clientEmail: string }[];
    };
    assert.equal(data.bookings.length, 1);
    assert.equal(data.bookings[0].id, 'bkg-101');
    assert.equal(data.bookings[0].budgetRange, 'Protected');
    assert.equal(data.bookings[0].clientEmail, '');
    assert.equal(data.bookings[0].quotations.length, 0);
  } finally {
    await cleanup();
  }
});

test('enforces Executive Admin MFA verification before granting admin dashboard access', async () => {
  const priorCode = process.env.ADMIN_MFA_PASSCODE;
  process.env.ADMIN_MFA_PASSCODE = '202687';
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    const preMfaToken = await loginAs(baseUrl, 'user-admin-director');

    // Before MFA verification, /api/admin/overview must return 403
    const blockedRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${preMfaToken}` },
    });
    assert.equal(blockedRes.status, 403);

    // Invalid MFA code rejected
    const badMfa = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${preMfaToken}`,
      },
      body: JSON.stringify({ code: '000000' }),
    });
    assert.equal(badMfa.status, 403);

    // Valid MFA code issues elevated token
    const goodMfa = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${preMfaToken}`,
      },
      body: JSON.stringify({ code: '202687' }),
    });
    assert.equal(goodMfa.status, 200);
    const mfaData = (await goodMfa.json()) as { token: string; mfaVerified: boolean };
    assert.equal(mfaData.mfaVerified, true);

    const allowedRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${mfaData.token}` },
    });
    assert.equal(allowedRes.status, 200);
  } finally {
    await cleanup();
    if (priorCode === undefined) delete process.env.ADMIN_MFA_PASSCODE;
    else process.env.ADMIN_MFA_PASSCODE = priorCode;
  }
});

test('disables demo personas and switching in production, requires SESSION_SECRET, and isolates public leads from existing clients', async () => {
  const priorEnv = process.env.NODE_ENV;
  const priorSecret = process.env.SESSION_SECRET;
  const priorDbUrl = process.env.DATABASE_URL;
  const { baseUrl, cleanup } = await startIsolatedServer();

  try {
    // Public guest inquiry must NOT inherit user-client-camille ownership
    const guestBookingRes = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Stranger Inquiry',
        clientEmail: 'stranger@example.com',
        clientPhone: '(803) 555-0188',
        eventTitle: 'Private Gala Inquiry',
        eventType: 'Corporate Events',
        serviceDivisionIds: ['corporate-events'],
        eventDate: '2027-08-14',
        location: 'Columbia, SC',
        venueName: 'Foundry Hall',
        guestCount: 90,
        budgetRange: '$15,000 – $25,000',
      }),
    });
    assert.equal(guestBookingRes.status, 201);
    const createdLead = (await guestBookingRes.json()) as { booking: { id: string; clientId: string } };
    assert.notEqual(createdLead.booking.clientId, 'user-client-camille');
    assert.ok(createdLead.booking.clientId.startsWith('lead:'));

    const camilleToken = await loginAs(baseUrl, 'user-client-camille');
    const camilleListRes = await fetch(`${baseUrl}/api/bookings`, {
      headers: { Authorization: `Bearer ${camilleToken}` },
    });
    const camilleList = (await camilleListRes.json()) as { bookings: { id: string }[] };
    assert.equal(camilleList.bookings.some((b) => b.id === createdLead.booking.id), false);

    // Health liveness probe
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    assert.ok(healthRes.headers.get('x-request-id'));

    // Production guards
    process.env.NODE_ENV = 'production';
    delete process.env.SESSION_SECRET;
    delete process.env.DATABASE_URL;

    const prodPersonas = await fetch(`${baseUrl}/api/auth/personas`);
    assert.equal(prodPersonas.status, 404);

    const prodSwitch = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-admin-director' }),
    });
    assert.equal(prodSwitch.status, 404);

    const prodReady = await fetch(`${baseUrl}/ready`);
    assert.equal(prodReady.status, 503);

    assert.throws(
      () =>
        signSessionToken({
          userId: 'user-admin-director',
          role: 'admin',
          mfaVerified: false,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
      /SESSION_SECRET is required in production/,
    );
  } finally {
    if (priorEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorEnv;
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    if (priorDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDbUrl;
    await cleanup();
  }
});
