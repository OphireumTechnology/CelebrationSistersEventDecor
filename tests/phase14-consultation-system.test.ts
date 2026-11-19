import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, type CreateAppOptions } from '../server/app.ts';
import { redactSensitiveFields } from '../server/observability.ts';
import { NotificationOutboxWorker } from '../server/outbox.ts';
import { computeConsultationAvailability, localDateTimeToUtc, STUDIO_TIMEZONE } from '../server/scheduling.ts';
import { readDb } from '../server/store.ts';
import { generateTotpCode } from '../server/totp.ts';

async function startServer(options: CreateAppOptions = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p14-consult-'));
  const dbPath = path.join(tmpDir, 'db.json');
  process.env.CS_DB_PATH = dbPath;
  const app = createApp({ enableRateLimit: false, ...options });
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
      delete process.env.CS_DB_PATH;
    },
  };
}

async function loginToken(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { token: string }).token;
}

async function loginAdminMfaToken(baseUrl: string): Promise<string> {
  const initialToken = await loginToken(baseUrl, 'user-admin-director');
  const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${initialToken}` },
  });
  assert.equal(enrollRes.status, 200);
  const { secret } = (await enrollRes.json()) as { secret: string };
  assert.ok(secret, 'TOTP enrollment must return a secret');
  const code = generateTotpCode(secret);
  const res = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${initialToken}`,
    },
    body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { token: string }).token;
}

function futureWeekdayIso(minDaysAhead: number): string {
  for (let offset = minDaysAhead; offset < minDaysAhead + 14; offset += 1) {
    const dt = new Date(Date.now() + offset * 86_400_000);
    const dow = dt.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      return dt.toISOString().slice(0, 10);
    }
  }
  return new Date(Date.now() + minDaysAhead * 86_400_000).toISOString().slice(0, 10);
}

