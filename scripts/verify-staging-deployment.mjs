#!/usr/bin/env node
/**
 * Post-deploy verification gate. GitHub CI success alone is insufficient.
 * Set STAGING_URL, EXPECTED_COMMIT_SHA and DEPLOYED_COMMIT_SHA from independent
 * Railway deployment metadata. Never trust a user-supplied claimed SHA as proof.
 * Exit nonzero on missing evidence, mismatched SHA, or unhealthy endpoints.
 */
const required = ['STAGING_URL','EXPECTED_COMMIT_SHA','DEPLOYED_COMMIT_SHA'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('BLOCKED: missing independent deployment evidence: '+missing.join(', '));
  process.exit(2);
}
const expected = process.env.EXPECTED_COMMIT_SHA.toLowerCase();
const deployed = process.env.DEPLOYED_COMMIT_SHA.toLowerCase();
if (!/^[a-f0-9]{40}$/.test(expected) || !/^[a-f0-9]{40}$/.test(deployed) || expected !== deployed) {
  console.error('FAILED: GitHub commit SHA does not match deployed Railway SHA.');
  process.exit(1);
}
const origin = new URL(process.env.STAGING_URL);
if (origin.protocol !== 'https:') {
  console.error('FAILED: staging URL must use HTTPS');
  process.exit(1);
}
const healthPath = process.env.STAGING_HEALTH_PATH || '/api/health';
const healthUrl = new URL(healthPath, origin);
if (healthUrl.origin !== origin.origin) {
  console.error('FAILED: health path must remain on staging origin');
  process.exit(1);
}
try {
  const res = await fetch(healthUrl, {signal:AbortSignal.timeout(12000), redirect:'error'});
  if (!res.ok) throw new Error('health endpoint returned HTTP '+res.status);
  console.log('PASS: Railway SHA matches GitHub; HTTPS health endpoint returned '+res.status);
  console.log('NOTE: auth, MFA, database and isolation tests require separate live certification.');
} catch (error) {
  console.error('FAILED: staging health verification: '+error.message);
  process.exit(1);
}
