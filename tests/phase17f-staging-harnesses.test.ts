import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertStagingSafetyGuard } from '../scripts/verify-staging-postgres.ts';
import { verifyStagingRailwayAndResend } from '../scripts/verify-staging-railway-and-resend.ts';
import { createApp } from '../server/app.ts';
import { classifyDatabaseError } from '../server/lib/pgErrorClassifier.ts';

function futureIsoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

describe('Phase 17F — SQLSTATE Error Classification, Staging Harnesses & Concurrency Edge Cases', () => {
  it('classifies PostgreSQL SQLSTATE 23P01/23505/40001 -> 409, 42501 -> 403, and 08006/57P01 -> 503 with zero PII leakage', () => {
    const excl = classifyDatabaseError({
      code: '23P01',
      message: 'conflicting key value violates exclusion constraint "consultations_no_overlapping_active_slot" (client@secret.com)',
    });
    assert.equal(excl?.httpStatus, 409);
    assert.equal(excl?.code, 'SLOT_CONFLICT');
    assert.equal(excl?.message.includes('client@secret.com'), false);
    assert.equal(excl?.message.includes('consultations_no_overlapping_active_slot'), false);

    const unique = classifyDatabaseError({ code: '23505', message: 'duplicate key value' });
    assert.equal(unique?.httpStatus, 409);

    const serial = classifyDatabaseError({ code: '40001', message: 'could not serialize access' });
    assert.equal(serial?.httpStatus, 409);

    const rlsDeny = classifyDatabaseError({
      code: '42501',
      message: 'new row violates row-level security policy for table "consultations"',
    });
    assert.equal(rlsDeny?.httpStatus, 403);
    assert.equal(rlsDeny?.code, 'FORBIDDEN');
    assert.equal(rlsDeny?.message.includes('consultations'), false);

    const dropConn = classifyDatabaseError({ code: '08006', message: 'connection failure' });
    assert.equal(dropConn?.httpStatus, 503);
    assert.equal(dropConn?.code, 'DATABASE_UNAVAILABLE');

    const unknown = classifyDatabaseError(new Error('unexpected runtime failure'));
    assert.equal(unknown, null);
  });

  it('enforces STAGING_DB_CONFIRM and rejects production-labeled DATABASE_URL in assertStagingSafetyGuard', () => {
    assert.throws(
      () => assertStagingSafetyGuard({ DATABASE_URL: 'postgresql://user:pass@staging.railway.internal:5432/staging' }),
      /SAFETY_GUARD/,
    );
    assert.throws(
      () =>
        assertStagingSafetyGuard({
          STAGING_DB_CONFIRM: 'YES_ISOLATED_STAGING',
          DATABASE_URL: 'postgresql://user:pass@prod-db.railway.internal:5432/production',
        }),
      /production database/i,
    );
    const ok = assertStagingSafetyGuard({
      STAGING_DB_CONFIRM: 'YES_ISOLATED_STAGING',
      DATABASE_URL: 'postgresql://user:pass@staging-pg.railway.internal:5432/cs_staging',
    });
    assert.ok(ok.databaseUrl.includes('staging-pg'));
  });

  it('executes verifyStagingRailwayAndResend end-to-end against a live Express server with signed Svix webhooks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p17f-verifier-'));
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
      const report = await verifyStagingRailwayAndResend({
        apiBaseUrl: `http://127.0.0.1:${addr.port}`,
        frontendOrigin: 'https://celebrationsistersdecor.com',
        testRecipientEmail: 'qa-staging@example.com',
        resendWebhookSecret: testSecret,
        requireHttps: false,
        requirePostgres: false,
      });
      assert.equal(report.ok, true, `Expected all staging verifier checks to pass: ${JSON.stringify(report.checks)}`);
      assert.equal(report.checks.length, 13);
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

  it('rejects rescheduling conflict onto an occupied slot (409) and allows booking after cancellation release', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p17f-resched-'));
    const prevDbPath = process.env.CS_DB_PATH;
    const prevAdapter = process.env.PERSISTENCE_ADAPTER;
    process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
    process.env.PERSISTENCE_ADAPTER = 'json-local';

    const app = createApp({ enableRateLimit: false });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const addr = server.address();
      assert.ok(typeof addr === 'object' && addr);
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const availRes = await fetch(
        `${baseUrl}/api/consultations/availability?startDate=${futureIsoDate(7)}&days=14&timezone=America/New_York&method=video`,
      );
      const avail = (await availRes.json()) as {
        days: Array<{ slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
      };
      const slots = avail.days.flatMap((d) => d.slots).filter((s) => s.available);
      assert.ok(slots.length >= 2);
      const slotA = slots[0];
      const slotB = slots.find((s) => s.plannerId === slotA.plannerId && s.startUtc !== slotA.startUtc) || slots[1];

      const makePayload = (slot: { startUtc: string; plannerId: string }, label: string) => ({
        clientName: `Client ${label}`,
        clientEmail: `client-${label.toLowerCase()}@example.com`,
        clientPhone: '(803) 555-0155',
        preferredContactMethod: 'email',
        eventType: 'Wedding',
        eventTitle: `Event ${label}`,
        serviceDivisionIds: ['div-event-decor'],
        eventDate: futureIsoDate(100),
        venueName: 'Lace House',
        location: 'Columbia, SC',
        guestCount: 110,
        budgetRange: '$25,000 - $50,000',
        consultationMethod: 'video',
        consultationStartUtc: slot.startUtc,
        plannerId: slot.plannerId,
        clientTimezone: 'America/New_York',
        privacyConsentAccepted: true,
      });

      const resA = await fetch(`${baseUrl}/api/consultations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makePayload(slotA, 'A')),
      });
      assert.equal(resA.status, 201);
      const bodyA = (await resA.json()) as { consultation: { id: string }; accessToken: string };

      const resB = await fetch(`${baseUrl}/api/consultations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makePayload(slotB, 'B')),
      });
      assert.equal(resB.status, 201);
      const bodyB = (await resB.json()) as { consultation: { id: string }; accessToken: string };

      // Attempt to reschedule B onto A's occupied slot -> must fail with 409 Conflict
      const conflictResched = await fetch(`${baseUrl}/api/consultations/${bodyB.consultation.id}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consultation-Token': bodyB.accessToken },
        body: JSON.stringify({ newStartUtc: slotA.startUtc, plannerId: slotA.plannerId }),
      });
      assert.equal(conflictResched.status, 409);

      // Cancel A -> immediately frees slotA -> B reschedules cleanly into slotA (200)
      const cancelA = await fetch(`${baseUrl}/api/consultations/${bodyA.consultation.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consultation-Token': bodyA.accessToken },
        body: JSON.stringify({ reason: 'Release for test' }),
      });
      assert.equal(cancelA.status, 200);

      const okResched = await fetch(`${baseUrl}/api/consultations/${bodyB.consultation.id}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consultation-Token': bodyB.accessToken },
        body: JSON.stringify({ newStartUtc: slotA.startUtc, plannerId: slotA.plannerId }),
      });
      assert.equal(okResched.status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
      if (prevDbPath === undefined) delete process.env.CS_DB_PATH;
      else process.env.CS_DB_PATH = prevDbPath;
      if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
      else process.env.PERSISTENCE_ADAPTER = prevAdapter;
    }
  });
});
