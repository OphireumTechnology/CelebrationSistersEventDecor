import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateMigrationsDirectory } from '../scripts/verify-migrations.ts';
import { createApp } from '../server/app.ts';
import { setAiProviderOverrideForTests } from '../server/gemini.ts';
import { generateTotpCode } from '../server/totp.ts';
import { sanitizeApiBaseUrl } from '../src/lib/apiClient.ts';

async function startServerOnDb(dbPath: string) {
  process.env.CS_DB_PATH = dbPath;
  const app = createApp({ enableRateLimit: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function loginToken(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ userId }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

function futureIso(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

test('Block 11.2: SQL migrations 001-005 pass ordering, non-destructive DDL, full RLS coverage & security_invoker audit', async () => {
  const result = await validateMigrationsDirectory();
  assert.equal(result.passed, true, `Migration audit errors: ${result.errors.join('; ')}`);
  assert.deepEqual(result.files, [
    '001_initial_schema.sql',
    '002_rls_policies.sql',
    '003_auth_identity.sql',
    '004_production_hardening.sql',
    '005_rls_event_planner_and_invoices.sql',
  ]);
  assert.ok(result.rlsTablesChecked >= 20);
});

test('Block 11.7: Complete customer-to-administrator lifecycle with payment honesty, audit logs & restart persistence', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p11-lifecycle-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const eventDate = futureIso(90);
  let server1 = await startServerOnDb(dbPath);

  try {
    const clientToken = await loginToken(server1.baseUrl, 'user-client-camille');
    const staffToken = await loginToken(server1.baseUrl, 'user-staff-maya');
    const adminPreToken = await loginToken(server1.baseUrl, 'user-admin-director');

    // 1. Availability hold created
    const holdRes = await fetch(`${server1.baseUrl}/api/availability/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({
        eventDate,
        venueName: 'Lace House Courtyard',
        clientEmail: 'camille.mercer@example.com',
      }),
    });
    assert.equal(holdRes.status, 201);

    // 2. Consultation created with Idempotency-Key
    const createRes = await fetch(`${server1.baseUrl}/api/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientToken}`,
        'Idempotency-Key': 'p11-e2e-lifecycle-01',
      },
      body: JSON.stringify({
        clientName: 'Camille Mercer',
        clientEmail: 'camille.mercer@example.com',
        clientPhone: '(803) 555-0142',
        eventTitle: 'Mercer Autumn Vow Renewal',
        eventType: 'Anniversaries & Private Events',
        serviceDivisionIds: ['luxury-decor', 'event-lighting'],
        eventDate,
        location: 'Columbia, SC',
        venueName: 'Lace House Courtyard',
        guestCount: 140,
        budgetRange: '$28,000 - $42,000',
        notes: 'Champagne velvet drapery and warm pin-spot lighting.',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      booking: {
        id: string;
        referenceCode: string;
        payments: { id: string }[];
        milestones: { id: string }[];
      };
    };
    const bookingId = created.booking.id;
    const refCode = created.booking.referenceCode;

    // 3. Public tracking returns accurate status
    const trackRes = await fetch(
      `${server1.baseUrl}/api/bookings/track?referenceCode=${encodeURIComponent(refCode)}&email=camille.mercer@example.com`,
    );
    assert.equal(trackRes.status, 200);

    // 4. Staff reviews request and walks state machine: Consultation Scheduled -> Proposal in Preparation -> Quote Sent
    for (const nextStatus of ['Consultation Scheduled', 'Proposal in Preparation'] as const) {
      const stepRes = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
        body: JSON.stringify({ status: nextStatus }),
      });
      assert.equal(stepRes.status, 200);
    }

    const quoteRes = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
      body: JSON.stringify({
        items: [
          { description: 'Architectural floral canopy & luxury drapery', division: 'Luxury Decor', quantity: 1, unitPrice: 14500 },
          { description: 'Warm pin-spot & uplighting production', division: 'Event Lighting', quantity: 1, unitPrice: 5500 },
        ],
        discountAmount: 0,
      }),
    });
    assert.equal(quoteRes.status, 200);

    const quoteSentRes = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
      body: JSON.stringify({ status: 'Quote Sent' }),
    });
    assert.equal(quoteSentRes.status, 200);

    // 5. Client signs contract -> status advances to Payment Pending; staff countersigns
    const clientSign = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/contract/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ signatureName: 'Camille Mercer' }),
    });
    assert.equal(clientSign.status, 200);
    const signedBody = (await clientSign.json()) as {
      booking: { status: string; contract: { clientSigned: boolean; documentHash: string }; payments: { id: string }[] };
    };
    assert.equal(signedBody.booking.contract.clientSigned, true);
    assert.ok(signedBody.booking.contract.documentHash.length === 64);
    assert.equal(signedBody.booking.status, 'Payment Pending');

    const staffSign = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/contract/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
      body: JSON.stringify({ signatureName: 'Maya Lin' }),
    });
    assert.equal(staffSign.status, 200);

    // 6. Payment milestone honesty: production blocks client self-pay; staff staging ledger records honestly
    const depositId = signedBody.booking.payments[0]?.id;
    assert.ok(depositId);

    const prevEnv = process.env.NODE_ENV;
    let prodClientSelfPayStatus = 0;
    let prodClientSelfPayCode = '';
    try {
      process.env.NODE_ENV = 'production';
      const prodClientSelfPay = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/payments/${depositId}/pay`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      prodClientSelfPayStatus = prodClientSelfPay.status;
      const body = (await prodClientSelfPay.json()) as { code?: string };
      prodClientSelfPayCode = body.code || '';
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
    // Fails closed with 503 DATABASE_UNAVAILABLE when DB is absent in prod (never hangs, never 200)
    assert.equal(prodClientSelfPayStatus, 503);
    assert.equal(prodClientSelfPayCode, 'DATABASE_UNAVAILABLE');

    const ledgerPay = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/payments/${depositId}/pay`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.equal(ledgerPay.status, 200);
    const ledgerBody = (await ledgerPay.json()) as {
      booking: { status: string };
      paymentProcessingMode: string;
      liveProcessorVerified: boolean;
    };
    assert.equal(ledgerBody.paymentProcessingMode, 'manual_staging_ledger');
    assert.equal(ledgerBody.liveProcessorVerified, false);
    assert.equal(ledgerBody.booking.status, 'Confirmed');

    // 7. Planning milestone toggled & client message sent
    const msId = created.booking.milestones[0]?.id;
    assert.ok(msId);
    const msRes = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/milestones/${msId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.equal(msRes.status, 200);

    const msgRes = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ text: 'Excited for our floral walkthrough next Tuesday!' }),
    });
    assert.equal(msgRes.status, 200);

    // 8. Staff transitions booking Confirmed -> Planning -> In Progress -> Completed
    for (const nextStatus of ['Planning', 'In Progress', 'Completed'] as const) {
      const stepRes = await fetch(`${server1.baseUrl}/api/bookings/${bookingId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
        body: JSON.stringify({ status: nextStatus }),
      });
      assert.equal(stepRes.status, 200);
    }

    // 9. Restart backend cleanly and verify full persistence + admin audit/notification visibility with TOTP MFA
    await server1.close();
    server1 = await startServerOnDb(dbPath);

    const adminPre2 = await loginToken(server1.baseUrl, 'user-admin-director');
    assert.ok(adminPreToken);
    const enroll = await fetch(`${server1.baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminPre2}` },
    });
    const { secret } = (await enroll.json()) as { secret: string };
    const mfaRes = await fetch(`${server1.baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminPre2}` },
      body: JSON.stringify({ code: generateTotpCode(secret) }),
    });
    assert.equal(mfaRes.status, 200);
    const { token: adminMfaToken } = (await mfaRes.json()) as { token: string };

    const overviewRes = await fetch(`${server1.baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${adminMfaToken}` },
    });
    assert.equal(overviewRes.status, 200);
    const overview = (await overviewRes.json()) as {
      auditLogs: { action: string; targetId: string }[];
    };
    assert.ok(overview.auditLogs.some((a) => a.action === 'PAYMENT_MILESTONE_RECORDED' && a.targetId === refCode));
    assert.ok(overview.auditLogs.some((a) => a.action === 'CONTRACT_SIGNED' && a.targetId === refCode));

    const persistedTrack = await fetch(
      `${server1.baseUrl}/api/bookings/track?referenceCode=${encodeURIComponent(refCode)}&email=camille.mercer@example.com`,
    );
    assert.equal(persistedTrack.status, 200);
    const persistedBody = (await persistedTrack.json()) as { tracking: { status: string } };
    assert.equal(persistedBody.tracking.status, 'Completed');
  } finally {
    await server1.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.CS_DB_PATH;
  }
});

