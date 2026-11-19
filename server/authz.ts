import type { NextFunction, Request, Response } from 'express';
import type { BookingRecord, UserRole, UserSession, VendorRecord } from '../src/types/domain.ts';
import { verifyCsrfToken, type AuthenticatedContext } from './auth.ts';

const UNSAFE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function getAllowedOrigins(): string[] {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  if (process.env.NODE_ENV !== 'production') {
    return [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ];
  }

  // Default GitHub Pages origin if production deployment omits override, safely overridable via ALLOWED_ORIGINS
  return ['https://ophireumtechnology.github.io'];
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  const normalized = origin.trim().replace(/\/+$/, '');
  if (normalized === '*') return false;
  return getAllowedOrigins().includes(normalized);
}

/**
 * Explicit credentialed CORS middleware for GitHub Pages -> Railway HTTPS communication.
 * Never sets Access-Control-Allow-Origin: * alongside Access-Control-Allow-Credentials: true.
 */
export function corsAllowlistMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    res.setHeader('Vary', 'Origin');

    if (origin && isOriginAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With, X-Request-Id, X-CSRF-Token, Idempotency-Key',
      );
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After');
    }

    if (req.method === 'OPTIONS') {
      if (origin && !isOriginAllowed(origin)) {
        return res.status(403).json({ error: 'CORS origin denied.', code: 'CORS_ORIGIN_DENIED' });
      }
      return res.status(204).end();
    }

    return next();
  };
}

export interface CsrfValidationResult {
  valid: boolean;
  code?: 'CSRF_ORIGIN_REJECTED' | 'CSRF_TOKEN_INVALID';
  reason?: string;
}

/**
 * Strict CSRF defense for cookie-authenticated state-changing requests (Block 13.3):
 * - Bearer/Supabase JWT requests are inherently CSRF-immune (browsers never auto-attach Authorization headers).
 * - Arbitrary custom headers (e.g., X-Requested-With) are NEVER treated as sufficient proof of CSRF safety.
 * - If X-CSRF-Token is supplied, it MUST cryptographically match the active session JTI (HMAC-SHA256).
 * - Origin (preferred) or Referer must match same-origin Host or explicit ALLOWED_ORIGINS allowlist.
 * - Requests missing BOTH Origin and Referer are REJECTED unless carrying a cryptographically verified
 *   session-bound X-CSRF-Token.
 */
export function validateCsrfProtection(
  req: Request,
  ctx: Pick<AuthenticatedContext, 'authMethod' | 'sessionJti'>,
): CsrfValidationResult {
  if (!UNSAFE_HTTP_METHODS.has(req.method.toUpperCase())) {
    return { valid: true };
  }
  if (ctx.authMethod !== 'cookie') {
    return { valid: true };
  }

  const csrfHeader = (req.header('x-csrf-token') || '').trim();
  let hasVerifiedCsrfToken = false;
  if (csrfHeader) {
    if (!verifyCsrfToken(ctx.sessionJti, csrfHeader)) {
      return {
        valid: false,
        code: 'CSRF_TOKEN_INVALID',
        reason: 'Invalid or forged X-CSRF-Token header.',
      };
    }
    hasVerifiedCsrfToken = true;
  }

  const originHeader = (req.header('origin') || '').trim();
  const refererHeader = (req.header('referer') || '').trim();
  const candidate = originHeader || refererHeader;

  if (!candidate) {
    // Missing Origin and Referer: NEVER trust unverified X-Requested-With.
    // Permit ONLY when a cryptographically verified session-bound X-CSRF-Token is present.
    if (hasVerifiedCsrfToken) {
      return { valid: true };
    }
    return {
      valid: false,
      code: 'CSRF_ORIGIN_REJECTED',
      reason: 'Missing Origin/Referer headers without a verified cryptographic CSRF token.',
    };
  }

  // Reject explicit "null" Origin (sandboxed iframe / data: URI cross-site form submissions)
  if (candidate.toLowerCase() === 'null') {
    return {
      valid: false,
      code: 'CSRF_ORIGIN_REJECTED',
      reason: 'Null Origin rejected by CSRF policy.',
    };
  }

  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(candidate).origin;
  } catch {
    return {
      valid: false,
      code: 'CSRF_ORIGIN_REJECTED',
      reason: 'Malformed Origin or Referer URL.',
    };
  }

  const host = req.header('host');
  if (host) {
    const expectedHttp = `http://${host}`;
    const expectedHttps = `https://${host}`;
    if (parsedOrigin === expectedHttp || parsedOrigin === expectedHttps) {
      return { valid: true };
    }
  }

  if (isOriginAllowed(parsedOrigin)) {
    return { valid: true };
  }

  return {
    valid: false,
    code: 'CSRF_ORIGIN_REJECTED',
    reason: 'Origin is not in the trusted CORS/CSRF allowlist.',
  };
}

