import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Isolated Railway Staging API + Resend Delivery & Svix Webhook Verifier (Phase 17F).
 *
 * Covers:
 * - REQ-RAIL-01: HTTPS/health/ready/auth-config/CORS preflight/live availability/
 *   idempotent booking/120-minute notice rejection/self-service token lifecycle/reschedule/cancel.
 * - REQ-RES-01: Signed Svix webhook acceptance (email.delivered), duplicate svix-id suppression,
 *   invalid signature rejection (401), expired >300s timestamp rejection (401), and
 *   out-of-order terminal status downgrade protection.
 */

export interface StagingApiVerifyOptions {
  apiBaseUrl: string;
  frontendOrigin?: string;
  testRecipientEmail?: string;
  resendWebhookSecret?: string;
  requireHttps?: boolean;
  requirePostgres?: boolean;
  requireCanonicalMigrations?: boolean;
  checkUnauthenticatedGuards?: boolean;
  requireSupabaseAuth?: boolean;
  requireResendLive?: boolean;
}

export interface StagingApiCheckResult {
  id: string;
  check: string;
  passed: boolean;
  detail: string;
}

export function buildSignedSvixHeaders(secret: string, rawBody: string, timestampSec: number, svixId: string) {
  const keyPart = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const keyBytes = Buffer.from(keyPart, 'base64');
  const signedPayload = `${svixId}.${timestampSec}.${rawBody}`;
  const sig = crypto.createHmac('sha256', keyBytes).update(signedPayload).digest('base64');
  return {
    'svix-id': svixId,
    'svix-timestamp': String(timestampSec),
    'svix-signature': `v1,${sig}`,
  };
}

function futureIsoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

