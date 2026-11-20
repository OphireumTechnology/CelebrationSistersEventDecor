import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp, evaluateApplicationReadiness } from '../server/app.ts';
import {
  checkPersistenceHealth,
  setInjectedPgPoolForTests,
} from '../server/repositories/postgresRepository.ts';

async function startServer() {
  const app = createApp({ enableRateLimit: false });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind server');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeMockPgPool(opts: {
  migrationsCount: number;
  missingTables?: string[];
  overlapConstraintPresent?: boolean;
}) {
  const missing = new Set(opts.missingTables ?? []);
  return {
    async connect() {
      throw new Error('not needed');
    },
    async query(sql: string) {
      if (/to_regclass/i.test(sql)) {
        return {
          rows: [
            {
              rate_limit_tbl: missing.has('rate_limit_buckets') ? null : 'rate_limit_buckets',
              migrations_tbl: missing.has('schema_migrations') ? null : 'schema_migrations',
              consultations_tbl: missing.has('consultations') ? null : 'consultations',
              holds_tbl: missing.has('consultation_slot_holds') ? null : 'consultation_slot_holds',
              outbox_tbl: missing.has('notification_outbox') ? null : 'notification_outbox',
              webhooks_tbl: missing.has('notification_webhook_events') ? null : 'notification_webhook_events',
              crm_tasks_tbl: missing.has('crm_follow_up_tasks') ? null : 'crm_follow_up_tasks',
            },
          ],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        } as never;
      }
      if (/FROM schema_migrations/i.test(sql)) {
        return {
          rows: [{ cnt: opts.migrationsCount }],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        } as never;
      }
      if (/FROM pg_constraint/i.test(sql)) {
        return {
          rows: [{ present: opts.overlapConstraintPresent ?? true }],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        } as never;
      }
      return {
        rows: [{ ok: 1 }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never;
    },
    async end() {},
  };
}

test('Phase 23: checkPersistenceHealth verifies essential tables, 8 canonical migrations, and overlap exclusion constraint', async () => {
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;
  process.env.PERSISTENCE_ADAPTER = 'postgres';
  try {
    setInjectedPgPoolForTests(
      makeMockPgPool({ migrationsCount: 8, missingTables: [], overlapConstraintPresent: true }),
    );
    const full = await checkPersistenceHealth();
    assert.equal(full.ready, true);
    assert.equal(full.connected, true);
    assert.equal(full.schema?.essentialTablesPresent, true);
    assert.deepEqual(full.schema?.missingEssentialTables, []);
    assert.equal(full.schema?.overlapConstraintPresent, true);
    assert.equal(full.schema?.canonicalSchemaReady, true);

    setInjectedPgPoolForTests(
      makeMockPgPool({
        migrationsCount: 8,
        missingTables: ['notification_outbox'],
        overlapConstraintPresent: false,
      }),
    );
    const degraded = await checkPersistenceHealth();
    assert.equal(degraded.schema?.essentialTablesPresent, false);
    assert.deepEqual(degraded.schema?.missingEssentialTables, ['notification_outbox']);
    assert.equal(degraded.schema?.overlapConstraintPresent, false);
    assert.equal(degraded.schema?.canonicalSchemaReady, false);
  } finally {
    setInjectedPgPoolForTests(null);
    if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
    else process.env.PERSISTENCE_ADAPTER = prevAdapter;
  }
});

test('Phase 23: GET /health reports liveness (200) while production GET /ready fails closed (503) when migrations, constraints, auth, or email are missing', async () => {
  const saved: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    PERSISTENCE_ADAPTER: process.env.PERSISTENCE_ADAPTER,
    DATABASE_URL: process.env.DATABASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    STAFF_NOTIFICATION_EMAIL: process.env.STAFF_NOTIFICATION_EMAIL,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
  };

  process.env.NODE_ENV = 'production';
  process.env.PERSISTENCE_ADAPTER = 'postgres';
  delete process.env.DATABASE_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.STAFF_NOTIFICATION_EMAIL;
  delete process.env.RESEND_WEBHOOK_SECRET;

  const srv = await startServer();
  try {
    // 1. Live SELECT 1 succeeds, but 0 migrations + no auth + no email => /health is 200 alive, /ready MUST be 503 not_ready
    setInjectedPgPoolForTests(
      makeMockPgPool({
        migrationsCount: 0,
        missingTables: ['schema_migrations', 'consultations'],
        overlapConstraintPresent: false,
      }),
    );

    const healthRes = await fetch(`${srv.baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean; status: string };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.status, 'alive');

    const unreadyRes = await fetch(`${srv.baseUrl}/ready`);
    assert.equal(unreadyRes.status, 503);
    const unreadyBody = (await unreadyRes.json()) as {
      ok: boolean;
      status: string;
      productionReady: boolean;
      blockingReasons: string[];
      checks: Record<string, boolean>;
    };
    assert.equal(unreadyBody.ok, false);
    assert.equal(unreadyBody.status, 'not_ready');
    assert.equal(unreadyBody.productionReady, false);
    assert.equal(unreadyBody.checks.database, true);
    assert.equal(unreadyBody.checks.migrations, false);
    assert.equal(unreadyBody.checks.schemaObjects, false);
    assert.equal(unreadyBody.checks.auth, false);
    assert.equal(unreadyBody.checks.email, false);
    assert.ok(unreadyBody.blockingReasons.length >= 4);

    // 2. Configure ALL required production dependencies with sentinel secret values & verify 200 ready + zero secret leakage
    setInjectedPgPoolForTests(
      makeMockPgPool({ migrationsCount: 8, missingTables: [], overlapConstraintPresent: true }),
    );
    const sentinelResendKey = 'test_resend_secret_sentinel_999';
    const sentinelWebhookSecret = 'test_webhook_secret_sentinel_888';
    const sentinelServiceRole = 'test_supabase_service_sentinel_777';
    process.env.SUPABASE_URL = 'https://staging-ready.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-public-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = sentinelServiceRole;
    process.env.RESEND_API_KEY = sentinelResendKey;
    process.env.EMAIL_FROM = 'concierge@celebrationsistersdecor.com';
    process.env.STAFF_NOTIFICATION_EMAIL = 'qa-ops@celebrationsistersdecor.com';
    process.env.RESEND_WEBHOOK_SECRET = sentinelWebhookSecret;

    const readyRes = await fetch(`${srv.baseUrl}/ready`);
    assert.equal(readyRes.status, 200);
    const rawText = await readyRes.text();
    assert.equal(rawText.includes(sentinelResendKey), false, 'Ready payload must never disclose email API key');
    assert.equal(rawText.includes(sentinelWebhookSecret), false, 'Ready payload must never disclose webhook secret');
    assert.equal(rawText.includes(sentinelServiceRole), false, 'Ready payload must never disclose service role key');

    const readyBody = JSON.parse(rawText) as {
      ok: boolean;
      status: string;
      productionReady: boolean;
      blockingReasons: string[];
      checks: Record<string, boolean>;
    };
    assert.equal(readyBody.ok, true);
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.productionReady, true);
    assert.deepEqual(readyBody.blockingReasons, []);
    assert.equal(readyBody.checks.database, true);
    assert.equal(readyBody.checks.migrations, true);
    assert.equal(readyBody.checks.schemaObjects, true);
    assert.equal(readyBody.checks.auth, true);
    assert.equal(readyBody.checks.email, true);
    assert.equal(readyBody.checks.worker, true);

    // 3. Unhealthy worker heartbeat flips evaluateApplicationReadiness to 503 in production
    const unhealthyWorkerEval = evaluateApplicationReadiness({
      persistence: {
        adapter: 'postgres',
        ready: true,
        connected: true,
        schema: {
          rateLimitTablePresent: true,
          migrationsTablePresent: true,
          migrationsAppliedCount: 8,
          essentialTablesPresent: true,
          missingEssentialTables: [],
          overlapConstraintPresent: true,
          canonicalSchemaReady: true,
        },
        reason: 'ok',
      },
      auth: {
        provider: 'supabase',
        supabaseConfigured: true,
        adminClientConfigured: true,
        jwtVerificationConfigured: true,
        readyForProductionAuth: true,
        mfaPolicy: 'totp_required_for_admin',
        reason: 'ok',
      },
      email: {
        provider: 'resend',
        configured: true,
        fromAddressConfigured: true,
        staffRecipientConfigured: true,
        webhookSecretConfigured: true,
        liveDeliveryEnabled: false,
        reason: 'ok',
      },
      worker: {
        workerId: 'w-1',
        pollingActive: true,
        pollingDisabled: false,
        healthy: false,
        lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
      },
      isProduction: true,
    });
    assert.equal(unhealthyWorkerEval.httpStatus, 503);
    assert.equal(unhealthyWorkerEval.checks.worker, false);
  } finally {
    setInjectedPgPoolForTests(null);
    await srv.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
