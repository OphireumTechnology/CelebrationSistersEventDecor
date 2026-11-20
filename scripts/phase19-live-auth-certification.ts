/**
 * Phase 19B/C live Supabase staging certification.
 * Execute ONLY in a secured staging job with ephemeral credentials supplied
 * through secret environment variables. Never log passwords, keys or JWTs.
 * No production writes, no automatic privilege assignment or MFA bypass.
 */
import { createClient } from '@supabase/supabase-js';
import { verifyProviderAccessToken } from '../server/identityProvider.ts';

const expectedRef = 'diasvulceaahmorucoro';
const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const api = (process.env.PHASE19_API_BASE_URL || '').replace(/\/+$/, '');
const result: { name: string; passed: boolean; detail?: string }[] = [];
const check = (name: string, passed: boolean, detail?: string) => {
  result.push({ name, passed, detail });
  console.log('PHASE19_CHECK ' + JSON.stringify({ name, passed, detail }));
};
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Missing staging secret/configuration: ' + name);
  return value;
}
async function request(path: string, token?: string) {
  const response = await fetch(api + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    signal: AbortSignal.timeout(15000),
  });
  return response.status;
}
async function main() {
  if (process.env.RAILWAY_ENVIRONMENT_NAME !== 'staging' ||
      process.env.STAGING_DB_CONFIRM !== 'YES_ISOLATED_STAGING' ||
      new URL(url).hostname !== expectedRef + '.supabase.co' ||
      !api.startsWith('https://') && !api.endsWith('.railway.internal:8080')) {
    throw new Error('Phase 19 staging-only environment gate failed');
  }
  if (process.env.EMAIL_LIVE_DELIVERY_ENABLED !== 'false') {
    throw new Error('Live email delivery must explicitly be disabled');
  }
  const anon = required('SUPABASE_ANON_KEY');
  const serviceRole = required('SUPABASE_SERVICE_ROLE_KEY');
  const customerEmail = required('PHASE19_CUSTOMER_EMAIL');
  const customerPassword = required('PHASE19_CUSTOMER_PASSWORD');
  const adminEmail = required('PHASE19_ADMIN_EMAIL');
  const adminPassword = required('PHASE19_ADMIN_PASSWORD');
  if (customerEmail === adminEmail) throw new Error('Distinct test identities required');
  const publicClient = () => createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const adminClient = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });

  // Optional provisioning requires an explicit second gate. Never overwrite users,
  // grant admin role, or enroll/disable MFA automatically.
  if (process.env.PHASE19_PROVISION_USERS === 'YES_CREATE_STAGING_USERS') {
    for (const [email, password] of [[customerEmail, customerPassword], [adminEmail, adminPassword]]) {
      const created = await adminClient.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { phase19_staging_only: true },
      });
      if (created.error) {
        // Existing users must be reviewed, never silently reset or modified.
        if (!/already (registered|exists)/i.test(created.error.message)) {
          throw new Error('Staging identity provisioning failed: ' + created.error.name);
        }
        check('existing-' + (email === adminEmail ? 'admin' : 'customer') + '-requires-review', false);
      } else {
        check('provision-' + (email === adminEmail ? 'admin' : 'customer'), Boolean(created.data.user?.id));
      }
    }
  }
  async function login(email: string, password: string) {
    const { data, error } = await publicClient().auth.signInWithPassword({ email, password });
    if (error || !data.session?.access_token || !data.user) throw new Error('Staging sign-in failed');
    const claims = await verifyProviderAccessToken(data.session.access_token, { supabaseUrl: url });
    if (!claims || claims.sub !== data.user.id) throw new Error('Genuine Supabase JWT verification failed');
    return { token: data.session.access_token, userId: data.user.id, aal: claims.aal };
  }
  const customer = await login(customerEmail, customerPassword);
  const admin = await login(adminEmail, adminPassword);
  check('genuine-customer-jwt', true);
  check('genuine-admin-jwt', true);
  check('distinct-immutable-subjects', customer.userId !== admin.userId);
  check('customer-admin-denied', [401, 403].includes(await request('/api/admin/metrics', customer.token)));
  check('anonymous-admin-denied', [401, 403].includes(await request('/api/admin/metrics')));
  check('forged-admin-token-denied', [401, 403].includes(await request('/api/admin/metrics', 'invalid.staging.jwt')));
  check('admin-aal2', admin.aal === 'aal2', admin.aal === 'aal2' ? 'MFA verified' : 'TOTP enrollment and AAL2 challenge required');
  if (admin.aal === 'aal2') {
    // AAL2 is necessary but not sufficient; immutable trusted backend binding
    // must independently authorize the account.
    const status = await request('/api/admin/metrics', admin.token);
    check('trusted-admin-binding-and-aal2', status === 200, 'HTTP ' + status);
  } else {
    check('trusted-admin-binding-and-aal2', false, 'Blocked until genuine AAL2 session');
  }
  // Ownership test needs seeded two-owner resources and their IDs.
  // Never report cross-account isolation as passed without actual records.
  check('cross-account-record-isolation', false, 'Blocked: two-owner fixture and resource identifiers required');
}
try {
  await main();
} catch (error) {
  check('runner-prerequisites', false, error instanceof Error ? error.message : 'Unexpected failure');
}
const passed = result.length > 0 && result.every(x => x.passed);
console.log('PHASE19_SUMMARY ' + JSON.stringify({ status: passed ? 'passed' : 'blocked', results: result }));
if (!passed) process.exitCode = 1;