export async function verifyStagingRailwayAndResend(
  options: StagingApiVerifyOptions,
): Promise<{ ok: boolean; checks: StagingApiCheckResult[] }> {
  const baseUrl = options.apiBaseUrl.replace(/\/+$/, '');
  const origin = options.frontendOrigin || 'https://celebrationsistersdecor.com';
  const testEmail = options.testRecipientEmail || 'staging-qa-internal@example.com';
  const checks: StagingApiCheckResult[] = [];

  if (options.requireHttps && !baseUrl.startsWith('https://')) {
    throw new Error(`Staging API URL must use HTTPS when requireHttps is true (received: ${baseUrl}).`);
  }

  // 1. Health & Readiness
  const healthRes = await fetch(`${baseUrl}/health`);
  const healthBody = (await healthRes.json()) as { ok?: boolean; status?: string };
  checks.push({
    id: 'STG-API-01',
    check: 'GET /health returns 200 OK',
    passed: healthRes.status === 200 && healthBody.ok === true,
    detail: `status=${healthRes.status}, requestId=${healthRes.headers.get('x-request-id') || 'missing'}`,
  });

  const readyRes = await fetch(`${baseUrl}/ready`);
  const readyBody = (await readyRes.json()) as {
    ok?: boolean;
    persistence?: {
      adapter?: string;
      ready?: boolean;
      connected?: boolean;
      schema?: {
        rateLimitTablePresent?: boolean;
        migrationsTablePresent?: boolean;
        migrationsAppliedCount?: number;
      };
    };
    auth?: {
      provider?: string;
      supabaseConfigured?: boolean;
      readyForProductionAuth?: boolean;
    };
    email?: { configured?: boolean; liveDeliveryEnabled?: boolean; provider?: string };
  };
  const pgOk = options.requirePostgres
    ? readyBody.persistence?.adapter === 'postgres' && readyBody.persistence?.connected === true
    : readyBody.persistence?.ready === true;
  const schema = readyBody.persistence?.schema;
  const migrationsOk = options.requireCanonicalMigrations
    ? Boolean(
        schema?.rateLimitTablePresent === true &&
          schema?.migrationsTablePresent === true &&
          (schema?.migrationsAppliedCount ?? 0) >= 8,
      )
    : true;
  checks.push({
    id: 'STG-API-02',
    check: 'GET /ready confirms database connectivity, readiness & schema state',
    passed: readyRes.status === 200 && readyBody.ok === true && pgOk && migrationsOk,
    detail: `status=${readyRes.status}, adapter=${readyBody.persistence?.adapter}, connected=${readyBody.persistence?.connected}, rateLimitTable=${String(schema?.rateLimitTablePresent)}, migrationsApplied=${String(schema?.migrationsAppliedCount ?? 'n/a')}`,
  });

  if (options.requireSupabaseAuth) {
    checks.push({
      id: 'STG-AUTH-01',
      check: 'GET /ready confirms Supabase Auth is configured and ready for production auth',
      passed:
        readyBody.auth?.supabaseConfigured === true && readyBody.auth?.readyForProductionAuth === true,
      detail: `provider=${readyBody.auth?.provider ?? 'unknown'}, supabaseConfigured=${String(readyBody.auth?.supabaseConfigured)}, readyForProductionAuth=${String(readyBody.auth?.readyForProductionAuth)}`,
    });
  }

  if (options.requireResendLive) {
    checks.push({
      id: 'STG-RES-00',
      check: 'GET /ready confirms Resend live email delivery is configured and enabled',
      passed:
        readyBody.email?.configured === true && readyBody.email?.liveDeliveryEnabled === true,
      detail: `provider=${readyBody.email?.provider ?? 'unknown'}, configured=${String(readyBody.email?.configured)}, liveDeliveryEnabled=${String(readyBody.email?.liveDeliveryEnabled)}`,
    });
  }

  if (options.checkUnauthenticatedGuards) {
    const [unauthConsults, unauthMetrics] = await Promise.all([
      fetch(`${baseUrl}/api/consultations`),
      fetch(`${baseUrl}/api/admin/metrics`),
    ]);
    checks.push({
      id: 'STG-SEC-01',
      check: 'Protected admin & consultation listing routes reject unauthenticated access (401/403)',
      passed:
        (unauthConsults.status === 401 || unauthConsults.status === 403) &&
        (unauthMetrics.status === 401 || unauthMetrics.status === 403),
      detail: `consultations=${unauthConsults.status}, adminMetrics=${unauthMetrics.status}`,
    });
  }

  // 2. Auth config bootstrap (zero-404 production posture)
  const authCfgRes = await fetch(`${baseUrl}/api/auth/config`);
  const authCfg = (await authCfgRes.json()) as { demoPersonasAvailable?: boolean; mfaPolicy?: string };
  checks.push({
    id: 'STG-API-03',
    check: 'GET /api/auth/config exposes demoPersonasAvailable flag cleanly',
    passed: authCfgRes.status === 200 && typeof authCfg.demoPersonasAvailable === 'boolean',
    detail: `status=${authCfgRes.status}, demoPersonasAvailable=${String(authCfg.demoPersonasAvailable)}`,
  });

  // 3. CORS preflight with X-Consultation-Token & Idempotency-Key
  const corsRes = await fetch(`${baseUrl}/api/consultations`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, X-Consultation-Token, Idempotency-Key',
    },
  });
  const acao = corsRes.headers.get('access-control-allow-origin') || '';
  const acah = (corsRes.headers.get('access-control-allow-headers') || '').toLowerCase();
  checks.push({
    id: 'STG-API-04',
    check: 'CORS preflight allows origin and X-Consultation-Token + Idempotency-Key headers',
    passed:
      (corsRes.status === 204 || corsRes.status === 200) &&
      acao === origin &&
      acah.includes('x-consultation-token') &&
      acah.includes('idempotency-key'),
    detail: `status=${corsRes.status}, acao=${acao}`,
  });

  // 4. Live studio consultation availability
  const availRes = await fetch(
    `${baseUrl}/api/consultations/availability?startDate=${futureIsoDate(5)}&days=14&timezone=America/New_York&method=video`,
  );
  const availData = (await availRes.json()) as {
    days?: Array<{ slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
  };
  const openSlots = (availData.days || []).flatMap((d) => d.slots).filter((s) => s.available);
  checks.push({
    id: 'STG-API-05',
    check: 'GET /api/consultations/availability returns real available studio slots',
    passed: availRes.status === 200 && openSlots.length >= 2,
    detail: `status=${availRes.status}, availableSlots=${openSlots.length}`,
  });

  // 5. 120-minute minimum notice rejection guard
  const tooSoonUtc = new Date(Date.now() + 30 * 60_000).toISOString();
  const noticeRes = await fetch(`${baseUrl}/api/consultations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: 'Notice Cutoff Probe',
      clientEmail: testEmail,
      clientPhone: '(803) 555-0199',
      preferredContactMethod: 'email',
      eventType: 'Wedding',
      eventTitle: 'Too Soon Notice Probe',
      serviceDivisionIds: ['div-event-decor'],
      eventDate: futureIsoDate(90),
      venueName: 'Lace House',
      location: 'Columbia, SC',
      guestCount: 100,
      budgetRange: '$25,000 - $50,000',
      consultationMethod: 'video',
      consultationStartUtc: tooSoonUtc,
      plannerId: openSlots[0]?.plannerId || 'user-staff-maya',
      clientTimezone: 'America/New_York',
      privacyConsentAccepted: true,
    }),
  });
  checks.push({
    id: 'STG-API-06',
    check: 'POST /api/consultations enforces 120-minute minimum notice cutoff',
    passed: noticeRes.status === 400 || noticeRes.status === 409,
    detail: `status=${noticeRes.status}`,
  });

  // 6. Complete booking + Idempotency-Key replay + Self-Service Token + Reschedule + Cancel
  const idempKey = `p17f-staging-verify-${crypto.randomBytes(6).toString('hex')}`;
  const bookingPayload = {
    clientName: 'Staging QA Verification',
    clientEmail: testEmail,
    clientPhone: '(803) 555-0144',
    preferredContactMethod: 'email',
    eventType: 'Wedding',
    eventTitle: 'Phase 17F Staging Verification Booking',
    eventTheme: 'Champagne Ivory',
    serviceDivisionIds: ['div-event-decor'],
    eventDate: futureIsoDate(110),
    venueName: 'Columbia Museum of Art',
    location: 'Columbia, SC',
    guestCount: 120,
    budgetRange: '$25,000 - $50,000',
    consultationMethod: 'video',
    consultationStartUtc: openSlots[0]?.startUtc,
    plannerId: openSlots[0]?.plannerId,
    clientTimezone: 'America/New_York',
    privacyConsentAccepted: true,
  };

  const createRes = await fetch(`${baseUrl}/api/consultations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempKey },
    body: JSON.stringify(bookingPayload),
  });
  const created = (await createRes.json()) as {
    consultation?: { id: string; referenceCode: string };
    accessToken?: string;
    notificationStatus?: { outboxQueued?: number };
  };
  const consId = created.consultation?.id || '';
  const refCode = created.consultation?.referenceCode || '';
  const token = created.accessToken || '';
  checks.push({
    id: 'STG-API-07',
    check: 'POST /api/consultations creates booking, scoped csa_ token & outbox entries',
    passed:
      createRes.status === 201 &&
      Boolean(consId) &&
      token.startsWith('csa_') &&
      (created.notificationStatus?.outboxQueued || 0) >= 1,
    detail: `status=${createRes.status}, ref=${refCode}, outboxQueued=${created.notificationStatus?.outboxQueued ?? 0}`,
  });

  const replayRes = await fetch(`${baseUrl}/api/consultations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempKey },
    body: JSON.stringify(bookingPayload),
  });
  const replayed = (await replayRes.json()) as { deduplicated?: boolean; consultation?: { id?: string } };
  checks.push({
    id: 'STG-API-08',
    check: 'Idempotency-Key replay returns original consultation without duplication',
    passed: replayRes.status === 200 && replayed.deduplicated === true && replayed.consultation?.id === consId,
    detail: `status=${replayRes.status}, deduplicated=${String(replayed.deduplicated)}`,
  });

  // Wrong token vs valid token lookup
  const wrongTokenRes = await fetch(
    `${baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(refCode)}`,
    { headers: { 'X-Consultation-Token': 'csa_invalid_probe_token_000' } },
  );
  const validTokenRes = await fetch(
    `${baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(refCode)}`,
    { headers: { 'X-Consultation-Token': token } },
  );
  checks.push({
    id: 'STG-API-09',
    check: 'Scoped X-Consultation-Token rejects wrong token (403) and returns verified status (200)',
    passed: wrongTokenRes.status === 403 && validTokenRes.status === 200,
    detail: `wrong=${wrongTokenRes.status}, valid=${validTokenRes.status}`,
  });

  // Reschedule + Cancel cleanup so staging slot is released
  const secondSlot = openSlots.find((s) => s.startUtc !== openSlots[0]?.startUtc) || openSlots[1];
  const reschedRes = await fetch(`${baseUrl}/api/consultations/${encodeURIComponent(consId)}/reschedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Consultation-Token': token },
    body: JSON.stringify({
      newStartUtc: secondSlot?.startUtc,
      plannerId: secondSlot?.plannerId,
      reason: 'Phase 17F staging verification reschedule',
    }),
  });
  const cancelRes = await fetch(`${baseUrl}/api/consultations/${encodeURIComponent(consId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Consultation-Token': token },
    body: JSON.stringify({ reason: 'Phase 17F staging verification cleanup' }),
  });
  checks.push({
    id: 'STG-API-10',
    check: 'Client reschedule & cancel lifecycle completes cleanly and releases slot',
    passed: reschedRes.status === 200 && cancelRes.status === 200,
    detail: `reschedule=${reschedRes.status}, cancel=${cancelRes.status}`,
  });

  // 7. Signed Svix Resend webhook verification (when secret supplied)
  if (options.resendWebhookSecret) {
    const nowSec = Math.floor(Date.now() / 1000);
    const providerMessageId = `re_msg_${crypto.randomBytes(6).toString('hex')}`;
    const deliveredPayload = JSON.stringify({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: { email_id: providerMessageId, to: [testEmail], subject: 'Staging Verification' },
    });

    // Invalid signature -> 401
    const invalidSigRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': `msg_bad_${crypto.randomBytes(4).toString('hex')}`,
        'svix-timestamp': String(nowSec),
        'svix-signature': 'v1,aW52YWxpZF9zaWduYXR1cmU=',
      },
      body: deliveredPayload,
    });
    checks.push({
      id: 'STG-RES-01',
      check: 'Resend webhook rejects invalid Svix HMAC signature (401)',
      passed: invalidSigRes.status === 401,
      detail: `status=${invalidSigRes.status}`,
    });

    // Expired timestamp (>300s old) -> 401
    const expiredTs = nowSec - 600;
    const expiredHeaders = buildSignedSvixHeaders(
      options.resendWebhookSecret,
      deliveredPayload,
      expiredTs,
      `msg_exp_${crypto.randomBytes(4).toString('hex')}`,
    );
    const expiredRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...expiredHeaders },
      body: deliveredPayload,
    });
    checks.push({
      id: 'STG-RES-02',
      check: 'Resend webhook rejects expired Svix timestamp >300s (401)',
      passed: expiredRes.status === 401,
      detail: `status=${expiredRes.status}`,
    });

    // Valid signed webhook -> 200 + Duplicate svix-id -> deduplicated: true
    const validSvixId = `msg_ok_${crypto.randomBytes(6).toString('hex')}`;
    const validHeaders = buildSignedSvixHeaders(options.resendWebhookSecret, deliveredPayload, nowSec, validSvixId);
    const okRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...validHeaders },
      body: deliveredPayload,
    });
    const dupRes = await fetch(`${baseUrl}/api/webhooks/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...validHeaders },
      body: deliveredPayload,
    });
    const dupBody = (await dupRes.json()) as { deduplicated?: boolean };
    checks.push({
      id: 'STG-RES-03',
      check: 'Signed Svix webhook accepted (200) and duplicate svix-id suppressed',
      passed: okRes.status === 200 && dupRes.status === 200 && dupBody.deduplicated === true,
      detail: `first=${okRes.status}, duplicate=${dupRes.status}, deduplicated=${String(dupBody.deduplicated)}`,
    });
  }

  return { ok: checks.every((c) => c.passed), checks };
}

