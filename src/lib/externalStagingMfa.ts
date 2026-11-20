import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const PROJECT_REF = 'nswxwwmtcasmkjtmrdqg';
let client: SupabaseClient | null = null;
let pendingTotpFactorId: string | null = null;

/** Explicit opt-in only: browser never receives a service-role key. */
export function getExternalStagingMfaClient(): SupabaseClient | null {
  if (import.meta.env.VITE_PHASE19_EXTERNAL_AUTH_STAGING !== 'true') return null;
  const key = import.meta.env.VITE_PHASE19_EXTERNAL_AUTH_ANON_KEY;
  if (!key) return null;
  if (!client) client = createClient(`https://${PROJECT_REF}.supabase.co`, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}

export async function enrollExternalStagingTotp() {
  const supabase = getExternalStagingMfaClient();
  if (!supabase) throw new Error('External staging MFA is not configured.');
  const { data: user, error: userError } = await supabase.auth.getUser();
  if (userError || user.user?.id !== 'fd9523dd-eb07-4cca-9040-62feea3f5353') {
    throw new Error('Authenticated staging administrator session required.');
  }
  const { data, error } = await supabase.auth.mfa.enroll({factorType:'totp', friendlyName:'Celebration Sisters staging administrator'});
  if (error) throw error;
  pendingTotpFactorId = data.id;
  return { factorId:data.id, qr:data.totp.qr_code, secret:data.totp.secret, uri:data.totp.uri };
}

export function getPendingExternalTotpFactorId(): string | null { return pendingTotpFactorId; }

export async function verifyExternalStagingTotp(factorId:string, code:string) {
  const supabase = getExternalStagingMfaClient();
  if (!supabase) throw new Error('External staging MFA is not configured.');
  const {data,error} = await supabase.auth.mfa.challengeAndVerify({factorId,code});
  if (error) throw error;
  const {data:aal,error:aalError} = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError || aal.currentLevel !== 'aal2') throw new Error('Supabase AAL2 verification did not complete.');
  const {data:session} = await supabase.auth.getSession();
  if (!session.session?.access_token) throw new Error('No authenticated AAL2 access token returned.');
  pendingTotpFactorId = null;
  return {accessToken:session.session.access_token};
}
