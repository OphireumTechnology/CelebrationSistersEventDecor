import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyProviderAccessToken, resolveTrustedUserFromClaims } from '../server/identityProvider.ts';
import type { UserSession } from '../src/types/domain.ts';

// Phase 19 deterministic cryptographic contract tests. These are NOT a substitute
// for a real token issued by the connected Supabase staging Auth project.
const issuer = 'https://phase19-staging.supabase.co/auth/v1';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const resolver = async () => publicKey;
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    email: 'client@example.test',
    email_verified: true,
    aal: 'aal1',
    user_metadata: { role: 'admin' },
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256' })
    .setSubject('00000000-0000-4000-8000-000000000019')
    .setIssuer(issuer)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
const options = { supabaseUrl: 'https://phase19-staging.supabase.co', keyResolver: resolver };

test('Phase19: valid cryptographically signed JWT is accepted but mutable metadata cannot grant admin', async () => {
  const claims = await verifyProviderAccessToken(await token(), options);
  assert.ok(claims);
  const result = resolveTrustedUserFromClaims(claims, []);
  assert.equal(result.user.role, 'client');
  assert.equal(result.emailVerified, true);
});

test('Phase19: tampered signature is rejected', async () => {
  const original = await token();
  const parts = original.split('.');
  const signature = parts[2];
  parts[2] = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  assert.equal(await verifyProviderAccessToken(parts.join('.'), options), null);
});

test('Phase19: wrong issuer and audience are rejected', async () => {
  const wrongIssuer = await new SignJWT({ email: 'client@example.test' })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('test').setIssuer('https://other.supabase.co/auth/v1')
    .setAudience('authenticated').setExpirationTime('5m').sign(privateKey);
  assert.equal(await verifyProviderAccessToken(wrongIssuer, options), null);
  const wrongAudience = await new SignJWT({ email: 'client@example.test' })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('test').setIssuer(issuer)
    .setAudience('service_role').setExpirationTime('5m').sign(privateKey);
  assert.equal(await verifyProviderAccessToken(wrongAudience, options), null);
});

test('Phase19: expired signed JWT is rejected', async () => {
  const expired = await new SignJWT({ email: 'client@example.test' })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('test').setIssuer(issuer)
    .setAudience('authenticated').setIssuedAt(1).setExpirationTime(2).sign(privateKey);
  assert.equal(await verifyProviderAccessToken(expired, options), null);
});

test('Phase19: matching privileged email never binds a different Supabase subject', async () => {
  const claims = await verifyProviderAccessToken(await token({ email: 'admin@example.test' }), options);
  assert.ok(claims);
  const admin = {
    id: 'admin-1', supabaseUserId: '00000000-0000-4000-8000-000000000020',
    name: 'Staging Admin', email: 'admin@example.test', role: 'admin',
    emailVerified: true, accountStatus: 'active',
  } as UserSession;
  const resolved = resolveTrustedUserFromClaims(claims, [admin]);
  assert.equal(resolved.user.role, 'client');
  assert.equal(resolved.emailPrivilegeBindBlocked, true);
});

test('Phase19: linked admin requires AAL2 MFA', async () => {
  const claims = await verifyProviderAccessToken(await token(), options);
  assert.ok(claims);
  const admin = {
    id: 'admin-1', supabaseUserId: claims.sub, name: 'Staging Admin',
    email: claims.email, role: 'admin', emailVerified: true, accountStatus: 'active',
  } as UserSession;
  const aal1 = resolveTrustedUserFromClaims(claims, [admin]);
  assert.equal(aal1.user.role, 'admin');
  assert.equal(aal1.mfaVerified, false);
  const aal2Claims = await verifyProviderAccessToken(await token({ aal: 'aal2' }), options);
  assert.ok(aal2Claims);
  assert.equal(resolveTrustedUserFromClaims(aal2Claims, [admin]).mfaVerified, true);
});
