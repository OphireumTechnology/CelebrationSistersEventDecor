/** Staging-only external Supabase Auth trust policy. No production Auth writes. */
export const STAGING_AUTH_PROJECT_REF = 'nswxwwmtcasmkjtmrdqg';
export const STAGING_ADMIN_SUBJECT = 'fd9523dd-eb07-4cca-9040-62feea3f5353';
export const STAGING_AUTH_ISSUER = `https://${STAGING_AUTH_PROJECT_REF}.supabase.co/auth/v1`;
export interface StagingAdminClaims { sub: string; aal: 'aal1' | 'aal2'; rawClaims: Record<string, unknown> }
export function stagingExternalAuthEnabled(env: Record<string,string|undefined>): boolean {
  return env.RAILWAY_ENVIRONMENT_NAME === 'staging'
    && env.STAGING_DB_CONFIRM === 'YES_ISOLATED_STAGING'
    && env.EMAIL_LIVE_DELIVERY_ENABLED === 'false'
    && env.PHASE19_EXTERNAL_AUTH_READ_ONLY === 'YES_EXTERNAL_AUTH_STAGING_ONLY'
    && env.PHASE19_EXTERNAL_AUTH_PROJECT_REF === STAGING_AUTH_PROJECT_REF;
}
/** Call ONLY after cryptographic issuer/audience/expiry verification using issuer-specific JWKS. */
export function authorizedStagingAdmin(claims: StagingAdminClaims, verifiedIssuer: string, env: Record<string,string|undefined>): boolean {
  return stagingExternalAuthEnabled(env)
    && verifiedIssuer === STAGING_AUTH_ISSUER
    && claims.sub === STAGING_ADMIN_SUBJECT
    && claims.aal === 'aal2';
}

/** Cryptographic verification is mandatory before any staging admin authorization. */
export async function verifyStagingExternalAdminJwt(
  token: string,
  env: Record<string,string|undefined>,
  verify: (token:string, options:{supabaseUrl:string})=>Promise<{sub:string;aal:'aal1'|'aal2';rawClaims:Record<string,unknown>}|null>,
): Promise<boolean> {
  if (!stagingExternalAuthEnabled(env)) return false;
  const verified = await verify(token, {supabaseUrl:`https://${STAGING_AUTH_PROJECT_REF}.supabase.co`});
  return Boolean(verified && authorizedStagingAdmin(verified, STAGING_AUTH_ISSUER, env));
}
