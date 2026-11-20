import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizedStagingAdmin, stagingExternalAuthEnabled, STAGING_ADMIN_SUBJECT, STAGING_AUTH_ISSUER } from '../server/stagingExternalAuthPolicy.ts';
const env = { RAILWAY_ENVIRONMENT_NAME:'staging', STAGING_DB_CONFIRM:'YES_ISOLATED_STAGING', EMAIL_LIVE_DELIVERY_ENABLED:'false', PHASE19_EXTERNAL_AUTH_READ_ONLY:'YES_EXTERNAL_AUTH_STAGING_ONLY', PHASE19_EXTERNAL_AUTH_PROJECT_REF:'nswxwwmtcasmkjtmrdqg' };
const claims = { sub: STAGING_ADMIN_SUBJECT, aal:'aal2' as const, rawClaims:{} };
test('external Auth opt-in requires isolated staging and live email off', () => {
  assert.equal(stagingExternalAuthEnabled(env), true);
  for (const [key,value] of Object.entries({RAILWAY_ENVIRONMENT_NAME:'production', STAGING_DB_CONFIRM:'', EMAIL_LIVE_DELIVERY_ENABLED:'true', PHASE19_EXTERNAL_AUTH_READ_ONLY:'', PHASE19_EXTERNAL_AUTH_PROJECT_REF:'other'})) {
    assert.equal(stagingExternalAuthEnabled({...env,[key]:value}),false,key);
  }
});
test('only trusted immutable subject with AAL2 and verified issuer passes', () => {
  assert.equal(authorizedStagingAdmin(claims,STAGING_AUTH_ISSUER,env),true);
  assert.equal(authorizedStagingAdmin({...claims,sub:'43d8d6ae-a4a3-41a0-a099-a19f10c0be72'},STAGING_AUTH_ISSUER,env),false);
  assert.equal(authorizedStagingAdmin({...claims,aal:'aal1'},STAGING_AUTH_ISSUER,env),false);
  assert.equal(authorizedStagingAdmin(claims,'https://other.supabase.co/auth/v1',env),false);
  assert.equal(authorizedStagingAdmin({...claims,sub:'attacker',rawClaims:{user_metadata:{role:'admin'}}},STAGING_AUTH_ISSUER,env),false);
  assert.equal(authorizedStagingAdmin(claims,STAGING_AUTH_ISSUER,{...env,RAILWAY_ENVIRONMENT_NAME:'production'}),false);
});