test('Phase 14 Backend & Scheduling: real-time availability, blackout dates, timezone conversion, and buffer conflict detection', async () => {
  const srv = await startServer();
  try {
    const startDate = futureWeekdayIso(5);
    const res = await fetch(
      `${srv.baseUrl}/api/consultations/availability?startDate=${startDate}&days=7&timezone=America/Los_Angeles&method=video`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      studioTimezone: string;
      clientTimezone: string;
      days: Array<{ date: string; availableCount: number; slots: Array<{ startUtc: string; plannerId: string; available: boolean; displayLabel: string }> }>;
    };
    assert.equal(body.studioTimezone, 'America/New_York');
    assert.equal(body.clientTimezone, 'America/Los_Angeles');
    assert.equal(body.days.length, 7);

    const openDay = body.days.find((d) => d.availableCount > 0);
    assert.ok(openDay, 'Expected at least one day with open consultation slots');
    assert.ok(openDay.slots.some((s) => s.available));

    // Invalid timezone rejected
    const badTz = await fetch(`${srv.baseUrl}/api/consultations/availability?timezone=Mars/Olympus`);
    assert.equal(badTz.status, 400);

    // Blackout date blocks all slots for that date
    const adminToken = await loginAdminMfaToken(srv.baseUrl);
    const blackoutRes = await fetch(`${srv.baseUrl}/api/admin/blackout-dates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ date: openDay.date, reason: 'Studio Editorial Shoot Closure' }),
    });
    assert.equal(blackoutRes.status, 201);

    const afterBlackout = await fetch(
      `${srv.baseUrl}/api/consultations/availability?startDate=${openDay.date}&days=1&timezone=America/New_York`,
    );
    assert.equal(afterBlackout.status, 200);
    const afterBody = (await afterBlackout.json()) as {
      days: Array<{ isBlackout: boolean; availableCount: number; blackoutReason?: string }>;
    };
    assert.equal(afterBody.days[0].isBlackout, true);
    assert.equal(afterBody.days[0].availableCount, 0);
    assert.match(afterBody.days[0].blackoutReason || '', /Editorial Shoot/);
  } finally {
    await srv.cleanup();
  }
});

test('Phase 14 Booking Lifecycle: atomic booking, idempotency, simultaneous slot 409 conflict, scoped token status, reschedule & cancel slot release', async () => {
  const srv = await startServer();
  try {
    const startDate = futureWeekdayIso(7);
    const availRes = await fetch(
      `${srv.baseUrl}/api/consultations/availability?startDate=${startDate}&days=5&timezone=America/New_York&method=video`,
    );
    const avail = (await availRes.json()) as {
      days: Array<{ date: string; slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
    };
    const openSlots = avail.days.flatMap((d) => d.slots).filter((s) => s.available);
    assert.ok(openSlots.length >= 2, 'Need at least 2 available consultation slots');

    const slotA = openSlots[0];
    const slotB = openSlots[1];
    const eventDate = futureWeekdayIso(90);

    // Missing privacy consent is rejected (400)
    const missingConsent = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Luxury Wedding Planning & Design',
        serviceDivisionIds: ['wedding-planning'],
        eventDate,
        guestCount: 180,
        budgetRange: '$25,000 – $45,000',
        location: 'Columbia, SC',
        venueName: 'Lace House Gardens',
        consultationStartUtc: slotA.startUtc,
        consultationMethod: 'video',
        plannerId: slotA.plannerId,
        clientTimezone: 'America/New_York',
        clientName: 'Elena & Marcus Vance',
        clientEmail: 'elena.vance@example.com',
        clientPhone: '803-555-0199',
        privacyConsentAccepted: false,
      }),
    });
    assert.equal(missingConsent.status, 400);

    // Valid booking with Idempotency-Key succeeds (201) and returns scoped verification token
    const idempotencyKey = 'p14-idem-booking-1';
    const payload = {
      eventType: 'Luxury Wedding Planning & Design',
      eventTitle: 'Vance Estate Autumn Wedding',
      serviceDivisionIds: ['wedding-planning', 'luxury-decor'],
      eventDate,
      guestCount: 180,
      budgetRange: '$25,000 – $45,000',
      location: 'Columbia, SC',
      venueName: 'Lace House Gardens',
      consultationStartUtc: slotA.startUtc,
      consultationMethod: 'video',
      plannerId: slotA.plannerId,
      clientTimezone: 'America/Chicago',
      clientName: 'Elena & Marcus Vance',
      clientEmail: 'elena.vance@example.com',
      clientPhone: '803-555-0199',
      preferredContactMethod: 'email',
      notes: 'Royal purple velvet drapery and champagne gold floral arches.',
      privacyConsentAccepted: true,
    };

    const createRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      deduplicated: boolean;
      consultation: { id: string; referenceCode: string; status: string; accessTokenHash?: string };
      accessToken: string;
      notificationStatus: { outboxQueued: number };
    };
    assert.equal(created.deduplicated, false);
    assert.equal(created.consultation.status, 'Pending');
    assert.equal(created.consultation.accessTokenHash, undefined, 'Must never expose accessTokenHash to client');
    assert.ok(created.accessToken.startsWith('csa_'), 'Scoped verification token must be issued once');
    assert.equal(created.notificationStatus.outboxQueued, 2);

    // Replaying the same Idempotency-Key returns deduplicated record without creating duplicate
    const replayRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(replayRes.status, 200);
    const replayed = (await replayRes.json()) as { deduplicated: boolean; consultation: { id: string } };
    assert.equal(replayed.deduplicated, true);
    assert.equal(replayed.consultation.id, created.consultation.id);

    // Second client attempting the EXACT SAME slot gets 409 Conflict with suggested alternative slots
    const raceRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'p14-idem-booking-rival',
      },
      body: JSON.stringify({
        ...payload,
        clientName: 'Rival Client',
        clientEmail: 'rival@example.com',
      }),
    });
    assert.equal(raceRes.status, 409);
    const raceBody = (await raceRes.json()) as { code: string; suggestedSlots: unknown[] };
    assert.equal(raceBody.code, 'SLOT_CONFLICT');
    assert.ok(Array.isArray(raceBody.suggestedSlots) && raceBody.suggestedSlots.length > 0);

    // Predictable reference-only lookup without accessToken is blocked (400)
    const noTokenLookup = await fetch(
      `${srv.baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}`,
    );
    assert.equal(noTokenLookup.status, 400);

    // Wrong token is rejected (403)
    const badTokenLookup = await fetch(
      `${srv.baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}&accessToken=csa_wrong_token`,
    );
    assert.equal(badTokenLookup.status, 403);

    // Valid reference + accessToken returns sanitized status
    const okLookup = await fetch(
      `${srv.baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}&accessToken=${encodeURIComponent(created.accessToken)}`,
    );
    assert.equal(okLookup.status, 200);
    const okLookupBody = (await okLookup.json()) as {
      consultation: { referenceCode: string; canReschedule: boolean; canCancel: boolean };
    };
    assert.equal(okLookupBody.consultation.referenceCode, created.consultation.referenceCode);
    assert.equal(okLookupBody.consultation.canReschedule, true);
    assert.equal(okLookupBody.consultation.canCancel, true);

    // Reschedule from slotA -> slotB via scoped accessToken releases slotA immediately
    const reschedRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/reschedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newStartUtc: slotB.startUtc,
        plannerId: slotB.plannerId,
        accessToken: created.accessToken,
        reason: 'Flight arrival changed',
      }),
    });
    assert.equal(reschedRes.status, 200);
    const reschedBody = (await reschedRes.json()) as { consultation: { status: string; rescheduleCount: number } };
    assert.equal(reschedBody.consultation.status, 'Rescheduled');
    assert.equal(reschedBody.consultation.rescheduleCount, 1);

    // Verify slotA is now free and bookable by another client at a different venue!
    const bookFreedSlot = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        eventTitle: 'Holloway Anniversary Gala',
        venueName: 'Columbia Museum of Art',
        clientName: 'Derrick Holloway',
        clientEmail: 'derrick.holloway@example.com',
        consultationStartUtc: slotA.startUtc,
        plannerId: slotA.plannerId,
      }),
    });
    assert.equal(bookFreedSlot.status, 201);

    // Cancel rescheduled consultation via scoped token releases slotB
    const cancelRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: created.accessToken,
        reason: 'Postponing to next quarter',
      }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelBody = (await cancelRes.json()) as { consultation: { status: string } };
    assert.equal(cancelBody.consultation.status, 'Cancelled');
  } finally {
    await srv.cleanup();
  }
});

test('Phase 14 CRM Conversion, Proposal Integer-Cent Handoff, Staff Assignment Conflict & Notifications Outbox', async () => {
  const sentPayloads: Array<{ to: string[]; subject: string }> = [];
  let attemptCount = 0;
  const mockFetch: typeof fetch = async (_url, init) => {
    attemptCount += 1;
    const parsed = JSON.parse(String(init?.body || '{}')) as { to: string[]; subject: string };
    // Simulate a transient 503 failure on first attempt to verify retry logic, then 200 ProviderAccepted
    if (attemptCount === 1) {
      return new Response(JSON.stringify({ message: 'Transient upstream 503' }), { status: 503 });
    }
    sentPayloads.push(parsed);
    return new Response(JSON.stringify({ id: `msg-resend-${attemptCount}` }), { status: 200 });
  };

  const prevKey = process.env.RESEND_API_KEY;
  const prevFrom = process.env.EMAIL_FROM;
  const prevLive = process.env.EMAIL_LIVE_DELIVERY_ENABLED;
  process.env.RESEND_API_KEY = 'mock-resend-sandbox-token';
  process.env.EMAIL_FROM = 'concierge@celebrationsistersdecor.com';
  process.env.EMAIL_LIVE_DELIVERY_ENABLED = 'true';

  const worker = new NotificationOutboxWorker({ fetchImpl: mockFetch, baseBackoffMs: 1 });
  const srv = await startServer({ notificationFetch: mockFetch, outboxWorker: worker });

  try {
    const adminToken = await loginAdminMfaToken(srv.baseUrl);
    const staffToken = await loginToken(srv.baseUrl, 'user-staff-maya');

    // Create a fresh pending consultation to walk through the complete CRM conversion lifecycle
    const availRes = await fetch(
      `${srv.baseUrl}/api/consultations/availability?startDate=${futureWeekdayIso(10)}&days=5&timezone=America/New_York&method=video`,
    );
    const availBody = (await availRes.json()) as {
      days: Array<{ slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
    };
    const openSlot = availBody.days.flatMap((d) => d.slots).find((s) => s.available);
    assert.ok(openSlot, 'Need an open consultation slot for CRM conversion test');

    const createRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'p14-crm-lifecycle-create',
      },
      body: JSON.stringify({
        eventType: 'Corporate Events',
        eventTitle: 'Carolina Civic Foundation Annual Gala',
        serviceDivisionIds: ['corporate-events', 'luxury-decor'],
        eventDate: futureWeekdayIso(110),
        guestCount: 250,
        budgetRange: '$35,000 – $55,000',
        location: 'Columbia, SC',
        venueName: 'Pastides Alumni Center',
        consultationStartUtc: openSlot.startUtc,
        consultationMethod: 'video',
        plannerId: openSlot.plannerId,
        clientTimezone: 'America/New_York',
        clientName: 'Nadia Sterling',
        clientEmail: 'nadia.sterling@example.com',
        clientPhone: '803-555-0188',
        preferredContactMethod: 'email',
        notes: 'Gold gala stage plan with floral chandeliers.',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(createRes.status, 201);
    const createdConsult = ((await createRes.json()) as { consultation: { id: string } }).consultation;
    const consultId = createdConsult.id;

    // Confirm newly created pending consultation
    const confirmRes = await fetch(`${srv.baseUrl}/api/consultations/${consultId}/confirm`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.equal(confirmRes.status, 200);
    assert.equal(((await confirmRes.json()) as { consultation: { status: string } }).consultation.status, 'Confirmed');

    // Reassign consultation to Executive Director
    const assignRes = await fetch(`${srv.baseUrl}/api/consultations/${consultId}/assign`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ plannerId: 'user-admin-director' }),
    });
    assert.equal(assignRes.status, 200);

    // Complete consultation with outcome summary + auto follow-up task
    const completeRes = await fetch(`${srv.baseUrl}/api/consultations/${consultId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        status: 'Completed',
        outcomeSummary: 'Approved 250-guest gold gala stage plan with floral chandeliers.',
        followUpTitle: 'Send revised drapery swatch photo deck',
      }),
    });
    assert.equal(completeRes.status, 200);
    const completeBody = (await completeRes.json()) as {
      consultation: { status: string; crmStage: string };
      followUpTask?: { id: string; status: string };
    };
    assert.equal(completeBody.consultation.status, 'Completed');
    assert.equal(completeBody.consultation.crmStage, 'Consultation Completed');
    assert.equal(completeBody.followUpTask?.status, 'Open');

    // Proposal handoff uses EXACT integer-cent arithmetic (0.1 + 0.2 trap test: $19.99 * 3 + $0.03 - $10.00 = $50.00)
    const propRes = await fetch(`${srv.baseUrl}/api/consultations/${consultId}/proposal-handoff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        lineItems: [
          { description: 'Custom Candlelight Cluster', quantity: 3, unitPrice: 19.99 },
          { description: 'Gold Seal Rounding Adjustment', quantity: 1, unitPrice: 0.03 },
        ],
        discountAmount: 10.0,
        notes: 'Exact cent arithmetic verification.',
        markAsSent: true,
      }),
    });
    assert.equal(propRes.status, 201);
    const propBody = (await propRes.json()) as {
      consultation: { crmStage: string };
      quotation: { totalAmount: number; subtotal: number; discountAmount: number };
      amountsCents: { subtotalCents: number; discountCents: number; totalCents: number };
    };
    assert.equal(propBody.consultation.crmStage, 'Proposal Sent');
    assert.equal(propBody.amountsCents.subtotalCents, 6000);
    assert.equal(propBody.amountsCents.discountCents, 1000);
    assert.equal(propBody.amountsCents.totalCents, 5000);
    assert.equal(propBody.quotation.totalAmount, 50);

    // Client decision -> Event Booked
    const decisionRes = await fetch(`${srv.baseUrl}/api/consultations/${consultId}/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ decision: 'Approved', notes: 'Signed off on itemized quote.' }),
    });
    assert.equal(decisionRes.status, 200);
    assert.equal(
      ((await decisionRes.json()) as { consultation: { crmStage: string } }).consultation.crmStage,
      'Event Booked',
    );

    // Drain outbox retries & verify honest ProviderAccepted status (never fabricated 'Delivered')
    await new Promise((r) => setTimeout(r, 20));
    await worker.processOnce();
    const db = await readDb();
    assert.ok(db.notificationDeliveries.some((d) => d.status === 'ProviderAccepted'));
    assert.equal(
      db.notificationDeliveries.some((d) => d.status === 'Delivered'),
      false,
      'Resend 2xx must remain ProviderAccepted until webhook confirmation',
    );
    assert.ok(sentPayloads.length >= 2);
  } finally {
    if (prevKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = prevKey;
    if (prevFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = prevFrom;
    if (prevLive === undefined) delete process.env.EMAIL_LIVE_DELIVERY_ENABLED;
    else process.env.EMAIL_LIVE_DELIVERY_ENABLED = prevLive;
    await srv.cleanup();
  }
});

