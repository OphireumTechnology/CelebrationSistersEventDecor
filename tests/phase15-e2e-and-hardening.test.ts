import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/app.ts';
import { verifyResendWebhookSignature } from '../server/notifications.ts';
import { NotificationOutboxWorker } from '../server/outbox.ts';
import {
  buildPostgresSslConfig,
  setInjectedPgPoolForTests,
} from '../server/repositories/postgresRepository.ts';
import {
  getStudioHolidayReason,
  validateConsultationTokenAccess,
} from '../server/scheduling.ts';
import { readDb, withTransaction } from '../server/store.ts';
import { generateTotpCode } from '../server/totp.ts';
import { AdminConsultationCommandCenter } from '../src/components/AdminConsultationCommandCenter.tsx';
import { ConsultationModal } from '../src/components/ConsultationModal.tsx';

function futureIsoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

async function startTestServer(dbPath: string, extraEnv?: Record<string, string | undefined>) {
  const prevEnv: Record<string, string | undefined> = {
    CS_DB_PATH: process.env.CS_DB_PATH,
    PERSISTENCE_ADAPTER: process.env.PERSISTENCE_ADAPTER,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_LIVE_DELIVERY_ENABLED: process.env.EMAIL_LIVE_DELIVERY_ENABLED,
  };
  process.env.CS_DB_PATH = dbPath;
  process.env.PERSISTENCE_ADAPTER = 'json-local';
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

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
      setInjectedPgPoolForTests(null);
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

async function loginAs(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ userId }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function loginAdminWithMfa(baseUrl: string): Promise<string> {
  const preToken = await loginAs(baseUrl, 'user-admin-director');
  const setupRes = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${preToken}` },
  });
  assert.equal(setupRes.status, 200);
  const setup = (await setupRes.json()) as { secret: string };
  const code = generateTotpCode(setup.secret);
  const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preToken}` },
    body: JSON.stringify({ code }),
  });
  assert.equal(verifyRes.status, 200);
  const verified = (await verifyRes.json()) as { token: string };
  return verified.token;
}

async function getAvailableSlots(baseUrl: string, method = 'video', days = 14) {
  const startDate = futureIsoDate(2);
  const res = await fetch(
    `${baseUrl}/api/consultations/availability?startDate=${startDate}&days=${days}&timezone=America/New_York&method=${method}`,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    days: Array<{
      date: string;
      isBlackout: boolean;
      blackoutReason?: string;
      availableCount: number;
      slots: Array<{
        slotId: string;
        plannerId: string;
        plannerName: string;
        startUtc: string;
        endUtc: string;
        available: boolean;
      }>;
    }>;
  };
  return body.days.flatMap((d) => d.slots.filter((s) => s.available));
}

