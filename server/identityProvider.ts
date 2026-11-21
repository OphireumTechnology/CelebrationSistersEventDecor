import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { stagingExternalAuthEnabled, STAGING_AUTH_PROJECT_REF } from './stagingExternalAuthPolicy.ts';
import type { AccountStatus, UserRole, UserSession } from '../src/types/domain.ts';

const ASYMMETRIC_JWT_ALGS = ['ES256', 'RS256', 'EdDSA'] as const;
const SYMMETRIC_JWT_ALGS = ['HS256'] as const;
const ALLOWED_JWT_ALGS = new Set<string>([...ASYMMETRIC_JWT_ALGS, ...SYMMETRIC_JWT_ALGS]);

export interface IdentityProviderStatus {
  provider: 'supabase' | 'staging-session';
  supabaseConfigured: boolean;
  adminClientConfigured: boolean;
  jwtVerificationConfigured: boolean;
  readyForProductionAuth: boolean;
  externalStagingAuthActive?: boolean;
  mfaPolicy: 'totp_required_for_admin';
  reason: string;
}

export interface VerifiedProviderClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  aal: 'aal1' | 'aal2';
  sessionId?: string;
  rawClaims: JWTPayload;
}

export type TokenKeyResolver = Parameters<typeof jwtVerify>[1];

