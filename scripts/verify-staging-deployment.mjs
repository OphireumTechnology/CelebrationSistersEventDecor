#!/usr/bin/env node
/**
 * Phase 34 & 39 Post-Deploy Verification Gate.
 *
 * GitHub CI success alone is NEVER sufficient proof of a healthy Railway deployment.
 * Enforces:
 *   GITHUB_APPROVED_SHA === RAILWAY_DEPLOYED_SHA === STAGING_TESTED_SHA
 *
 * Supports independent Railway GraphQL deployment metadata lookup when
 * RAILWAY_API_TOKEN (or RAILWAY_TOKEN) + RAILWAY_SERVICE_ID + RAILWAY_ENVIRONMENT_ID
 * are provided, and fails closed on missing evidence, SHA mismatch, non-HTTPS URLs,
 * unready database/migrations, unsafe live email enablement in staging, or broken
 * unauthenticated access guards.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA40_RE = /^[a-f0-9]{40}$/;
const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.app/graphql/v2';

export function isValidSha40(value) {
  return typeof value === 'string' && SHA40_RE.test(value.trim().toLowerCase());
}

/**
 * Independently retrieves the latest successful deployment metadata from Railway GraphQL API.
 * Never logs or echoes token values.
 */
export async function fetchRailwayDeployedCommitSha(
  { railwayToken = '', serviceId = '', environmentId = '', projectId = '' } = {},
  fetchImpl = fetch,
) {
  if (!railwayToken || !serviceId || !environmentId) {
    return {
      ok: false,
      blocked: true,
      reason: 'Missing RAILWAY_API_TOKEN, RAILWAY_SERVICE_ID, or RAILWAY_ENVIRONMENT_ID for independent Railway lookup.',
    };
  }

  const query = `
    query LatestStagingDeployments($input: DeploymentListInput!) {
      deployments(first: 5, input: $input) {
        edges {
          node {
            id
            status
            createdAt
            staticUrl
            meta
          }
        }
      }
    }
  `;

  const input = {
    serviceId,
    environmentId,
    ...(projectId ? { projectId } : {}),
  };

  const res = await fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${railwayToken}`,
    },
    body: JSON.stringify({ query, variables: { input } }),
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
  });

  if (!res.ok) {
    return {
      ok: false,
      blocked: false,
      reason: `Railway GraphQL API returned HTTP ${res.status}`,
    };
  }

  const payload = await res.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    return {
      ok: false,
      blocked: false,
      reason: `Railway GraphQL error: ${payload.errors[0]?.message || 'Unknown error'}`,
    };
  }

  const edges = payload?.data?.deployments?.edges || [];
  const activeSuccess = edges
    .map((e) => e?.node)
    .find((node) => node && node.status === 'SUCCESS');

  if (!activeSuccess) {
    return {
      ok: false,
      blocked: false,
      reason: 'No active SUCCESS deployment found for the specified Railway service and environment.',
    };
  }

  const meta = activeSuccess.meta && typeof activeSuccess.meta === 'object' ? activeSuccess.meta : {};
  const commitHash =
    typeof meta.commitHash === 'string'
      ? meta.commitHash.trim().toLowerCase()
      : typeof meta.commitSha === 'string'
        ? meta.commitSha.trim().toLowerCase()
        : '';

  if (!isValidSha40(commitHash)) {
    return {
      ok: false,
      blocked: false,
      reason: 'Railway deployment metadata did not contain a valid 40-character commitHash.',
    };
  }

  return {
    ok: true,
    blocked: false,
    deployedSha: commitHash,
    deploymentId: activeSuccess.id,
    deploymentStatus: activeSuccess.status,
    deployedAt: activeSuccess.createdAt || null,
    evidenceUrl: projectId
      ? `https://railway.app/project/${projectId}/service/${serviceId}?id=${activeSuccess.id}`
      : null,
  };
}

/**
 * Runs the full fail-closed staging deployment verification gate and returns a
 * machine-readable certification payload + deterministic process exit code:
 *   0 = PASS
 *   1 = FAILED
 *   2 = BLOCKED (missing independent evidence)
 */
