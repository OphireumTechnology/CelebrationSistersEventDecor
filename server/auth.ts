import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { UserRole, UserSession } from '../src/types/domain.ts';

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
  authMethod: 'cookie' | 'bearer' | 'guest';
  spoofAttemptDetected: boolean;
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
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const segment of header.split(';')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx === -1) continue;
    const key = segment.slice(0, eqIdx).trim();
    const val = segment.slice(eqIdx + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(val);
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
};

/**
 * Resolves authenticated user strictly from a cryptographically signed session cookie
 * or Bearer token. Unverified raw headers (x-user-id / x-user-role) are NEVER trusted.
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
    return {
      session: GUEST_USER,
      mfaVerified: false,
      authMethod: 'guest',
      spoofAttemptDetected: Boolean(rawSpoofHeader),
    };
  }

  const verified = verifySessionToken(rawToken);
  if (!verified) {
    return {
      session: GUEST_USER,
      mfaVerified: false,
      authMethod: 'guest',
      spoofAttemptDetected: true,
    };
  }

  const matchedUser = registeredUsers.find((u) => u.id === verified.userId);
  if (!matchedUser) {
    return {
      session: GUEST_USER,
      mfaVerified: false,
      authMethod: 'guest',
      spoofAttemptDetected: false,
    };
  }

  return {
    session: matchedUser,
    mfaVerified: verified.mfaVerified,
    authMethod,
    spoofAttemptDetected: false,
  };
}

export function verifyAdminMfaCode(code: string): boolean {
  const expected = process.env.ADMIN_MFA_PASSCODE;
  if (!expected) return false;
  const providedBuf = Buffer.from(code.trim(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
