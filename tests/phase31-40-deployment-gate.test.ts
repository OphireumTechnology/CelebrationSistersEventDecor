import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  fetchRailwayDeployedCommitSha,
  verifyStagingDeployment,
} from '../scripts/verify-staging-deployment.mjs';

const SHA_A = 'fdf693187be1993aa151f0ab8b2f0b41fb44fff7';
const SHA_B = 'de848c890138ee00db72ce08e093a0f337215226';
const STAGING_ORIGIN = 'https://celebrationsisterseventdecor-staging-staging.up.railway.app';

function createMockFetch(overrides?: {
  railwaySha?: string;
  healthStatus?: number;
  readyStatus?: number;
  readyBody?: Record<string, unknown>;
  configBody?: Record<string, unknown>;
  unauthBookingsStatus?: number;
  unauthAdminStatus?: number;
  authedAdminStatus?: number;
}) {
  return async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('backboard.railway.app/graphql/v2')) {
      return new Response(
        JSON.stringify({
          data: {
            deployments: {
              edges: [
                {
                  node: {
                    id: 'dep-staging-001',
                    status: 'SUCCESS',
                    createdAt: '2026-11-20T22:45:00.000Z',
                    meta: { commitHash: overrides?.railwaySha ?? SHA_A },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith('/health')) {
      const status = overrides?.healthStatus ?? 200;
      return new Response(JSON.stringify({ ok: status === 200, status: 'alive' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/ready')) {
      const status = overrides?.readyStatus ?? 200;
      const body = overrides?.readyBody ?? {
        ok: true,
        checks: {
          database: true,
          migrations: true,
          schemaObjects: true,
          auth: true,
          email: true,
          worker: true,
        },
        persistence: {
          schema: {
            migrationsAppliedCount: 8,
            overlapConstraintPresent: true,
          },
        },
        email: {
          configured: true,
          liveDeliveryEnabled: false,
        },
      };
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/auth/config')) {
      return new Response(
        JSON.stringify(
          overrides?.configBody ?? {
            demoPersonasAvailable: false,
            readyForProductionAuth: true,
          },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith('/api/bookings')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: overrides?.unauthBookingsStatus ?? 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/admin/overview')) {
      const headers = (init?.headers || {}) as Record<string, string>;
      if (headers.Authorization?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: overrides?.authedAdminStatus ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: overrides?.unauthAdminStatus ?? 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
  };
}

test('Phase 34/39: verifyStagingDeployment returns BLOCKED (exit 2) when independent Railway evidence is missing', async () => {
  const result = await verifyStagingDeployment(
    { STAGING_URL: STAGING_ORIGIN, GITHUB_APPROVED_SHA: SHA_A },
    createMockFetch() as unknown as typeof fetch,
  );
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.exitCode, 2);
});

test('Phase 34/39: verifyStagingDeployment independently fetches Railway SHA via GraphQL and fails closed on SHA mismatch', async () => {
  const mismatch = await verifyStagingDeployment(
    {
      STAGING_URL: STAGING_ORIGIN,
      GITHUB_APPROVED_SHA: SHA_A,
      RAILWAY_API_TOKEN: 'rw-test-placeholder-token',
      RAILWAY_PROJECT_ID: 'proj-1',
      RAILWAY_ENVIRONMENT_ID: 'env-1',
      RAILWAY_SERVICE_ID: 'svc-1',
    },
    createMockFetch({ railwaySha: SHA_B }) as unknown as typeof fetch,
  );
  assert.equal(mismatch.status, 'FAILED');
  assert.equal(mismatch.exitCode, 1);
  assert.equal(mismatch.githubApprovedSha, SHA_A);
  assert.equal(mismatch.railwayDeployedSha, SHA_B);
  assert.equal(mismatch.shaEvidenceSource, 'railway_graphql_api');
});

test('Phase 34/39: verifyStagingDeployment passes when GITHUB === RAILWAY === STAGING SHA and all live health, DB, email-safety, and auth checks succeed', async () => {
  const pass = await verifyStagingDeployment(
    {
      STAGING_URL: STAGING_ORIGIN,
      GITHUB_APPROVED_SHA: SHA_A,
      RAILWAY_API_TOKEN: 'rw-test-placeholder-token',
      RAILWAY_PROJECT_ID: 'proj-1',
      RAILWAY_ENVIRONMENT_ID: 'env-1',
      RAILWAY_SERVICE_ID: 'svc-1',
      STAGING_ADMIN_AAL2_TOKEN: 'jwt-aal2-test',
    },
    createMockFetch({ railwaySha: SHA_A }) as unknown as typeof fetch,
  );
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.githubApprovedSha, SHA_A);
  assert.equal(pass.railwayDeployedSha, SHA_A);
  assert.equal(pass.stagingTestedSha, SHA_A);
  assert.equal(pass.railwayDeploymentId, 'dep-staging-001');
  assert.ok(pass.checks.every((c: { passed: boolean }) => c.passed));
});

test('Phase 34/39: verifyStagingDeployment fails closed on non-HTTPS origin, cross-origin health path, unready DB, live staging email enabled, or broken auth guard', async () => {
  const httpRes = await verifyStagingDeployment(
    { STAGING_URL: 'http://example.test', GITHUB_APPROVED_SHA: SHA_A, DEPLOYED_COMMIT_SHA: SHA_A },
    createMockFetch() as unknown as typeof fetch,
  );
  assert.equal(httpRes.exitCode, 1);

  const crossOriginPath = await verifyStagingDeployment(
    {
      STAGING_URL: STAGING_ORIGIN,
      GITHUB_APPROVED_SHA: SHA_A,
      DEPLOYED_COMMIT_SHA: SHA_A,
      STAGING_HEALTH_PATH: 'https://evil.example.test/health',
    },
    createMockFetch() as unknown as typeof fetch,
  );
  assert.equal(crossOriginPath.exitCode, 1);

  const liveEmailEnabled = await verifyStagingDeployment(
    { STAGING_URL: STAGING_ORIGIN, GITHUB_APPROVED_SHA: SHA_A, DEPLOYED_COMMIT_SHA: SHA_A },
    createMockFetch({
      readyBody: {
        ok: true,
        checks: { database: true, migrations: true, schemaObjects: true, auth: true, worker: true },
        persistence: { schema: { migrationsAppliedCount: 8, overlapConstraintPresent: true } },
        email: { configured: true, liveDeliveryEnabled: true },
      },
    }) as unknown as typeof fetch,
  );
  assert.equal(liveEmailEnabled.exitCode, 1);

  const authLeak = await verifyStagingDeployment(
    { STAGING_URL: STAGING_ORIGIN, GITHUB_APPROVED_SHA: SHA_A, DEPLOYED_COMMIT_SHA: SHA_A },
    createMockFetch({ unauthBookingsStatus: 200 }) as unknown as typeof fetch,
  );
  assert.equal(authLeak.exitCode, 1);

  const missingTokenLookup = await fetchRailwayDeployedCommitSha({
    railwayToken: '',
    serviceId: '',
    environmentId: '',
    projectId: '',
  });
  assert.equal(missingTokenLookup.blocked, true);
});

test('Phase 39: dedicated staging-deployment-gate workflow integrates verify-staging-deployment.mjs separately from CI', async () => {
  const workflowPath = path.resolve(process.cwd(), '.github/workflows/staging-deployment-gate.yml');
  const content = await fs.readFile(workflowPath, 'utf8');
  assert.ok(content.includes('scripts/verify-staging-deployment.mjs'));
  assert.ok(content.includes('RAILWAY_API_TOKEN'));
  assert.ok(content.includes('staging-deployment-certification.json'));
  assert.ok(content.includes('actions/upload-artifact@v4'));
});
