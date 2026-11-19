import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  BOOKING_STATUSES,
  type AuthSecurityEvent,
  type BookingRecord,
  type BookingStatus,
} from '../src/types/domain.ts';
import { LEGACY_TO_ARCH_STATUS } from '../src/types/lifecycle.ts';
import {
  clearSessionCookie,
  deriveCsrfToken,
  generateMfaRecoveryCodes,
  generateSessionId,
  normalizeRecoveryCode,
  resolveAuthenticatedContextAsync,
  setSessionCookie,
  sha256Hex,
  signSessionToken,
  verifyAdminMfaChallenge,
  type AuthenticatedContext,
} from './auth.ts';
import {
  corsAllowlistMiddleware,
  getAllowedOrigins,
  hasPlanningClearance,
  requireActiveAccount,
  requireAdminWithMfa,
  requireRoles,
  validateCsrfProtection,
} from './authz.ts';
import { generateConceptProposal, getGeminiConfigStatus, runConciergeTurn } from './gemini.ts';
import { getIdentityProviderStatus, type VerifyProviderTokenOptions } from './identityProvider.ts';
import {
  buildConsultationConfirmationTemplate,
  buildStaffAlertTemplate,
  buildStatusUpdateTemplate,
  getEmailProviderStatus,
  type FetchLike,
} from './notifications.ts';
import { logStructured, observability } from './observability.ts';
import { enqueueOutboxNotification, NotificationOutboxWorker } from './outbox.ts';
import {
  createRateLimiter,
  InMemoryRateLimitStore,
  PostgresRateLimitStore,
  type RateLimitStore,
} from './rateLimit.ts';
import {
  checkPersistenceHealth,
  getPersistenceAdapterMode,
  getPgPool,
} from './repositories/postgresRepository.ts';
import {
  appendAudit,
  appendSecurityEvent,
  canTransitionBookingStatus,
  isAuthorizedForBooking,
  readDb,
  sanitizeBookingForRole,
  sanitizeUserForClient,
  withTransaction,
} from './store.ts';
import { buildTotpProvisioningUri, generateTotpSecret } from './totp.ts';

export interface CreateAppOptions {
  enableRateLimit?: boolean;
  providerVerifyOptions?: VerifyProviderTokenOptions;
  rateLimitStore?: RateLimitStore;
  notificationFetch?: FetchLike;
  outboxWorker?: NotificationOutboxWorker;
  trustProxy?: boolean | number | string;
}

function isValidIsoCalendarDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function createApp(options: CreateAppOptions = {}) {
  const enableRateLimit = options.enableRateLimit ?? true;
  const app = express();

  // Express 4 does not catch rejected promises from async route handlers automatically.
  // Wrap route registration methods so any async DB/runtime rejection routes cleanly to the global error handler.
  const wrapAsyncArgs = (args: unknown[]) =>
    args.map((arg) => {
      if (typeof arg === 'function' && arg.length <= 3) {
        const fn = arg as (req: Request, res: Response, next: NextFunction) => unknown;
        return (req: Request, res: Response, next: NextFunction) => {
          try {
            const result = fn(req, res, next);
            if (result && typeof (result as Promise<unknown>).catch === 'function') {
              (result as Promise<unknown>).catch(next);
            }
          } catch (err) {
            next(err);
          }
        };
      }
      return arg;
    });

  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const original = app[method].bind(app) as (...args: unknown[]) => unknown;
    (app as unknown as Record<string, (...args: unknown[]) => unknown>)[method] = (...args: unknown[]) => {
      if (method === 'get' && args.length === 1) {
        return original(...args);
      }
      return original(...wrapAsyncArgs(args));
    };
  }

  app.disable('x-powered-by');

  // Explicitly configure Express proxy trust for Railway / reverse-proxy deployment (Block 13.2).
  // Never default to `trust proxy = true` (which blindly trusts arbitrary caller-supplied X-Forwarded-For chains).
  if (options.trustProxy !== undefined) {
    app.set('trust proxy', options.trustProxy);
  } else {
    const rawTrustProxy = (
      process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? '1' : 'false')
    )
      .trim()
      .toLowerCase();
    if (rawTrustProxy === 'false' || rawTrustProxy === '0' || rawTrustProxy === '') {
      app.set('trust proxy', false);
    } else if (/^\d+$/.test(rawTrustProxy)) {
      app.set('trust proxy', Number(rawTrustProxy));
    } else if (rawTrustProxy === 'true') {
      app.set('trust proxy', 1);
    } else {
      app.set('trust proxy', rawTrustProxy);
    }
  }

  app.use(express.json({ limit: '1mb' }));

  // Security headers (OWASP ASVS aligned), correlation IDs & structured request observability
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const incomingId = req.header('x-request-id');
    const requestId =
      incomingId && /^[a-zA-Z0-9_-]{8,64}$/.test(incomingId) ? incomingId : crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      observability.recordHttpRequest(res.statusCode, durationMs);
      if (process.env.LOG_HTTP_REQUESTS === 'true' || res.statusCode >= 500) {
        logStructured(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
          requestId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs,
        });
      }
    });
    next();
  });

  // Explicit credentialed CORS allowlist (GitHub Pages -> Railway)
  app.use(corsAllowlistMiddleware());

  const resolvedRateStore: RateLimitStore =
    options.rateLimitStore ??
    (getPersistenceAdapterMode() === 'postgres' && process.env.DATABASE_URL
      ? new PostgresRateLimitStore(getPgPool())
      : new InMemoryRateLimitStore());
  const rateLimit = createRateLimiter(resolvedRateStore, enableRateLimit);

  const outboxWorker =
    options.outboxWorker ??
    new NotificationOutboxWorker({
      fetchImpl: options.notificationFetch,
    });

  function generateUniqueBookingReference(existingBookings: BookingRecord[], eventDate: string): string {
    const year = eventDate.slice(0, 4) || String(new Date().getUTCFullYear());
    const prefix = `CS-${year}-`;
    const existingSet = new Set(existingBookings.map((b) => b.referenceCode.toUpperCase()));
    let maxNum = 64;
    for (const b of existingBookings) {
      const match = /^CS-\d{4}-(\d+)$/i.exec(b.referenceCode);
      if (match) {
        const parsedNum = Number(match[1]);
        if (Number.isFinite(parsedNum) && parsedNum > maxNum) {
          maxNum = parsedNum;
        }
      }
    }
    let nextNum = maxNum + 1;
    let candidate = `${prefix}${String(nextNum).padStart(4, '0')}`;
    while (existingSet.has(candidate.toUpperCase())) {
      nextNum += 1;
      candidate = `${prefix}${String(nextNum).padStart(4, '0')}`;
    }
    return candidate;
  }

  async function getAuth(req: Request) {
    const db = await readDb();
    const ctx = await resolveAuthenticatedContextAsync(
      req,
      db.users,
      options.providerVerifyOptions,
      db.revokedSessionIds,
    );
    return { db, ctx };
  }

  async function logSecurityIncident(
    ctx: AuthenticatedContext,
    eventType: AuthSecurityEvent['eventType'],
    target: string,
    details: string,
  ) {
    await withTransaction((wdb) => {
      appendSecurityEvent(wdb, {
        eventType,
        userId: ctx.session.id !== 'guest-public' ? ctx.session.id : undefined,
        outcome: 'denied',
        details: `${target}: ${details}`,
      });
    });
  }

  // Cookie-authenticated state-changing request CSRF Origin/Referer + cryptographic synchronizer token protection
  app.use('/api', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
        return next();
      }
      // Only requests carrying a session cookie (and not Bearer auth) can be vulnerable to cookie CSRF.
      const hasBearer = Boolean((req.header('authorization') || '').trim().toLowerCase().startsWith('bearer '));
      const rawCookie = req.header('cookie') || '';
      if (hasBearer || !rawCookie.includes('cs_session=')) {
        return next();
      }

      const { ctx } = await getAuth(req);
      const csrfCheck = validateCsrfProtection(req, ctx);
      if (!csrfCheck.valid) {
        await withTransaction((wdb) => {
          appendSecurityEvent(wdb, {
            eventType: 'CSRF_REJECTED',
            userId: ctx.session.id !== 'guest-public' ? ctx.session.id : undefined,
            outcome: 'denied',
            details: `Rejected cookie-authenticated ${req.method} ${req.path}: ${csrfCheck.reason}`,
          });
          appendAudit(wdb, ctx.session, 'CSRF_ORIGIN_REJECTED', 'API', req.path, csrfCheck.reason || 'Cross-site cookie mutation rejected');
        });
        return res.status(403).json({
          error: 'Cross-site state-changing request rejected by CSRF protection policy.',
          code: csrfCheck.code || 'CSRF_ORIGIN_REJECTED',
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });

  function requireAdminMfa(ctx: AuthenticatedContext, res: Response): boolean {
    return requireAdminWithMfa(ctx, res);
  }

  // Health & Infrastructure Readiness
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      status: 'alive',
      service: 'Celebration Sisters Event Decor Platform',
      requestId: res.getHeader('X-Request-Id'),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    const persistence = await checkPersistenceHealth();
    const ai = getGeminiConfigStatus();
    const auth = getIdentityProviderStatus();
    const email = getEmailProviderStatus();
    res.status(persistence.ready ? 200 : 503).json({
      ok: persistence.ready,
      persistence,
      auth,
      email,
      ai: { model: ai.model, configured: ai.configured },
      requestId: res.getHeader('X-Request-Id'),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/health', async (_req: Request, res: Response) => {
    const persistence = await checkPersistenceHealth();
    const ai = getGeminiConfigStatus();
    const auth = getIdentityProviderStatus();
    const email = getEmailProviderStatus();
    res.status(persistence.ready ? 200 : 503).json({
      ok: persistence.ready,
      service: 'Celebration Sisters Event Decor Platform',
      persistence,
      auth,
      email,
      ai: { model: ai.model, configured: ai.configured, timeoutMs: ai.timeoutMs },
      requestId: res.getHeader('X-Request-Id'),
      timestamp: new Date().toISOString(),
    });
  });

  // Authentication & Signed Session Management
  app.get('/api/auth/config', (_req: Request, res: Response) => {
    const identity = getIdentityProviderStatus();
    res.json({
      ...identity,
      viteSupabaseConfigured: Boolean(process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY),
      allowedOriginsCount: getAllowedOrigins().length,
    });
  });

  app.get('/api/auth/personas', async (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Demo personas are unavailable in production.' });
    }
    const db = await readDb();
    res.json({ personas: db.users.map(sanitizeUserForClient) });
  });

  app.get('/api/auth/session', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (ctx.spoofAttemptDetected) {
      await logSecurityIncident(
        ctx,
        req.header('authorization') ? 'TOKEN_REJECTED' : 'SPOOF_ATTEMPT',
        '/api/auth/session',
        'Rejected invalid token or spoofed identity headers',
      );
    }
    if (ctx.emailPrivilegeBindBlocked) {
      await logSecurityIncident(
        ctx,
        'EMAIL_PRIVILEGE_BIND_BLOCKED',
        '/api/auth/session',
        'Blocked email-only privilege inheritance; immutable supabaseUserId binding required',
      );
    }
    res.json({
      user: sanitizeUserForClient(ctx.session),
      mfaVerified: ctx.mfaVerified,
      mfaRequired: ctx.session.role === 'admin' && !ctx.mfaVerified,
      emailVerified: ctx.emailVerified,
      accountStatus: ctx.accountStatus,
      aal: ctx.aal,
      authMethod: ctx.authMethod,
      csrfToken: ctx.sessionJti ? deriveCsrfToken(ctx.sessionJti) : undefined,
    });
  });

  app.post(
    '/api/auth/switch',
    rateLimit(20, 60_000, { failClosed: true, endpointGroup: 'auth' }),
    async (req: Request, res: Response) => {
      if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Demo account switching is unavailable in production.' });
      }
      const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Valid userId is required.' });
      }
      const db = await readDb();
      const user = db.users.find((u) => u.id === parsed.data.userId);
      if (!user) {
        return res.status(404).json({ error: 'Account not found.' });
      }
      if (user.accountStatus === 'suspended' || user.accountStatus === 'deactivated') {
        return res.status(403).json({
          error: 'This account is suspended or deactivated.',
          code: 'ACCOUNT_SUSPENDED',
        });
      }

      const jti = generateSessionId();
      const csrfToken = deriveCsrfToken(jti);
      const token = signSessionToken({
        jti,
        userId: user.id,
        role: user.role,
        mfaVerified: user.role !== 'admin',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 8,
      });

      setSessionCookie(res, token, { req, csrfToken });
      res.json({
        user: sanitizeUserForClient(user),
        token,
        csrfToken,
        mfaRequired: user.role === 'admin',
        mfaVerified: user.role !== 'admin',
      });
    },
  );

  // Enroll or rotate RFC 6238 TOTP factor for authenticated administrator.
  // Replacing an existing MFA factor strictly requires step-up auth (aal2 / mfaVerified) or a valid single-use recovery code.
  app.post(
    '/api/auth/mfa/totp/enroll',
    rateLimit(5, 60_000, { failClosed: true, endpointGroup: 'mfa' }),
    async (req: Request, res: Response) => {
      const { db: preflightDb, ctx } = await getAuth(req);
      if (!requireActiveAccount(ctx, res)) return;
      if (ctx.session.role !== 'admin') {
        return res.status(403).json({ error: 'Executive director clearance required to enroll admin TOTP MFA.' });
      }

      const bodyParsed = z
        .object({ recoveryCode: z.string().trim().min(6).max(32).optional() })
        .safeParse(req.body ?? {});
      const providedRecoveryCode = bodyParsed.success ? bodyParsed.data.recoveryCode : undefined;

      const existingTarget = preflightDb.users.find((u) => u.id === ctx.session.id);
      const alreadyEnrolled = Boolean(existingTarget?.mfaEnrolled && existingTarget?.totpSecret);

      if (alreadyEnrolled && !ctx.mfaVerified) {
        let recoveryMatched = false;
        if (providedRecoveryCode && existingTarget?.mfaRecoveryCodeHashes?.length) {
          const candidateHash = sha256Hex(normalizeRecoveryCode(providedRecoveryCode));
          recoveryMatched = existingTarget.mfaRecoveryCodeHashes.includes(candidateHash);
        }
        if (!recoveryMatched) {
          await logSecurityIncident(
            ctx,
            'MFA_FAILED',
            '/api/auth/mfa/totp/enroll',
            'Blocked attempt to replace existing admin TOTP factor without step-up MFA or valid recovery code',
          );
          return res.status(403).json({
            error: 'Step-up MFA verification or a valid single-use recovery code is required to replace an existing TOTP factor.',
            code: 'STEP_UP_MFA_REQUIRED',
          });
        }
      }

      const secret = generateTotpSecret();
      const otpauthUri = buildTotpProvisioningUri(ctx.session.email, secret);
      const recovery = generateMfaRecoveryCodes(8);

      await withTransaction((db) => {
        const target = db.users.find((u) => u.id === ctx.session.id);
        if (target) {
          target.totpSecret = secret;
          target.mfaEnrolled = true;
          target.mfaRecoveryCodeHashes = recovery.hashes;
        }
        appendAudit(
          db,
          ctx.session,
          alreadyEnrolled ? 'MFA_TOTP_ROTATED' : 'MFA_TOTP_ENROLLED',
          'AuthSession',
          ctx.session.id,
          alreadyEnrolled
            ? 'Rotated RFC 6238 TOTP authenticator factor after step-up verification'
            : 'Enrolled RFC 6238 TOTP authenticator factor and issued 8 single-use recovery codes',
        );
        appendSecurityEvent(db, {
          eventType: 'MFA_ENROLLED',
          userId: ctx.session.id,
          outcome: 'allowed',
          details: alreadyEnrolled ? 'Admin TOTP factor rotated via step-up auth' : 'Admin TOTP factor enrolled',
        });
      });

      res.json({
        enrolled: true,
        algorithm: 'SHA1',
        digits: 6,
        periodSeconds: 30,
        secret,
        otpauthUri,
        recoveryCodes: recovery.plainCodes,
      });
    },
  );

  app.post(
    '/api/auth/mfa/verify',
    rateLimit(10, 60_000, { failClosed: true, endpointGroup: 'mfa' }),
    async (req: Request, res: Response) => {
      const { ctx } = await getAuth(req);
      if (!requireActiveAccount(ctx, res)) return;
      const parsed = z.object({ code: z.string().min(6).max(12) }).safeParse(req.body);
      const challenge = parsed.success
        ? verifyAdminMfaChallenge(ctx.session, parsed.data.code)
        : { verified: false, method: 'none' as const };
      if (!parsed.success || !challenge.verified) {
        await withTransaction((db) => {
          appendAudit(db, ctx.session, 'MFA_VERIFICATION_FAILED', 'AuthSession', ctx.session.id, 'Invalid MFA code entered');
          appendSecurityEvent(db, {
            eventType: 'MFA_FAILED',
            userId: ctx.session.id,
            outcome: 'denied',
            details: 'Invalid director MFA verification code entered',
          });
        });
        return res.status(403).json({ error: 'Invalid director MFA verification code.', code: 'MFA_INVALID' });
      }

      const jti = generateSessionId();
      const csrfToken = deriveCsrfToken(jti);
      const token = signSessionToken({
        jti,
        userId: ctx.session.id,
        role: ctx.session.role,
        mfaVerified: true,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 8,
      });
      setSessionCookie(res, token, { req, csrfToken });
      await withTransaction((db) => {
        appendAudit(
          db,
          ctx.session,
          'MFA_VERIFIED',
          'AuthSession',
          ctx.session.id,
          `Privileged MFA verified (${challenge.method})`,
        );
        appendSecurityEvent(db, {
          eventType: 'MFA_VERIFIED',
          userId: ctx.session.id,
          outcome: 'allowed',
          details: `Privileged MFA verified via ${challenge.method}`,
        });
      });

      res.json({
        user: sanitizeUserForClient(ctx.session),
        token,
        csrfToken,
        mfaVerified: true,
        mfaRequired: false,
        method: challenge.method,
      });
    },
  );

  // Single-use MFA recovery code verification (Block 13.4)
  app.post(
    '/api/auth/mfa/recover',
    rateLimit(5, 60_000, { failClosed: true, endpointGroup: 'mfa_recovery' }),
    async (req: Request, res: Response) => {
      const { ctx } = await getAuth(req);
      if (!requireActiveAccount(ctx, res)) return;
      if (ctx.session.role !== 'admin') {
        return res.status(403).json({ error: 'Executive director clearance required.' });
      }

      const parsed = z.object({ recoveryCode: z.string().trim().min(6).max(32) }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Valid single-use recovery code required.' });
      }

      const candidateHash = sha256Hex(normalizeRecoveryCode(parsed.data.recoveryCode));
      const outcome = await withTransaction((db) => {
        const target = db.users.find((u) => u.id === ctx.session.id);
        const hashes = target?.mfaRecoveryCodeHashes || [];
        const matchIdx = hashes.findIndex((h) => h === candidateHash);
        if (!target || matchIdx === -1) {
          appendSecurityEvent(db, {
            eventType: 'MFA_FAILED',
            userId: ctx.session.id,
            outcome: 'denied',
            details: 'Invalid or already-used MFA recovery code submitted',
          });
          return null;
        }
        hashes.splice(matchIdx, 1);
        target.mfaRecoveryCodeHashes = hashes;
        appendAudit(
          db,
          ctx.session,
          'MFA_RECOVERY_CODE_USED',
          'AuthSession',
          ctx.session.id,
          `Consumed single-use MFA recovery code (${hashes.length} remaining)`,
        );
        appendSecurityEvent(db, {
          eventType: 'MFA_RECOVERY_USED',
          userId: ctx.session.id,
          outcome: 'allowed',
          details: `Admin MFA recovery code accepted (${hashes.length} remaining)`,
        });
        return { remaining: hashes.length };
      });

      if (!outcome) {
        return res.status(403).json({ error: 'Invalid or already-consumed MFA recovery code.', code: 'MFA_RECOVERY_INVALID' });
      }

      const jti = generateSessionId();
      const csrfToken = deriveCsrfToken(jti);
      const token = signSessionToken({
        jti,
        userId: ctx.session.id,
        role: ctx.session.role,
        mfaVerified: true,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 8,
      });
      setSessionCookie(res, token, { req, csrfToken });

      res.json({
        user: sanitizeUserForClient(ctx.session),
        token,
        csrfToken,
        mfaVerified: true,
        mfaRequired: false,
        remainingRecoveryCodes: outcome.remaining,
      });
    },
  );

  // Authenticated MFA factor revocation (requires step-up aal2 session)
  app.post(
    '/api/auth/mfa/totp/revoke',
    rateLimit(5, 60_000, { failClosed: true, endpointGroup: 'mfa' }),
    async (req: Request, res: Response) => {
      const { ctx } = await getAuth(req);
      if (!requireAdminMfa(ctx, res)) return;

      await withTransaction((db) => {
        const target = db.users.find((u) => u.id === ctx.session.id);
        if (target) {
          target.totpSecret = undefined;
          target.mfaEnrolled = false;
          target.mfaRecoveryCodeHashes = [];
        }
        if (ctx.sessionJti) {
          db.revokedSessionIds[ctx.sessionJti] = ctx.sessionExpiresAt ?? Date.now() + 1000 * 60 * 60 * 8;
        }
        appendAudit(db, ctx.session, 'MFA_TOTP_REVOKED', 'AuthSession', ctx.session.id, 'Revoked admin TOTP MFA factor and invalidated current session');
        appendSecurityEvent(db, {
          eventType: 'MFA_REVOKED',
          userId: ctx.session.id,
          outcome: 'allowed',
          details: 'Admin TOTP MFA factor revoked after aal2 verification',
        });
      });

      clearSessionCookie(res, { req });
      res.json({ revoked: true, reenrollmentRequired: true });
    },
  );

  app.post('/api/auth/logout', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    clearSessionCookie(res, { req });
    if (ctx.session.role !== 'guest') {
      await withTransaction((db) => {
        if (ctx.sessionJti) {
          const now = Date.now();
          for (const [k, exp] of Object.entries(db.revokedSessionIds)) {
            if (exp < now) delete db.revokedSessionIds[k];
          }
          db.revokedSessionIds[ctx.sessionJti] = ctx.sessionExpiresAt ?? now + 1000 * 60 * 60 * 8;
          appendSecurityEvent(db, {
            eventType: 'SESSION_REVOKED',
            userId: ctx.session.id,
            outcome: 'allowed',
            details: 'Server-side session JTI revoked on logout',
          });
        }
        appendSecurityEvent(db, {
          eventType: 'LOGOUT',
          userId: ctx.session.id,
          outcome: 'allowed',
          details: 'Session closed by user',
        });
      });
    }
    res.json({ ok: true });
  });

  // Availability, Blackout Dates & Temporary Holds
  app.get('/api/availability', async (req: Request, res: Response) => {
    const date = String(req.query.date || '').trim();
    const venue = String(req.query.venue || '').trim().toLowerCase();
    if (!date) {
      return res.status(400).json({ error: 'Event date is required to check availability.' });
    }
    const db = await readDb();
    const blackout = db.blackoutDates.find((b) => b.date === date);
    if (blackout) {
      return res.json({
        date,
        available: false,
        blackout: true,
        capacityNote: `Date unavailable (${blackout.reason}). Please choose an alternate celebration date.`,
      });
    }

    const nowIso = new Date().toISOString();
    const activeStatuses: BookingStatus[] = ['Confirmed', 'Planning', 'In Progress', 'Contract Pending', 'Payment Pending'];
    const sameDateCount = db.bookings.filter((b) => b.eventDate === date && b.status !== 'Cancelled').length;
    const exactVenueConflict = venue
      ? db.bookings.some(
          (b) =>
            b.eventDate === date &&
            b.venueName.toLowerCase() === venue &&
            activeStatuses.includes(b.status),
        )
      : false;
    const activeHoldConflict = venue
      ? db.availabilityHolds.some(
          (h) =>
            h.eventDate === date &&
            h.venueName.toLowerCase() === venue &&
            h.expiresAt > nowIso,
        )
      : false;

    const available = !exactVenueConflict && !activeHoldConflict && sameDateCount < 3;
    res.json({
      date,
      available,
      blackout: false,
      capacityNote: exactVenueConflict
        ? 'This venue and date are already reserved in our production calendar.'
        : activeHoldConflict
          ? 'A temporary consultation hold currently exists for this venue and date.'
          : sameDateCount >= 3
            ? 'Production capacity for this date is currently full. Please select an alternate date.'
            : 'Date is currently open for consultation and preliminary hold.',
    });
  });

  app.post('/api/availability/holds', rateLimit(10, 60_000), async (req: Request, res: Response) => {
    const schema = z.object({
      eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      venueName: z.string().trim().min(2),
      clientEmail: z.string().email(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid eventDate, venueName, and clientEmail required.' });

    try {
      const hold = await withTransaction((db) => {
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        db.availabilityHolds = db.availabilityHolds.filter((h) => h.expiresAt > nowIso);

        const conflict = db.availabilityHolds.find(
          (h) =>
            h.eventDate === parsed.data.eventDate &&
            h.venueName.toLowerCase() === parsed.data.venueName.toLowerCase(),
        );
        if (conflict) {
          throw new Error('HOLD_CONFLICT:A temporary hold already exists for this venue and date.');
        }

        const newHold = {
          id: `hld-${now}`,
          eventDate: parsed.data.eventDate,
          venueName: parsed.data.venueName,
          clientEmail: parsed.data.clientEmail,
          createdAt: nowIso,
          expiresAt: new Date(now + 1000 * 60 * 60 * 48).toISOString(),
        };
        db.availabilityHolds.push(newHold);
        return newHold;
      });
      res.status(201).json({ hold });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to place hold.';
      if (msg.startsWith('HOLD_CONFLICT:')) return res.status(409).json({ error: msg.slice(14) });
      return res.status(500).json({ error: msg });
    }
  });

  // Bookings list (strictly isolated by verified signed session or verified Supabase JWT)
  app.get('/api/bookings', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (ctx.spoofAttemptDetected) {
      await withTransaction((wdb) => {
        appendAudit(wdb, ctx.session, 'PRIVILEGE_SPOOF_BLOCKED', 'API', '/api/bookings', 'Rejected unverified identity/role header or invalid token');
        appendSecurityEvent(wdb, {
          eventType: req.header('authorization') ? 'TOKEN_REJECTED' : 'SPOOF_ATTEMPT',
          outcome: 'denied',
          details: 'Rejected unverified token or spoofed identity header on GET /api/bookings',
        });
      });
    }
    if (ctx.session.role !== 'guest' && (ctx.accountStatus === 'suspended' || ctx.accountStatus === 'deactivated')) {
      await logSecurityIncident(ctx, 'SUSPENDED_ACCOUNT_BLOCKED', '/api/bookings', 'Suspended account access blocked');
    }
    if (!requireActiveAccount(ctx, res)) {
      return;
    }
    const visible = db.bookings
      .filter((b) => isAuthorizedForBooking(b, ctx.session, db.vendors))
      .map((b) => sanitizeBookingForRole(b, ctx.session));
    res.json({ bookings: visible });
  });

  // Public consultation status lookup (strictly requires matching referenceCode + clientEmail; omits sensitive financials/notes)
  app.get('/api/bookings/track', rateLimit(15, 60_000), async (req: Request, res: Response) => {
    const referenceCode = String(req.query.referenceCode || '').trim().toUpperCase();
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!referenceCode || !email) {
      return res.status(400).json({ error: 'Both referenceCode and email are required to track a consultation.' });
    }

    const db = await readDb();
    const matched = db.bookings.find(
      (b) => b.referenceCode.toUpperCase() === referenceCode && b.clientEmail.toLowerCase() === email,
    );
    if (!matched) {
      return res.status(404).json({ error: 'No matching consultation found for that reference code and email.' });
    }

    return res.json({
      tracking: {
        referenceCode: matched.referenceCode,
        eventTitle: matched.eventTitle,
        eventDate: matched.eventDate,
        venueName: matched.venueName,
        location: matched.location,
        status: matched.status,
        architecturalStage: matched.architecturalStage,
        assignedLeadPlanner: matched.assignedLeadPlanner,
        updatedAt: matched.updatedAt,
      },
    });
  });

  const createBookingSchema = z.object({
    clientName: z.string().trim().min(2, 'Full name is required'),
    clientEmail: z.string().trim().email('Valid email address is required'),
    clientPhone: z.string().trim().min(7, 'Phone number is required'),
    eventTitle: z.string().trim().min(3, 'Event title is required'),
    eventType: z.string().trim().min(2),
    serviceDivisionIds: z.array(z.string()).min(1, 'Select at least one service division'),
    packageTier: z.string().trim().default('Custom Consultation Package'),
    eventDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD date format')
      .refine((v) => isValidIsoCalendarDate(v), 'Event date must be a valid calendar date'),
    location: z.string().trim().min(2),
    venueName: z.string().trim().min(2),
    guestCount: z.coerce.number().int().min(10).max(2000),
    budgetRange: z.string().trim().min(2),
    notes: z.string().trim().max(2000).default(''),
    requestConsultation: z.boolean().default(true),
  });

  app.post('/api/bookings', rateLimit(20, 60_000), async (req: Request, res: Response) => {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid booking input.' });
    }
    const input = parsed.data;
    const todayIso = new Date().toISOString().slice(0, 10);
    if (input.eventDate < todayIso) {
      return res.status(400).json({ error: 'Event date cannot be in the past. Please choose an upcoming date.' });
    }

    const rawIdemKey = (req.header('idempotency-key') || '').trim();
    const idempotencyKey =
      rawIdemKey && /^[a-zA-Z0-9_:-]{8,128}$/.test(rawIdemKey) ? rawIdemKey : undefined;

    const { ctx } = await getAuth(req);

    try {
      const outcome = await withTransaction(async (db) => {
        if (idempotencyKey && db.bookingIdempotencyKeys[idempotencyKey]) {
          const existingId = db.bookingIdempotencyKeys[idempotencyKey];
          const existingBooking = db.bookings.find((b) => b.id === existingId);
          if (existingBooking) {
            return { booking: existingBooking, deduplicated: true };
          }
        }

        const blackout = db.blackoutDates.find((b) => b.date === input.eventDate);
        if (blackout) {
          throw new Error(`BLACKOUT:Selected date (${input.eventDate}) is blocked: ${blackout.reason}.`);
        }

        const duplicate = db.bookings.find(
          (b) =>
            b.status !== 'Cancelled' &&
            b.eventDate === input.eventDate &&
            b.venueName.toLowerCase() === input.venueName.toLowerCase(),
        );
        if (duplicate) {
          throw new Error(`DUPLICATE:An active booking (${duplicate.referenceCode}) already exists for ${input.venueName} on ${input.eventDate}.`);
        }

        const sameDateBookings = db.bookings.filter(
          (b) => b.eventDate === input.eventDate && b.status !== 'Cancelled',
        );
        if (sameDateBookings.length >= 3) {
          throw new Error('CAPACITY:Our production calendar for this date has reached maximum simultaneous events.');
        }

        const refCode = generateUniqueBookingReference(db.bookings, input.eventDate);
        const id = `bkg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const initialStatus: BookingStatus = input.requestConsultation ? 'Consultation Requested' : 'Inquiry';
        const clientId =
          ctx.session.role === 'client'
            ? ctx.session.id
            : `lead:${sha256Hex(input.clientEmail.trim().toLowerCase()).slice(0, 12)}`;
        const termsSummary = `Preliminary production framework for ${input.eventTitle} on ${input.eventDate} at ${input.venueName}. Final itemized quotation required prior to execution.`;

        const newBooking: BookingRecord = {
          id,
          referenceCode: refCode,
          clientId,
          clientName: input.clientName,
          clientEmail: input.clientEmail,
          clientPhone: input.clientPhone,
          eventTitle: input.eventTitle,
          eventType: input.eventType,
          serviceDivisionIds: input.serviceDivisionIds,
          packageTier: input.packageTier,
          eventDate: input.eventDate,
          location: input.location,
          venueName: input.venueName,
          guestCount: input.guestCount,
          budgetRange: input.budgetRange,
          status: initialStatus,
          architecturalStage: LEGACY_TO_ARCH_STATUS[initialStatus],
          notes: input.notes,
          assignedLeadPlanner: 'Maya Jenkins',
          assignedVendorIds: [],
          quotations: [],
          contract: {
            id: `ctr-${Date.now()}`,
            bookingId: id,
            title: `Event Production Proposal Agreement — ${refCode}`,
            termsSummary,
            documentHash: sha256Hex(`${refCode}|${termsSummary}`),
            clientSigned: false,
            staffCountersigned: false,
          },
          payments: [],
          milestones: [
            {
              id: `ms-${Date.now()}-1`,
              title: 'Complete Discovery Consultation with Columbia Lead Planner',
              dueDate: input.eventDate,
              owner: 'Planner',
              completed: false,
            },
            {
              id: `ms-${Date.now()}-2`,
              title: 'Review AI Concept Studio Board & Itemized Quote',
              dueDate: input.eventDate,
              owner: 'Client',
              completed: false,
            },
          ],
          scheduleItems: [],
          messages: [
            {
              id: `msg-${Date.now()}`,
              sender: 'Celebration Sisters Intake',
              role: 'staff',
              text: `Inquiry ${refCode} received for ${input.eventDate} in ${input.location}. A lead planner will review availability and respond shortly.`,
              createdAt: new Date().toISOString(),
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        db.bookings.unshift(newBooking);
        if (idempotencyKey) {
          db.bookingIdempotencyKeys[idempotencyKey] = newBooking.id;
        }

        // Persist notification intent atomically in the SAME transaction as the booking (Block 13.7)
        const clientTpl = buildConsultationConfirmationTemplate({
          clientName: newBooking.clientName,
          referenceCode: newBooking.referenceCode,
          eventTitle: newBooking.eventTitle,
          eventDate: newBooking.eventDate,
          venueName: newBooking.venueName,
          location: newBooking.location,
        });
        const staffRecipient =
          (process.env.STAFF_NOTIFICATION_EMAIL || '').trim() || 'directors@celebrationsisters.example.com';
        const staffTpl = buildStaffAlertTemplate({
          referenceCode: newBooking.referenceCode,
          clientName: newBooking.clientName,
          eventTitle: newBooking.eventTitle,
          eventDate: newBooking.eventDate,
          venueName: newBooking.venueName,
          budgetRange: newBooking.budgetRange,
        });

        enqueueOutboxNotification(db, {
          idempotencyKey: `booking-confirm:${newBooking.id}`,
          category: 'consultation_confirmation',
          recipient: newBooking.clientEmail,
          bookingReference: newBooking.referenceCode,
          ...clientTpl,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `booking-staff-alert:${newBooking.id}`,
          category: 'staff_new_booking_alert',
          recipient: staffRecipient,
          bookingReference: newBooking.referenceCode,
          ...staffTpl,
        });

        appendAudit(
          db,
          ctx.session,
          'BOOKING_INQUIRY_CREATED',
          'Booking',
          refCode,
          `Created ${initialStatus} (${newBooking.architecturalStage}) for ${input.eventTitle} (${input.eventDate})`,
        );
        return { booking: newBooking, deduplicated: false };
      });

      observability.recordBookingOutcome(true);

      // Trigger best-effort outbox worker drain; durable intent already committed safely inside transaction
      if (!outcome.deduplicated) {
        try {
          await outboxWorker.processOnce();
        } catch (workerErr) {
          logStructured('warn', 'booking_outbox_immediate_drain_deferred', {
            referenceCode: outcome.booking.referenceCode,
            error: workerErr instanceof Error ? workerErr.message : 'Worker deferred',
          });
        }
      }

      res.status(outcome.deduplicated ? 200 : 201).json({
        booking: outcome.booking,
        deduplicated: outcome.deduplicated,
      });
    } catch (err) {
      observability.recordBookingOutcome(false);
      const msg = err instanceof Error ? err.message : 'Unable to save booking inquiry.';
      if (msg.startsWith('DUPLICATE:') || msg.startsWith('CAPACITY:') || msg.startsWith('BLACKOUT:')) {
        return res.status(409).json({ error: msg.split(':').slice(1).join(':') });
      }
      return res.status(500).json({ error: 'Unable to save booking inquiry.' });
    }
  });

  // Status transition endpoint with strict state machine & confirmation guard
  app.patch('/api/bookings/:id/status', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (
      !requireRoles(
        ctx,
        ['event_planner', 'staff', 'admin'],
        res,
        'Only authorized planners, staff, or directors may advance booking workflow statuses.',
      )
    ) {
      return;
    }
    if (ctx.session.role === 'admin' && !ctx.mfaVerified) {
      return res.status(403).json({
        error: 'MFA verification required for executive status transitions.',
        code: 'MFA_REQUIRED',
        mfaRequired: true,
      });
    }

    const parsed = z.object({ status: z.enum(BOOKING_STATUSES) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid booking status provided.' });
    }
    const targetStatus = parsed.data.status;

    try {
      const updated = await withTransaction(async (db) => {
        const booking = db.bookings.find((b) => b.id === req.params.id);
        if (!booking) throw new Error('NOT_FOUND:Booking not found.');

        if (!canTransitionBookingStatus(booking.status, targetStatus)) {
          throw new Error(`INVALID_STATE:Cannot transition directly from "${booking.status}" to "${targetStatus}".`);
        }

        if (targetStatus === 'Confirmed') {
          const hasSignedContract = booking.contract.clientSigned && booking.contract.staffCountersigned;
          const hasPaidDeposit = booking.payments.some((p) => p.status === 'Paid');
          if (!hasSignedContract || !hasPaidDeposit) {
            throw new Error(
              'GUARD:Cannot confirm event until both contract signatures and initial deposit payment are verified.',
            );
          }
        }

        const prev = booking.status;
        booking.status = targetStatus;
        booking.architecturalStage = LEGACY_TO_ARCH_STATUS[targetStatus];
        booking.updatedAt = new Date().toISOString();

        if (targetStatus === 'Cancelled') {
          for (const milestone of booking.payments) {
            if (milestone.status === 'Pending' || milestone.status === 'Overdue') {
              milestone.status = 'Cancelled';
            }
          }
        }

        if (prev !== targetStatus) {
          const tpl = buildStatusUpdateTemplate({
            clientName: booking.clientName,
            referenceCode: booking.referenceCode,
            eventTitle: booking.eventTitle,
            previousStatus: prev,
            newStatus: targetStatus,
          });
          enqueueOutboxNotification(db, {
            idempotencyKey: `booking-status:${booking.id}:${targetStatus}`,
            category: 'booking_status_update',
            recipient: booking.clientEmail,
            bookingReference: booking.referenceCode,
            ...tpl,
          });
        }

        appendAudit(
          db,
          ctx.session,
          'BOOKING_STATUS_UPDATED',
          'Booking',
          booking.referenceCode,
          `${prev} -> ${targetStatus} (${booking.architecturalStage})`,
        );
        return { booking, previousStatus: prev };
      });

      if (updated.previousStatus !== updated.booking.status) {
        try {
          await outboxWorker.processOnce();
        } catch (workerErr) {
          logStructured('warn', 'status_outbox_immediate_drain_deferred', {
            referenceCode: updated.booking.referenceCode,
            error: workerErr instanceof Error ? workerErr.message : 'Worker deferred',
          });
        }
      }

      res.json({ booking: updated.booking });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Status update failed.';
      if (msg.startsWith('NOT_FOUND:')) return res.status(404).json({ error: msg.slice(10) });
      if (msg.startsWith('INVALID_STATE:') || msg.startsWith('GUARD:')) {
        return res.status(422).json({ error: msg.split(':').slice(1).join(':') });
      }
      return res.status(500).json({ error: 'Status update failed.' });
    }
  });

  // Assign lead planner, staff & vendors to a booking (Block 13.8)
  app.patch('/api/bookings/:id/assignments', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (
      !requireRoles(
        ctx,
        ['event_planner', 'staff', 'admin'],
        res,
        'Only authorized planners, staff, or directors may update event assignments.',
      )
    ) {
      return;
    }
    if (ctx.session.role === 'admin' && !ctx.mfaVerified) {
      return res.status(403).json({ error: 'MFA verification required.', code: 'MFA_REQUIRED', mfaRequired: true });
    }
    const parsed = z
      .object({
        assignedLeadPlanner: z.string().trim().min(2).max(120).optional(),
        assignedVendorIds: z.array(z.string().trim().min(1)).max(20).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid assignment payload.' });
    }

    const updated = await withTransaction((db) => {
      const booking = db.bookings.find((b) => b.id === req.params.id);
      if (!booking) return null;
      if (parsed.data.assignedLeadPlanner) {
        booking.assignedLeadPlanner = parsed.data.assignedLeadPlanner;
      }
      if (parsed.data.assignedVendorIds) {
        const validVendorIds = parsed.data.assignedVendorIds.filter((vid) =>
          db.vendors.some((v) => v.id === vid),
        );
        booking.assignedVendorIds = Array.from(new Set(validVendorIds));
        for (const vendor of db.vendors) {
          const shouldHave = booking.assignedVendorIds.includes(vendor.id);
          const alreadyHas = vendor.assignedBookingIds.includes(booking.id);
          if (shouldHave && !alreadyHas) {
            vendor.assignedBookingIds.push(booking.id);
          } else if (!shouldHave && alreadyHas) {
            vendor.assignedBookingIds = vendor.assignedBookingIds.filter((bid) => bid !== booking.id);
          }
        }
      }
      booking.updatedAt = new Date().toISOString();
      appendAudit(
        db,
        ctx.session,
        'BOOKING_ASSIGNMENTS_UPDATED',
        'Booking',
        booking.referenceCode,
        `Lead: ${booking.assignedLeadPlanner}; Vendors: ${booking.assignedVendorIds.join(', ') || 'none'}`,
      );
      return booking;
    });

    if (!updated) return res.status(404).json({ error: 'Booking not found.' });
    res.json({ booking: updated });
  });

  // Create itemized quotation version (Planner/Staff/Admin only; cent-exact math; discounts approved by MFA Admin)
  app.post('/api/bookings/:id/quotes', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (
      !requireRoles(
        ctx,
        ['event_planner', 'staff', 'admin'],
        res,
        'Only authorized planners, staff, or directors can issue quotations.',
      )
    ) {
      return;
    }
    const schema = z.object({
      items: z
        .array(
          z.object({
            description: z.string().trim().min(2).max(300),
            division: z.string().trim().min(2).max(150),
            quantity: z.coerce.number().int().min(1).max(10000),
            unitPrice: z.coerce.number().finite().min(0).max(1_000_000),
          }),
        )
        .min(1),
      discountAmount: z.coerce.number().finite().min(0).default(0),
      discountReason: z.string().trim().max(300).optional(),
      notes: z.string().trim().max(1500).default(''),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid quotation items.' });
    }

    try {
      const updated = await withTransaction(async (db) => {
        const booking = db.bookings.find((b) => b.id === req.params.id);
        if (!booking) throw new Error('NOT_FOUND:Booking not found.');
        if (booking.status === 'Cancelled' || booking.status === 'Completed') {
          throw new Error(`INVALID_STATE:Cannot issue quotations for a ${booking.status} booking.`);
        }

        // Integer-cent precision financial arithmetic (Block 13.9)
        const subtotalCents = parsed.data.items.reduce(
          (sum, i) => sum + i.quantity * Math.round(i.unitPrice * 100),
          0,
        );
        const discountCents = Math.round(parsed.data.discountAmount * 100);
        if (discountCents > subtotalCents) {
          throw new Error('INVALID_DISCOUNT:Discount amount cannot exceed quotation subtotal.');
        }

        const discountApproved =
          discountCents === 0 || (ctx.session.role === 'admin' && ctx.mfaVerified);
        const totalCents = Math.max(0, subtotalCents - (discountApproved ? discountCents : 0));
        const total = Number((totalCents / 100).toFixed(2));
        const normalizedDiscount = Number((discountCents / 100).toFixed(2));
        const nextVersion = booking.quotations.length + 1;

        booking.quotations.push({
          version: nextVersion,
          createdAt: new Date().toISOString(),
          items: parsed.data.items.map((item, idx) => ({
            ...item,
            unitPrice: Number((Math.round(item.unitPrice * 100) / 100).toFixed(2)),
            id: `qi-${Date.now()}-${idx}`,
          })),
          discountAmount: normalizedDiscount,
          discountReason: parsed.data.discountReason,
          discountApproved,
          discountApprovedBy: discountApproved && discountCents > 0 ? ctx.session.name : undefined,
          totalAmount: total,
          notes: parsed.data.notes,
        });

        if (booking.payments.length === 0 && totalCents > 0) {
          const depositCents = Math.round(totalCents * 0.5);
          const balanceCents = totalCents - depositCents;
          booking.payments.push(
            {
              id: `pay-${Date.now()}-1`,
              label: '50% Retainer Deposit',
              amount: Number((depositCents / 100).toFixed(2)),
              dueDate: booking.eventDate,
              status: 'Pending',
            },
            {
              id: `pay-${Date.now()}-2`,
              label: '50% Final Production Balance',
              amount: Number((balanceCents / 100).toFixed(2)),
              dueDate: booking.eventDate,
              status: 'Pending',
            },
          );
        }

        if (canTransitionBookingStatus(booking.status, 'Quote Sent')) {
          booking.status = 'Quote Sent';
          booking.architecturalStage = LEGACY_TO_ARCH_STATUS['Quote Sent'];
        }
        booking.updatedAt = new Date().toISOString();
        appendAudit(db, ctx.session, 'QUOTATION_ISSUED', 'Booking', booking.referenceCode, `Issued Quote v${nextVersion} ($${total.toFixed(2)})`);
        return booking;
      });
      res.json({ booking: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to issue quote.';
      if (msg.startsWith('NOT_FOUND:')) return res.status(404).json({ error: msg.slice(10) });
      if (msg.startsWith('INVALID_DISCOUNT:')) return res.status(400).json({ error: msg.slice(17) });
      if (msg.startsWith('INVALID_STATE:')) return res.status(422).json({ error: msg.slice(14) });
      return res.status(500).json({ error: 'Unable to issue quote.' });
    }
  });

  // Digital Contract Signature with SHA-256 hash & evidentiary metadata
  app.post('/api/bookings/:id/contract/sign', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['client', 'event_planner', 'staff', 'admin'], res, 'Not authorized to sign this contract.')) {
      return;
    }
    const schema = z.object({ signatureName: z.string().trim().min(2, 'Typed legal signature is required') });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Signature required.' });
    }

    try {
      const updated = await withTransaction(async (db) => {
        const booking = db.bookings.find((b) => b.id === req.params.id);
        if (!booking) throw new Error('NOT_FOUND:Booking not found.');
        if (!isAuthorizedForBooking(booking, ctx.session, db.vendors)) {
          throw new Error('FORBIDDEN:Record-level access denied.');
        }
        if (booking.status === 'Cancelled') {
          throw new Error('INVALID_STATE:Cannot sign a contract for a cancelled booking.');
        }

        booking.contract.documentHash = sha256Hex(`${booking.referenceCode}|${booking.contract.termsSummary}`);

        if (ctx.session.role === 'client') {
          booking.contract.clientSigned = true;
          booking.contract.clientSignedBy = parsed.data.signatureName;
          booking.contract.clientSignedAt = new Date().toISOString();
          booking.contract.clientSignatureIp = req.ip || '127.0.0.1';
          if (booking.status === 'Quote Sent' || booking.status === 'Awaiting Approval' || booking.status === 'Contract Pending') {
            booking.status = 'Payment Pending';
            booking.architecturalStage = LEGACY_TO_ARCH_STATUS['Payment Pending'];
          }
        } else {
          booking.contract.staffCountersigned = true;
          booking.contract.staffCountersignedBy = parsed.data.signatureName;
        }

        booking.updatedAt = new Date().toISOString();
        appendAudit(
          db,
          ctx.session,
          'CONTRACT_SIGNED',
          'Contract',
          booking.referenceCode,
          `Signed by ${parsed.data.signatureName} (sha256:${booking.contract.documentHash.slice(0, 12)})`,
        );
        return booking;
      });
      res.json({ booking: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Signing failed.';
      if (msg.startsWith('FORBIDDEN:')) return res.status(403).json({ error: msg.slice(10) });
      if (msg.startsWith('NOT_FOUND:')) return res.status(404).json({ error: msg.slice(10) });
      if (msg.startsWith('INVALID_STATE:')) return res.status(422).json({ error: msg.slice(14) });
      return res.status(400).json({ error: msg });
    }
  });

  // Record payment milestone (Manual/Staging Ledger only — live Stripe/PayPal processing NOT YET INTEGRATED)
  app.post('/api/bookings/:id/payments/:paymentId/pay', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (
      !requireRoles(
        ctx,
        ['client', 'event_planner', 'staff', 'admin'],
        res,
        'Not authorized to record payment milestones.',
      )
    ) {
      return;
    }

    // Never allow client self-marking of payments in production without a verified payment gateway
    if (process.env.NODE_ENV === 'production' && ctx.session.role === 'client') {
      return res.status(501).json({
        error: 'Live online payment processing is not yet activated. Please coordinate milestone settlement with your Columbia planning director.',
        code: 'PAYMENT_PROVIDER_NOT_INTEGRATED',
        liveProcessorVerified: false,
      });
    }

    try {
      const updated = await withTransaction(async (db) => {
        const booking = db.bookings.find((b) => b.id === req.params.id);
        if (!booking) throw new Error('NOT_FOUND:Booking not found.');
        if (!isAuthorizedForBooking(booking, ctx.session, db.vendors)) {
          throw new Error('FORBIDDEN:Access denied.');
        }
        if (booking.status === 'Cancelled') {
          throw new Error('INVALID_STATE:Cannot settle payments on a cancelled booking.');
        }

        const milestone = booking.payments.find((p) => p.id === req.params.paymentId);
        if (!milestone) throw new Error('NOT_FOUND:Payment milestone not found.');
        if (milestone.status === 'Paid') {
          return booking; // Idempotent guard
        }
        if (milestone.status === 'Refunded' || milestone.status === 'Cancelled') {
          throw new Error(`INVALID_STATE:Cannot mark a ${milestone.status} milestone as Paid.`);
        }
        milestone.status = 'Paid';
        milestone.paidAt = new Date().toISOString();
        milestone.reference = `LEDGER-${Math.floor(10000 + Math.random() * 90000)}`;

        if (booking.status === 'Payment Pending' && booking.contract.clientSigned && booking.contract.staffCountersigned) {
          booking.status = 'Confirmed';
          booking.architecturalStage = LEGACY_TO_ARCH_STATUS['Confirmed'];
        }
        booking.updatedAt = new Date().toISOString();
        appendAudit(
          db,
          ctx.session,
          'PAYMENT_MILESTONE_RECORDED',
          'Payment',
          booking.referenceCode,
          `Recorded manual/staging ledger milestone $${milestone.amount} (${milestone.label}) — live processor not connected`,
        );
        return booking;
      });
      res.json({
        booking: updated,
        paymentProcessingMode: 'manual_staging_ledger',
        liveProcessorVerified: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Payment error.';
      if (msg.startsWith('FORBIDDEN:')) return res.status(403).json({ error: msg.slice(10) });
      if (msg.startsWith('NOT_FOUND:')) return res.status(404).json({ error: msg.slice(10) });
      if (msg.startsWith('INVALID_STATE:')) return res.status(422).json({ error: msg.slice(14) });
      return res.status(400).json({ error: msg });
    }
  });

  // Record payment refund state (MFA-verified Executive Admin only; manual staging ledger — live Stripe disabled)
  app.post('/api/bookings/:id/payments/:paymentId/refund', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;

    const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'A clear refund reason (minimum 3 characters) is required.' });
    }

    try {
      const updated = await withTransaction((db) => {
        const booking = db.bookings.find((b) => b.id === req.params.id);
        if (!booking) throw new Error('NOT_FOUND:Booking not found.');
        const milestone = booking.payments.find((p) => p.id === req.params.paymentId);
        if (!milestone) throw new Error('NOT_FOUND:Payment milestone not found.');
        if (milestone.status === 'Refunded') {
          return booking; // Idempotent refund guard
        }
        if (milestone.status !== 'Paid') {
          throw new Error('INVALID_STATE:Only Paid milestones can be marked Refunded.');
        }

        milestone.status = 'Refunded';
        milestone.refundedAt = new Date().toISOString();
        milestone.refundReason = parsed.data.reason;
        booking.updatedAt = new Date().toISOString();

        appendAudit(
          db,
          ctx.session,
          'PAYMENT_MILESTONE_REFUNDED',
          'Payment',
          booking.referenceCode,
          `Recorded manual/staging refund of $${milestone.amount} (${milestone.label}): ${parsed.data.reason}`,
        );
        return booking;
      });
      res.json({
        booking: updated,
        paymentProcessingMode: 'manual_staging_ledger',
        liveProcessorVerified: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refund recording error.';
      if (msg.startsWith('NOT_FOUND:')) return res.status(404).json({ error: msg.slice(10) });
      if (msg.startsWith('INVALID_STATE:')) return res.status(422).json({ error: msg.slice(14) });
      return res.status(500).json({ error: 'Unable to record refund.' });
    }
  });

  app.patch('/api/bookings/:id/milestones/:milestoneId', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['client', 'event_planner', 'staff', 'admin'], res, 'Unauthorized.')) {
      return;
    }
    const updated = await withTransaction(async (db) => {
      const booking = db.bookings.find((b) => b.id === req.params.id);
      if (!booking || !isAuthorizedForBooking(booking, ctx.session, db.vendors)) return null;
      const ms = booking.milestones.find((m) => m.id === req.params.milestoneId);
      if (!ms) return null;
      ms.completed = !ms.completed;
      booking.updatedAt = new Date().toISOString();
      return booking;
    });
    if (!updated) return res.status(404).json({ error: 'Milestone not found.' });
    res.json({ booking: updated });
  });

  app.post('/api/bookings/:id/messages', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireActiveAccount(ctx, res)) return;
    const parsed = z.object({ text: z.string().trim().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Message cannot be empty.' });

    const updated = await withTransaction(async (db) => {
      const booking = db.bookings.find((b) => b.id === req.params.id);
      if (!booking || !isAuthorizedForBooking(booking, ctx.session, db.vendors)) return null;
      booking.messages.push({
        id: `msg-${Date.now()}`,
        sender: ctx.session.name,
        role: ctx.session.role,
        text: parsed.data.text,
        createdAt: new Date().toISOString(),
      });
      booking.updatedAt = new Date().toISOString();
      return booking;
    });
    if (!updated) return res.status(404).json({ error: 'Booking not found.' });
    res.json({ booking: updated });
  });

  // Concept Studio endpoints (server-enforced record-level isolation & approval)
  app.get('/api/concepts', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireActiveAccount(ctx, res)) return;
    const visible = hasPlanningClearance(ctx.session)
      ? db.concepts
      : ctx.session.role === 'client'
        ? db.concepts.filter((c) => c.clientId === ctx.session.id)
        : [];
    res.json({ concepts: visible });
  });

  app.post('/api/concepts/:id/approve', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (
      !requireRoles(
        ctx,
        ['client', 'event_planner', 'staff', 'admin'],
        res,
        'Unauthorized to approve design concepts.',
      )
    ) {
      return;
    }
    const updated = await withTransaction(async (db) => {
      const concept = db.concepts.find((c) => c.id === req.params.id);
      if (!concept) return null;
      if (ctx.session.role === 'client' && concept.clientId !== ctx.session.id) return 'FORBIDDEN' as const;

      if (ctx.session.role === 'client') {
        concept.clientApproved = true;
        concept.clientApprovedAt = new Date().toISOString();
      } else {
        concept.staffApproved = true;
        concept.staffApprovedBy = ctx.session.name;
        concept.staffApprovedAt = new Date().toISOString();
      }
      appendAudit(db, ctx.session, 'CONCEPT_APPROVED', 'DesignConcept', concept.id, `${ctx.session.role} approval recorded`);
      return concept;
    });
    if (updated === 'FORBIDDEN') return res.status(403).json({ error: 'Record-level access denied.' });
    if (!updated) return res.status(404).json({ error: 'Concept not found.' });
    res.json({ concept: updated });
  });

  // AI Event Concierge (Server-side Gemini API with usage caps & session ownership isolation)
  app.post('/api/ai/concierge', rateLimit(15, 60_000), async (req: Request, res: Response) => {
    const schema = z.object({
      sessionId: z.string().optional(),
      clientName: z.string().max(120).optional(),
      message: z.string().trim().min(1).max(1500),
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(2000),
          }),
        )
        .max(20)
        .default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please enter a valid message for the AI Event Concierge.' });
    }

    const { ctx } = await getAuth(req);
    const callerOwnerId = ctx.session.role === 'guest' ? undefined : ctx.session.id;

    try {
      const aiResult = await runConciergeTurn(parsed.data.history, parsed.data.message);
      const now = new Date().toISOString();

      const savedSession = await withTransaction(async (db) => {
        let existing = parsed.data.sessionId
          ? db.aiSessions.find((s) => s.id === parsed.data.sessionId)
          : undefined;

        // Prevent cross-customer AI session hijacking
        if (existing && existing.ownerUserId && existing.ownerUserId !== callerOwnerId && !hasPlanningClearance(ctx.session)) {
          existing = undefined;
        }

        if (!existing) {
          existing = {
            id: `ais-${Date.now()}`,
            ownerUserId: callerOwnerId,
            createdAt: now,
            clientName: parsed.data.clientName || (ctx.session.role !== 'guest' ? ctx.session.name : 'Prospective Client'),
            messages: [],
            summary: aiResult.extractedLead.summary,
            escalatedToHuman: aiResult.extractedLead.needsHumanEscalation,
          };
          db.aiSessions.unshift(existing);
        }

        existing.messages.push(
          { role: 'user', content: parsed.data.message, timestamp: now },
          { role: 'assistant', content: aiResult.reply, timestamp: new Date().toISOString() },
        );
        existing.eventCategory = aiResult.extractedLead.eventCategory;
        existing.eventDate = aiResult.extractedLead.eventDate;
        existing.location = aiResult.extractedLead.location;
        if (aiResult.extractedLead.guestCount !== null) {
          existing.guestCount = aiResult.extractedLead.guestCount;
        }
        existing.theme = aiResult.extractedLead.theme;
        existing.budgetRange = aiResult.extractedLead.budgetRange;
        existing.summary = aiResult.extractedLead.summary;
        existing.escalatedToHuman = existing.escalatedToHuman || aiResult.extractedLead.needsHumanEscalation;
        return existing;
      });

      res.json({
        sessionId: savedSession.id,
        reply: aiResult.reply,
        extractedLead: aiResult.extractedLead,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI Concierge encountered an upstream error.';
      if (msg.startsWith('AI_TIMEOUT:')) {
        return res.status(504).json({ error: 'AI Event Concierge timed out. Please try again.', code: 'AI_TIMEOUT' });
      }
      if (msg.startsWith('AI_INVALID_OUTPUT:')) {
        return res.status(502).json({ error: 'AI Event Concierge returned an invalid response. Please retry.', code: 'AI_INVALID_OUTPUT' });
      }
      return res.status(502).json({ error: msg, code: 'AI_PROVIDER_ERROR' });
    }
  });

  // AI Event Concept Studio (Server-side Gemini API with strict concept & booking isolation)
  app.post('/api/ai/concept-studio', rateLimit(12, 60_000), async (req: Request, res: Response) => {
    const schema = z.object({
      conceptId: z.string().optional(),
      bookingId: z.string().optional(),
      eventType: z.string().min(2).max(120),
      guestCount: z.coerce.number().int().min(10).max(2000),
      venueStyle: z.string().min(2).max(200),
      preferredPalette: z.string().min(2).max(200),
      visionDescription: z.string().min(5).max(1500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please describe your event vision and venue style.' });
    }

    const { db: preflightDb, ctx } = await getAuth(req);

    // Pre-check concept revision & booking authorization BEFORE calling Gemini API
    if (parsed.data.conceptId) {
      const existingCheck = preflightDb.concepts.find((c) => c.id === parsed.data.conceptId);
      if (existingCheck) {
        const canRevise =
          hasPlanningClearance(ctx.session) ||
          (ctx.session.role === 'client' && existingCheck.clientId === ctx.session.id);
        if (!canRevise) {
          return res.status(403).json({ error: 'Cannot revise another client concept.' });
        }
      }
    }
    if (parsed.data.bookingId) {
      const bookingCheck = preflightDb.bookings.find((b) => b.id === parsed.data.bookingId);
      if (!bookingCheck || !isAuthorizedForBooking(bookingCheck, ctx.session, preflightDb.vendors)) {
        return res.status(403).json({ error: 'Not authorized to attach a concept to this booking.' });
      }
    }

    try {
      const proposal = await generateConceptProposal(parsed.data);

      const savedConcept = await withTransaction(async (db) => {
        const existing = parsed.data.conceptId
          ? db.concepts.find((c) => c.id === parsed.data.conceptId)
          : undefined;

        if (existing) {
          const canRevise =
            hasPlanningClearance(ctx.session) ||
            (ctx.session.role === 'client' && existing.clientId === ctx.session.id);
          if (!canRevise) {
            throw new Error('FORBIDDEN:Cannot revise another client concept.');
          }
          const nextVer = existing.currentVersion + 1;
          existing.currentVersion = nextVer;
          existing.clientApproved = false;
          existing.staffApproved = false;
          existing.revisions.unshift({
            version: nextVer,
            createdAt: new Date().toISOString(),
            ...proposal,
          });
          appendAudit(db, ctx.session, 'CONCEPT_REVISED', 'DesignConcept', existing.id, `Created revision v${nextVer}`);
          return existing;
        }

        const safeBookingId = parsed.data.bookingId
          ? parsed.data.bookingId
          : ctx.session.role === 'client'
            ? db.bookings.find((b) => b.clientId === ctx.session.id)?.id || 'unassigned-client-concept'
            : 'public-concierge-preview';

        const newConcept = {
          id: `cnc-${Date.now()}`,
          bookingId: safeBookingId,
          clientId:
            ctx.session.role === 'client'
              ? ctx.session.id
              : ctx.session.role === 'guest'
                ? 'public-concierge-preview'
                : ctx.session.id,
          title: `${proposal.themeName} Concept`,
          eventType: parsed.data.eventType,
          currentVersion: 1,
          revisions: [
            {
              version: 1,
              createdAt: new Date().toISOString(),
              ...proposal,
            },
          ],
          clientApproved: false,
          staffApproved: false,
          isConceptualVisualization: true as const,
          createdAt: new Date().toISOString(),
        };
        db.concepts.unshift(newConcept);
        appendAudit(db, ctx.session, 'CONCEPT_GENERATED', 'DesignConcept', newConcept.id, `Generated conceptual visualization (${proposal.themeName})`);
        return newConcept;
      });

      res.json({ concept: savedConcept });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Concept Studio AI service error.';
      if (msg.startsWith('FORBIDDEN:')) return res.status(403).json({ error: msg.slice(10) });
      if (msg.startsWith('AI_TIMEOUT:')) {
        return res.status(504).json({ error: 'AI Event Concept Studio timed out. Please try again.', code: 'AI_TIMEOUT' });
      }
      if (msg.startsWith('AI_INVALID_OUTPUT:')) {
        return res.status(502).json({ error: 'AI Event Concept Studio returned an invalid proposal. Please retry.', code: 'AI_INVALID_OUTPUT' });
      }
      return res.status(502).json({ error: msg, code: 'AI_PROVIDER_ERROR' });
    }
  });

  // Vendors & Staff Operations
  app.get('/api/vendors', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['vendor', 'event_planner', 'staff', 'admin'], res, 'Vendor or operations clearance required.')) {
      return;
    }
    const vendors =
      ctx.session.role === 'vendor'
        ? db.vendors.filter((v) => v.email.toLowerCase() === ctx.session.email.toLowerCase() || v.contactName === ctx.session.name)
        : db.vendors;
    res.json({ vendors });
  });

  app.patch('/api/vendors/:id/deliverables/:delivId', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['vendor', 'event_planner', 'staff', 'admin'], res, 'Unauthorized.')) {
      return;
    }
    const parsed = z.object({ status: z.enum(['Pending', 'In Progress', 'Completed']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid deliverable status.' });

    const updated = await withTransaction(async (db) => {
      const vendor = db.vendors.find((v) => v.id === req.params.id);
      if (!vendor) return null;
      if (ctx.session.role === 'vendor' && vendor.email.toLowerCase() !== ctx.session.email.toLowerCase()) {
        return 'FORBIDDEN' as const;
      }
      const deliv = vendor.deliverables.find((d) => d.id === req.params.delivId);
      if (!deliv) return null;
      deliv.status = parsed.data.status;
      appendAudit(db, ctx.session, 'VENDOR_DELIVERABLE_UPDATED', 'Vendor', vendor.id, `${deliv.task} -> ${deliv.status}`);
      return vendor;
    });
    if (updated === 'FORBIDDEN') return res.status(403).json({ error: 'Access denied.' });
    if (!updated) return res.status(404).json({ error: 'Deliverable not found.' });
    res.json({ vendor: updated });
  });

  app.get('/api/staff/checklists', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['event_planner', 'staff', 'admin'], res, 'Planner or staff clearance required.')) {
      return;
    }
    res.json({ checklists: db.staffChecklists });
  });

  app.patch('/api/staff/checklists/:id/tasks/:taskId', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['event_planner', 'staff', 'admin'], res, 'Planner or staff clearance required.')) return;
    const updated = await withTransaction(async (db) => {
      const chk = db.staffChecklists.find((c) => c.id === req.params.id);
      if (!chk) return null;
      const task = chk.tasks.find((t) => t.id === req.params.taskId);
      if (!task) return null;
      task.completed = !task.completed;
      return chk;
    });
    if (!updated) return res.status(404).json({ error: 'Task not found.' });
    res.json({ checklist: updated });
  });

  app.post('/api/staff/checklists/:id/issues', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['event_planner', 'staff', 'admin'], res, 'Planner or staff clearance required.')) return;
    const parsed = z.object({
      summary: z.string().trim().min(3),
      severity: z.enum(['Low', 'Medium', 'High']),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Issue summary required.' });

    const updated = await withTransaction(async (db) => {
      const chk = db.staffChecklists.find((c) => c.id === req.params.id);
      if (!chk) return null;
      chk.issuesReported.unshift({
        id: `iss-${Date.now()}`,
        summary: parsed.data.summary,
        severity: parsed.data.severity,
        reportedAt: new Date().toISOString(),
      });
      appendAudit(db, ctx.session, 'EVENT_DAY_ISSUE_REPORTED', 'StaffChecklist', chk.id, `[${parsed.data.severity}] ${parsed.data.summary}`);
      return chk;
    });
    if (!updated) return res.status(404).json({ error: 'Checklist not found.' });
    res.json({ checklist: updated });
  });

  // Inventory
  app.get('/api/inventory', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['event_planner', 'staff', 'admin'], res, 'Operations clearance required.')) {
      return;
    }
    res.json({ inventory: db.inventory });
  });

  app.patch('/api/inventory/:id', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireRoles(ctx, ['event_planner', 'staff', 'admin'], res, 'Unauthorized.')) return;
    const parsed = z.object({
      allocatedQuantity: z.coerce.number().int().min(0).optional(),
      condition: z.enum(['Pristine', 'Inspection Needed', 'In Maintenance']).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid inventory update.' });

    const updated = await withTransaction(async (db) => {
      const item = db.inventory.find((i) => i.id === req.params.id);
      if (!item) return null;
      if (parsed.data.allocatedQuantity !== undefined) {
        item.allocatedQuantity = Math.min(item.totalQuantity, parsed.data.allocatedQuantity);
      }
      if (parsed.data.condition) {
        item.condition = parsed.data.condition;
      }
      return item;
    });
    if (!updated) return res.status(404).json({ error: 'Inventory item not found.' });
    res.json({ item: updated });
  });

  // Executive Admin Dashboard Overview (Strict Role + MFA Required)
  app.get('/api/admin/overview', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;

    const totalPipelineValue = db.bookings.reduce((sum, b) => {
      const latestQuote = b.quotations[b.quotations.length - 1];
      return sum + (latestQuote?.totalAmount || 0);
    }, 0);
    const collectedRevenue = db.bookings.reduce(
      (sum, b) => sum + b.payments.filter((p) => p.status === 'Paid').reduce((ps, p) => ps + p.amount, 0),
      0,
    );

    res.json({
      metrics: {
        activeBookings: db.bookings.filter((b) => b.status !== 'Cancelled' && b.status !== 'Completed').length,
        totalPipelineValue,
        collectedRevenue,
        aiSessionsCount: db.aiSessions.length,
        pendingApprovals: db.concepts.filter((c) => !c.clientApproved || !c.staffApproved).length,
      },
      aiSessions: db.aiSessions,
      automationWorkflows: db.automationWorkflows,
      automationLogs: db.automationLogs,
      auditLogs: db.auditLogs,
      authSecurityEvents: db.authSecurityEvents,
      notificationDeliveries: db.notificationDeliveries,
      blackoutDates: db.blackoutDates,
      availabilityHolds: db.availabilityHolds,
      users: db.users.map(sanitizeUserForClient),
    });
  });

  // Explicit admin-controlled immutable Supabase UID identity binding
  app.post('/api/admin/users/:id/link-identity', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    const parsed = z.object({ supabaseUserId: z.string().trim().min(6).max(128) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid immutable supabaseUserId is required.' });
    }

    try {
      const updatedUser = await withTransaction((db) => {
        const conflict = db.users.find(
          (u) => u.supabaseUserId === parsed.data.supabaseUserId && u.id !== req.params.id,
        );
        if (conflict) {
          throw new Error('CONFLICT:This Supabase identity is already linked to another user.');
        }
        const target = db.users.find((u) => u.id === req.params.id);
        if (!target) return null;
        target.supabaseUserId = parsed.data.supabaseUserId;
        appendAudit(
          db,
          ctx.session,
          'IDENTITY_LINKED',
          'User',
          target.id,
          `Bound immutable supabaseUserId for role ${target.role}`,
        );
        appendSecurityEvent(db, {
          eventType: 'ACCOUNT_LINKED',
          userId: target.id,
          outcome: 'allowed',
          details: `Executive director bound immutable Supabase UID to ${target.id} (${target.role})`,
        });
        return sanitizeUserForClient(target);
      });

      if (!updatedUser) return res.status(404).json({ error: 'User not found.' });
      return res.json({ user: updatedUser });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to link identity.';
      if (msg.startsWith('CONFLICT:')) return res.status(409).json({ error: msg.slice(9) });
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // Admin-controlled account suspension / reactivation (Block 13.4)
  app.patch('/api/admin/users/:id/status', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    const parsed = z
      .object({
        accountStatus: z.enum(['active', 'suspended', 'deactivated']),
        reason: z.string().trim().min(3).max(300).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid accountStatus (active, suspended, deactivated) is required.' });
    }
    if (req.params.id === ctx.session.id && parsed.data.accountStatus !== 'active') {
      return res.status(400).json({ error: 'Executive administrators cannot suspend or deactivate their own active session.' });
    }

    const updatedUser = await withTransaction((db) => {
      const target = db.users.find((u) => u.id === req.params.id);
      if (!target) return null;
      const prevStatus = target.accountStatus ?? 'active';
      target.accountStatus = parsed.data.accountStatus;
      appendAudit(
        db,
        ctx.session,
        'USER_ACCOUNT_STATUS_CHANGED',
        'User',
        target.id,
        `${prevStatus} -> ${target.accountStatus}${parsed.data.reason ? ` (${parsed.data.reason})` : ''}`,
      );
      appendSecurityEvent(db, {
        eventType: 'ACCOUNT_STATUS_CHANGED',
        userId: target.id,
        outcome: 'allowed',
        details: `Account status updated from ${prevStatus} to ${target.accountStatus} by ${ctx.session.id}`,
      });
      return sanitizeUserForClient(target);
    });

    if (!updatedUser) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: updatedUser });
  });

  app.get('/api/admin/notifications', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    res.json({
      provider: getEmailProviderStatus(),
      deliveries: db.notificationDeliveries,
      outbox: db.notificationOutbox,
    });
  });

  app.get('/api/admin/outbox', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    const queueDepth = db.notificationOutbox.filter(
      (j) => j.status === 'Pending' || j.status === 'Retrying' || j.status === 'Claimed',
    ).length;
    const deadLetterCount = db.notificationOutbox.filter((j) => j.status === 'DeadLetter').length;
    res.json({
      queueDepth,
      deadLetterCount,
      jobs: db.notificationOutbox,
    });
  });

  app.post('/api/admin/outbox/process', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    const summary = await outboxWorker.processOnce();
    res.json({ summary });
  });

  app.get('/api/admin/metrics', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    const queueDepth = db.notificationOutbox.filter(
      (j) => j.status === 'Pending' || j.status === 'Retrying' || j.status === 'Claimed',
    ).length;
    const deadLetterCount = db.notificationOutbox.filter((j) => j.status === 'DeadLetter').length;
    res.json({
      metrics: observability.getSnapshot(),
      outbox: {
        queueDepth,
        deadLetterCount,
      },
    });
  });

  app.post('/api/admin/blackout-dates', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    const parsed = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().trim().min(3),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid YYYY-MM-DD date and reason required.' });

    const created = await withTransaction(async (db) => {
      const exists = db.blackoutDates.some((b) => b.date === parsed.data.date);
      if (exists) return null;
      const entry = {
        id: `blk-${Date.now()}`,
        date: parsed.data.date,
        reason: parsed.data.reason,
        createdBy: ctx.session.name,
        createdAt: new Date().toISOString(),
      };
      db.blackoutDates.push(entry);
      appendAudit(db, ctx.session, 'BLACKOUT_DATE_ADDED', 'BlackoutDate', entry.date, entry.reason);
      return entry;
    });
    if (!created) return res.status(409).json({ error: 'Blackout date already exists.' });
    res.status(201).json({ blackoutDate: created });
  });

  app.patch('/api/admin/automation/:id', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    const parsed = z.object({ authorizedEnabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid toggle payload.' });

    const updated = await withTransaction(async (db) => {
      const wf = db.automationWorkflows.find((w) => w.id === req.params.id);
      if (!wf) return null;
      wf.authorizedEnabled = parsed.data.authorizedEnabled;
      appendAudit(
        db,
        ctx.session,
        'AUTOMATION_AUTHORIZATION_CHANGED',
        'AutomationWorkflow',
        wf.id,
        `${wf.name} set to ${wf.authorizedEnabled ? 'AUTHORIZED' : 'PAUSED'}`,
      );
      return wf;
    });
    if (!updated) return res.status(404).json({ error: 'Workflow not found.' });
    res.json({ workflow: updated });
  });

  app.post('/api/admin/automation/:id/run', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;

    const result = await withTransaction(async (db) => {
      const wf = db.automationWorkflows.find((w) => w.id === req.params.id);
      if (!wf) return null;
      const latestBooking = db.bookings[0];
      const logEntry = {
        id: `alog-${Date.now()}`,
        workflowId: wf.id,
        workflowName: wf.name,
        recipient: latestBooking?.clientEmail || 'system@celebrationsisters.example.com',
        bookingRef: latestBooking?.referenceCode || 'N/A',
        status: wf.authorizedEnabled ? ('Dispatched' as const) : ('Skipped (Unauthorized)' as const),
        timestamp: new Date().toISOString(),
      };
      if (wf.authorizedEnabled) {
        wf.dispatchCount += 1;
        wf.lastRunAt = logEntry.timestamp;
      }
      db.automationLogs.unshift(logEntry);
      return { workflow: wf, log: logEntry };
    });
    if (!result) return res.status(404).json({ error: 'Workflow not found.' });
    res.json(result);
  });

  // Global safe error handler — prevents hung sockets, unhandled rejections, stack trace leaks, or raw SQL errors
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const isSyntax = err instanceof SyntaxError && 'status' in err;
    if (isSyntax) {
      res.status(400).json({ error: 'Malformed JSON request payload.', code: 'BAD_JSON' });
      return;
    }
    const errMsg = err instanceof Error ? err.message : '';
    const errCode =
      typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : '';
    if (
      errMsg.includes('PERSISTENCE_READINESS_FAILURE') ||
      errMsg.includes('DATABASE_URL is not configured') ||
      ['ECONNREFUSED', 'ETIMEDOUT', '57P01', '57P03'].includes(errCode)
    ) {
      res.status(503).json({
        error: 'Database service is temporarily unavailable. Please try again shortly.',
        code: 'DATABASE_UNAVAILABLE',
        requestId: res.getHeader('X-Request-Id'),
      });
      return;
    }
    res.status(500).json({
      error: 'An unexpected server error occurred. Please try again later.',
      code: 'INTERNAL_SERVER_ERROR',
      requestId: res.getHeader('X-Request-Id'),
    });
  });

  return app;
}
