import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { AccountStatus, UserRole, UserSession } from '../src/types/domain.ts';
import {
  resolveTrustedUserFromClaims,
  verifyProviderAccessToken,
  type VerifyProviderTokenOptions,
} from './identityProvider.ts';
import { verifyTotpCode } from './totp.ts';

export const SESSION_COOKIE_NAME = 'cs_session';

const EPHEMERAL_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');

function getSessionSecret(): string {
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production');
  }
  return process.env.SESSION_SECRET || EPHEMERAL_FALLBACK_SECRET;
}

export interface SignedSessionPayload {
  userId: string;
  role: UserRole;
  mfaVerified: boolean;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthenticatedContext {
  session: UserSession;
  mfaVerified: boolean;
  emailVerified: boolean;
  accountStatus: AccountStatus;
  aal: 'aal1' | 'aal2';
  authMethod: 'cookie' | 'bearer' | 'supabase_jwt' | 'guest';
  spoofAttemptDetected: boolean;
  emailPrivilegeBindBlocked?: boolean;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function signSessionToken(payload: SignedSessionPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
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

export function setSessionCookie(res: Response, token: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = isProd && process.env.CROSS_ORIGIN_COOKIES === 'true' ? 'SameSite=None' : 'SameSite=Lax';
  const flags = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    sameSite,
    `Max-Age=${60 * 60 * 8}`,
  ];
  if (isProd) {
    flags.push('Secure');
  }
  res.setHeader('Set-Cookie', flags.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = isProd && process.env.CROSS_ORIGIN_COOKIES === 'true' ? 'SameSite=None' : 'SameSite=Lax';
  const flags = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', sameSite, 'Max-Age=0'];
  if (isProd) {
    flags.push('Secure');
  }
  res.setHeader('Set-Cookie', flags.join('; '));
}

export const GUEST_USER: UserSession = {
  id: 'guest-public',
  name: 'Public Visitor',
  email: 'visitor@celebrationsisters.example.com',
  role: 'guest',
  emailVerified: false,
  accountStatus: 'active',
};

function guestContext(spoofAttemptDetected: boolean): AuthenticatedContext {
  return {
    session: GUEST_USER,
    mfaVerified: false,
    emailVerified: false,
    accountStatus: 'active',
    aal: 'aal1',
    authMethod: 'guest',
    spoofAttemptDetected,
  };
}

/**
 * Synchronous session resolver for HMAC-signed session cookies / tokens.
 */
export function resolveAuthenticatedContext(
  req: Request,
  registeredUsers: UserSession[],
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

  const matchedUser = registeredUsers.find((u) => u.id === verified.userId);
  if (!matchedUser) {
    return guestContext(false);
  }

  const accountStatus: AccountStatus = matchedUser.accountStatus ?? 'active';
  const emailVerified = matchedUser.emailVerified ?? true;

  return {
    session: matchedUser,
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
      const claims = await verifyProviderAccessToken(rawToken, providerVerifyOptions);
      if (!claims) {
        return guestContext(true);
      }
      const resolved = resolveTrustedUserFromClaims(claims, registeredUsers);
      return {
        session: resolved.user,
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
    return resolveAuthenticatedContext(req, registeredUsers);
  }

  if (rawSpoofHeader && !parseCookies(req)[SESSION_COOKIE_NAME]) {
    return guestContext(true);
  }

  return resolveAuthenticatedContext(req, registeredUsers);
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
