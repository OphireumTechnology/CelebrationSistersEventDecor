import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AccountStatus, UserRole, UserSession } from '../src/types/domain.ts';

export interface IdentityProviderStatus {
  provider: 'supabase' | 'staging-session';
  supabaseConfigured: boolean;
  adminClientConfigured: boolean;
  jwtVerificationConfigured: boolean;
  readyForProductionAuth: boolean;
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

  const supabaseConfigured = Boolean(url && anonKey);
  const adminClientConfigured = Boolean(url && serviceKey);
  const jwtVerificationConfigured = Boolean(url || jwtSecret);
  const readyForProductionAuth = supabaseConfigured && (adminClientConfigured || Boolean(jwtSecret));

  if (readyForProductionAuth) {
    return {
      provider: 'supabase',
      supabaseConfigured,
      adminClientConfigured,
      jwtVerificationConfigured,
      readyForProductionAuth: true,
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
 * Cryptographically verifies a Supabase Auth access JWT (signature, issuer, audience, expiry).
 * Never trusts client-editable user_metadata role claims.
 */
export async function verifyProviderAccessToken(
  token: string,
  options: VerifyProviderTokenOptions = {},
): Promise<VerifiedProviderClaims | null> {
  const rawUrl = (options.supabaseUrl ?? process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const rawSecret = (options.jwtSecret ?? process.env.SUPABASE_JWT_SECRET ?? '').trim();

  if (!options.keyResolver && !rawUrl && !rawSecret) {
    return null;
  }

  const verifyOptions = {
    audience: 'authenticated',
    ...(rawUrl ? { issuer: `${rawUrl}/auth/v1` } : {}),
  };

  try {
    let payload: JWTPayload;

    if (options.keyResolver) {
      const verified = await jwtVerify(token, options.keyResolver, verifyOptions);
      payload = verified.payload;
    } else if (rawSecret) {
      const secretKey = new TextEncoder().encode(rawSecret);
      const verified = await jwtVerify(token, secretKey, verifyOptions);
      payload = verified.payload;
    } else {
      const jwks = getRemoteJwks(rawUrl);
      const verified = await jwtVerify(token, jwks, verifyOptions);
      payload = verified.payload;
    }

    if (!payload.sub || typeof payload.sub !== 'string') {
      return null;
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const appMeta = (payload.app_metadata && typeof payload.app_metadata === 'object'
      ? payload.app_metadata
      : {}) as Record<string, unknown>;
    const userMeta = (payload.user_metadata && typeof payload.user_metadata === 'object'
      ? payload.user_metadata
      : {}) as Record<string, unknown>;

    // Email verification must come from standard JWT / Supabase confirmation claims
    const emailVerified =
      payload.email_verified === true ||
      Boolean(appMeta.email_verified === true) ||
      Boolean(typeof payload.email_confirmed_at === 'string' && payload.email_confirmed_at.length > 0) ||
      // Fallback: if neither email_verified nor user_metadata spoofing overrides exist, check confirmation timestamp
      (typeof userMeta.email_verified === 'boolean' && payload.email_verified === true);

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
 * Self-registered accounts NEVER receive privileged roles from client-supplied claims.
 */
export function resolveTrustedUserFromClaims(
  claims: VerifiedProviderClaims,
  registeredUsers: UserSession[],
): { user: UserSession; accountStatus: AccountStatus; emailVerified: boolean; mfaVerified: boolean } {
  const matched = registeredUsers.find(
    (u) =>
      (u.supabaseUserId && u.supabaseUserId === claims.sub) ||
      (claims.email && u.email.toLowerCase() === claims.email.toLowerCase()),
  );

  if (matched) {
    const accountStatus: AccountStatus = matched.accountStatus ?? 'active';
    const role: UserRole = matched.role;
    const isAdmin = role === 'admin';
    const mfaVerified = isAdmin ? claims.aal === 'aal2' : claims.aal === 'aal2' || !matched.mfaEnrolled;

    return {
      user: {
        ...matched,
        supabaseUserId: matched.supabaseUserId || claims.sub,
        emailVerified: claims.emailVerified,
        accountStatus,
      },
      accountStatus,
      emailVerified: claims.emailVerified,
      mfaVerified,
    };
  }

  // Unmatched verified provider accounts receive strictly the least-privileged 'client' role.
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
  };
}