function signSvixWebhook(secret: string, svixId: string, svixTimestamp: string, payload: string): string {
  const secretRaw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = Buffer.from(secretRaw, 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${svixId}.${svixTimestamp}.${payload}`).digest('base64');
  return `v1,${sig}`;
}

test('Block 15.5: PostgreSQL TLS CA certificate-chain verification against an isolated real TLS server', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p15-tls-'));
  try {
    const caKeyPath = path.join(tmpDir, 'ca.key');
    const caCertPath = path.join(tmpDir, 'ca.crt');
    const srvKeyPath = path.join(tmpDir, 'srv.key');
    const srvCsrPath = path.join(tmpDir, 'srv.csr');
    const srvCertPath = path.join(tmpDir, 'srv.crt');
    const extPath = path.join(tmpDir, 'san.ext');

    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKeyPath,
      '-out',
      caCertPath,
      '-days',
      '1',
      '-subj',
      '/CN=CelebrationSistersTestRootCA',
    ]);
    execFileSync('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      srvKeyPath,
      '-out',
      srvCsrPath,
      '-subj',
      '/CN=localhost',
    ]);
    await fs.writeFile(
      extPath,
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
      'utf8',
    );
    execFileSync('openssl', [
      'x509',
      '-req',
      '-in',
      srvCsrPath,
      '-CA',
      caCertPath,
      '-CAkey',
      caKeyPath,
      '-CAcreateserial',
      '-out',
      srvCertPath,
      '-days',
      '1',
      '-extfile',
      extPath,
    ]);

    const caPem = await fs.readFile(caCertPath, 'utf8');
    const srvKey = await fs.readFile(srvKeyPath, 'utf8');
    const srvCert = await fs.readFile(srvCertPath, 'utf8');

    const tlsServer = tls.createServer({ key: srvKey, cert: srvCert }, (socket) => {
      socket.end('OK');
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = tlsServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const connectWithSsl = (ssl: tls.ConnectionOptions) =>
      new Promise<string>((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port, ...ssl }, () => {
          let buf = '';
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => {
            buf += chunk;
          });
          socket.on('end', () => resolve(buf));
        });
        socket.on('error', reject);
      });

    try {
      const dbUrl = `postgres://cs_app:secret@localhost:${port}/cs_db?sslmode=verify-full`;

      // 1. Fail closed when custom CA is NOT configured
      const defaultCfg = buildPostgresSslConfig(dbUrl, { NODE_ENV: 'production' });
      assert.equal(defaultCfg.diagnostics.rejectUnauthorized, true);
      assert.equal(defaultCfg.sanitizedConnectionString.includes('sslmode='), false);
      await assert.rejects(
        () => connectWithSsl(defaultCfg.ssl!),
        (err: NodeJS.ErrnoException) =>
          Boolean(err.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(err.code)),
      );

      // 2. Succeed with DATABASE_CA_CERT (\n-escaped Railway style)
      const inlineEscaped = caPem.replace(/\r?\n/g, '\\n');
      const inlineCfg = buildPostgresSslConfig(dbUrl, {
        NODE_ENV: 'production',
        DATABASE_CA_CERT: inlineEscaped,
      });
      assert.equal(inlineCfg.diagnostics.caSource, 'DATABASE_CA_CERT');
      assert.equal(inlineCfg.diagnostics.rejectUnauthorized, true);
      assert.equal(await connectWithSsl(inlineCfg.ssl!), 'OK');

      // 3. Succeed with DATABASE_CA_CERT_BASE64
      const b64Cfg = buildPostgresSslConfig(dbUrl, {
        NODE_ENV: 'production',
        DATABASE_CA_CERT_BASE64: Buffer.from(caPem, 'utf8').toString('base64'),
      });
      assert.equal(b64Cfg.diagnostics.caSource, 'DATABASE_CA_CERT_BASE64');
      assert.equal(await connectWithSsl(b64Cfg.ssl!), 'OK');

      // 4. Succeed with PGSSLROOTCERT file path
      const fileCfg = buildPostgresSslConfig(dbUrl, {
        NODE_ENV: 'production',
        PGSSLROOTCERT: caCertPath,
      });
      assert.equal(fileCfg.diagnostics.caSource, 'PGSSLROOTCERT');
      assert.equal(await connectWithSsl(fileCfg.ssl!), 'OK');

      // 5. Reject unsafe TLS downgrades unconditionally
      assert.throws(
        () => buildPostgresSslConfig(dbUrl, { PG_SSL_REJECT_UNAUTHORIZED: 'false' }),
        /TLS_CONFIG_FAILURE/,
      );
      assert.throws(
        () => buildPostgresSslConfig(`postgres://cs_app:secret@db.example.com:5432/cs_db?sslmode=no-verify`, {}),
        /TLS_CONFIG_FAILURE/,
      );
      assert.throws(
        () =>
          buildPostgresSslConfig('postgres://cs_app:secret@db.example.com:5432/cs_db', {
            NODE_ENV: 'production',
            PGSSLMODE: 'disable',
          }),
        /TLS_CONFIG_FAILURE/,
      );

      // 6. Private Railway internal mesh supports explicit PGSSLMODE=disable but defaults to verify-full
      const internalDefault = buildPostgresSslConfig('postgres://cs_app:secret@postgres.railway.internal:5432/railway', {
        NODE_ENV: 'production',
      });
      assert.equal(internalDefault.diagnostics.hostClass, 'railway-internal');
      assert.equal(internalDefault.diagnostics.rejectUnauthorized, true);

      const internalDisabled = buildPostgresSslConfig('postgres://cs_app:secret@postgres.railway.internal:5432/railway', {
        NODE_ENV: 'production',
        PGSSLMODE: 'disable',
      });
      assert.equal(internalDisabled.diagnostics.enabled, false);
    } finally {
      await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Block 15.3 & 15.4: Migration 008 schema/FORCE RLS audit and US Studio Holiday Calendar enforcement', async () => {
  const m008 = await fs.readFile(
    path.resolve(process.cwd(), 'db/migrations/008_phase15_token_lifecycle_and_webhook_audit.sql'),
    'utf8',
  );
  assert.match(m008, /ADD COLUMN IF NOT EXISTS event_theme/i);
  assert.match(m008, /ADD COLUMN IF NOT EXISTS access_token_expires_at/i);
  assert.match(m008, /ADD COLUMN IF NOT EXISTS access_token_revoked_at/i);
  assert.match(m008, /CREATE TABLE IF NOT EXISTS notification_webhook_events/i);
  assert.match(m008, /ALTER TABLE consultations FORCE ROW LEVEL SECURITY/i);
  assert.match(m008, /ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY/i);
  assert.match(m008, /ALTER TABLE notification_webhook_events FORCE ROW LEVEL SECURITY/i);
  assert.match(m008, /VALUES \('008'/i);

  // Holiday calendar unit checks
  assert.match(getStudioHolidayReason('2026-01-01') || '', /New Year's Day/);
  assert.match(getStudioHolidayReason('2026-05-25') || '', /Memorial Day/);
  assert.match(getStudioHolidayReason('2026-07-04') || '', /Independence Day/);
  assert.match(getStudioHolidayReason('2026-09-07') || '', /Labor Day/);
  assert.match(getStudioHolidayReason('2026-11-26') || '', /Thanksgiving/);
  assert.match(getStudioHolidayReason('2026-12-25') || '', /Christmas Day/);
  assert.equal(getStudioHolidayReason('2026-06-16'), null);

  // Holiday availability endpoint check (auto-computed US holiday not in manual blackoutDates)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p15-holiday-'));
  const srv = await startTestServer(path.join(tmpDir, 'db.json'));
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/consultations/availability?startDate=2026-11-26&days=1&timezone=America/New_York&method=video`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { days: Array<{ isBlackout: boolean; blackoutReason?: string; availableCount: number }> };
    assert.equal(body.days[0].isBlackout, true);
    assert.match(body.days[0].blackoutReason || '', /Thanksgiving/);
    assert.equal(body.days[0].availableCount, 0);
  } finally {
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Block 15.10 Scenarios A, B, D, E, F, G, H, I: Full E2E consultation, race condition, outbox dead-letter retry + Svix webhook, CRM conversion & client self-service token lifecycle', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p15-e2e-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const webhookSecret = `whsec_${Buffer.from('celebration-sisters-phase15-webhook-key-32').toString('base64')}`;
  const srv = await startTestServer(dbPath, {
    RESEND_WEBHOOK_SECRET: webhookSecret,
    RESEND_API_KEY: 're_test_placeholder_0000',
    EMAIL_LIVE_DELIVERY_ENABLED: 'true',
  });

  try {
    const slots = await getAvailableSlots(srv.baseUrl, 'video', 14);
    assert.ok(slots.length >= 4, 'Expected at least 4 open consultation slots');
    const [slotA, slotRace, slotResched] = slots;

    // SCENARIO A: Full booking with Event Theme persisted
    const createRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'p15-scenario-a-01',
      },
      body: JSON.stringify({
        eventType: 'Luxury Weddings & Reception Styling',
        eventTitle: 'Sterling Estate Royal Wedding',
        eventTheme: 'Candlelit Royal Amethyst & Champagne Gold',
        serviceDivisionIds: ['wedding-planning', 'luxury-decor'],
        eventDate: futureIsoDate(150),
        guestCount: 210,
        budgetRange: '$25,000 – $45,000',
        location: 'Columbia, SC',
        venueName: 'Lace House Gardens',
        consultationStartUtc: slotA.startUtc,
        consultationMethod: 'video',
        plannerId: slotA.plannerId,
        clientTimezone: 'America/New_York',
        clientName: 'Elena Sterling',
        clientEmail: 'elena.sterling@example.com',
        clientPhone: '(803) 555-0192',
        preferredContactMethod: 'email',
        notes: 'Suspended floral ceiling and gold chiavari seating.',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      consultation: { id: string; referenceCode: string; eventTheme?: string; accessTokenExpiresAt?: string };
      accessToken: string;
    };
    assert.equal(created.consultation.eventTheme, 'Candlelit Royal Amethyst & Champagne Gold');
    assert.ok(created.accessToken.startsWith('csa_'));
    assert.ok(created.consultation.accessTokenExpiresAt);

    // SCENARIO B: Simultaneous double-booking race condition
    const racePayload = {
      eventType: 'Corporate Galas & Executive Events',
      eventTitle: 'Concurrent Gala Inquiry',
      eventTheme: 'Modern Black & Gold',
      serviceDivisionIds: ['corporate-events'],
      eventDate: futureIsoDate(120),
      guestCount: 160,
      budgetRange: '$15,000 – $25,000',
      location: 'Columbia, SC',
      venueName: 'Columbia Museum of Art',
      consultationStartUtc: slotRace.startUtc,
      consultationMethod: 'video',
      plannerId: slotRace.plannerId,
      clientTimezone: 'America/New_York',
      clientName: 'Marcus Vance',
      clientEmail: 'marcus.vance@example.com',
      clientPhone: '(803) 555-0144',
      preferredContactMethod: 'phone',
      notes: 'Executive awards dinner.',
      privacyConsentAccepted: true,
    };

    const [r1, r2] = await Promise.all([
      fetch(`${srv.baseUrl}/api/consultations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'p15-race-1' },
        body: JSON.stringify(racePayload),
      }),
      fetch(`${srv.baseUrl}/api/consultations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'p15-race-2' },
        body: JSON.stringify({ ...racePayload, clientEmail: 'second.caller@example.com' }),
      }),
    ]);
    const raceStatuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(raceStatuses, [201, 409]);

    // SCENARIO H (part 1): Client self-service update + cross-client isolation
    const badUpdateRes = await fetch(
      `${srv.baseUrl}/api/consultations/${created.consultation.id}/client-details`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: 'csa_wrong_token', guestCount: 999 }),
      },
    );
    assert.equal(badUpdateRes.status, 403);

    const goodUpdateRes = await fetch(
      `${srv.baseUrl}/api/consultations/${created.consultation.id}/client-details`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: created.accessToken,
          clientPhone: '(803) 555-0199',
          preferredContactMethod: 'sms',
          eventTheme: 'Velvet Amethyst & Antique Brass',
          guestCount: 235,
          venueName: 'Boyd Plaza Conservatory',
        }),
      },
    );
    assert.equal(goodUpdateRes.status, 200);
    const updatedClientBody = (await goodUpdateRes.json()) as {
      consultation: { clientPhone: string; eventTheme?: string; guestCount: number; venueName: string };
    };
    assert.equal(updatedClientBody.consultation.clientPhone, '(803) 555-0199');
    assert.equal(updatedClientBody.consultation.eventTheme, 'Velvet Amethyst & Antique Brass');
    assert.equal(updatedClientBody.consultation.guestCount, 235);

    // SCENARIO G + I: Admin MFA confirms, qualifies stage, reschedules, completes, sends proposal & converts to Event Booked
    const adminToken = await loginAdminWithMfa(srv.baseUrl);

    // Confirm
    const confirmRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/confirm`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(confirmRes.status, 200);

    // Stage qualification (PATCH /api/consultations/:id/stage)
    const stageRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ crmStage: 'Qualified Lead', notes: 'Budget and venue verified' }),
    });
    assert.equal(stageRes.status, 200);

    // SCENARIO E: Reschedule releases old slot
    const reschedRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/reschedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        newStartUtc: slotResched.startUtc,
        plannerId: slotResched.plannerId,
        reason: 'Moved to preferred afternoon window',
      }),
    });
    assert.equal(reschedRes.status, 200);

    // Editable staff availability duration/buffers
    const staffUpdateRes = await fetch(`${srv.baseUrl}/api/staff/availability/${slotA.plannerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        rules: [
          {
            dayOfWeek: 2,
            startTimeLocal: '09:30',
            endTimeLocal: '17:00',
            slotDurationMinutes: 60,
            bufferBeforeMinutes: 10,
            bufferAfterMinutes: 20,
            allowedMethods: ['video', 'in_person_columbia', 'phone'],
            isActive: true,
          },
        ],
      }),
    });
    assert.equal(staffUpdateRes.status, 200);

    // Complete consultation + auto-create follow-up task
    const completeRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        status: 'Completed',
        outcomeSummary: 'Client approved full floral ceiling and velvet table runners.',
        followUpTitle: 'Send final floral architecture deck',
        followUpDueAt: futureIsoDate(3) + 'T17:00:00.000Z',
      }),
    });
    assert.equal(completeRes.status, 200);

    // Integer-cent proposal handoff
    const proposalRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/proposal-handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        lineItems: [
          { description: 'Suspended Floral Canopy Installation', quantity: 1, unitPriceCents: 1850000 },
          { description: 'Custom Velvet Linens & Crystal Chargers', quantity: 24, unitPriceCents: 12500 },
        ],
        discountCents: 50000,
        notes: 'Includes full Columbia production crew and strike.',
        markAsSent: true,
      }),
    });
    assert.equal(proposalRes.status, 201);

    // Client portal status lookup now exposes authorized proposalSummary
    const statusWithProposalRes = await fetch(
      `${srv.baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}&accessToken=${encodeURIComponent(created.accessToken)}`,
    );
    assert.equal(statusWithProposalRes.status, 200);
    const statusPayload = (await statusWithProposalRes.json()) as {
      consultation: {
        proposalSummary?: { version: number; totalAmount: number; itemCount: number; crmStage: string };
      };
    };
    assert.ok(statusPayload.consultation.proposalSummary);
    assert.equal(statusPayload.consultation.proposalSummary?.totalAmount, 21000);
    assert.equal(statusPayload.consultation.proposalSummary?.itemCount, 2);
    assert.equal(statusPayload.consultation.proposalSummary?.crmStage, 'Proposal Sent');

    // Convert to Event Booked
    const decisionRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ decision: 'Approved' }),
    });
    assert.equal(decisionRes.status, 200);

    // Admin analytics & planner workload verification
    const adminListRes = await fetch(`${srv.baseUrl}/api/consultations`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminListRes.status, 200);
    const adminList = (await adminListRes.json()) as {
      conversionAnalytics: { totalLeads: number; bookingConversionRatePct: number };
      plannerWorkload: Array<{ plannerId: string; bookedCount: number; completedCount: number }>;
      notificationOutbox: Array<{ id: string; status: string }>;
    };
    assert.ok(adminList.conversionAnalytics.totalLeads >= 2);
    assert.ok(adminList.conversionAnalytics.bookingConversionRatePct > 0);
    assert.ok(adminList.plannerWorkload.some((pw) => pw.bookedCount >= 1));

    // SCENARIO D: Outbox DeadLetter -> Admin MFA retry -> ProviderAccepted -> Svix Signed Webhook -> Delivered
    const targetJobId = adminList.notificationOutbox[0]?.id;
    assert.ok(targetJobId, 'Expected at least one queued outbox job');

    // Simulate dead-lettered job in persistence
    await withTransaction((db) => {
      const deadJob = db.notificationOutbox.find((j) => j.id === targetJobId)!;
      deadJob.status = 'DeadLetter';
      deadJob.attempts = 4;
      deadJob.lastError = 'Simulated Resend 503 outage';
    });

    // Admin retries job (using mocked fetch via worker for deterministic ProviderAccepted)
    const requeueRes = await fetch(`${srv.baseUrl}/api/admin/outbox/${targetJobId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ processImmediately: false }),
    });
    assert.equal(requeueRes.status, 200);
    const requeuedBody = (await requeueRes.json()) as { job: { status: string; attempts: number } };
    assert.equal(requeuedBody.job.status, 'Pending');
    assert.equal(requeuedBody.job.attempts, 0);

    // Process with stubbed 200 Resend provider response
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ id: 'resend_msg_phase15_001' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const worker = new NotificationOutboxWorker({
      fetchImpl: mockFetch,
      apiKey: 're_test_placeholder_0000',
      fromAddress: 'Celebration Sisters <consultations@celebrationsistersdecor.com>',
      liveDeliveryEnabled: true,
      batchSize: 10,
    });
    const summary = await worker.processOnce();
    assert.ok(summary.accepted >= 1);

    // Reject tampered Svix webhook signature
    const webhookPayload = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'resend_msg_phase15_001', to: ['elena.sterling@example.com'] },
    });
    const nowSec = String(Math.floor(Date.now() / 1000));
    const badWebhookRes = await fetch(`${srv.baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': 'msg_p15_bad',
        'svix-timestamp': nowSec,
        'svix-signature': 'v1,invalidSignatureBase64==',
      },
      body: webhookPayload,
    });
    assert.equal(badWebhookRes.status, 401);

    // Reject expired Svix timestamp (> 5 min old)
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    const expiredSigCheck = verifyResendWebhookSignature({
      rawBody: webhookPayload,
      svixId: 'msg_p15_old',
      svixTimestamp: oldTs,
      svixSignature: signSvixWebhook(webhookSecret, 'msg_p15_old', oldTs, webhookPayload),
      webhookSecret,
    });
    assert.equal(expiredSigCheck.valid, false);
    assert.match(expiredSigCheck.reason || '', /replay|window/i);

    // Accept valid Svix-signed delivery confirmation and transition outbox job to Delivered
    const validSig = signSvixWebhook(webhookSecret, 'msg_p15_delivered_01', nowSec, webhookPayload);
    const goodWebhookRes = await fetch(`${srv.baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': 'msg_p15_delivered_01',
        'svix-timestamp': nowSec,
        'svix-signature': validSig,
      },
      body: webhookPayload,
    });
    assert.equal(goodWebhookRes.status, 200);
    const goodWebhookBody = (await goodWebhookRes.json()) as {
      received: boolean;
      reconciled: boolean;
      deduplicated: boolean;
    };
    assert.equal(goodWebhookBody.received, true);
    assert.equal(goodWebhookBody.reconciled, true);
    assert.equal(goodWebhookBody.deduplicated, false);

    // Verify persisted outbox job actually transitioned to Delivered
    const dbAfterWebhook = await readDb();
    const deliveredJob = dbAfterWebhook.notificationOutbox.find((j) => j.providerMessageId === 'resend_msg_phase15_001');
    assert.equal(deliveredJob?.status, 'Delivered');

    // Duplicate svix-id is deduplicated idempotently
    const dupWebhookRes = await fetch(`${srv.baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': 'msg_p15_delivered_01',
        'svix-timestamp': nowSec,
        'svix-signature': validSig,
      },
      body: webhookPayload,
    });
    assert.equal(dupWebhookRes.status, 200);
    const dupBody = (await dupWebhookRes.json()) as { deduplicated?: boolean };
    assert.equal(dupBody.deduplicated, true);

    // SCENARIO H (part 2): Token expiration & immediate revocation
    const dbForExpiry = await readDb();
    const targetConsult = dbForExpiry.consultations.find((c) => c.id === created.consultation.id)!;
    const expiryCheck = validateConsultationTokenAccess(
      { ...targetConsult, accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString() },
      created.accessToken,
    );
    assert.equal(expiryCheck.valid, false);
    assert.equal(expiryCheck.code, 'TOKEN_EXPIRED');

    // Revoke token via API
    const revokeRes = await fetch(`${srv.baseUrl}/api/consultations/${created.consultation.id}/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: created.accessToken }),
    });
    assert.equal(revokeRes.status, 200);

    // Subsequent status lookup with revoked token is denied with 403 TOKEN_REVOKED
    const postRevokeRes = await fetch(
      `${srv.baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}&accessToken=${encodeURIComponent(created.accessToken)}`,
    );
    assert.equal(postRevokeRes.status, 403);
    const postRevokeBody = (await postRevokeRes.json()) as { code?: string };
    assert.equal(postRevokeBody.code, 'TOKEN_REVOKED');
  } finally {
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Block 15.10 Scenario C: PostgreSQL outage / TLS failure returns 503 DATABASE_UNAVAILABLE with zero false confirmation', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-p15-db-outage-'));
  const prevDbUrl = process.env.DATABASE_URL;
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;
  process.env.DATABASE_URL = 'postgres://cs_app:secret@db.example.com:5432/cs_db';
  process.env.PERSISTENCE_ADAPTER = 'postgres';

  setInjectedPgPoolForTests({
    async query() {
      const err = new Error('self-signed certificate in certificate chain') as NodeJS.ErrnoException;
      err.code = 'SELF_SIGNED_CERT_IN_CHAIN';
      throw err;
    },
    async connect() {
      const err = new Error('self-signed certificate in certificate chain') as NodeJS.ErrnoException;
      err.code = 'SELF_SIGNED_CERT_IN_CHAIN';
      throw err;
    },
    async end() {},
  });

  const app = createApp({ enableRateLimit: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  try {
    const res = await fetch(`${baseUrl}/api/consultations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'p15-outage-01' },
      body: JSON.stringify({
        eventType: 'Luxury Weddings & Reception Styling',
        eventTitle: 'Outage Safety Verification',
        serviceDivisionIds: ['wedding-planning'],
        eventDate: futureIsoDate(90),
        guestCount: 100,
        budgetRange: '$15,000 – $25,000',
        location: 'Columbia, SC',
        venueName: 'Studio Test',
        consultationStartUtc: new Date(Date.now() + 72 * 3600_000).toISOString(),
        consultationMethod: 'video',
        plannerId: 'user-planner-sierra',
        clientTimezone: 'America/New_York',
        clientName: 'Grace Harbor',
        clientEmail: 'grace.harbor@example.com',
        clientPhone: '(803) 555-0155',
        preferredContactMethod: 'email',
        notes: 'Must not show false confirmation.',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string; consultation?: unknown };
    assert.equal(body.code, 'DATABASE_UNAVAILABLE');
    assert.equal(body.consultation, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setInjectedPgPoolForTests(null);
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
    else process.env.PERSISTENCE_ADAPTER = prevAdapter;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Block 15.9 & 15.10 Scenario J: ConsultationModal and AdminConsultationCommandCenter SSR render Phase 15 fields & accessibility semantics', () => {
  const modalHtml = renderToStaticMarkup(
    React.createElement(ConsultationModal, {
      open: true,
      onClose: () => {},
    }),
  );
  assert.match(modalHtml, /wizard-event-theme/);
  assert.match(modalHtml, /Event Theme \/ Aesthetic Direction/);
  assert.match(modalHtml, /aria-current="step"/);
  assert.match(modalHtml, /min-h-\[44px\]/);

  const commandCenterHtml = renderToStaticMarkup(
    React.createElement(AdminConsultationCommandCenter, {
      currentRole: 'admin',
    }),
  );
  assert.match(commandCenterHtml, /Schedule &amp; Calendar/);
  assert.match(commandCenterHtml, /CRM Conversion Pipeline/);
  assert.match(commandCenterHtml, /Email Outbox/);
});