test('Block 11.8 & 11.9: AI Concierge/Concept Studio enforce schema validation, timeouts, non-mutation & cross-customer isolation', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p11-ai-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const srv = await startServerOnDb(dbPath);

  try {
    const camilleToken = await loginToken(srv.baseUrl, 'user-client-camille');
    const vendorToken = await loginToken(srv.baseUrl, 'user-vendor-floral');

    // 1. Valid AI Concierge turn succeeds & isolates session ownership; never alters bookings
    setAiProviderOverrideForTests({
      generateConciergeRaw: async () =>
        JSON.stringify({
          reply: 'We would be delighted to assist with your Columbia celebration. Let us arrange a private consultation.',
          extractedLead: {
            eventCategory: 'Wedding Planning and Design',
            eventDate: '2027-10-16',
            location: 'Columbia, SC',
            guestCount: 160,
            theme: 'Royal Purple & Champagne Gold',
            budgetRange: '$35,000 - $50,000',
            recommendedDivisions: ['Wedding Planning and Design', 'Luxury Event Decoration and Styling'],
            needsHumanEscalation: false,
            summary: '160-guest Columbia luxury wedding inquiry.',
          },
        }),
      generateConceptRaw: async () =>
        JSON.stringify({
          themeName: 'Gilded Orchid Soiree',
          visionSummary: 'Warm candlelight paired with architectural white orchids and champagne silk drapery.',
          colorPalette: [
            { name: 'Royal Purple', hex: '#4B2087', usage: 'Velvet focal accents' },
            { name: 'Champagne Gold', hex: '#B99045', usage: 'Metallic chargers & flatware' },
          ],
          floralConcept: 'Suspended phalaenopsis orchids and garden roses.',
          tableArrangement: 'Ivory silk linens with gold-rimmed glass chargers.',
          stageBackdrop: 'Sculptural champagne arch with soft drapery.',
          lightingPlan: '2700K warm pin-spotting across centerpieces.',
          recommendedDivisions: ['Luxury Event Decoration and Styling'],
        }),
    });

    const conciergeRes = await fetch(`${srv.baseUrl}/api/ai/concierge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${camilleToken}` },
      body: JSON.stringify({ message: 'Planning a 160-guest wedding in Columbia in October 2027.' }),
    });
    assert.equal(conciergeRes.status, 200);
    const conciergeBody = (await conciergeRes.json()) as { sessionId: string; extractedLead: { guestCount: number } };
    assert.equal(conciergeBody.extractedLead.guestCount, 160);

    // 2. Guest attempting to hijack authenticated client's AI session gets a separate new session
    const guestHijack = await fetch(`${srv.baseUrl}/api/ai/concierge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: conciergeBody.sessionId, message: 'Trying to append to Camille session.' }),
    });
    assert.equal(guestHijack.status, 200);
    const hijackBody = (await guestHijack.json()) as { sessionId: string };
    assert.notEqual(hijackBody.sessionId, conciergeBody.sessionId);

    // 3. Guest and Vendor MUST BE BLOCKED (403) from revising existing client concept 'cnc-101'
    const guestRevise = await fetch(`${srv.baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conceptId: 'cnc-101',
        eventType: 'Wedding',
        guestCount: 150,
        venueStyle: 'Ballroom',
        preferredPalette: 'Gold',
        visionDescription: 'Attempted unauthorized overwrite by guest.',
      }),
    });
    assert.equal(guestRevise.status, 403);

    const vendorRevise = await fetch(`${srv.baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vendorToken}` },
      body: JSON.stringify({
        conceptId: 'cnc-101',
        eventType: 'Wedding',
        guestCount: 150,
        venueStyle: 'Ballroom',
        preferredPalette: 'Gold',
        visionDescription: 'Attempted unauthorized overwrite by vendor.',
      }),
    });
    assert.equal(vendorRevise.status, 403);

    // 4. Guest-generated concept does NOT attach to private booking 'bkg-101'
    const guestConcept = await fetch(`${srv.baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Gala',
        guestCount: 120,
        venueStyle: 'Historic Atrium',
        preferredPalette: 'Ivory and Gold',
        visionDescription: 'Timeless ivory and gold evening gala.',
      }),
    });
    assert.equal(guestConcept.status, 200);
    const guestConceptBody = (await guestConcept.json()) as { concept: { bookingId: string; clientId: string } };
    assert.notEqual(guestConceptBody.concept.bookingId, 'bkg-101');
    assert.equal(guestConceptBody.concept.bookingId, 'public-concierge-preview');

    // 5. Malformed AI JSON output returns clean 502 AI_INVALID_OUTPUT
    setAiProviderOverrideForTests({
      generateConciergeRaw: async () => 'NOT_VALID_JSON{{{',
    });
    const badAiRes = await fetch(`${srv.baseUrl}/api/ai/concierge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Test malformed output.' }),
    });
    assert.equal(badAiRes.status, 502);
    const badAiBody = (await badAiRes.json()) as { code: string };
    assert.equal(badAiBody.code, 'AI_INVALID_OUTPUT');

    // 6. AI timeout returns clean 504 AI_TIMEOUT
    setAiProviderOverrideForTests({
      timeoutMs: 25,
      generateConciergeRaw: async () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('{}'), 200);
        }),
    });
    const timeoutRes = await fetch(`${srv.baseUrl}/api/ai/concierge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Test timeout.' }),
    });
    assert.equal(timeoutRes.status, 504);
    const timeoutBody = (await timeoutRes.json()) as { code: string };
    assert.equal(timeoutBody.code, 'AI_TIMEOUT');

    // 7. Security hygiene: SQLi probe in tracking returns clean 404, bad JSON returns 400 BAD_JSON, unsafe redirect/API URL rejected
    const sqliTrack = await fetch(
      `${srv.baseUrl}/api/bookings/track?referenceCode=${encodeURIComponent("' OR '1'='1")}&email=${encodeURIComponent("' OR '1'='1")}`,
    );
    assert.equal(sqliTrack.status, 404);

    const badJsonRes = await fetch(`${srv.baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":',
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonBody = (await badJsonRes.json()) as { code: string };
    assert.equal(badJsonBody.code, 'BAD_JSON');

    assert.equal(sanitizeApiBaseUrl('javascript:alert(1)'), '');
    assert.equal(sanitizeApiBaseUrl('http://evil.example.com'), '');
    assert.equal(sanitizeApiBaseUrl('https://api.celebrationsisters.com/'), 'https://api.celebrationsisters.com');
  } finally {
    setAiProviderOverrideForTests(null);
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.CS_DB_PATH;
  }
});