export async function verifyStagingDeployment(env = process.env, fetchImpl = fetch) {
  const executedAt = new Date().toISOString();
  const checks = [];

  const stagingUrlRaw = env.STAGING_URL?.trim() || '';
  const githubApprovedSha = (env.GITHUB_APPROVED_SHA || env.EXPECTED_COMMIT_SHA || '')
    .trim()
    .toLowerCase();
  const railwayToken = (env.RAILWAY_API_TOKEN || env.RAILWAY_TOKEN || '').trim();
  const railwayServiceId = (env.RAILWAY_SERVICE_ID || '').trim();
  const railwayEnvironmentId = (env.RAILWAY_ENVIRONMENT_ID || '').trim();
  const railwayProjectId = (env.RAILWAY_PROJECT_ID || '').trim();

  let railwayDeployedSha = (env.RAILWAY_DEPLOYED_SHA || env.DEPLOYED_COMMIT_SHA || '')
    .trim()
    .toLowerCase();
  let shaEvidenceSource = railwayDeployedSha ? 'independent_env_metadata' : 'none';
  let railwayDeploymentId = null;
  let railwayEvidenceUrl = null;

  if (railwayToken && railwayServiceId && railwayEnvironmentId) {
    const railwayLookup = await fetchRailwayDeployedCommitSha(
      {
        railwayToken,
        serviceId: railwayServiceId,
        environmentId: railwayEnvironmentId,
        projectId: railwayProjectId || undefined,
      },
      fetchImpl,
    );
    if (!railwayLookup.ok) {
      checks.push({
        id: 'railway_metadata_lookup',
        passed: false,
        detail: railwayLookup.reason,
      });
      return {
        status: railwayLookup.blocked ? 'BLOCKED' : 'FAILED',
        exitCode: railwayLookup.blocked ? 2 : 1,
        executedAt,
        stagingUrl: stagingUrlRaw || null,
        githubApprovedSha: githubApprovedSha || null,
        railwayDeployedSha: null,
        stagingTestedSha: null,
        shaEvidenceSource: 'railway_graphql_api',
        railwayDeploymentId: null,
        railwayEvidenceUrl: null,
        checks,
      };
    }
    railwayDeployedSha = railwayLookup.deployedSha;
    shaEvidenceSource = 'railway_graphql_api';
    railwayDeploymentId = railwayLookup.deploymentId;
    railwayEvidenceUrl = railwayLookup.evidenceUrl;
    checks.push({
      id: 'railway_metadata_lookup',
      passed: true,
      detail: `Retrieved SUCCESS deployment ${railwayDeploymentId} (${railwayDeployedSha}) directly from Railway GraphQL API`,
    });
  }

  const missing = [];
  if (!stagingUrlRaw) missing.push('STAGING_URL');
  if (!githubApprovedSha) missing.push('EXPECTED_COMMIT_SHA/GITHUB_APPROVED_SHA');
  if (!railwayDeployedSha) missing.push('DEPLOYED_COMMIT_SHA (or RAILWAY_API_TOKEN + RAILWAY_SERVICE_ID + RAILWAY_ENVIRONMENT_ID)');

  if (missing.length > 0) {
    checks.push({
      id: 'independent_evidence_present',
      passed: false,
      detail: `Missing independent deployment evidence: ${missing.join(', ')}`,
    });
    return {
      status: 'BLOCKED',
      exitCode: 2,
      executedAt,
      stagingUrl: stagingUrlRaw || null,
      githubApprovedSha: githubApprovedSha || null,
      railwayDeployedSha: railwayDeployedSha || null,
      stagingTestedSha: null,
      shaEvidenceSource,
      railwayDeploymentId,
      railwayEvidenceUrl,
      checks,
    };
  }

  const stagingTestedSha = (env.STAGING_TESTED_SHA || railwayDeployedSha).trim().toLowerCase();

  // 1. Strict three-way SHA synchronization invariant
  const shaSynced =
    isValidSha40(githubApprovedSha) &&
    isValidSha40(railwayDeployedSha) &&
    isValidSha40(stagingTestedSha) &&
    githubApprovedSha === railwayDeployedSha &&
    railwayDeployedSha === stagingTestedSha;

  checks.push({
    id: 'three_way_commit_sha_sync',
    passed: shaSynced,
    detail: shaSynced
      ? `GITHUB_APPROVED_SHA === RAILWAY_DEPLOYED_SHA === STAGING_TESTED_SHA (${githubApprovedSha})`
      : `Commit SHA mismatch or invalid SHA (github=${githubApprovedSha}, railway=${railwayDeployedSha}, tested=${stagingTestedSha})`,
  });

  if (!shaSynced) {
    return {
      status: 'FAILED',
      exitCode: 1,
      executedAt,
      stagingUrl: stagingUrlRaw,
      githubApprovedSha,
      railwayDeployedSha,
      stagingTestedSha,
      shaEvidenceSource,
      railwayDeploymentId,
      railwayEvidenceUrl,
      checks,
    };
  }

  // 2. Strict HTTPS & same-origin path safety
  let origin;
  try {
    origin = new URL(stagingUrlRaw);
  } catch {
    checks.push({ id: 'https_origin', passed: false, detail: 'Invalid STAGING_URL format' });
    return {
      status: 'FAILED',
      exitCode: 1,
      executedAt,
      stagingUrl: stagingUrlRaw,
      githubApprovedSha,
      railwayDeployedSha,
      stagingTestedSha,
      shaEvidenceSource,
      railwayDeploymentId,
      railwayEvidenceUrl,
      checks,
    };
  }

  if (origin.protocol !== 'https:') {
    checks.push({ id: 'https_origin', passed: false, detail: 'STAGING_URL must use HTTPS' });
    return {
      status: 'FAILED',
      exitCode: 1,
      executedAt,
      stagingUrl: stagingUrlRaw,
      githubApprovedSha,
      railwayDeployedSha,
      stagingTestedSha,
      shaEvidenceSource,
      railwayDeploymentId,
      railwayEvidenceUrl,
      checks,
    };
  }

  const healthPath = env.STAGING_HEALTH_PATH || '/health';
  const readyPath = env.STAGING_READY_PATH || '/ready';
  const healthUrl = new URL(healthPath, origin);
  const readyUrl = new URL(readyPath, origin);
  if (healthUrl.origin !== origin.origin || readyUrl.origin !== origin.origin) {
    checks.push({
      id: 'https_origin',
      passed: false,
      detail: 'Health and readiness paths must remain strictly on the staging origin',
    });
    return {
      status: 'FAILED',
      exitCode: 1,
      executedAt,
      stagingUrl: stagingUrlRaw,
      githubApprovedSha,
      railwayDeployedSha,
      stagingTestedSha,
      shaEvidenceSource,
      railwayDeploymentId,
      railwayEvidenceUrl,
      checks,
    };
  }
  checks.push({ id: 'https_origin', passed: true, detail: `Verified HTTPS origin ${origin.origin}` });

  const requestOpts = { signal: AbortSignal.timeout(12000), redirect: 'error' };

  // 3. Live HTTPS /health check
  try {
    const healthRes = await fetchImpl(healthUrl, requestOpts);
    const healthBody = await healthRes.json().catch(() => ({}));
    const healthPassed = healthRes.ok && healthBody?.ok === true;
    checks.push({
      id: 'https_health',
      passed: healthPassed,
      detail: `GET ${healthPath} -> HTTP ${healthRes.status}, ok=${String(healthBody?.ok)}`,
    });
  } catch (err) {
    checks.push({
      id: 'https_health',
      passed: false,
      detail: `GET ${healthPath} error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. Live HTTPS /ready check (database, migrations, overlap constraint, auth, worker, safe paused email)
  try {
    const readyRes = await fetchImpl(readyUrl, requestOpts);
    const readyBody = await readyRes.json().catch(() => ({}));
    const dbReady =
      readyRes.ok &&
      readyBody?.ok === true &&
      readyBody?.checks?.database === true &&
      readyBody?.checks?.migrations === true &&
      readyBody?.checks?.schemaObjects === true &&
      readyBody?.checks?.auth === true &&
      readyBody?.checks?.worker === true &&
      readyBody?.persistence?.schema?.overlapConstraintPresent === true;

    checks.push({
      id: 'database_and_readiness',
      passed: dbReady,
      detail: `GET ${readyPath} -> HTTP ${readyRes.status}, db=${String(readyBody?.checks?.database)}, migrations=${String(readyBody?.persistence?.schema?.migrationsAppliedCount ?? 'n/a')}, overlapConstraint=${String(readyBody?.persistence?.schema?.overlapConstraintPresent)}`,
    });

    const requirePausedEmail = env.ALLOW_STAGING_LIVE_EMAIL !== 'true';
    const emailSafe = !requirePausedEmail || readyBody?.email?.liveDeliveryEnabled === false;
    checks.push({
      id: 'staging_email_safety',
      passed: emailSafe,
      detail: `email.configured=${String(readyBody?.email?.configured)}, email.liveDeliveryEnabled=${String(readyBody?.email?.liveDeliveryEnabled)}`,
    });
  } catch (err) {
    checks.push({
      id: 'database_and_readiness',
      passed: false,
      detail: `GET ${readyPath} error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 5. Auth configuration & unauthenticated fail-closed security boundary checks
  try {
    const [cfgRes, bkgRes, admRes] = await Promise.all([
      fetchImpl(new URL('/api/auth/config', origin), requestOpts),
      fetchImpl(new URL('/api/bookings', origin), requestOpts),
      fetchImpl(new URL('/api/admin/overview', origin), requestOpts),
    ]);
    const cfgBody = await cfgRes.json().catch(() => ({}));
    const authGuardOk =
      cfgRes.ok &&
      cfgBody?.demoPersonasAvailable === false &&
      cfgBody?.readyForProductionAuth === true &&
      bkgRes.status === 401 &&
      admRes.status === 403;

    checks.push({
      id: 'auth_fail_closed_security',
      passed: authGuardOk,
      detail: `/api/auth/config=${cfgRes.status} (demoPersonas=${String(cfgBody?.demoPersonasAvailable)}, ready=${String(cfgBody?.readyForProductionAuth)}), unauth /api/bookings=${bkgRes.status}, unauth /api/admin/overview=${admRes.status}`,
    });
  } catch (err) {
    checks.push({
      id: 'auth_fail_closed_security',
      passed: false,
      detail: `Auth boundary check error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 6. Optional authenticated admin AAL2 check when secret token is supplied in CI
  if (env.STAGING_ADMIN_AAL2_TOKEN) {
    try {
      const adminRes = await fetchImpl(new URL('/api/admin/overview', origin), {
        ...requestOpts,
        headers: { Authorization: `Bearer ${env.STAGING_ADMIN_AAL2_TOKEN.trim()}` },
      });
      checks.push({
        id: 'authenticated_admin_aal2',
        passed: adminRes.status === 200,
        detail: `Authenticated AAL2 GET /api/admin/overview -> HTTP ${adminRes.status}`,
      });
    } catch (err) {
      checks.push({
        id: 'authenticated_admin_aal2',
        passed: false,
        detail: `Authenticated AAL2 check error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const allPassed = checks.every((c) => c.passed);
  return {
    status: allPassed ? 'PASS' : 'FAILED',
    exitCode: allPassed ? 0 : 1,
    executedAt,
    stagingUrl: origin.origin,
    githubApprovedSha,
    railwayDeployedSha,
    stagingTestedSha,
    shaEvidenceSource,
    railwayDeploymentId,
    railwayEvidenceUrl,
    checks,
  };
}

function parseOutputPath(argv) {
  const idx = argv.indexOf('--output');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return process.env.CERTIFICATION_OUTPUT_PATH || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const result = await verifyStagingDeployment(process.env);
  const json = JSON.stringify(result, null, 2);
  if (outputPath) {
    await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await fs.writeFile(path.resolve(outputPath), json + '\n', 'utf8');
  }
  if (result.exitCode === 0) {
    console.log(json);
  } else {
    console.error(json);
  }
  process.exit(result.exitCode);
}