export interface VerifyProviderTokenOptions {
  supabaseUrl?: string;
  jwtSecret?: string;
  keyResolver?: TokenKeyResolver;
  useJwksOnly?: boolean;
  confirmProviderEmail?: (token: string, subject: string) => Promise<boolean>;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getRemoteJwks(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const normalized = supabaseUrl.trim().replace(/\/+$/, '');
  const existing = jwksCache.get(normalized);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${normalized}/auth/v1/.well-known/jwks.json`));
  jwksCache.set(normalized, jwks);
  return jwks;
}

export function getIdentityProviderStatus(): IdentityProviderStatus {
  const isProd = process.env.NODE_ENV === 'production';
  const url = (process.env.SUPABASE_URL || '').trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const jwtSecret = (process.env.SUPABASE_JWT_SECRET || '').trim();
  const externalStagingAuthActive = stagingExternalAuthEnabled(process.env);

  const supabaseConfigured = Boolean(url && anonKey);
  const adminClientConfigured = Boolean(url && serviceKey);
  const jwtVerificationConfigured = Boolean(url || jwtSecret || externalStagingAuthActive);
  const readyForProductionAuth = supabaseConfigured && (adminClientConfigured || Boolean(jwtSecret));

  if (readyForProductionAuth) {
    return {
      provider: 'supabase',
      supabaseConfigured,
      adminClientConfigured,
      jwtVerificationConfigured,
      readyForProductionAuth: true,
      externalStagingAuthActive,
      mfaPolicy: 'totp_required_for_admin',
      reason: 'Supabase Auth environment configuration detected.',
    };
  }

  return {
    provider: isProd ? 'supabase' : 'staging-session',
    supabaseConfigured,
    adminClientConfigured,
    jwtVerificationConfigured,
    readyForProductionAuth: false,
    externalStagingAuthActive,
    mfaPolicy: 'totp_required_for_admin',
    reason: isProd
      ? 'Production customer authentication is blocked until SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_JWT_SECRET) are configured.'
      : 'Supabase Auth keys are not configured; running non-production staging session adapter only.',
  };
}

export function createSupabasePublicClient(): SupabaseClient | null {
  const url = (process.env.SUPABASE_URL || '').trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function createSupabaseAdminClient(): SupabaseClient | null {
  const url = (process.env.SUPABASE_URL || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Cryptographically verifies a Supabase Auth access JWT (signature, issuer, audience, expiry, algorithm).
 * Routes asymmetric tokens (ES256/RS256/EdDSA) directly to issuer-specific JWKS even when SUPABASE_JWT_SECRET
 * is set for another project, and never trusts client-editable user_metadata role claims.
 */
export async function verifyProviderAccessToken(
  token: string,
  options: VerifyProviderTokenOptions = {},
): Promise<VerifiedProviderClaims | null> {
  const envUrl = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const rawUrl = (options.supabaseUrl ?? envUrl).trim().replace(/\/+$/, '');
  const explicitOverrideToDifferentProject = Boolean(options.supabaseUrl && envUrl && rawUrl !== envUrl);
  const rawSecret = options.useJwksOnly
    ? ''
    : (options.jwtSecret ?? (explicitOverrideToDifferentProject ? '' : process.env.SUPABASE_JWT_SECRET ?? '')).trim();

  if ((options.useJwksOnly && !rawUrl) || (!options.keyResolver && !rawUrl && !rawSecret)) {
    return null;
  }

  let tokenAlg = '';
  try {
    const header = decodeProtectedHeader(token);
    tokenAlg = typeof header.alg === 'string' ? header.alg : '';
  } catch {
    return null;
  }

  if (!tokenAlg || !ALLOWED_JWT_ALGS.has(tokenAlg)) {
    return null;
  }

  const isAsymmetricAlg = (ASYMMETRIC_JWT_ALGS as readonly string[]).includes(tokenAlg);
  if (options.useJwksOnly && !isAsymmetricAlg) {
    return null;
  }

  const baseVerifyOptions = {
    audience: 'authenticated',
    ...(rawUrl ? { issuer: `${rawUrl}/auth/v1` } : {}),
  };

  try {
    let payload: JWTPayload;

    if (options.keyResolver) {
      if (!isAsymmetricAlg) return null;
      const verified = await jwtVerify(token, options.keyResolver, {
        ...baseVerifyOptions,
        algorithms: [...ASYMMETRIC_JWT_ALGS],
      });
      payload = verified.payload;
    } else if (isAsymmetricAlg) {
      if (!rawUrl) return null;
      const jwks = getRemoteJwks(rawUrl);
      const verified = await jwtVerify(token, jwks, {
        ...baseVerifyOptions,
        algorithms: [...ASYMMETRIC_JWT_ALGS],
      });
      payload = verified.payload;
    } else {
      if (!rawSecret) return null;
      const secretKey = new TextEncoder().encode(rawSecret);
      const verified = await jwtVerify(token, secretKey, {
        ...baseVerifyOptions,
        algorithms: [...SYMMETRIC_JWT_ALGS],
      });
      payload = verified.payload;
    }

    if (!payload.sub || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
      return null;
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const appMeta = (payload.app_metadata && typeof payload.app_metadata === 'object'
      ? payload.app_metadata
      : {}) as Record<string, unknown>;
    // Standard Supabase JWTs may omit email confirmation. Use the provider's
    // authenticated User record as fallback and never trust user_metadata.
    const emailVerified =
      payload.email_verified === true ||
      appMeta.email_verified === true ||
      (typeof payload.email_confirmed_at === 'string' && payload.email_confirmed_at.length > 0) ||
      (await options.confirmProviderEmail?.(token, payload.sub)) === true;

    const aal = payload.aal === 'aal2' ? 'aal2' : 'aal1';
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;

    return {
      sub: payload.sub,
      email,
      emailVerified,
      aal,
      sessionId,
      rawClaims: payload,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a verified provider identity strictly against trusted server records.
 * Security invariants:
 * - Privileged accounts (admin, staff, event_planner, vendor) MUST match by immutable supabaseUserId === claims.sub.
 * - Email address matching NEVER grants access to an existing privileged account or overwrites an existing supabaseUserId.
 * - Unmatched accounts strictly receive the least-privileged 'client' role.
 */
export function resolveTrustedUserFromClaims(
  claims: VerifiedProviderClaims,
  registeredUsers: UserSession[],
): {
  user: UserSession;
  accountStatus: AccountStatus;
  emailVerified: boolean;
  mfaVerified: boolean;
  emailPrivilegeBindBlocked: boolean;
} {
  // 1. Primary authoritative lookup: immutable Supabase subject UUID
  const byImmutableSub = registeredUsers.find(
    (u) => Boolean(u.supabaseUserId) && u.supabaseUserId === claims.sub,
  );

  if (byImmutableSub) {
    const accountStatus: AccountStatus = byImmutableSub.accountStatus ?? 'active';
    const role: UserRole = byImmutableSub.role;
    const isAdmin = role === 'admin';
    const mfaVerified = isAdmin ? claims.aal === 'aal2' : claims.aal === 'aal2' || !byImmutableSub.mfaEnrolled;

    return {
      user: {
        ...byImmutableSub,
        emailVerified: claims.emailVerified,
        accountStatus,
      },
      accountStatus,
      emailVerified: claims.emailVerified,
      mfaVerified,
      emailPrivilegeBindBlocked: false,
    };
  }

  // 2. Check if an unlinked account shares this email
  const emailCandidate = claims.email
    ? registeredUsers.find((u) => u.email.toLowerCase() === claims.email.toLowerCase())
    : undefined;

  let emailPrivilegeBindBlocked = false;
  if (emailCandidate) {
    const isPrivileged = emailCandidate.role !== 'client';
    const alreadyLinkedElsewhere = Boolean(emailCandidate.supabaseUserId && emailCandidate.supabaseUserId !== claims.sub);

    if (isPrivileged || alreadyLinkedElsewhere) {
      // NEVER grant privileged roles or cross-link an already-bound account based on email alone.
      emailPrivilegeBindBlocked = true;
    } else if (claims.emailVerified) {
      // Safe one-way migration for unlinked, verified least-privileged client record only
      const accountStatus: AccountStatus = emailCandidate.accountStatus ?? 'active';
      return {
        user: {
          ...emailCandidate,
          supabaseUserId: claims.sub,
          emailVerified: true,
          accountStatus,
        },
        accountStatus,
        emailVerified: true,
        mfaVerified: claims.aal === 'aal2',
        emailPrivilegeBindBlocked: false,
      };
    }
  }

  // 3. Unmatched verified provider accounts receive strictly the least-privileged 'client' role.
  const fullNameClaim =
    typeof claims.rawClaims.user_metadata === 'object' &&
    claims.rawClaims.user_metadata &&
    typeof (claims.rawClaims.user_metadata as Record<string, unknown>).full_name === 'string'
      ? ((claims.rawClaims.user_metadata as Record<string, unknown>).full_name as string).trim()
      : claims.email.split('@')[0] || 'Verified Client';

  const accountStatus: AccountStatus = claims.emailVerified ? 'active' : 'pending_verification';

  return {
    user: {
      id: `sb:${claims.sub}`,
      supabaseUserId: claims.sub,
      name: fullNameClaim,
      email: claims.email,
      role: 'client',
      emailVerified: claims.emailVerified,
      accountStatus,
    },
    accountStatus,
    emailVerified: claims.emailVerified,
    mfaVerified: claims.aal === 'aal2',
    emailPrivilegeBindBlocked,
  };
}

/** Separate, public-key-only client for staging verification against existing Auth users.
 * Never use a production service-role key or mutate Auth admin records. */
export function createStagingExternalAuthClient(): SupabaseClient | null {
  if (!stagingExternalAuthEnabled(process.env)) return null;
  const key = process.env.PHASE19_EXTERNAL_AUTH_ANON_KEY?.trim();
  if (!key) return null;
  return createClient(`https://${STAGING_AUTH_PROJECT_REF}.supabase.co`, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
