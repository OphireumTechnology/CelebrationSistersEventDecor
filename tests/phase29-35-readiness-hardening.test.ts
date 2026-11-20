import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { evaluateApplicationReadiness } from '../server/app.ts';
import { redactSensitiveFields } from '../server/observability.ts';

test('Phase 29-35: redactSensitiveFields preserves non-PII email operational diagnostics while redacting PII & secrets', () => {
  const result = redactSensitiveFields({
    emailProvider: 'resend',
    emailLiveEnabled: true,
    emailConfigured: true,
    emailVerified: true,
    email: 'client@example.com',
    clientEmail: 'vip@example.com',
    staffNotificationEmail: 'directors@celebrationsistersdecor.com',
    apiKey: 're_supersecretkey1234567890',
    webhookSecret: 'whsec_testsecret1234567890',
  }) as Record<string, unknown>;

  assert.equal(result.emailProvider, 'resend');
  assert.equal(result.emailLiveEnabled, true);
  assert.equal(result.emailConfigured, true);
  assert.equal(result.emailVerified, true);
  assert.equal(result.email, '[REDACTED]');
  assert.equal(result.clientEmail, '[REDACTED]');
  assert.equal(result.staffNotificationEmail, '[REDACTED]');
  assert.equal(result.apiKey, '[REDACTED]');
  assert.equal(result.webhookSecret, '[REDACTED]');
});

test('Phase 29-35: evaluateApplicationReadiness fails closed (503) in production if outbox polling is disabled', () => {
  const readiness = evaluateApplicationReadiness({
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
      liveDeliveryEnabled: true,
      reason: 'ok',
    },
    worker: {
      workerId: 'outbox-worker-test',
      pollingActive: false,
      pollingDisabled: true,
      healthy: true,
      lastHeartbeatAt: null,
    },
    isProduction: true,
  });

  assert.equal(readiness.httpStatus, 503);
  assert.equal(readiness.ok, false);
  assert.equal(readiness.status, 'not_ready');
  assert.equal(readiness.checks.worker, false);
  assert.ok(
    readiness.blockingReasons.some((r) => r.includes('DISABLE_OUTBOX_POLLING=true')),
    `Expected DISABLE_OUTBOX_POLLING blocking reason, got: ${JSON.stringify(readiness.blockingReasons)}`,
  );
});

test('Phase 29-35: CI workflow triggers hosted checks on release/** branches', async () => {
  const ciYaml = await fs.readFile(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  assert.match(ciYaml, /'release\/\*\*'/);
  assert.match(ciYaml, /docker-build:/);
  assert.match(ciYaml, /npm audit --audit-level=high/);
});
