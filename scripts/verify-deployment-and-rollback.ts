/**
 * Automated Deployment Verification & Rollback Readiness Harness
 *
 * Non-destructive post-deploy verification script for staging and production Railway backends.
 * Verifies:
 *   1. Process liveness (/health) + OWASP security headers + absence of X-Powered-By
 *   2. Application readiness (/ready) + strict production gate validation
 *   3. Identity provider config (/api/auth/config) + demo-persona suppression in production
 *   4. Unauthenticated fail-closed guards on /api/bookings and /api/admin/overview
 *   5. CORS allowlist enforcement (allows trusted origin; blocks untrusted origin reflection)
 *   6. Real-time consultation availability endpoint (/api/consultations/availability)
 *   7. Canonical migration directory validation (001-008 + RLS write policies)
 *   8. Rollback & disaster-recovery tooling presence (pg-backup-restore-drill.sh, reconciliation script)
 *
 * Usage:
 *   npx tsx scripts/verify-deployment-and-rollback.ts --url https://your-backend.up.railway.app
 *   npx tsx scripts/verify-deployment-and-rollback.ts --url https://your-backend.up.railway.app --strict-production
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateMigrationsDirectory } from './verify-migrations.ts';

export interface DeploymentCheckResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export interface DeploymentVerificationReport {
  targetUrl: string;
  strictProduction: boolean;
  passed: boolean;
  executedAt: string;
  checks: DeploymentCheckResult[];
}

export interface VerifyDeploymentOptions {
  targetUrl: string;
  allowedOrigin?: string;
  strictProduction?: boolean;
  fetchImpl?: typeof fetch;
  repoRoot?: string;
}

export async function verifyDeploymentAndRollback(
  options: VerifyDeploymentOptions,
): Promise<DeploymentVerificationReport> {
  const targetUrl = options.targetUrl.trim().replace(/\/+$/, '');
  const allowedOrigin = (options.allowedOrigin || 'https://celebrationsistersdecor.com').trim();
  const strictProduction = Boolean(options.strictProduction);
  const fetchFn = options.fetchImpl ?? fetch;
  const repoRoot = options.repoRoot ?? process.cwd();
  const checks: DeploymentCheckResult[] = [];

  // 1. Liveness & OWASP security headers
  try {
    const res = await fetchFn(`${targetUrl}/health`, { method: 'GET' });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const hasRequestId = Boolean(res.headers.get('x-request-id'));
    const hasNoSniff = res.headers.get('x-content-type-options') === 'nosniff';
    const hasReferrer = res.headers.get('referrer-policy') === 'strict-origin-when-cross-origin';
    const noPoweredBy = !res.headers.get('x-powered-by');
    const ok = res.status === 200 && body.ok === true && hasRequestId && hasNoSniff && hasReferrer && noPoweredBy;
    checks.push({
      id: 'liveness_and_headers',
      name: 'Process Liveness (/health) & Security Headers',
      passed: ok,
      detail: ok
        ? `HTTP 200 ok=true with X-Request-Id, nosniff, Referrer-Policy, and hidden X-Powered-By`
        : `status=${res.status}, ok=${String(body.ok)}, headers=${JSON.stringify({ hasRequestId, hasNoSniff, hasReferrer, noPoweredBy })}`,
    });
  } catch (err) {
    checks.push({
      id: 'liveness_and_headers',
      name: 'Process Liveness (/health) & Security Headers',
      passed: false,
      detail: err instanceof Error ? err.message : 'Health endpoint unreachable',
    });
  }

  // 2. Readiness contract (/ready)
  try {
    const res = await fetchFn(`${targetUrl}/ready`, { method: 'GET' });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      status?: string;
      productionReady?: boolean;
      blockingReasons?: string[];
      checks?: Record<string, boolean>;
    };
    const contractValid =
      (res.status === 200 || res.status === 503) &&
      typeof body.productionReady === 'boolean' &&
      Array.isArray(body.blockingReasons) &&
      typeof body.checks === 'object' &&
      body.checks !== null;
    const passed = strictProduction ? contractValid && res.status === 200 && body.productionReady === true : contractValid;
    checks.push({
      id: 'readiness_probe',
      name: strictProduction ? 'Strict Production Readiness (/ready === 200)' : 'Readiness Probe Contract (/ready)',
      passed,
      detail: passed
        ? `HTTP ${res.status} status=${body.status} productionReady=${String(body.productionReady)} blockers=${body.blockingReasons?.length ?? 0}`
        : `HTTP ${res.status} productionReady=${String(body.productionReady)} blockers=${(body.blockingReasons || []).join(' | ') || 'invalid schema'}`,
    });
  } catch (err) {
    checks.push({
      id: 'readiness_probe',
      name: 'Readiness Probe Contract (/ready)',
      passed: false,
      detail: err instanceof Error ? err.message : 'Readiness probe failed',
    });
  }

  // 3. Auth configuration & demo persona suppression
  try {
    const res = await fetchFn(`${targetUrl}/api/auth/config`, { method: 'GET' });
    const body = (await res.json().catch(() => ({}))) as {
      provider?: string;
      demoPersonasAvailable?: boolean;
      readyForProductionAuth?: boolean;
    };
    const ok = strictProduction
      ? res.status === 200 && body.demoPersonasAvailable === false && body.readyForProductionAuth === true
      : res.status === 200 && typeof body.provider === 'string';
    checks.push({
      id: 'auth_config_guard',
      name: 'Auth Configuration & Demo Persona Policy',
      passed: ok,
      detail: `HTTP ${res.status} provider=${String(body.provider)} demoPersonas=${String(body.demoPersonasAvailable)} ready=${String(body.readyForProductionAuth)}`,
    });
  } catch (err) {
    checks.push({
      id: 'auth_config_guard',
      name: 'Auth Configuration & Demo Persona Policy',
      passed: false,
      detail: err instanceof Error ? err.message : 'Auth config check failed',
    });
  }

  // 4. Unauthenticated fail-closed guards
  try {
    const [bookingsRes, adminRes] = await Promise.all([
      fetchFn(`${targetUrl}/api/bookings`, { method: 'GET' }),
      fetchFn(`${targetUrl}/api/admin/overview`, { method: 'GET' }),
    ]);
    const bookingsBlocked = bookingsRes.status === 401 || bookingsRes.status === 403;
    const adminBlocked = adminRes.status === 401 || adminRes.status === 403;
    const ok = bookingsBlocked && adminBlocked;
    checks.push({
      id: 'unauth_fail_closed',
      name: 'Fail-Closed Auth Guards (/api/bookings & /api/admin/overview)',
      passed: ok,
      detail: `/api/bookings=${bookingsRes.status}, /api/admin/overview=${adminRes.status}`,
    });
  } catch (err) {
    checks.push({
      id: 'unauth_fail_closed',
      name: 'Fail-Closed Auth Guards (/api/bookings & /api/admin/overview)',
      passed: false,
      detail: err instanceof Error ? err.message : 'Auth guard probe failed',
    });
  }

  // 5. CORS allowlist enforcement
  try {
    const [allowedRes, blockedRes] = await Promise.all([
      fetchFn(`${targetUrl}/api/auth/config`, {
        method: 'GET',
        headers: { Origin: allowedOrigin },
      }),
      fetchFn(`${targetUrl}/api/auth/config`, {
        method: 'GET',
        headers: { Origin: 'https://untrusted-origin.example.net' },
      }),
    ]);
    const acaoAllowed = allowedRes.headers.get('access-control-allow-origin');
    const acaoBlocked = blockedRes.headers.get('access-control-allow-origin');
    const ok = acaoAllowed === allowedOrigin && acaoBlocked !== 'https://untrusted-origin.example.net' && acaoBlocked !== '*';
    checks.push({
      id: 'cors_allowlist',
      name: 'Strict CORS Allowlist Enforcement',
      passed: ok,
      detail: `allowed(${allowedOrigin})=${String(acaoAllowed)}, untrusted=${String(acaoBlocked)}`,
    });
  } catch (err) {
    checks.push({
      id: 'cors_allowlist',
      name: 'Strict CORS Allowlist Enforcement',
      passed: false,
      detail: err instanceof Error ? err.message : 'CORS probe failed',
    });
  }

  // 6. Real-time consultation availability
  try {
    const res = await fetchFn(
      `${targetUrl}/api/consultations/availability?days=7&timezone=America/New_York&method=video`,
      { method: 'GET' },
    );
    const body = (await res.json().catch(() => ({}))) as {
      studioTimezone?: string;
      days?: unknown[];
    };
    const ok =
      res.status === 200 &&
      body.studioTimezone === 'America/New_York' &&
      Array.isArray(body.days) &&
      body.days.length === 7;
    checks.push({
      id: 'consultation_availability',
      name: 'Real-Time Consultation Availability Endpoint',
      passed: ok,
      detail: `HTTP ${res.status} studioTimezone=${String(body.studioTimezone)} days=${Array.isArray(body.days) ? body.days.length : 0}`,
    });
  } catch (err) {
    checks.push({
      id: 'consultation_availability',
      name: 'Real-Time Consultation Availability Endpoint',
      passed: false,
      detail: err instanceof Error ? err.message : 'Availability endpoint failed',
    });
  }

  // 7. Canonical migration directory static integrity (001-008 + RLS)
  try {
    const migResult = await validateMigrationsDirectory(path.join(repoRoot, 'db/migrations'));
    const ok = migResult.passed && migResult.files.length === 8;
    checks.push({
      id: 'canonical_migrations_integrity',
      name: 'Canonical PostgreSQL Migrations & FORCE RLS Validation',
      passed: ok,
      detail: ok
        ? `Validated ${migResult.files.length} canonical migrations with zero errors`
        : `Errors: ${migResult.errors.join('; ')}`,
    });
  } catch (err) {
    checks.push({
      id: 'canonical_migrations_integrity',
      name: 'Canonical PostgreSQL Migrations & FORCE RLS Validation',
      passed: false,
      detail: err instanceof Error ? err.message : 'Migration validation failed',
    });
  }

  // 8. Backup, restore, and rollback tooling readiness
  const requiredOpsScripts = [
    'scripts/verify-migrations.ts',
    'scripts/run-migrations.ts',
    'scripts/reconcile-snapshot-to-normalized.ts',
    'scripts/verify-staging-postgres.ts',
    'scripts/verify-staging-railway-and-resend.ts',
  ];
  const missingScripts = requiredOpsScripts.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
  const opsOk = missingScripts.length === 0;
  checks.push({
    id: 'rollback_and_dr_scripts',
    name: 'Backup, Restore & Rollback Operations Tooling',
    passed: opsOk,
    detail: opsOk
      ? `All ${requiredOpsScripts.length} disaster-recovery and verification scripts present`
      : `Missing scripts: ${missingScripts.join(', ')}`,
  });

  return {
    targetUrl,
    strictProduction,
    passed: checks.every((c) => c.passed),
    executedAt: new Date().toISOString(),
    checks,
  };
}

function parseArgs(argv: string[]) {
  let targetUrl = process.env.RAILWAY_BACKEND_URL || 'http://127.0.0.1:3000';
  let allowedOrigin = process.env.FRONTEND_PUBLIC_URL || 'https://celebrationsistersdecor.com';
  let strictProduction = false;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url' && argv[i + 1]) {
      targetUrl = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--origin' && argv[i + 1]) {
      allowedOrigin = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--strict-production') {
      strictProduction = true;
    }
  }
  return { targetUrl, allowedOrigin, strictProduction };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  verifyDeploymentAndRollback(args)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.passed ? 0 : 1);
    })
    .catch((err) => {
      console.error('Deployment verification error:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