export function isCsrfOriginValid(
  req: Request,
  authMethod: AuthenticatedContext['authMethod'],
  sessionJti?: string,
): boolean {
  return validateCsrfProtection(req, { authMethod, sessionJti }).valid;
}

export function requireActiveAccount(ctx: AuthenticatedContext, res: Response, requireVerified = false): boolean {
  if (ctx.session.role === 'guest') {
    res.status(401).json({
      error: ctx.sessionRevoked
        ? 'Your session has been signed out or revoked. Please sign in again.'
        : 'Authentication required.',
      code: ctx.sessionRevoked ? 'SESSION_REVOKED' : 'AUTH_REQUIRED',
    });
    return false;
  }

  if (ctx.accountStatus === 'suspended' || ctx.accountStatus === 'deactivated') {
    res.status(403).json({
      error: 'This account is suspended or deactivated. Contact Celebration Sisters Executive Office.',
      code: 'ACCOUNT_SUSPENDED',
    });
    return false;
  }

  if (requireVerified && !ctx.emailVerified) {
    res.status(403).json({
      error: 'Please verify your email address before accessing protected portal resources.',
      code: 'EMAIL_VERIFICATION_REQUIRED',
    });
    return false;
  }

  return true;
}

export function requireRoles(
  ctx: AuthenticatedContext,
  allowed: UserRole[],
  res: Response,
  deniedMessage = 'Insufficient permissions for this operation.',
): boolean {
  if (!requireActiveAccount(ctx, res)) return false;
  if (!allowed.includes(ctx.session.role)) {
    res.status(403).json({ error: deniedMessage, code: 'ROLE_FORBIDDEN' });
    return false;
  }
  return true;
}

export function requireAdminWithMfa(ctx: AuthenticatedContext, res: Response): boolean {
  if (ctx.session.role !== 'admin') {
    res.status(403).json({ error: 'Executive director clearance required.', code: 'ADMIN_REQUIRED' });
    return false;
  }
  if (ctx.accountStatus === 'suspended' || ctx.accountStatus === 'deactivated') {
    res.status(403).json({
      error: 'This account is suspended or deactivated. Contact Celebration Sisters Executive Office.',
      code: 'ACCOUNT_SUSPENDED',
    });
    return false;
  }
  if (!ctx.mfaVerified) {
    res.status(403).json({
      error: 'MFA_REQUIRED: Executive director session requires multi-factor verification before accessing administrative controls.',
      code: 'MFA_REQUIRED',
      mfaRequired: true,
    });
    return false;
  }
  return true;
}

export function hasPlanningClearance(session: UserSession): boolean {
  return session.role === 'admin' || session.role === 'staff' || session.role === 'event_planner';
}

export function canAccessBookingRecord(
  booking: BookingRecord,
  session: UserSession,
  vendors: VendorRecord[],
): boolean {
  if (session.role === 'admin' || session.role === 'staff' || session.role === 'event_planner') {
    return true;
  }
  if (session.role === 'client') {
    return booking.clientId === session.id;
  }
  if (session.role === 'vendor') {
    const vendor = vendors.find(
      (v) => v.email.toLowerCase() === session.email.toLowerCase() || v.contactName === session.name,
    );
    if (!vendor) return false;
    return booking.assignedVendorIds.includes(vendor.id) || vendor.assignedBookingIds.includes(booking.id);
  }
  return false;
}