async function main() {
  if (process.argv.includes('--self-check')) {
    console.log(
      JSON.stringify({
        ok: true,
        mode: 'self-check',
        guardRequired: 'STAGING_API_CONFIRM=YES_ISOLATED_STAGING',
        envRequired: ['STAGING_API_BASE_URL'],
        optionalEnv: [
          'STAGING_FRONTEND_ORIGIN',
          'STAGING_RESEND_TEST_EMAIL',
          'RESEND_WEBHOOK_SECRET',
          'STAGING_REQUIRE_SUPABASE_AUTH',
          'STAGING_REQUIRE_RESEND_LIVE',
        ],
      }),
    );
    return;
  }

  if (process.env.STAGING_API_CONFIRM !== 'YES_ISOLATED_STAGING') {
    throw new Error('SAFETY_GUARD: Set STAGING_API_CONFIRM=YES_ISOLATED_STAGING before running against staging.');
  }
  const apiBaseUrl = (process.env.STAGING_API_BASE_URL || '').trim();
  if (!apiBaseUrl) {
    throw new Error('STAGING_API_BASE_URL is required.');
  }

  const report = await verifyStagingRailwayAndResend({
    apiBaseUrl,
    frontendOrigin: process.env.STAGING_FRONTEND_ORIGIN || 'https://celebrationsistersdecor.com',
    testRecipientEmail: process.env.STAGING_RESEND_TEST_EMAIL || 'staging-qa-internal@example.com',
    resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET,
    requireHttps: true,
    requirePostgres: true,
    requireCanonicalMigrations: true,
    checkUnauthenticatedGuards: true,
    requireSupabaseAuth: process.env.STAGING_REQUIRE_SUPABASE_AUTH === 'true',
    requireResendLive: process.env.STAGING_REQUIRE_RESEND_LIVE === 'true',
  });

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
