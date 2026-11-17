import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { LEGACY_TO_ARCH_STATUS, toArchitecturalStage } from '../src/types/lifecycle.ts';

async function startIsolatedServer() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-booking-test-'));
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

test('prevents double booking under simultaneous concurrent POST /api/bookings requests', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    const payload = {
      clientName: 'Lauren Whitaker',
      clientEmail: 'lauren@example.com',
      clientPhone: '(803) 555-0199',
      eventTitle: 'Spring Estate Gala',
      eventType: 'Wedding Planning and Design',
      serviceDivisionIds: ['wedding-planning'],
      eventDate: '2027-05-15',
      location: 'Columbia, SC',
      venueName: 'Millstone Reserve',
      guestCount: 150,
      budgetRange: '$20,000 – $30,000',
    };

    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      fetch(`${baseUrl}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, clientEmail: 'other@example.com' }),
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 409]);
  } finally {
    await cleanup();
  }
});

test('blocks booking inquiries on studio blackout dates and honors temporary holds', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    // 2026-12-25 is a seeded blackout date
    const blackoutRes = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Holiday Host',
        clientEmail: 'host@example.com',
        clientPhone: '(803) 555-0111',
        eventTitle: 'Christmas Gala',
        eventType: 'Corporate Events',
        serviceDivisionIds: ['corporate-events'],
        eventDate: '2026-12-25',
        location: 'Columbia, SC',
        venueName: 'Columbia Hall',
        guestCount: 80,
        budgetRange: '$10,000 – $15,000',
      }),
    });
    assert.equal(blackoutRes.status, 409);

    // Place temporary hold and verify availability endpoint reflects hold
    const holdRes = await fetch(`${baseUrl}/api/availability/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventDate: '2027-06-20',
        venueName: 'Riverbanks Conservatory',
        clientEmail: 'hold@example.com',
      }),
    });
    assert.equal(holdRes.status, 201);

    const availRes = await fetch(
      `${baseUrl}/api/availability?date=2027-06-20&venue=${encodeURIComponent('Riverbanks Conservatory')}`,
    );
    const availData = (await availRes.json()) as { available: boolean };
    assert.equal(availData.available, false);
  } finally {
    await cleanup();
  }
});

test('enforces state-machine transitions, confirmation guards, and 18-stage lifecycle mapping', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    assert.equal(LEGACY_TO_ARCH_STATUS['Confirmed'], 'BOOKED');
    assert.equal(toArchitecturalStage('Planning'), 'IN_PLANNING');

    const switchRes = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-staff-maya' }),
    });
    const { token: staffToken } = (await switchRes.json()) as { token: string };

    // bkg-102 is in 'Contract Pending'; skipping straight to 'Confirmed' must fail (422)
    const skipRes = await fetch(`${baseUrl}/api/bookings/bkg-102/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ status: 'Confirmed' }),
    });
    assert.equal(skipRes.status, 422);

    // Moving to 'Payment Pending' is valid, then moving to 'Confirmed' without signed contract + deposit fails GUARD
    const step1 = await fetch(`${baseUrl}/api/bookings/bkg-102/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ status: 'Payment Pending' }),
    });
    assert.equal(step1.status, 200);

    const guardRes = await fetch(`${baseUrl}/api/bookings/bkg-102/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ status: 'Confirmed' }),
    });
    assert.equal(guardRes.status, 422);
    const guardBody = (await guardRes.json()) as { error: string };
    assert.match(guardBody.error, /contract signatures and initial deposit/i);
  } finally {
    await cleanup();
  }
});
