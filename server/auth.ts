import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { AccountStatus, UserRole, UserSession } from '../src/types/domain.ts';
import {
  resolveTrustedUserFromClaims,
  verifyProviderAccessToken,
  type VerifyProviderTokenOptions,
} from './identityProvider.ts';
import { verifyTotpCode } from './totp.ts';
import { stagingExternalAuthEnabled, STAGING_ADMIN_SUBJECT, STAGING_AUTH_PROJECT_REF } from './stagingExternalAuthPolicy.ts';

export const SESSION_COOKIE_NAME = 'cs_session';
export const CSRF_COOKIE_NAME = 'cs_csrf';

const EPHEMERAL_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');

function getSessionSecret(): string {
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production');
  }
  return process.env.SESSION_SECRET || EPHEMERAL_FALLBACK_SECRET;
}

export interface SignedSessionPayload {
  jti?: string;
  userId: string;
  role: UserRole;
  mfaVerified: boolean;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthenticatedContext {
  session: UserSession;
  sessionJti?: string;
  sessionExpiresAt?: number;
  mfaVerified: boolean;
  emailVerified: boolean;
  accountStatus: AccountStatus;
  aal: 'aal1' | 'aal2';
  authMethod: 'cookie' | 'bearer' | 'supabase_jwt' | 'guest';
  spoofAttemptDetected: boolean;
  emailPrivilegeBindBlocked?: boolean;
  sessionRevoked?: boolean;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateSessionId(): string {
  return `sid_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Derives a session-bound cryptographic CSRF synchronizer token from the session JTI
 * using HMAC-SHA256 keyed by the server session secret.
 */
export function deriveCsrfToken(sessionJti: string): string {
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(`csrf:${sessionJti}`)
    .digest('base64url');
}

export function verifyCsrfToken(sessionJti: string | undefined, providedToken: string | undefined): boolean {
  if (!sessionJti || !providedToken) return false;
  const trimmed = providedToken.trim();
  if (!trimmed || trimmed.length > 256) return false;
  const expected = deriveCsrfToken(sessionJti);
  const a = Buffer.from(trimmed, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generates single-use MFA recovery codes (returned once at enrollment) and their SHA-256 hashes.
 */
export function generateMfaRecoveryCodes(count = 8): { plainCodes: string[]; hashes: string[] } {
  const plainCodes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const partA = crypto.randomBytes(3).toString('hex').toUpperCase();
    const partB = crypto.randomBytes(3).toString('hex').toUpperCase();
    const code = `${partA}-${partB}`;
    plainCodes.push(code);
    hashes.push(sha256Hex(normalizeRecoveryCode(code)));
  }
  return { plainCodes, hashes };
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function signSessionToken(payload: SignedSessionPayload): string {
  const normalized: SignedSessionPayload = {
    ...payload,
    jti: payload.jti || generateSessionId(),
  };
  const encoded = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SignedSessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedSessionPayload;
    if (!parsed.userId || !parsed.role || typeof parsed.expiresAt !== 'number') return null;
    if (Date.now() > parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.header('cookie');
  if (!header) return Object.create(null) as Record<string, string>;
  const result = Object.create(null) as Record<string, string>;
  for (const segment of header.split(';')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx === -1) continue;
    const key = segment.slice(0, eqIdx).trim();
    const val = segment.slice(eqIdx + 1).trim();
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        // Malformed percent-encoding is untrusted client input, never a server crash.
      }
    }
  }
  return result;
}

export function isRequestSecure(req?: Request): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  if (!req) return false;
  if (req.secure) return true;
  // Honor X-Forwarded-Proto only when Express trust proxy is enabled (req.protocol reflects it)
  return req.protocol === 'https';
}

export function setSessionCookie(
  res: Response,
  token: string,
  options?: { req?: Request; csrfToken?: string },
): void {
  const isProd = process.env.NODE_ENV === 'production';
  const secure = isProd || isRequestSecure(options?.req);
  const crossOrigin = isProd && process.env.CROSS_ORIGIN_COOKIES === 'true';
  // SameSite=None strictly requires Secure; downgrade safely to Lax when non-HTTPS local dev
  const sameSite = crossOrigin && secure ? 'SameSite=None' : 'SameSite=Lax';
  const maxAge = 60 * 60 * 8;

  const sessionFlags = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    sameSite,
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    sessionFlags.push('Secure');
  }

  const cookiesToSet = [sessionFlags.join('; ')];

  if (options?.csrfToken) {
    const csrfFlags = [
      `${CSRF_COOKIE_NAME}=${encodeURIComponent(options.csrfToken)}`,
      'Path=/',
      sameSite,
      `Max-Age=${maxAge}`,
    ];
    if (secure) {
      csrfFlags.push('Secure');
    }
    cookiesToSet.push(csrfFlags.join('; '));
  }

  res.setHeader('Set-Cookie', cookiesToSet.length === 1 ? cookiesToSet[0] : cookiesToSet);
}

export function clearSessionCookie(res: Response, options?: { req?: Request }): void {
  const isProd = process.env.NODE_ENV === 'production';
  const secure = isProd || isRequestSecure(options?.req);
  const crossOrigin = isProd && process.env.CROSS_ORIGIN_COOKIES === 'true';
  const sameSite = crossOrigin && secure ? 'SameSite=None' : 'SameSite=Lax';

  const sessionFlags = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', sameSite, 'Max-Age=0'];
  const csrfFlags = [`${CSRF_COOKIE_NAME}=`, 'Path=/', sameSite, 'Max-Age=0'];
  if (secure) {
    sessionFlags.push('Secure');
    csrfFlags.push('Secure');
  }
  res.setHeader('Set-Cookie', [sessionFlags.join('; '), csrfFlags.join('; ')]);
}

export const GUEST_USER: UserSession = {
  id: 'guest-public',
  name: 'Public Visitor',
  email: 'visitor@celebrationsisters.example.com',
  role: 'guest',
  emailVerified: false,
  accountStatus: 'active',
};

function guestContext(spoofAttemptDetected: boolean, sessionRevoked = false): AuthenticatedContext {
  return {
    session: GUEST_USER,
    mfaVerified: false,
    emailVerified: false,
    accountStatus: 'active',
    aal: 'aal1',
    authMethod: 'guest',
    spoofAttemptDetected,
    sessionRevoked,
  };
}

/**
 * Synchronous session resolver for HMAC-signed session cookies / tokens.
 * Rejects expired, tampered, or server-revoked (post-logout) session JTIs.
 */
export function resolveAuthenticatedContext(
  req: Request,
  registeredUsers: UserSession[],
  revokedSessionIds?: Record<string, number>,
): AuthenticatedContext {
  const rawSpoofHeader = req.header('x-user-id') || req.header('x-user-role');
  const authHeader = req.header('authorization');
  const cookies = parseCookies(req);

  let rawToken: string | null = null;
  let authMethod: 'cookie' | 'bearer' | 'guest' = 'guest';

  if (authHeader && authHeader.startsWith('Bearer ')) {
    rawToken = authHeader.slice(7).trim();
    authMethod = 'bearer';
  } else if (cookies[SESSION_COOKIE_NAME]) {
    rawToken = cookies[SESSION_COOKIE_NAME];
    authMethod = 'cookie';
  }

  if (!rawToken) {
    return guestContext(Boolean(rawSpoofHeader));
  }

  const verified = verifySessionToken(rawToken);
  if (!verified) {
    return guestContext(true);
  }

  // Enforce server-side session invalidation (post-logout replay protection)
  if (verified.jti && revokedSessionIds && revokedSessionIds[verified.jti]) {
    return guestContext(true, true);
  }

  const matchedUser = registeredUsers.find((u) => u.id === verified.userId);
  if (!matchedUser) {
    // A supplied authenticated credential whose account no
    // longer exists must not become an authorized guest request.
    return guestContext(true);
  }

  const accountStatus: AccountStatus = matchedUser.accountStatus ?? 'active';
  const emailVerified = matchedUser.emailVerified ?? true;

  return {
    session: matchedUser,
    sessionJti: verified.jti,
    sessionExpiresAt: verified.expiresAt,
    mfaVerified: verified.mfaVerified,
    emailVerified,
    accountStatus,
    aal: verified.mfaVerified ? 'aal2' : 'aal1',
    authMethod,
    spoofAttemptDetected: false,
  };
}

/**
 * Primary request authentication resolver.
 * Supports cryptographic Supabase Auth JWTs (3-segment JWT via Authorization: Bearer)
 * alongside server-signed HttpOnly session cookies/tokens.
 * Unverified raw headers (x-user-id / x-user-role) and mutable JWT user_metadata role claims are NEVER trusted.
 */
export async function resolveAuthenticatedContextAsync(
  req: Request,
  registeredUsers: UserSession[],
  providerVerifyOptions?: VerifyProviderTokenOptions,
  revokedSessionIds?: Record<string, number>,
): Promise<AuthenticatedContext> {
  const rawSpoofHeader = req.header('x-user-id') || req.header('x-user-role');
  const authHeader = req.header('authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const rawToken = authHeader.slice(7).trim();
    if (!rawToken) {
      return guestContext(true);
    }

    // Standard 3-part JWS indicates an external identity provider JWT (Supabase Auth)
    if (rawToken.split('.').length === 3) {
      // Explicit staging-only external issuer. Never let a failed external verification
      // fall back to another issuer, local token, email, or mutable role metadata.
      const externalStaging = stagingExternalAuthEnabled(process.env);
      const verificationOptions = externalStaging
        ? {
            supabaseUrl: `https://${STAGING_AUTH_PROJECT_REF}.supabase.co`,
            useJwksOnly: true,
            keyResolver: providerVerifyOptions?.keyResolver,
            confirmProviderEmail: providerVerifyOptions?.confirmProviderEmail,
          }
        : providerVerifyOptions;
      const claims = await verifyProviderAccessToken(rawToken, verificationOptions);
      if (!claims) {
        return guestContext(true);
      }
      if (claims.sessionId && revokedSessionIds && revokedSessionIds[`sb:${claims.sessionId}`]) {
        return guestContext(true, true);
      }
      const resolved = resolveTrustedUserFromClaims(claims, registeredUsers);
      // External Auth never creates an admin. The UUID must already be bound
      // to a trusted active staging administrator record; otherwise deny.
      if (externalStaging && claims.sub === STAGING_ADMIN_SUBJECT &&
          (resolved.user.role !== 'admin' ||
           resolved.user.supabaseUserId !== STAGING_ADMIN_SUBJECT ||
           resolved.accountStatus !== 'active')) {
        return guestContext(true);
      }
      // AAL1 remains authenticated for MFA enrollment but cannot pass admin MFA guards.
      if (externalStaging && resolved.user.role === 'admin' &&
          claims.sub !== STAGING_ADMIN_SUBJECT) {
        return guestContext(true);
      }
      return {
        session: resolved.user,
        sessionJti: claims.sessionId ? `sb:${claims.sessionId}` : undefined,
        mfaVerified: resolved.mfaVerified,
        emailVerified: resolved.emailVerified,
        accountStatus: resolved.accountStatus,
        aal: claims.aal,
        authMethod: 'supabase_jwt',
        spoofAttemptDetected: false,
        emailPrivilegeBindBlocked: resolved.emailPrivilegeBindBlocked,
      };
    }