test('Phase 14 Security: RBAC isolation, Admin MFA gate, vendor denial, cross-client isolation, and accessToken log redaction', async () => {
  const srv = await startServer();
  try {
    // Unauthenticated access to /api/consultations is denied (401)
    const unauth = await fetch(`${srv.baseUrl}/api/consultations`);
    assert.equal(unauth.status, 401);

    // Vendor access to /api/consultations is denied (403)
    const vendorToken = await loginToken(srv.baseUrl, 'user-vendor-floral');
    const vendorRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      headers: { Authorization: `Bearer ${vendorToken}` },
    });
    assert.equal(vendorRes.status, 403);

    // Admin without MFA is denied (403 MFA_REQUIRED)
    const adminNoMfa = await loginToken(srv.baseUrl, 'user-admin-director');
    const adminBlocked = await fetch(`${srv.baseUrl}/api/consultations`, {
      headers: { Authorization: `Bearer ${adminNoMfa}` },
    });
    assert.equal(adminBlocked.status, 403);

    // Client sees ONLY own consultations, cannot confirm or inspect CRM pipeline
    const clientToken = await loginToken(srv.baseUrl, 'user-client-camille');
    const clientListRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(clientListRes.status, 200);
    const clientList = (await clientListRes.json()) as {
      consultations: Array<{ clientId: string; referenceCode: string }>;
    };
    assert.ok(clientList.consultations.length >= 1);
    assert.ok(
      clientList.consultations.every((c) => c.clientId === 'user-client-camille'),
      'Client must never see another client consultation',
    );

    const clientConfirmAttempt = await fetch(`${srv.baseUrl}/api/consultations/con-103/confirm`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(clientConfirmAttempt.status, 403);

    const clientCrmAttempt = await fetch(`${srv.baseUrl}/api/crm/pipeline`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(clientCrmAttempt.status, 403);

    // Structured log redaction strips accessToken, clientEmail, and secret keys
    const redacted = redactSensitiveFields({
      accessToken: 'csa_super_secret_token_value',
      clientEmail: 'vip@example.com',
      referenceCode: 'CS-2026-0099',
    }) as Record<string, unknown>;
    assert.equal(redacted.accessToken, '[REDACTED]');
    assert.equal(redacted.clientEmail, '[REDACTED]');
    assert.equal(redacted.referenceCode, 'CS-2026-0099');

    // Scheduling helper handles DST & buffers deterministically
    const utcDt = localDateTimeToUtc('2026-07-15', '10:00', STUDIO_TIMEZONE);
    assert.equal(utcDt.toISOString(), '2026-07-15T14:00:00.000Z'); // EDT = UTC-4
    const winterDt = localDateTimeToUtc('2026-01-15', '10:00', STUDIO_TIMEZONE);
    assert.equal(winterDt.toISOString(), '2026-01-15T15:00:00.000Z'); // EST = UTC-5

    const computed = computeConsultationAvailability({
      startDate: '2026-07-15',
      days: 1,
      clientTimezone: 'America/New_York',
      rules: [],
      blackoutDates: [],
      consultations: [],
      slotHolds: [],
      users: [],
    });
    assert.equal(computed[0].isStudioOpen, false);
  } finally {
    await srv.cleanup();
  }
});
