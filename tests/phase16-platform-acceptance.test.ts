import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { QueryResult, QueryResultRow } from 'pg';
import { createApp } from '../server/app.ts';
import { getStaffNotificationRecipient } from '../server/notifications.ts';
import { logStructured } from '../server/observability.ts';
import { NotificationOutboxWorker } from '../server/outbox.ts';
import type { PgClientLike } from '../server/repositories/postgresRepository.ts';
import {
  computeConsultationAvailability,
  validateRequestedConsultationSlot,
  STUDIO_TIMEZONE,
} from '../server/scheduling.ts';
import { readDb, withTransaction } from '../server/store.ts';
import { generateTotpCode } from '../server/totp.ts';
import { runMigrationsOnClient } from '../scripts/run-migrations.ts';

function signSvix(rawBody: string, svixId: string, svixTimestamp: string, webhookSecret: string): string {
  const clean = webhookSecret.startsWith('whsec_') ? webhookSecret.slice('whsec_'.length) : webhookSecret;
  const key = Buffer.from(clean, 'base64');
  const sig = crypto
    .createHmac('sha256', key)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`, 'utf8')
    .digest('base64');
  return `v1,${sig}`;
}

function futureIsoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

describe('Phase 16 — Platform Integration, Concurrency, CRM, Observability & Migration Acceptance', () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;
  let adminBearer: string;
  let clientBearer: string;
  let vendorBearer: string;
  const webhookSecret = `whsec_${Buffer.from('phase16-test-webhook-signing-key-32b').toString('base64')}`;

  async function issuePersonaBearer(userId: string, withAdminMfa = false): Promise<string> {
    const sw = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ userId }),
    });
    assert.equal(sw.status, 200);
    const { token } = (await sw.json()) as { token: string };
    if (!withAdminMfa) return token;

    const enroll = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(enroll.status, 200);
    const { secret } = (await enroll.json()) as { secret: string };
    const verify = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: generateTotpCode(secret) }),
    });
    assert.equal(verify.status, 200);
    const verified = (await verify.json()) as { token: string };
    return verified.token;
  }

  async function fetchDistinctAvailableSlots(count: number): Promise<Array<{ startUtc: string; plannerId: string }>> {
    const res = await fetch(
      `${baseUrl}/api/consultations/availability?startDate=${futureIsoDate(5)}&days=21&timezone=America/New_York&method=video`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      days: Array<{ slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
    };
    const slots = body.days
      .flatMap((d) => d.slots)
      .filter((s) => s.available);
    assert.ok(slots.length >= count, `Expected at least ${count} available slots, found ${slots.length}`);
    return slots.slice(0, count);
  }

  function makeConsultationPayload(
    slot: { startUtc: string; plannerId: string },
    index: number,
  ): Record<string, unknown> {
    return {
      clientName: `Phase16 Client ${index}`,
      clientEmail: `phase16.client.${index}@example.com`,
      clientPhone: `(803) 555-01${String(index % 90 + 10)}`,
      preferredContactMethod: 'email',
      eventType: 'Luxury Wedding',
      eventTitle: `Phase16 Estate Celebration #${index}`,
      eventTheme: 'Champagne Velvet & Amethyst Candlelight',
      serviceDivisionIds: ['div-event-decor'],
      eventDate: futureIsoDate(100 + index),
      venueName: 'Lace House Gardens',
      location: 'Columbia, SC',
      guestCount: 180,
      budgetRange: '$50,000 - $100,000',
      consultationMethod: 'video',
      consultationStartUtc: slot.startUtc,
      plannerId: slot.plannerId,
      clientTimezone: 'America/New_York',
      privacyConsentAccepted: true,
    };
  }

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-phase16-'));
    process.env.CS_DB_PATH = path.join(tmpDir, 'phase16-db.json');
    process.env.PERSISTENCE_ADAPTER = 'json-local';
    process.env.ALLOW_DEMO_AUTH = 'true';
    process.env.EMAIL_LIVE_DELIVERY_ENABLED = 'false';
    process.env.RESEND_WEBHOOK_SECRET = webhookSecret;
    process.env.ALLOWED_ORIGINS = 'https://celebrationsistersdecor.com,http://127.0.0.1:3000';
    process.env.SUPPRESS_STRUCTURED_LOGS = 'true';

    const app = createApp({ enableRateLimit: false });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    adminBearer = await issuePersonaBearer('user-admin-director', true);
    clientBearer = await issuePersonaBearer('user-client-camille', false);
    vendorBearer = await issuePersonaBearer('user-vendor-floral', false);
  });

  after(async () => {
    delete process.env.SUPPRESS_STRUCTURED_LOGS;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. BOOKING ENGINE CONCURRENCY (2, 3, 10, 25 SIMULTANEOUS REQUESTS)
  // =========================================================================
  describe('1. Booking Engine Concurrency, Idempotency & DST Correctness', () => {
    for (const concurrency of [2, 3, 10, 25]) {
      it(`enforces strictly 1 winner and ${concurrency - 1} HTTP 409 rejections under ${concurrency}-way simultaneous slot race`, async () => {
        const [slot] = await fetchDistinctAvailableSlots(1);
        const requests = Array.from({ length: concurrency }, (_, idx) =>
          fetch(`${baseUrl}/api/consultations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(makeConsultationPayload(slot, concurrency * 100 + idx)),
          }).then(async (res) => ({ status: res.status, body: await res.json() })),
        );

        const outcomes = await Promise.all(requests);
        const winners = outcomes.filter((o) => o.status === 201);
        const conflicts = outcomes.filter((o) => o.status === 409);

        assert.equal(winners.length, 1, `Expected strictly 1 winner in ${concurrency}-way race`);
        assert.equal(conflicts.length, concurrency - 1, `Expected ${concurrency - 1} conflicts`);

        const db = await readDb();
        const matchingActive = db.consultations.filter(
          (c) =>
            c.assignedPlannerId === slot.plannerId &&
            c.startUtc === slot.startUtc &&
            !['Cancelled', 'No-show'].includes(c.status),
        );
        assert.equal(matchingActive.length, 1, 'Exactly one persisted active consultation for contended slot');

        const winnerRef = (winners[0].body as { consultation: { referenceCode: string } }).consultation.referenceCode;
        const winnerOutbox = db.notificationOutbox.filter((j) => j.bookingReference === winnerRef);
        assert.equal(winnerOutbox.length, 2, 'Winner must enqueue exactly client confirmation + staff alert');
      });
    }

    it('deduplicates concurrent Idempotency-Key retries without creating duplicate consultations', async () => {
      const [slot] = await fetchDistinctAvailableSlots(1);
      const idempotencyKey = `idem-phase16-${crypto.randomUUID()}`;
      const payload = makeConsultationPayload(slot, 9001);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          fetch(`${baseUrl}/api/consultations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify(payload),
          }).then(async (r) => ({ status: r.status, body: (await r.json()) as { consultation?: { id: string } } })),
        ),
      );

      const created = responses.filter((r) => r.status === 201);
      const deduplicated = responses.filter((r) => r.status === 200);
      assert.equal(created.length, 1);
      assert.equal(deduplicated.length, 4);

      const uniqueIds = new Set(responses.map((r) => r.body.consultation?.id));
      assert.equal(uniqueIds.size, 1, 'All retries must return the exact same consultation ID');
    });

    it('computes consistent UTC conversions and slot validation across US DST spring-forward and fall-back transitions', async () => {
      const db = await readDb();
      // 2027-03-14 is US DST spring-forward (EDT starts); 2027-11-07 is US DST fall-back (EST resumes)
      for (const transitionDate of ['2027-03-15', '2027-11-08']) {
        const days = computeConsultationAvailability({
          startDate: transitionDate,
          days: 3,
          clientTimezone: 'America/Los_Angeles',
          method: 'video',
          rules: db.staffAvailabilityRules,
          blackoutDates: [],
          consultations: [],
          slotHolds: [],
          users: db.users,
          nowMs: new Date(`${transitionDate}T00:00:00Z`).getTime() - 24 * 60 * 60_000,
        });
        const availableSlots = days.flatMap((d) => d.slots).filter((s) => s.available);
        assert.ok(availableSlots.length > 0, `Expected open slots around DST date ${transitionDate}`);
        for (const slot of availableSlots.slice(0, 6)) {
          const check = validateRequestedConsultationSlot({
            plannerId: slot.plannerId,
            startUtc: slot.startUtc,
            method: 'video',
            rules: db.staffAvailabilityRules,
            blackoutDates: [],
            consultations: [],
            slotHolds: [],
            nowMs: new Date(`${transitionDate}T00:00:00Z`).getTime() - 24 * 60 * 60_000,
          });
          assert.equal(check.valid, true, `Slot ${slot.startUtc} around ${transitionDate} (${STUDIO_TIMEZONE}) must validate`);
        }
      }
    });

    it('reclaims expired Claimed outbox lease after simulated worker crash/restart', async () => {
      const staleJobId = `job-stale-${crypto.randomUUID().slice(0, 8)}`;
      const pastIso = new Date(Date.now() - 10 * 60_000).toISOString();
      await withTransaction((db) => {
        db.notificationOutbox.unshift({
          id: staleJobId,
          idempotencyKey: `stale-recovery:${staleJobId}`,
          category: 'consultation_confirmation',
          channel: 'Email',
          recipient: 'recovery@example.com',
          bookingReference: 'CS-2026-RECOV',
          subject: 'Crash recovery verification',
          htmlBody: '<p>Recovery check</p>',
          textBody: 'Recovery check',
          status: 'Claimed',
          attempts: 1,
          maxAttempts: 5,
          nextAttemptAt: pastIso,
          claimedBy: 'crashed-worker-pid-999',
          claimedAt: pastIso,
          createdAt: pastIso,
          updatedAt: pastIso,
        });
      });

      const worker = new NotificationOutboxWorker({
        workerId: 'restarted-worker-01',
        batchSize: 20,
      });
      const summary = await worker.processOnce();
      assert.ok(summary.claimed >= 1, 'Restarted worker must reclaim expired Claimed lease');

      const db = await readDb();
      const job = db.notificationOutbox.find((j) => j.id === staleJobId);
      assert.ok(job);
      assert.notEqual(job.status, 'Claimed', 'Reclaimed job must exit stale Claimed state');
    });
  });

  // =========================================================================
  // 2. SPLIT-ORIGIN CORS & RESEND SINGLE-SOURCE-OF-TRUTH CONFIG
  // =========================================================================
  describe('2. Split-Origin CORS & Resend Runtime Configuration Hygiene', () => {
    it('allows X-Consultation-Token in CORS preflight for celebrationsistersdecor.com and rejects untrusted origins', async () => {
      const allowedPreflight = await fetch(`${baseUrl}/api/consultations/status`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://celebrationsistersdecor.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'X-Consultation-Token, Content-Type',
        },
      });
      assert.equal(allowedPreflight.status, 204);
      assert.equal(
        allowedPreflight.headers.get('access-control-allow-origin'),
        'https://celebrationsistersdecor.com',
      );
      const allowHeaders = allowedPreflight.headers.get('access-control-allow-headers') || '';
      assert.match(allowHeaders, /X-Consultation-Token/i);

      const blockedPreflight = await fetch(`${baseUrl}/api/consultations/status`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil-phishing.example.net',
          'Access-Control-Request-Method': 'GET',
        },
      });
      assert.equal(blockedPreflight.status, 403);
    });

    it('has zero direct process.env email config reads outside server/notifications.ts', async () => {
      const serverDir = path.resolve(process.cwd(), 'server');
      const entries = await fs.readdir(serverDir, { recursive: true });
      const offending: string[] = [];
      const envPattern =
        /process\.env\.(RESEND_API_KEY|EMAIL_FROM|EMAIL_LIVE_DELIVERY_ENABLED|RESEND_WEBHOOK_SECRET|STAFF_NOTIFICATION_EMAIL)/;

      for (const rel of entries) {
        if (!rel.endsWith('.ts') || rel === 'notifications.ts') continue;
        const content = await fs.readFile(path.join(serverDir, rel), 'utf8');
        if (envPattern.test(content)) {
          offending.push(rel);
        }
      }
      assert.deepEqual(offending, [], `Unexpected direct email env reads outside server/notifications.ts: ${offending.join(', ')}`);
      assert.equal(
        getStaffNotificationRecipient({ STAFF_NOTIFICATION_EMAIL: 'concierge@celebrationsistersdecor.com' }),
        'concierge@celebrationsistersdecor.com',
      );
      assert.equal(getStaffNotificationRecipient({}), 'directors@celebrationsisters.example.com');
    });
  });

  // =========================================================================
  // 3. CRM 8-STAGE LIFECYCLE, PROPOSAL HANDOFF & RBAC ISOLATION
  // =========================================================================
  describe('3. Full CRM Conversion Pipeline, Itemized Proposal & RBAC Enforcement', () => {
    it('executes full consultation -> confirm -> reassign -> complete -> itemized proposal -> Event Booked conversion and rejects unauthorized roles', async () => {
      const freshAvailRes = await fetch(
        `${baseUrl}/api/consultations/availability?startDate=${futureIsoDate(18)}&days=7&timezone=America/New_York&method=video`,
      );
      assert.equal(freshAvailRes.status, 200);
      const freshBody = (await freshAvailRes.json()) as {
        days: Array<{ slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
      };
      const slot = freshBody.days.flatMap((d) => d.slots).find((s) => s.available);
      assert.ok(slot, 'Expected available slot 18 days ahead');
      const createRes = await fetch(`${baseUrl}/api/consultations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeConsultationPayload(slot, 777)),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as {
        consultation: { id: string; referenceCode: string; assignedPlannerId: string };
      };
      const consultationId = created.consultation.id;

      // Unauthorized roles must be blocked (requireAdminWithMfa -> 403; requireRoles -> 401 for guest, 403 for client/vendor)
      for (const [label, headers, expectedAssignStatus] of [
        ['guest', {}, 401],
        ['client', { Authorization: `Bearer ${clientBearer}` }, 403],
        ['vendor', { Authorization: `Bearer ${vendorBearer}` }, 403],
      ] as const) {
        const denyAdmin = await fetch(`${baseUrl}/api/admin/metrics`, { headers });
        assert.equal(denyAdmin.status, 403, `${label} must receive 403 on /api/admin/metrics`);

        const denyAssign = await fetch(`${baseUrl}/api/consultations/${consultationId}/assign`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ plannerId: 'user-staff-maya' }),
        });
        assert.equal(denyAssign.status, expectedAssignStatus, `${label} must receive ${expectedAssignStatus} on planner assign`);
      }

      // Admin confirms appointment
      const confirmRes = await fetch(`${baseUrl}/api/consultations/${consultationId}/confirm`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminBearer}` },
      });
      assert.equal(confirmRes.status, 200);

      // Reassign planner (pick alternate active planner)
      const targetPlannerId =
        created.consultation.assignedPlannerId === 'user-staff-maya'
          ? 'user-admin-director'
          : 'user-staff-maya';
      const assignRes = await fetch(`${baseUrl}/api/consultations/${consultationId}/assign`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
        body: JSON.stringify({ plannerId: targetPlannerId }),
      });
      assert.equal(assignRes.status, 200);
      const assignedJson = (await assignRes.json()) as { consultation: { assignedPlannerId: string } };
      assert.equal(assignedJson.consultation.assignedPlannerId, targetPlannerId);

      // Complete consultation + auto follow-up task
      const completeRes = await fetch(`${baseUrl}/api/consultations/${consultationId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
        body: JSON.stringify({
          status: 'Completed',
          outcomeSummary: 'Client approved gold floral archway and champagne drapery concept.',
          followUpTitle: 'Send itemized floral & lighting proposal',
          followUpDueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        }),
      });
      assert.equal(completeRes.status, 200);
      const completedJson = (await completeRes.json()) as {
        consultation: { status: string; crmStage: string };
        followUpTask?: { id: string; title: string };
      };
      assert.equal(completedJson.consultation.status, 'Completed');
      assert.equal(completedJson.consultation.crmStage, 'Consultation Completed');
      assert.ok(completedJson.followUpTask?.id);

      // Reject excessive discount > subtotal
      const badDiscountRes = await fetch(`${baseUrl}/api/consultations/${consultationId}/proposal-handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
        body: JSON.stringify({
          lineItems: [{ description: 'Floral Archway', quantity: 1, unitPriceCents: 100_000 }],
          discountCents: 200_000,
        }),
      });
      assert.equal(badDiscountRes.status, 400);

      // Issue valid itemized proposal (exact integer-cent calculation)
      const proposalRes = await fetch(`${baseUrl}/api/consultations/${consultationId}/proposal-handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
        body: JSON.stringify({
          lineItems: [
            { description: 'Grand Ballroom Floral Architecture', quantity: 1, unitPriceCents: 1_250_000 },
            { description: 'Custom Velvet Linens & Charger Plates', quantity: 15, unitPriceCents: 25_000 },
          ],
          discountCents: 50_000,
          notes: 'Includes setup, on-site styling, and midnight strike.',
          markAsSent: true,
        }),
      });
      assert.equal(proposalRes.status, 201);
      const proposalJson = (await proposalRes.json()) as {
        consultation: { crmStage: string };
        amountsCents: { subtotalCents: number; discountCents: number; totalCents: number };
      };
      assert.equal(proposalJson.consultation.crmStage, 'Proposal Sent');
      assert.equal(proposalJson.amountsCents.subtotalCents, 1_625_000);
      assert.equal(proposalJson.amountsCents.discountCents, 50_000);
      assert.equal(proposalJson.amountsCents.totalCents, 1_575_000);

      // Record client approval -> Event Booked
      const decisionRes = await fetch(`${baseUrl}/api/consultations/${consultationId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
        body: JSON.stringify({
          decision: 'Approved',
          notes: 'Signed proposal and requested retainer invoice.',
        }),
      });
      assert.equal(decisionRes.status, 200);
      const decisionJson = (await decisionRes.json()) as { consultation: { crmStage: string } };
      assert.equal(decisionJson.consultation.crmStage, 'Event Booked');
    });
  });

  // =========================================================================
  // 4. OBSERVABILITY, REQUEST CORRELATION & SECRET REDACTION
  // =========================================================================
  describe('4. Operational Observability, Request Correlation & Log Redaction', () => {
    it('returns X-Request-Id headers and records booking, webhook, and auth security counters in /api/admin/metrics', async () => {
      // Trigger invalid consultation token -> increments auth.invalidConsultationToken403
      const badTokenRes = await fetch(
        `${baseUrl}/api/consultations/status?referenceCode=CS-2099-0000`,
        { headers: { 'X-Consultation-Token': 'csa_invalid_probe' } },
      );
      assert.equal(badTokenRes.status, 403);
      assert.ok(badTokenRes.headers.get('x-request-id'), 'Error response must carry X-Request-Id header');

      // Trigger invalid webhook signature -> increments webhooks.rejectedSignature
      const badWebhookRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': 'msg_bad_sig',
          'svix-timestamp': String(Math.floor(Date.now() / 1000)),
          'svix-signature': 'v1,invalidSignature',
        },
        body: JSON.stringify({ type: 'email.delivered', data: { email_id: 're_none' } }),
      });
      assert.equal(badWebhookRes.status, 401);

      // Trigger valid signed webhook -> increments webhooks.received
      const validBody = JSON.stringify({ type: 'email.delivered', data: { email_id: 're_phase16_probe' } });
      const ts = String(Math.floor(Date.now() / 1000));
      const svixId = `msg_phase16_${crypto.randomUUID().slice(0, 8)}`;
      const validWebhookRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': ts,
          'svix-signature': signSvix(validBody, svixId, ts, webhookSecret),
        },
        body: validBody,
      });
      assert.equal(validWebhookRes.status, 200);

      // Duplicate delivery of same svix-id -> increments webhooks.deduplicated
      const dupWebhookRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': ts,
          'svix-signature': signSvix(validBody, svixId, ts, webhookSecret),
        },
        body: validBody,
      });
      assert.equal(dupWebhookRes.status, 200);
      const dupBody = (await dupWebhookRes.json()) as { deduplicated: boolean };
      assert.equal(dupBody.deduplicated, true);

      const metricsRes = await fetch(`${baseUrl}/api/admin/metrics`, {
        headers: { Authorization: `Bearer ${adminBearer}` },
      });
      assert.equal(metricsRes.status, 200);
      assert.ok(metricsRes.headers.get('x-request-id'));
      const { metrics } = (await metricsRes.json()) as {
        metrics: {
          bookings: { attempts: number; succeeded: number; failed: number };
          webhooks: { received: number; deduplicated: number; rejectedSignature: number };
          auth: { unauthorized401: number; forbidden403: number; invalidConsultationToken403: number };
        };
      };

      assert.ok(metrics.bookings.succeeded >= 1);
      assert.ok(metrics.bookings.failed >= 1);
      assert.ok(metrics.webhooks.rejectedSignature >= 1);
      assert.ok(metrics.webhooks.received >= 1);
      assert.ok(metrics.webhooks.deduplicated >= 1);
      assert.ok(metrics.auth.unauthorized401 >= 1);
      assert.ok(metrics.auth.forbidden403 >= 1);
      assert.ok(metrics.auth.invalidConsultationToken403 >= 1);

      // Verify structured log redaction strips credentials & emails
      const redacted = logStructured('info', 'phase16_redaction_probe', {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret.sig',
        clientEmail: 'vip@example.com',
        dsn: 'postgresql://user:supersecret@db.example.internal:5432/app',
        safeReference: 'CS-2026-0100',
      });
      assert.doesNotMatch(redacted, /supersecret|vip@example\.com|eyJhbGci/);
      assert.match(redacted, /CS-2026-0100/);
    });
  });

  // =========================================================================
  // 5. POSTGRESQL MIGRATION RUNNER (TRANSACTIONAL, IDEMPOTENT & DRIFT-SAFE)
  // =========================================================================
  describe('5. Ordered PostgreSQL Migration Runner Verification', () => {
    function createMockMigrationClient(failOnSubstring?: string) {
      const applied = new Map<string, string>();
      const txLog: string[] = [];
      let pendingVersion: string | null = null;
      let pendingChecksum: string | null = null;

      const client: PgClientLike = {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: unknown[],
        ): Promise<QueryResult<T>> {
          const trimmed = text.trim();
          if (trimmed === 'BEGIN') {
            txLog.push('BEGIN');
            pendingVersion = null;
            pendingChecksum = null;
            return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
          }
          if (trimmed === 'COMMIT') {
            txLog.push('COMMIT');
            if (pendingVersion && pendingChecksum) {
              applied.set(pendingVersion, pendingChecksum);
            }
            return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
          }
          if (trimmed === 'ROLLBACK') {
            txLog.push('ROLLBACK');
            pendingVersion = null;
            pendingChecksum = null;
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }
          if (trimmed.startsWith('SELECT version, checksum_sha256 FROM public.schema_migrations')) {
            const rows = Array.from(applied.entries()).map(([version, checksum_sha256]) => ({
              version,
              checksum_sha256,
            }));
            return { rows: rows as unknown as T[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
          }
          if (trimmed.startsWith('INSERT INTO public.schema_migrations')) {
            pendingVersion = String(values?.[0] ?? '');
            pendingChecksum = String(values?.[1] ?? '');
            return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }
          if (failOnSubstring && trimmed.includes(failOnSubstring)) {
            throw new Error('simulated_sql_error');
          }
          return { rows: [], rowCount: 0, command: 'OK', oid: 0, fields: [] };
        },
        release() {},
      };

      return { client, applied, txLog };
    }

    it('applies all 8 migrations sequentially inside transactions and skips cleanly on idempotent rerun', async () => {
      const { client, applied } = createMockMigrationClient();

      const dryRun = await runMigrationsOnClient(client, { dryRun: true });
      assert.equal(dryRun.totalFiles, 8);
      assert.equal(dryRun.pending.length, 8);
      assert.equal(dryRun.applied.length, 0);

      const firstRun = await runMigrationsOnClient(client, { dryRun: false });
      assert.equal(firstRun.applied.length, 8);
      assert.equal(firstRun.skipped.length, 0);
      assert.equal(applied.size, 8);

      const secondRun = await runMigrationsOnClient(client, { dryRun: false });
      assert.equal(secondRun.applied.length, 0);
      assert.equal(secondRun.skipped.length, 8);
    });

    it('rolls back failed migration transaction cleanly and detects checksum tampering', async () => {
      const { client, txLog } = createMockMigrationClient('notification_webhook_events');
      await assert.rejects(
        () => runMigrationsOnClient(client, { dryRun: false }),
        /MIGRATION_FAILED \(008_phase15_token_lifecycle_and_webhook_audit\.sql\)/,
      );
      assert.equal(txLog[txLog.length - 1], 'ROLLBACK');

      // Checksum mismatch detection
      const tamper = createMockMigrationClient();
      tamper.applied.set('001_initial_schema', 'deadbeef00000000000000000000000000000000000000000000000000000000');
      await assert.rejects(
        () => runMigrationsOnClient(tamper.client, { dryRun: false }),
        /MIGRATION_CHECKSUM_MISMATCH/,
      );
    });
  });
});