    // 2-part server HMAC staging token
    return resolveAuthenticatedContext(req, registeredUsers, revokedSessionIds);
  }

  if (rawSpoofHeader && !parseCookies(req)[SESSION_COOKIE_NAME]) {
    return guestContext(true);
  }

  return resolveAuthenticatedContext(req, registeredUsers, revokedSessionIds);
}

/**
 * Verifies administrator MFA challenge using RFC 6238 TOTP bound to the user account.
 * Shared static passcodes are strictly prohibited in production mode.
 */
export function verifyAdminMfaChallenge(user: UserSession, code: string): {
  verified: boolean;
  method: 'totp' | 'staging_passcode' | 'none';
} {
  if (user.totpSecret) {
    return {
      verified: verifyTotpCode(user.totpSecret, code),
      method: 'totp',
    };
  }

  // Production strictly prohibits static shared passcodes.
  if (process.env.NODE_ENV === 'production') {
    return { verified: false, method: 'none' };
  }

  // Non-production local/staging compatibility only when ADMIN_MFA_PASSCODE is explicitly configured
  const expected = process.env.ADMIN_MFA_PASSCODE;
  if (!expected) {
    return { verified: false, method: 'none' };
  }
  const providedBuf = Buffer.from(code.trim(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    return { verified: false, method: 'staging_passcode' };
  }
  return {
    verified: crypto.timingSafeEqual(providedBuf, expectedBuf),
    method: 'staging_passcode',
  };
}

export function verifyAdminMfaCode(code: string): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const expected = process.env.ADMIN_MFA_PASSCODE;
  if (!expected) return false;
  const providedBuf = Buffer.from(code.trim(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
