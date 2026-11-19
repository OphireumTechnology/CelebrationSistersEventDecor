import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  BOOKING_STATUSES,
  CRM_PIPELINE_STAGES,
  type AuthSecurityEvent,
  type BookingRecord,
  type BookingStatus,
  type ConsultationAppointment,
  type ConsultationMethod,
  type CrmFollowUpTask,
  type StaffAvailabilityRule,
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
  buildConsultationCancelledTemplate,
  buildConsultationConfirmationTemplate,
  buildConsultationConfirmedTemplate,
  buildConsultationFollowUpTemplate,
  buildConsultationReminderTemplate,
  buildConsultationRescheduledTemplate,
  buildInternalOperationsAlertTemplate,
  buildProposalAvailableTemplate,
  buildStaffAlertTemplate,
  buildStatusUpdateTemplate,
  getEmailProviderStatus,
  verifyResendWebhookSignature,
  type FetchLike,
} from './notifications.ts';
import { logStructured, observability } from './observability.ts';
import {
  enqueueOutboxNotification,
  NotificationOutboxWorker,
  recordProviderDeliveryConfirmation,
  requeueOutboxJob,
} from './outbox.ts';
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
  canTransitionConsultationStatus,
  computeConsultationAvailability,
  findPlannerSlotConflict,
  formatFullDateTimeForTimezone,
  generateConsultationAccessToken,
  isValidIanaTimezone,
  STUDIO_TIMEZONE,
  SUPPORTED_TIMEZONES,
  validateConsultationTokenAccess,
  validateRequestedConsultationSlot,
} from './scheduling.ts';
import {
  appendAudit,
  appendSecurityEvent,
  canTransitionBookingStatus,
  isAuthorizedForBooking,
  readDb,
  sanitizeBookingForRole,
  sanitizeConsultationForClient,
  sanitizeUserForClient,
  withTransaction,
  type DatabaseSchema,
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

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

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

    const consultationMetrics = computeConsultationMetrics(db);

    res.json({
      metrics: {
        activeBookings: db.bookings.filter((b) => b.status !== 'Cancelled' && b.status !== 'Completed').length,
        totalPipelineValue,
        collectedRevenue,
        aiSessionsCount: db.aiSessions.length,
        pendingApprovals: db.concepts.filter((c) => !c.clientApproved || !c.staffApproved).length,
      },
      consultationMetrics,
      consultations: db.consultations.map(sanitizeConsultationForClient),
      staffAvailabilityRules: db.staffAvailabilityRules,
      crmFollowUpTasks: db.crmFollowUpTasks,
      aiSessions: db.aiSessions,
      automationWorkflows: db.automationWorkflows,
      automationLogs: db.automationLogs,
      auditLogs: db.auditLogs,
      authSecurityEvents: db.authSecurityEvents,
      notificationDeliveries: db.notificationDeliveries,
      notificationOutbox: db.notificationOutbox,
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

  app.post('/api/admin/outbox/:jobId/retry', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 240) : undefined;
    const result = await requeueOutboxJob(String(req.params.jobId), ctx.session, reason);
    if (!result.ok) {
      return res.status(result.error?.includes('not found') ? 404 : 409).json({ error: result.error });
    }
    const summary = req.body?.processImmediately ? await outboxWorker.processOnce() : undefined;
    res.json({ job: result.job, summary });
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

  // =========================================================================
  // PHASE 14 — ENTERPRISE CONSULTATION SCHEDULING, CRM & COMMAND CENTER API
  // =========================================================================

  function formatConsultationMethodLabel(method: ConsultationMethod): string {
    if (method === 'in_person_columbia') return 'In-Person (Columbia, SC Studio)';
    if (method === 'phone') return 'Executive Phone Consultation';
    return 'Private Video Consultation';
  }

  function computeConsultationMetrics(db: DatabaseSchema) {
    const nowMs = Date.now();
    const list = db.consultations;
    return {
      total: list.length,
      newRequests: list.filter((c) => c.status === 'Pending' || c.status === 'Draft').length,
      pending: list.filter((c) => c.status === 'Pending').length,
      confirmed: list.filter((c) => c.status === 'Confirmed').length,
      rescheduled: list.filter((c) => c.status === 'Rescheduled').length,
      upcoming: list.filter(
        (c) =>
          (c.status === 'Pending' || c.status === 'Confirmed' || c.status === 'Rescheduled') &&
          new Date(c.startUtc).getTime() >= nowMs,
      ).length,
      completed: list.filter((c) => c.status === 'Completed').length,
      cancelled: list.filter((c) => c.status === 'Cancelled').length,
      noShow: list.filter((c) => c.status === 'No-show').length,
      overdueFollowUps: db.crmFollowUpTasks.filter(
        (t) => t.status === 'Open' && new Date(t.dueAt).getTime() < nowMs,
      ).length,
    };
  }

  function requireStaffOrAdminMfa(ctx: AuthenticatedContext, res: Response, message = 'Operations clearance required.'): boolean {
    if (!requireRoles(ctx, ['event_planner', 'staff', 'admin'], res, message)) return false;
    if (ctx.session.role === 'admin' && !requireAdminMfa(ctx, res)) return false;
    return true;
  }

  function resolveConsultationActorAccess(
    req: Request,
    ctx: AuthenticatedContext,
    consultation: ConsultationAppointment,
  ): 'staff_or_admin' | 'client_owner' | 'scoped_token' | null {
    if (ctx.authMethod !== 'guest' && (ctx.session.accountStatus ?? 'active') === 'active') {
      if (ctx.session.role === 'event_planner' || ctx.session.role === 'staff') {
        return 'staff_or_admin';
      }
      if (ctx.session.role === 'admin' && ctx.mfaVerified) {
        return 'staff_or_admin';
      }
      if (
        ctx.session.role === 'client' &&
        (consultation.clientId === ctx.session.id ||
          consultation.clientEmail.toLowerCase() === ctx.session.email.toLowerCase())
      ) {
        return 'client_owner';
      }
    }
    const providedToken =
      (typeof req.body?.accessToken === 'string' ? req.body.accessToken : undefined) ||
      (typeof req.query?.accessToken === 'string' ? req.query.accessToken : undefined) ||
      req.header('x-consultation-token') ||
      undefined;
    const tokenCheck = validateConsultationTokenAccess(consultation, providedToken);
    if (tokenCheck.valid) {
      return 'scoped_token';
    }
    return null;
  }

  // 1. Real-time server-authoritative consultation availability calendar
  app.get(
    '/api/consultations/availability',
    rateLimit(90, 60_000, { endpointGroup: 'consultations:availability', failClosed: false }),
    async (req: Request, res: Response) => {
      const startDate =
        typeof req.query.startDate === 'string' && isValidIsoCalendarDate(req.query.startDate)
          ? req.query.startDate
          : new Date().toISOString().slice(0, 10);
      const daysRaw = Number(req.query.days ?? 14);
      const days = Number.isFinite(daysRaw) ? Math.min(31, Math.max(1, Math.floor(daysRaw))) : 14;
      const requestedTz =
        typeof req.query.timezone === 'string' && req.query.timezone.trim()
          ? req.query.timezone.trim()
          : STUDIO_TIMEZONE;
      if (!isValidIanaTimezone(requestedTz)) {
        return res.status(400).json({ error: 'Invalid IANA timezone identifier.', supportedTimezones: SUPPORTED_TIMEZONES });
      }
      const methodRaw = typeof req.query.method === 'string' ? req.query.method.trim() : undefined;
      const methodParsed = methodRaw ? z.enum(['video', 'in_person_columbia', 'phone']).safeParse(methodRaw) : null;
      if (methodParsed && !methodParsed.success) {
        return res.status(400).json({ error: 'Invalid consultation method. Use video, in_person_columbia, or phone.' });
      }
      const plannerId =
        typeof req.query.plannerId === 'string' && req.query.plannerId.trim() ? req.query.plannerId.trim() : undefined;
      const excludeConsultationId =
        typeof req.query.excludeConsultationId === 'string' && req.query.excludeConsultationId.trim()
          ? req.query.excludeConsultationId.trim()
          : undefined;

      const db = await readDb();
      const availability = computeConsultationAvailability({
        startDate,
        days,
        clientTimezone: requestedTz,
        method: methodParsed?.success ? methodParsed.data : undefined,
        plannerId,
        excludeConsultationId,
        rules: db.staffAvailabilityRules,
        blackoutDates: db.blackoutDates,
        consultations: db.consultations,
        slotHolds: db.consultationSlotHolds,
        users: db.users,
      });

      const planners = db.users
        .filter((u) => ['event_planner', 'staff', 'admin'].includes(u.role) && (u.accountStatus ?? 'active') === 'active')
        .map((u) => ({ id: u.id, name: u.name, role: u.role }));

      res.json({
        studioTimezone: STUDIO_TIMEZONE,
        clientTimezone: requestedTz,
        supportedTimezones: SUPPORTED_TIMEZONES,
        planners,
        days: availability,
      });
    },
  );

  // 2. Temporary 10-minute consultation slot hold
  app.post(
    '/api/consultations/holds',
    rateLimit(25, 60_000, { endpointGroup: 'consultations:holds', failClosed: false }),
    async (req: Request, res: Response) => {
      const parsed = z
        .object({
          plannerId: z.string().trim().min(2).max(120),
          startUtc: z.string().datetime(),
          method: z.enum(['video', 'in_person_columbia', 'phone']).default('video'),
          holderKey: z.string().trim().min(6).max(160),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Valid plannerId, startUtc (ISO-8601 UTC), method, and holderKey are required.' });
      }

      const holderHash = sha256Hex(parsed.data.holderKey);
      const nowMs = Date.now();
      const outcome = await withTransaction((db) => {
        db.consultationSlotHolds = db.consultationSlotHolds.filter((h) => new Date(h.expiresAt).getTime() > nowMs);

        const check = validateRequestedConsultationSlot({
          plannerId: parsed.data.plannerId,
          startUtc: parsed.data.startUtc,
          method: parsed.data.method,
          rules: db.staffAvailabilityRules,
          blackoutDates: db.blackoutDates,
          consultations: db.consultations,
          slotHolds: db.consultationSlotHolds,
          ignoreHolderHash: holderHash,
          nowMs,
        });
        if (!check.valid || !check.endUtc) {
          return {
            ok: false as const,
            error: check.error || 'Selected slot is unavailable.',
            code: check.errorCode || 'SLOT_CONFLICT',
          };
        }

        db.consultationSlotHolds = db.consultationSlotHolds.filter((h) => h.holderFingerprintHash !== holderHash);
        const hold = {
          id: `chold-${crypto.randomUUID().slice(0, 12)}`,
          plannerId: parsed.data.plannerId,
          slotStartUtc: new Date(parsed.data.startUtc).toISOString(),
          slotEndUtc: check.endUtc,
          holderFingerprintHash: holderHash,
          expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
          createdAt: new Date(nowMs).toISOString(),
        };
        db.consultationSlotHolds.push(hold);
        return { ok: true as const, hold };
      });

      if (!outcome.ok) {
        const status = outcome.code === 'SLOT_CONFLICT' || outcome.code === 'BLACKOUT' ? 409 : 400;
        return res.status(status).json({ error: outcome.error, code: outcome.code });
      }

      res.status(201).json({
        hold: {
          id: outcome.hold.id,
          plannerId: outcome.hold.plannerId,
          startUtc: outcome.hold.slotStartUtc,
          endUtc: outcome.hold.slotEndUtc,
          expiresAt: outcome.hold.expiresAt,
        },
      });
    },
  );

  // 3. Create Consultation Booking (Atomic scheduling + linked CRM/booking + transactional outbox)
  const createConsultationSchema = z.object({
    eventType: z.string().trim().min(2).max(120),
    eventTitle: z.string().trim().min(3).max(180).optional(),
    eventTheme: z.string().trim().max(180).optional(),
    serviceDivisionIds: z.array(z.string().trim().min(1)).min(1).max(12),
    eventDate: z.string().refine(isValidIsoCalendarDate, 'Target event date must be a valid YYYY-MM-DD calendar date.'),
    guestCount: z.coerce.number().int().min(10).max(5000),
    budgetRange: z.string().trim().min(2).max(80),
    location: z.string().trim().min(2).max(160),
    venueName: z.string().trim().min(2).max(180).default('Venue To Be Finalized'),
    consultationStartUtc: z.string().datetime(),
    consultationMethod: z.enum(['video', 'in_person_columbia', 'phone']).default('video'),
    plannerId: z.string().trim().min(2).max(120).optional(),
    clientTimezone: z.string().trim().min(2).max(80).default(STUDIO_TIMEZONE),
    holderKey: z.string().trim().min(6).max(160).optional(),
    clientName: z.string().trim().min(2).max(140),
    clientEmail: z.string().trim().email().max(180),
    clientPhone: z.string().trim().min(7).max(40),
    preferredContactMethod: z.enum(['email', 'phone', 'sms']).default('email'),
    notes: z.string().trim().max(3000).default(''),
    privacyConsentAccepted: z.literal(true),
  });

  app.post(
    '/api/consultations',
    rateLimit(20, 60_000, { endpointGroup: 'consultations:create', failClosed: false }),
    async (req: Request, res: Response) => {
      const { ctx } = await getAuth(req);
      const parsed = createConsultationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Please complete all required consultation fields and accept the privacy consent notice.',
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const input = parsed.data;
      if (!isValidIanaTimezone(input.clientTimezone)) {
        return res.status(400).json({ error: 'Unsupported timezone provided.' });
      }
      const todayIso = new Date().toISOString().slice(0, 10);
      if (input.eventDate < todayIso) {
        return res.status(400).json({ error: 'Target event date cannot be in the past.' });
      }

      const rawIdempotency = (req.header('idempotency-key') || '').trim().slice(0, 128);
      const idempotencyKey = rawIdempotency || undefined;
      const holderHash = input.holderKey ? sha256Hex(input.holderKey) : undefined;
      const nowIso = new Date().toISOString();
      const nowMs = Date.now();

      const result = await withTransaction((db) => {
        if (idempotencyKey && db.consultationIdempotencyKeys[idempotencyKey]) {
          const existingId = db.consultationIdempotencyKeys[idempotencyKey];
          const existingConsultation = db.consultations.find((c) => c.id === existingId);
          const existingBooking = existingConsultation
            ? db.bookings.find((b) => b.id === existingConsultation.bookingId)
            : undefined;
          if (existingConsultation) {
            return {
              ok: true as const,
              deduplicated: true,
              consultation: existingConsultation,
              booking: existingBooking,
              accessToken: undefined,
              outboxJobs: db.notificationOutbox.filter((j) => j.bookingReference === existingConsultation.referenceCode),
            };
          }
        }

        db.consultationSlotHolds = db.consultationSlotHolds.filter((h) => new Date(h.expiresAt).getTime() > nowMs);

        const candidatePlannerIds = input.plannerId
          ? [input.plannerId]
          : Array.from(new Set(db.staffAvailabilityRules.filter((r) => r.isActive).map((r) => r.plannerId)));

        let chosenPlannerId: string | null = null;
        let slotValidation: ReturnType<typeof validateRequestedConsultationSlot> | null = null;

        for (const pid of candidatePlannerIds) {
          const check = validateRequestedConsultationSlot({
            plannerId: pid,
            startUtc: input.consultationStartUtc,
            method: input.consultationMethod,
            rules: db.staffAvailabilityRules,
            blackoutDates: db.blackoutDates,
            consultations: db.consultations,
            slotHolds: db.consultationSlotHolds,
            ignoreHolderHash: holderHash,
            nowMs,
          });
          if (check.valid) {
            chosenPlannerId = pid;
            slotValidation = check;
            break;
          }
          if (!slotValidation) slotValidation = check;
        }

        if (!chosenPlannerId || !slotValidation?.valid || !slotValidation.endUtc) {
          const startDateFallback = new Date(input.consultationStartUtc).toISOString().slice(0, 10);
          const suggestedDays = computeConsultationAvailability({
            startDate: startDateFallback >= todayIso ? startDateFallback : todayIso,
            days: 7,
            clientTimezone: input.clientTimezone,
            method: input.consultationMethod,
            rules: db.staffAvailabilityRules,
            blackoutDates: db.blackoutDates,
            consultations: db.consultations,
            slotHolds: db.consultationSlotHolds,
            users: db.users,
            nowMs,
          });
          const suggestedSlots = suggestedDays
            .flatMap((d) => d.slots)
            .filter((s) => s.available)
            .slice(0, 6);
          return {
            ok: false as const,
            code: slotValidation?.errorCode || 'SLOT_CONFLICT',
            error: slotValidation?.error || 'Selected consultation slot is no longer available.',
            suggestedSlots,
          };
        }

        const refCode = generateUniqueBookingReference(db.bookings, input.eventDate);
        const bookingId = `bkg-${crypto.randomUUID().slice(0, 10)}`;
        const consultationId = `con-${crypto.randomUUID().slice(0, 10)}`;
        const plannerName = slotValidation.plannerName || 'Maya Brooks';
        const resolvedEventTitle = (input.eventTitle || `${input.clientName} ${input.eventType}`).trim();
        const { token: accessToken, hash: accessTokenHash } = generateConsultationAccessToken();

        const linkedClientId =
          ctx.authMethod !== 'guest' && ctx.session.role === 'client'
            ? ctx.session.id
            : db.users.find((u) => u.email.toLowerCase() === input.clientEmail.toLowerCase())?.id || 'user-client-guest';

        const newBooking: BookingRecord = {
          id: bookingId,
          referenceCode: refCode,
          clientId: linkedClientId,
          clientName: input.clientName,
          clientEmail: input.clientEmail,
          clientPhone: input.clientPhone,
          eventTitle: resolvedEventTitle,
          eventType: input.eventType,
          serviceDivisionIds: input.serviceDivisionIds,
          packageTier: 'Bespoke Consultation',
          eventDate: input.eventDate,
          location: input.location,
          venueName: input.venueName,
          guestCount: input.guestCount,
          budgetRange: input.budgetRange,
          status: 'Consultation Scheduled',
          architecturalStage: LEGACY_TO_ARCH_STATUS['Consultation Scheduled'],
          assignedLeadPlanner: plannerName,
          assignedVendorIds: [],
          notes: input.notes,
          quotations: [],
          contract: {
            id: `ctr-${bookingId}`,
            bookingId,
            title: `${resolvedEventTitle} — Preliminary Consultation Record`,
            termsSummary:
              'Preliminary consultation scheduled. Final binding event agreement issued upon approved itemized proposal.',
            clientSigned: false,
            staffCountersigned: false,
          },
          payments: [],
          milestones: [
            {
              id: `ms-${Date.now()}-1`,
              title: 'Private Design Consultation',
              dueDate: new Date(input.consultationStartUtc).toISOString().slice(0, 10),
              completed: false,
              owner: 'Planner',
            },
            {
              id: `ms-${Date.now()}-2`,
              title: 'Itemized Proposal & Design Direction Delivery',
              dueDate: input.eventDate,
              completed: false,
              owner: 'Planner',
            },
          ],
          scheduleItems: [],
          messages: [
            {
              id: `msg-${Date.now()}`,
              sender: 'Celebration Sisters Concierge',
              role: 'staff',
              text: `Private consultation requested for ${formatFullDateTimeForTimezone(input.consultationStartUtc, STUDIO_TIMEZONE)} (${formatConsultationMethodLabel(input.consultationMethod)}).`,
              createdAt: nowIso,
            },
          ],
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        const startMs = new Date(input.consultationStartUtc).getTime();
        const tokenExpiryMs = Math.max(nowMs + 30 * 86_400_000, startMs + 90 * 86_400_000);
        const newConsultation: ConsultationAppointment = {
          id: consultationId,
          bookingId,
          referenceCode: refCode,
          clientId: linkedClientId,
          clientName: input.clientName,
          clientEmail: input.clientEmail,
          clientPhone: input.clientPhone,
          preferredContactMethod: input.preferredContactMethod,
          eventTitle: resolvedEventTitle,
          eventCategory: input.eventType,
          eventTheme: input.eventTheme || undefined,
          serviceDivisionIds: input.serviceDivisionIds,
          eventDate: input.eventDate,
          venueName: input.venueName,
          eventLocation: input.location,
          guestCount: input.guestCount,
          budgetRange: input.budgetRange,
          consultationNotes: input.notes,
          method: input.consultationMethod,
          status: 'Pending',
          assignedPlannerId: chosenPlannerId,
          assignedPlannerName: plannerName,
          startUtc: new Date(input.consultationStartUtc).toISOString(),
          endUtc: slotValidation.endUtc,
          durationMinutes: slotValidation.durationMinutes || 45,
          bufferBeforeMinutes: slotValidation.bufferBeforeMinutes ?? 15,
          bufferAfterMinutes: slotValidation.bufferAfterMinutes ?? 15,
          clientTimezone: input.clientTimezone,
          privacyConsentAccepted: true,
          privacyConsentAt: nowIso,
          privacyConsentVersion: '2026-11-v1',
          accessTokenHash,
          accessTokenExpiresAt: new Date(tokenExpiryMs).toISOString(),
          idempotencyKey,
          crmStage: 'Consultation Scheduled',
          rescheduleCount: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        db.bookings.unshift(newBooking);
        db.consultations.unshift(newConsultation);
        if (idempotencyKey) {
          db.consultationIdempotencyKeys[idempotencyKey] = consultationId;
          db.bookingIdempotencyKeys[idempotencyKey] = bookingId;
        }
        if (holderHash) {
          db.consultationSlotHolds = db.consultationSlotHolds.filter((h) => h.holderFingerprintHash !== holderHash);
        }

        const clientWindow = formatFullDateTimeForTimezone(newConsultation.startUtc, input.clientTimezone);
        const studioWindow = formatFullDateTimeForTimezone(newConsultation.startUtc, STUDIO_TIMEZONE);
        const methodLabel = formatConsultationMethodLabel(input.consultationMethod);

        const clientTpl = buildConsultationConfirmationTemplate({
          clientName: input.clientName,
          referenceCode: refCode,
          eventTitle: resolvedEventTitle,
          eventDate: input.eventDate,
          venueName: input.venueName,
          location: input.location,
          consultationWindow: clientWindow,
          consultationMethod: methodLabel,
          assignedPlanner: plannerName,
        });
        const staffTpl = buildStaffAlertTemplate({
          referenceCode: refCode,
          clientName: input.clientName,
          eventTitle: resolvedEventTitle,
          eventDate: input.eventDate,
          venueName: input.venueName,
          budgetRange: input.budgetRange,
          consultationWindow: studioWindow,
          assignedPlanner: plannerName,
        });

        const outboxJobs = [
          enqueueOutboxNotification(db, {
            idempotencyKey: `consultation:${consultationId}:confirmation`,
            category: 'consultation_confirmation',
            recipient: input.clientEmail,
            bookingReference: refCode,
            subject: clientTpl.subject,
            htmlBody: clientTpl.htmlBody,
            textBody: clientTpl.textBody,
          }),
        ];

        const staffEmail = (process.env.STAFF_NOTIFICATION_EMAIL || 'maya@celebrationsisters.example.com').trim();
        if (staffEmail) {
          outboxJobs.push(
            enqueueOutboxNotification(db, {
              idempotencyKey: `consultation:${consultationId}:staff_new_booking_alert`,
              category: 'staff_new_booking_alert',
              recipient: staffEmail,
              bookingReference: refCode,
              subject: staffTpl.subject,
              htmlBody: staffTpl.htmlBody,
              textBody: staffTpl.textBody,
            }),
          );
        }

        appendAudit(
          db,
          ctx.session,
          'CONSULTATION_BOOKED',
          'Consultation',
          refCode,
          `${resolvedEventTitle} scheduled for ${studioWindow} with ${plannerName} (${methodLabel})`,
        );

        return {
          ok: true as const,
          deduplicated: false,
          consultation: newConsultation,
          booking: newBooking,
          accessToken,
          outboxJobs,
        };
      });

      if (!result.ok) {
        const httpStatus = result.code === 'SLOT_CONFLICT' || result.code === 'BLACKOUT' ? 409 : 400;
        return res.status(httpStatus).json({
          error: result.error,
          code: result.code,
          suggestedSlots: result.suggestedSlots,
        });
      }

      await outboxWorker.processOnce().catch(() => {});

      const refreshedDb = await readDb();
      const deliveryRecords = refreshedDb.notificationDeliveries.filter(
        (d) => d.bookingReference === result.consultation.referenceCode,
      );

      res.status(result.deduplicated ? 200 : 201).json({
        deduplicated: result.deduplicated,
        consultation: sanitizeConsultationForClient(result.consultation),
        booking: result.booking,
        ...(result.accessToken ? { accessToken: result.accessToken } : {}),
        scheduleDisplay: {
          clientWindow: formatFullDateTimeForTimezone(result.consultation.startUtc, result.consultation.clientTimezone),
          studioWindow: formatFullDateTimeForTimezone(result.consultation.startUtc, STUDIO_TIMEZONE),
        },
        notificationStatus: {
          provider: getEmailProviderStatus(),
          outboxQueued: result.outboxJobs.length,
          deliveries: deliveryRecords.map((d) => ({
            id: d.id,
            category: d.category,
            status: d.status,
            provider: d.provider,
          })),
        },
      });
    },
  );

  // 4. Scoped-token public consultation status lookup (blocks predictable reference-only enumeration)
  app.get(
    '/api/consultations/status',
    rateLimit(30, 60_000, { endpointGroup: 'consultations:status', failClosed: true }),
    async (req: Request, res: Response) => {
      const referenceCode = typeof req.query.referenceCode === 'string' ? req.query.referenceCode.trim().toUpperCase() : '';
      const accessToken =
        (typeof req.query.accessToken === 'string' ? req.query.accessToken.trim() : '') ||
        (req.header('x-consultation-token') || '').trim();

      if (!referenceCode || !accessToken) {
        return res.status(400).json({
          error: 'Both referenceCode and scoped verification accessToken are required to view consultation details.',
          code: 'SCOPED_TOKEN_REQUIRED',
        });
      }

      const db = await readDb();
      const consultation = db.consultations.find((c) => c.referenceCode.toUpperCase() === referenceCode);
      if (!consultation) {
        return res.status(403).json({
          error: 'Consultation record not found or verification token is invalid.',
          code: 'INVALID_CONSULTATION_TOKEN',
        });
      }
      const tokenCheck = validateConsultationTokenAccess(consultation, accessToken);
      if (!tokenCheck.valid) {
        return res.status(403).json({
          error: tokenCheck.error || 'Consultation verification token is invalid.',
          code: tokenCheck.code || 'INVALID_CONSULTATION_TOKEN',
        });
      }

      const linkedBooking = db.bookings.find((b) => b.id === consultation.bookingId);
      const latestQuote = linkedBooking?.quotations.length
        ? linkedBooking.quotations[linkedBooking.quotations.length - 1]
        : undefined;
      const proposalSummary = latestQuote
        ? {
            version: latestQuote.version,
            totalAmount: latestQuote.totalAmount,
            discountAmount: latestQuote.discountAmount,
            itemCount: latestQuote.items.length,
            createdAt: latestQuote.createdAt,
            clientDecision: consultation.clientDecision || 'Pending',
            crmStage: consultation.crmStage,
          }
        : undefined;

      const canReschedule = canTransitionConsultationStatus(consultation.status, 'Rescheduled');
      const canCancel = canTransitionConsultationStatus(consultation.status, 'Cancelled');

      res.json({
        consultation: {
          id: consultation.id,
          referenceCode: consultation.referenceCode,
          eventTitle: consultation.eventTitle,
          eventType: consultation.eventCategory,
          eventTheme: consultation.eventTheme || '',
          eventDate: consultation.eventDate,
          guestCount: consultation.guestCount,
          budgetRange: consultation.budgetRange,
          venueName: consultation.venueName,
          location: consultation.eventLocation,
          clientPhone: consultation.clientPhone,
          preferredContactMethod: consultation.preferredContactMethod,
          notes: consultation.consultationNotes,
          method: consultation.method,
          methodLabel: formatConsultationMethodLabel(consultation.method),
          status: consultation.status,
          crmStage: consultation.crmStage,
          assignedPlannerId: consultation.assignedPlannerId,
          assignedPlannerName: consultation.assignedPlannerName,
          startUtc: consultation.startUtc,
          endUtc: consultation.endUtc,
          durationMinutes: consultation.durationMinutes,
          clientTimezone: consultation.clientTimezone,
          clientWindow: formatFullDateTimeForTimezone(consultation.startUtc, consultation.clientTimezone),
          studioWindow: formatFullDateTimeForTimezone(consultation.startUtc, STUDIO_TIMEZONE),
          rescheduleCount: consultation.rescheduleCount,
          accessTokenExpiresAt: consultation.accessTokenExpiresAt,
          canReschedule,
          canCancel,
          proposalSummary,
          updatedAt: consultation.updatedAt,
        },
      });
    },
  );

  // 4b. Client Self-Service Contact & Event Requirements Update (scoped token OR owning client session)
  app.patch(
    '/api/consultations/:id/client-details',
    rateLimit(25, 60_000, { endpointGroup: 'consultations:client_update', failClosed: true }),
    async (req: Request, res: Response) => {
      const { ctx } = await getAuth(req);
      const parsed = z
        .object({
          accessToken: z.string().trim().max(256).optional(),
          clientPhone: z.string().trim().min(7).max(40).optional(),
          preferredContactMethod: z.enum(['email', 'phone', 'sms']).optional(),
          clientTimezone: z.string().trim().min(2).max(80).optional(),
          eventTitle: z.string().trim().min(3).max(180).optional(),
          eventTheme: z.string().trim().max(180).optional(),
          guestCount: z.coerce.number().int().min(10).max(5000).optional(),
          venueName: z.string().trim().min(2).max(180).optional(),
          notes: z.string().trim().max(3000).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid contact or event requirement fields.' });
      }
      if (parsed.data.clientTimezone && !isValidIanaTimezone(parsed.data.clientTimezone)) {
        return res.status(400).json({ error: 'Invalid timezone identifier.' });
      }

      const nowIso = new Date().toISOString();
      const targetId = String(req.params.id);
      const outcome = await withTransaction((db) => {
        const consultation = db.consultations.find(
          (c) => c.id === targetId || c.referenceCode.toUpperCase() === targetId.toUpperCase(),
        );
        if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };

        const access = resolveConsultationActorAccess(req, ctx, consultation);
        if (!access) {
          return {
            ok: false as const,
            status: 403,
            error: 'Valid consultation verification token or owning client session required.',
          };
        }
        if (consultation.status === 'Cancelled') {
          return { ok: false as const, status: 409, error: 'Cancelled consultations cannot be modified.' };
        }

        const updatedFields: string[] = [];
        if (parsed.data.clientPhone !== undefined) {
          consultation.clientPhone = parsed.data.clientPhone;
          updatedFields.push('clientPhone');
        }
        if (parsed.data.preferredContactMethod !== undefined) {
          consultation.preferredContactMethod = parsed.data.preferredContactMethod;
          updatedFields.push('preferredContactMethod');
        }
        if (parsed.data.clientTimezone !== undefined) {
          consultation.clientTimezone = parsed.data.clientTimezone;
          updatedFields.push('clientTimezone');
        }
        if (parsed.data.eventTitle !== undefined) {
          consultation.eventTitle = parsed.data.eventTitle;
          updatedFields.push('eventTitle');
        }
        if (parsed.data.eventTheme !== undefined) {
          consultation.eventTheme = parsed.data.eventTheme;
          updatedFields.push('eventTheme');
        }
        if (parsed.data.guestCount !== undefined) {
          consultation.guestCount = parsed.data.guestCount;
          updatedFields.push('guestCount');
        }
        if (parsed.data.venueName !== undefined) {
          consultation.venueName = parsed.data.venueName;
          updatedFields.push('venueName');
        }
        if (parsed.data.notes !== undefined) {
          consultation.consultationNotes = parsed.data.notes;
          updatedFields.push('notes');
        }

        consultation.contactUpdatedAt = nowIso;
        consultation.updatedAt = nowIso;

        const linkedBooking = db.bookings.find((b) => b.id === consultation.bookingId);
        if (linkedBooking) {
          if (parsed.data.clientPhone !== undefined) linkedBooking.clientPhone = parsed.data.clientPhone;
          if (parsed.data.eventTitle !== undefined) linkedBooking.eventTitle = parsed.data.eventTitle;
          if (parsed.data.guestCount !== undefined) linkedBooking.guestCount = parsed.data.guestCount;
          if (parsed.data.venueName !== undefined) linkedBooking.venueName = parsed.data.venueName;
          if (parsed.data.notes !== undefined) linkedBooking.notes = parsed.data.notes;
          linkedBooking.updatedAt = nowIso;
        }

        appendAudit(
          db,
          ctx.session,
          'CONSULTATION_CLIENT_DETAILS_UPDATED',
          'Consultation',
          consultation.referenceCode,
          `Updated ${updatedFields.join(', ') || 'none'} via ${access}`,
        );

        return { ok: true as const, consultation };
      });

      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.error });
      }

      res.json({
        consultation: sanitizeConsultationForClient(outcome.consultation),
        scheduleDisplay: {
          clientWindow: formatFullDateTimeForTimezone(outcome.consultation.startUtc, outcome.consultation.clientTimezone),
          studioWindow: formatFullDateTimeForTimezone(outcome.consultation.startUtc, STUDIO_TIMEZONE),
        },
      });
    },
  );

  // 4c. Revoke Consultation Scoped Access Token (client owner, token holder, or admin MFA)
  app.post(
    '/api/consultations/:id/token/revoke',
    rateLimit(20, 60_000, { endpointGroup: 'consultations:token_revoke', failClosed: true }),
    async (req: Request, res: Response) => {
      const { ctx } = await getAuth(req);
      const targetId = String(req.params.id);
      const nowIso = new Date().toISOString();

      const outcome = await withTransaction((db) => {
        const consultation = db.consultations.find(
          (c) => c.id === targetId || c.referenceCode.toUpperCase() === targetId.toUpperCase(),
        );
        if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };

        const access = resolveConsultationActorAccess(req, ctx, consultation);
        if (!access) {
          return { ok: false as const, status: 403, error: 'Authorization required to revoke verification token.' };
        }

        consultation.accessTokenRevokedAt = nowIso;
        consultation.updatedAt = nowIso;

        appendAudit(
          db,
          ctx.session,
          'CONSULTATION_TOKEN_REVOKED',
          'Consultation',
          consultation.referenceCode,
          `Scoped verification token revoked via ${access}`,
        );

        return { ok: true as const, revokedAt: nowIso };
      });

      if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
      res.json({ revoked: true, revokedAt: outcome.revokedAt });
    },
  );

  // 5. Reschedule Consultation (Client with scoped token/session OR Staff/Admin)
  app.post(
    '/api/consultations/:id/reschedule',
    rateLimit(25, 60_000, { endpointGroup: 'consultations:reschedule', failClosed: true }),
    async (req: Request, res: Response) => {
      const { ctx } = await getAuth(req);
      const parsed = z
        .object({
          newStartUtc: z.string().datetime(),
          plannerId: z.string().trim().min(2).max(120).optional(),
          method: z.enum(['video', 'in_person_columbia', 'phone']).optional(),
          clientTimezone: z.string().trim().min(2).max(80).optional(),
          reason: z.string().trim().max(400).optional(),
          accessToken: z.string().trim().max(256).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Valid newStartUtc (ISO-8601 UTC) is required to reschedule.' });
      }
      if (parsed.data.clientTimezone && !isValidIanaTimezone(parsed.data.clientTimezone)) {
        return res.status(400).json({ error: 'Invalid timezone identifier.' });
      }

      const nowIso = new Date().toISOString();
      const nowMs = Date.now();
      const targetId = String(req.params.id);
      const outcome = await withTransaction((db) => {
        const consultation = db.consultations.find(
          (c) => c.id === targetId || c.referenceCode.toUpperCase() === targetId.toUpperCase(),
        );
        if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };

        const access = resolveConsultationActorAccess(req, ctx, consultation);
        if (!access) {
          return {
            ok: false as const,
            status: 403,
            error: 'Valid consultation verification token or authorized session required to reschedule.',
          };
        }
        if (!canTransitionConsultationStatus(consultation.status, 'Rescheduled')) {
          return {
            ok: false as const,
            status: 409,
            error: `Consultations in "${consultation.status}" status cannot be rescheduled.`,
          };
        }

        const targetPlannerId = parsed.data.plannerId || consultation.assignedPlannerId;
        const targetMethod = parsed.data.method || consultation.method;
        const check = validateRequestedConsultationSlot({
          plannerId: targetPlannerId,
          startUtc: parsed.data.newStartUtc,
          method: targetMethod,
          rules: db.staffAvailabilityRules,
          blackoutDates: db.blackoutDates,
          consultations: db.consultations,
          slotHolds: db.consultationSlotHolds,
          excludeConsultationId: consultation.id,
          nowMs,
        });
        if (!check.valid || !check.endUtc) {
          return {
            ok: false as const,
            status: check.errorCode === 'SLOT_CONFLICT' || check.errorCode === 'BLACKOUT' ? 409 : 400,
            error: check.error || 'Requested reschedule slot is unavailable.',
            code: check.errorCode,
          };
        }

        const prevStartUtc = consultation.startUtc;
        const prevWindowClient = formatFullDateTimeForTimezone(prevStartUtc, consultation.clientTimezone);
        const prevWindowStudio = formatFullDateTimeForTimezone(prevStartUtc, STUDIO_TIMEZONE);

        consultation.rescheduledFromStartUtc = prevStartUtc;
        consultation.startUtc = new Date(parsed.data.newStartUtc).toISOString();
        consultation.endUtc = check.endUtc;
        consultation.durationMinutes = check.durationMinutes || consultation.durationMinutes;
        consultation.bufferBeforeMinutes = check.bufferBeforeMinutes ?? consultation.bufferBeforeMinutes;
        consultation.bufferAfterMinutes = check.bufferAfterMinutes ?? consultation.bufferAfterMinutes;
        consultation.assignedPlannerId = targetPlannerId;
        consultation.assignedPlannerName = check.plannerName || consultation.assignedPlannerName;
        consultation.method = targetMethod;
        if (parsed.data.clientTimezone) consultation.clientTimezone = parsed.data.clientTimezone;
        consultation.status = 'Rescheduled';
        consultation.rescheduleCount += 1;
        consultation.updatedAt = nowIso;

        const linkedBooking = db.bookings.find((b) => b.id === consultation.bookingId);
        if (linkedBooking) {
          linkedBooking.assignedLeadPlanner = consultation.assignedPlannerName;
          linkedBooking.updatedAt = nowIso;
          linkedBooking.messages.push({
            id: `msg-${Date.now()}`,
            sender: access === 'staff_or_admin' ? ctx.session.name : consultation.clientName,
            role: access === 'staff_or_admin' ? 'staff' : 'client',
            text: `Consultation rescheduled to ${formatFullDateTimeForTimezone(consultation.startUtc, STUDIO_TIMEZONE)}.${parsed.data.reason ? ` Reason: ${parsed.data.reason}` : ''}`,
            createdAt: nowIso,
          });
        }

        const newWindowClient = formatFullDateTimeForTimezone(consultation.startUtc, consultation.clientTimezone);
        const newWindowStudio = formatFullDateTimeForTimezone(consultation.startUtc, STUDIO_TIMEZONE);
        const clientTpl = buildConsultationRescheduledTemplate({
          clientName: consultation.clientName,
          referenceCode: consultation.referenceCode,
          eventTitle: consultation.eventTitle,
          previousWindow: prevWindowClient,
          newWindow: newWindowClient,
          consultationMethod: formatConsultationMethodLabel(consultation.method),
          assignedPlanner: consultation.assignedPlannerName,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${consultation.id}:rescheduled:${consultation.rescheduleCount}`,
          category: 'consultation_rescheduled',
          recipient: consultation.clientEmail,
          bookingReference: consultation.referenceCode,
          subject: clientTpl.subject,
          htmlBody: clientTpl.htmlBody,
          textBody: clientTpl.textBody,
        });

        const staffEmail = (process.env.STAFF_NOTIFICATION_EMAIL || 'maya@celebrationsisters.example.com').trim();
        const staffTpl = buildInternalOperationsAlertTemplate({
          heading: 'Consultation Rescheduled',
          referenceCode: consultation.referenceCode,
          clientName: consultation.clientName,
          eventTitle: consultation.eventTitle,
          details: `Moved from ${prevWindowStudio} to ${newWindowStudio} (Planner: ${consultation.assignedPlannerName}).${parsed.data.reason ? ` Reason: ${parsed.data.reason}` : ''}`,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${consultation.id}:staff_reschedule_alert:${consultation.rescheduleCount}`,
          category: 'staff_reschedule_alert',
          recipient: staffEmail,
          bookingReference: consultation.referenceCode,
          subject: staffTpl.subject,
          htmlBody: staffTpl.htmlBody,
          textBody: staffTpl.textBody,
        });

        appendAudit(
          db,
          ctx.session,
          'CONSULTATION_RESCHEDULED',
          'Consultation',
          consultation.referenceCode,
          `${prevWindowStudio} -> ${newWindowStudio} via ${access}`,
        );

        return { ok: true as const, consultation };
      });

      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.error, code: outcome.code });
      }
      await outboxWorker.processOnce().catch(() => {});
      res.json({
        consultation: sanitizeConsultationForClient(outcome.consultation),
        scheduleDisplay: {
          clientWindow: formatFullDateTimeForTimezone(outcome.consultation.startUtc, outcome.consultation.clientTimezone),
          studioWindow: formatFullDateTimeForTimezone(outcome.consultation.startUtc, STUDIO_TIMEZONE),
        },
      });
    },
  );

  // 6. Cancel Consultation (releases slot immediately + dispatches client & staff alerts)
  app.post(
    '/api/consultations/:id/cancel',
    rateLimit(25, 60_000, { endpointGroup: 'consultations:cancel', failClosed: true }),
    async (req: Request, res: Response) => {
      const { ctx } = await getAuth(req);
      const parsed = z
        .object({
          reason: z.string().trim().max(400).optional(),
          accessToken: z.string().trim().max(256).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid cancellation payload.' });
      }

      const nowIso = new Date().toISOString();
      const targetId = String(req.params.id);
      const outcome = await withTransaction((db) => {
        const consultation = db.consultations.find(
          (c) => c.id === targetId || c.referenceCode.toUpperCase() === targetId.toUpperCase(),
        );
        if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };

        const access = resolveConsultationActorAccess(req, ctx, consultation);
        if (!access) {
          return {
            ok: false as const,
            status: 403,
            error: 'Valid consultation verification token or authorized session required to cancel.',
          };
        }
        if (!canTransitionConsultationStatus(consultation.status, 'Cancelled')) {
          return {
            ok: false as const,
            status: 409,
            error: `Consultations in "${consultation.status}" status cannot be cancelled.`,
          };
        }

        const prevWindowClient = formatFullDateTimeForTimezone(consultation.startUtc, consultation.clientTimezone);
        const prevWindowStudio = formatFullDateTimeForTimezone(consultation.startUtc, STUDIO_TIMEZONE);
        consultation.status = 'Cancelled';
        consultation.cancelledAt = nowIso;
        consultation.cancelReason = parsed.data.reason || 'Cancelled upon request';
        consultation.updatedAt = nowIso;

        const linkedBooking = db.bookings.find((b) => b.id === consultation.bookingId);
        if (linkedBooking) {
          linkedBooking.updatedAt = nowIso;
          linkedBooking.messages.push({
            id: `msg-${Date.now()}`,
            sender: access === 'staff_or_admin' ? ctx.session.name : consultation.clientName,
            role: access === 'staff_or_admin' ? 'staff' : 'client',
            text: `Consultation cancelled (${consultation.cancelReason}). Slot ${prevWindowStudio} released.`,
            createdAt: nowIso,
          });
        }

        const clientTpl = buildConsultationCancelledTemplate({
          clientName: consultation.clientName,
          referenceCode: consultation.referenceCode,
          eventTitle: consultation.eventTitle,
          cancelledWindow: prevWindowClient,
          reason: consultation.cancelReason,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${consultation.id}:cancelled`,
          category: 'consultation_cancelled',
          recipient: consultation.clientEmail,
          bookingReference: consultation.referenceCode,
          subject: clientTpl.subject,
          htmlBody: clientTpl.htmlBody,
          textBody: clientTpl.textBody,
        });

        const staffEmail = (process.env.STAFF_NOTIFICATION_EMAIL || 'maya@celebrationsisters.example.com').trim();
        const staffTpl = buildInternalOperationsAlertTemplate({
          heading: 'Consultation Cancelled',
          referenceCode: consultation.referenceCode,
          clientName: consultation.clientName,
          eventTitle: consultation.eventTitle,
          details: `Slot ${prevWindowStudio} released. Reason: ${consultation.cancelReason}`,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${consultation.id}:staff_cancellation_alert`,
          category: 'staff_cancellation_alert',
          recipient: staffEmail,
          bookingReference: consultation.referenceCode,
          subject: staffTpl.subject,
          htmlBody: staffTpl.htmlBody,
          textBody: staffTpl.textBody,
        });

        appendAudit(
          db,
          ctx.session,
          'CONSULTATION_CANCELLED',
          'Consultation',
          consultation.referenceCode,
          `Slot ${prevWindowStudio} released via ${access}: ${consultation.cancelReason}`,
        );

        return { ok: true as const, consultation };
      });

      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.error });
      }
      await outboxWorker.processOnce().catch(() => {});
      res.json({ consultation: sanitizeConsultationForClient(outcome.consultation) });
    },
  );

  // 7. Authenticated Consultation Listing (RBAC isolated: client=own, planner/staff/admin=all, vendor=403)
  app.get('/api/consultations', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireActiveAccount(ctx, res)) return;
    if (ctx.session.role === 'vendor') {
      await logSecurityIncident(ctx, 'TOKEN_REJECTED', '/api/consultations', 'Vendor denied consultation CRM access');
      return res.status(403).json({ error: 'Vendors do not have access to client consultation records.' });
    }
    if (ctx.session.role === 'admin' && !requireAdminMfa(ctx, res)) return;

    const isStaffOrAdmin = ['event_planner', 'staff', 'admin'].includes(ctx.session.role);
    let list = db.consultations.filter((c) => {
      if (isStaffOrAdmin) return true;
      return c.clientId === ctx.session.id || c.clientEmail.toLowerCase() === ctx.session.email.toLowerCase();
    });

    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const plannerFilter = typeof req.query.plannerId === 'string' ? req.query.plannerId.trim() : '';
    const crmFilter = typeof req.query.crmStage === 'string' ? req.query.crmStage.trim() : '';
    if (statusFilter) list = list.filter((c) => c.status === statusFilter);
    if (plannerFilter) list = list.filter((c) => c.assignedPlannerId === plannerFilter);
    if (crmFilter) list = list.filter((c) => c.crmStage === crmFilter);

    const sanitized = list.map(sanitizeConsultationForClient);
    if (!isStaffOrAdmin) {
      return res.json({ consultations: sanitized });
    }

    const planners = db.users
      .filter((u) => ['event_planner', 'staff', 'admin'].includes(u.role) && (u.accountStatus ?? 'active') === 'active')
      .map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email }));

    const nowMs = Date.now();
    const plannerWorkload = planners.map((p) => {
      const assigned = db.consultations.filter((c) => c.assignedPlannerId === p.id);
      const openTasks = db.crmFollowUpTasks.filter((t) => t.assignedToUserId === p.id && t.status === 'Open');
      return {
        plannerId: p.id,
        plannerName: p.name,
        role: p.role,
        activeUpcoming: assigned.filter(
          (c) => ['Pending', 'Confirmed', 'Rescheduled'].includes(c.status) && new Date(c.startUtc).getTime() >= nowMs,
        ).length,
        pendingReview: assigned.filter((c) => c.status === 'Pending').length,
        completedCount: assigned.filter((c) => c.status === 'Completed').length,
        bookedCount: assigned.filter((c) => c.crmStage === 'Event Booked').length,
        openFollowUps: openTasks.length,
      };
    });

    const totalConsults = db.consultations.length;
    const qualifiedOrFurther = db.consultations.filter((c) => c.crmStage !== 'New Inquiry').length;
    const completedOrFurther = db.consultations.filter((c) =>
      ['Consultation Completed', 'Proposal Prepared', 'Proposal Sent', 'Client Decision', 'Event Booked'].includes(c.crmStage),
    ).length;
    const proposalsSentOrFurther = db.consultations.filter((c) =>
      ['Proposal Sent', 'Client Decision', 'Event Booked'].includes(c.crmStage),
    ).length;
    const bookedCount = db.consultations.filter((c) => c.crmStage === 'Event Booked').length;

    res.json({
      consultations: sanitized,
      metrics: computeConsultationMetrics(db),
      conversionAnalytics: {
        totalLeads: totalConsults,
        qualifiedRatePct: totalConsults > 0 ? Math.round((qualifiedOrFurther / totalConsults) * 100) : 0,
        completionRatePct: totalConsults > 0 ? Math.round((completedOrFurther / totalConsults) * 100) : 0,
        proposalRatePct: totalConsults > 0 ? Math.round((proposalsSentOrFurther / totalConsults) * 100) : 0,
        bookingConversionRatePct: totalConsults > 0 ? Math.round((bookedCount / totalConsults) * 100) : 0,
      },
      plannerWorkload,
      planners,
      staffAvailabilityRules: db.staffAvailabilityRules,
      crmFollowUpTasks: db.crmFollowUpTasks,
      blackoutDates: db.blackoutDates,
      notificationOutbox: db.notificationOutbox,
      notificationWebhookEvents: db.notificationWebhookEvents,
      auditLogs: db.auditLogs.filter(
        (a) =>
          a.targetType === 'Consultation' ||
          a.targetType === 'CrmTask' ||
          a.targetType === 'StaffAvailability' ||
          a.targetType === 'OutboxNotification',
      ),
    });
  });

  // 7b. CRM Lead Qualification & Pipeline Stage Progression (Staff/Planner/Admin MFA)
  app.patch('/api/consultations/:id/stage', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res, 'Operations clearance required to update CRM pipeline stage.')) return;

    const parsed = z
      .object({
        crmStage: z.enum(CRM_PIPELINE_STAGES),
        notes: z.string().trim().max(1000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid CRM pipeline stage is required.' });
    }

    const nowIso = new Date().toISOString();
    const updated = await withTransaction((db) => {
      const consultation = db.consultations.find((c) => c.id === String(req.params.id));
      if (!consultation) return null;
      const prevStage = consultation.crmStage;
      consultation.crmStage = parsed.data.crmStage;
      if (parsed.data.notes) {
        consultation.outcomeSummary = consultation.outcomeSummary
          ? `${consultation.outcomeSummary}\n${parsed.data.notes}`
          : parsed.data.notes;
      }
      consultation.updatedAt = nowIso;
      appendAudit(
        db,
        ctx.session,
        'CRM_STAGE_UPDATED',
        'Consultation',
        consultation.referenceCode,
        `CRM stage ${prevStage} -> ${parsed.data.crmStage}${parsed.data.notes ? ` (${parsed.data.notes})` : ''}`,
      );
      return consultation;
    });

    if (!updated) return res.status(404).json({ error: 'Consultation not found.' });
    res.json({ consultation: sanitizeConsultationForClient(updated) });
  });

  // 8. Admin / Planner Confirm Consultation
  app.patch('/api/consultations/:id/confirm', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res, 'Planner or Executive clearance required to confirm consultations.')) return;

    const nowIso = new Date().toISOString();
    const outcome = await withTransaction((db) => {
      const consultation = db.consultations.find((c) => c.id === req.params.id);
      if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };
      if (!canTransitionConsultationStatus(consultation.status, 'Confirmed')) {
        return {
          ok: false as const,
          status: 409,
          error: `Cannot transition consultation from ${consultation.status} to Confirmed.`,
        };
      }

      const prev = consultation.status;
      consultation.status = 'Confirmed';
      consultation.updatedAt = nowIso;

      const clientTpl = buildConsultationConfirmedTemplate({
        clientName: consultation.clientName,
        referenceCode: consultation.referenceCode,
        eventTitle: consultation.eventTitle,
        consultationWindow: formatFullDateTimeForTimezone(consultation.startUtc, consultation.clientTimezone),
        consultationMethod: formatConsultationMethodLabel(consultation.method),
        assignedPlanner: consultation.assignedPlannerName,
      });
      enqueueOutboxNotification(db, {
        idempotencyKey: `consultation:${consultation.id}:confirmed:${nowIso.slice(0, 13)}`,
        category: 'consultation_confirmed',
        recipient: consultation.clientEmail,
        bookingReference: consultation.referenceCode,
        subject: clientTpl.subject,
        htmlBody: clientTpl.htmlBody,
        textBody: clientTpl.textBody,
      });

      appendAudit(db, ctx.session, 'CONSULTATION_CONFIRMED', 'Consultation', consultation.referenceCode, `${prev} -> Confirmed`);
      return { ok: true as const, consultation };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    await outboxWorker.processOnce().catch(() => {});
    res.json({ consultation: sanitizeConsultationForClient(outcome.consultation) });
  });

  // 9. Admin / Planner Reassign Staff Planner (with conflict validation)
  app.patch('/api/consultations/:id/assign', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res, 'Planner or Executive clearance required to assign staff.')) return;

    const parsed = z.object({ plannerId: z.string().trim().min(2).max(120) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid plannerId is required.' });

    const nowIso = new Date().toISOString();
    const outcome = await withTransaction((db) => {
      const consultation = db.consultations.find((c) => c.id === req.params.id);
      if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };

      const targetPlanner = db.users.find(
        (u) =>
          u.id === parsed.data.plannerId &&
          ['event_planner', 'staff', 'admin'].includes(u.role) &&
          (u.accountStatus ?? 'active') === 'active',
      );
      if (!targetPlanner) {
        return { ok: false as const, status: 404, error: 'Target planner account not found or inactive.' };
      }

      const conflict = findPlannerSlotConflict({
        plannerId: targetPlanner.id,
        startUtc: consultation.startUtc,
        endUtc: consultation.endUtc,
        bufferBeforeMinutes: consultation.bufferBeforeMinutes,
        bufferAfterMinutes: consultation.bufferAfterMinutes,
        consultations: db.consultations,
        slotHolds: db.consultationSlotHolds,
        excludeConsultationId: consultation.id,
      });
      if (conflict.conflict) {
        return {
          ok: false as const,
          status: 409,
          error: `${targetPlanner.name} already has a conflicting appointment during this window.`,
        };
      }

      const prevPlanner = consultation.assignedPlannerName;
      consultation.assignedPlannerId = targetPlanner.id;
      consultation.assignedPlannerName = targetPlanner.name;
      consultation.updatedAt = nowIso;

      const linkedBooking = db.bookings.find((b) => b.id === consultation.bookingId);
      if (linkedBooking) {
        linkedBooking.assignedLeadPlanner = targetPlanner.name;
        linkedBooking.updatedAt = nowIso;
      }

      const staffTpl = buildInternalOperationsAlertTemplate({
        heading: 'Consultation Assigned to You',
        referenceCode: consultation.referenceCode,
        clientName: consultation.clientName,
        eventTitle: consultation.eventTitle,
        details: `Reassigned from ${prevPlanner} to ${targetPlanner.name}. Scheduled: ${formatFullDateTimeForTimezone(consultation.startUtc, STUDIO_TIMEZONE)}.`,
      });
      enqueueOutboxNotification(db, {
        idempotencyKey: `consultation:${consultation.id}:assigned:${targetPlanner.id}:${nowIso.slice(0, 16)}`,
        category: 'staff_appointment_assigned',
        recipient: targetPlanner.email,
        bookingReference: consultation.referenceCode,
        subject: staffTpl.subject,
        htmlBody: staffTpl.htmlBody,
        textBody: staffTpl.textBody,
      });

      appendAudit(
        db,
        ctx.session,
        'CONSULTATION_PLANNER_ASSIGNED',
        'Consultation',
        consultation.referenceCode,
        `${prevPlanner} -> ${targetPlanner.name}`,
      );
      return { ok: true as const, consultation };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    await outboxWorker.processOnce().catch(() => {});
    res.json({ consultation: sanitizeConsultationForClient(outcome.consultation) });
  });

  // 10. Complete Consultation (or mark No-show), record outcome, advance CRM & create follow-up task
  app.post('/api/consultations/:id/complete', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res, 'Planner or Executive clearance required.')) return;

    const parsed = z
      .object({
        status: z.enum(['Completed', 'No-show']).default('Completed'),
        outcomeSummary: z.string().trim().min(5).max(2000),
        followUpTitle: z.string().trim().min(3).max(200).optional(),
        followUpDueAt: z.string().datetime().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Consultation outcomeSummary (min 5 characters) is required.' });
    }

    const nowIso = new Date().toISOString();
    const outcome = await withTransaction((db) => {
      const consultation = db.consultations.find((c) => c.id === req.params.id);
      if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };
      if (!canTransitionConsultationStatus(consultation.status, parsed.data.status)) {
        return {
          ok: false as const,
          status: 409,
          error: `Cannot transition consultation from ${consultation.status} to ${parsed.data.status}.`,
        };
      }

      consultation.status = parsed.data.status;
      consultation.outcomeSummary = parsed.data.outcomeSummary;
      consultation.completedAt = parsed.data.status === 'Completed' ? nowIso : undefined;
      consultation.updatedAt = nowIso;
      if (parsed.data.status === 'Completed') {
        consultation.crmStage = 'Consultation Completed';
      }

      const linkedBooking = db.bookings.find((b) => b.id === consultation.bookingId);
      if (linkedBooking && parsed.data.status === 'Completed') {
        if (canTransitionBookingStatus(linkedBooking.status, 'Proposal in Preparation')) {
          linkedBooking.status = 'Proposal in Preparation';
          linkedBooking.architecturalStage = LEGACY_TO_ARCH_STATUS['Proposal in Preparation'];
        }
        linkedBooking.updatedAt = nowIso;
      }

      let createdTask: CrmFollowUpTask | undefined;
      if (parsed.data.followUpTitle) {
        const dueAt = parsed.data.followUpDueAt || new Date(Date.now() + 48 * 60 * 60_000).toISOString();
        consultation.followUpDueAt = dueAt;
        createdTask = {
          id: `crm-task-${crypto.randomUUID().slice(0, 10)}`,
          consultationId: consultation.id,
          bookingId: consultation.bookingId,
          bookingReference: consultation.referenceCode,
          clientName: consultation.clientName,
          assignedToUserId: consultation.assignedPlannerId,
          assignedToName: consultation.assignedPlannerName,
          title: parsed.data.followUpTitle,
          notes: parsed.data.outcomeSummary,
          dueAt,
          status: 'Open',
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        db.crmFollowUpTasks.unshift(createdTask);
      }

      if (parsed.data.status === 'Completed') {
        const followTpl = buildConsultationFollowUpTemplate({
          clientName: consultation.clientName,
          referenceCode: consultation.referenceCode,
          eventTitle: consultation.eventTitle,
          outcomeSummary: parsed.data.outcomeSummary,
          assignedPlanner: consultation.assignedPlannerName,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${consultation.id}:followup`,
          category: 'consultation_followup',
          recipient: consultation.clientEmail,
          bookingReference: consultation.referenceCode,
          subject: followTpl.subject,
          htmlBody: followTpl.htmlBody,
          textBody: followTpl.textBody,
        });
      }

      const staffEmail = (process.env.STAFF_NOTIFICATION_EMAIL || 'maya@celebrationsisters.example.com').trim();
      const staffTpl = buildInternalOperationsAlertTemplate({
        heading: parsed.data.status === 'Completed' ? 'Follow-Up Required Post-Consultation' : 'Consultation Marked No-Show',
        referenceCode: consultation.referenceCode,
        clientName: consultation.clientName,
        eventTitle: consultation.eventTitle,
        details: `${parsed.data.outcomeSummary}${createdTask ? ` · Follow-up task created: ${createdTask.title}` : ''}`,
      });
      enqueueOutboxNotification(db, {
        idempotencyKey: `consultation:${consultation.id}:staff_followup:${parsed.data.status}`,
        category: 'staff_followup_required',
        recipient: staffEmail,
        bookingReference: consultation.referenceCode,
        subject: staffTpl.subject,
        htmlBody: staffTpl.htmlBody,
        textBody: staffTpl.textBody,
      });

      appendAudit(
        db,
        ctx.session,
        'CONSULTATION_OUTCOME_RECORDED',
        'Consultation',
        consultation.referenceCode,
        `Marked ${parsed.data.status}; CRM stage: ${consultation.crmStage}`,
      );
      return { ok: true as const, consultation, task: createdTask };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    await outboxWorker.processOnce().catch(() => {});
    res.json({
      consultation: sanitizeConsultationForClient(outcome.consultation),
      ...(outcome.task ? { followUpTask: outcome.task } : {}),
    });
  });

  // 11. Consultation-to-Proposal Handoff (exact integer-cent quotation math + CRM transition + email outbox)
  app.post('/api/consultations/:id/proposal-handoff', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res, 'Planner or Executive clearance required to issue proposals.')) return;

    const lineItemSchema = z.object({
      description: z.string().trim().min(2).max(240),
      division: z.string().trim().min(2).max(120).optional(),
      quantity: z.coerce.number().int().min(1).max(500).default(1),
      unitPriceCents: z.coerce.number().int().min(0).optional(),
      unitPrice: z.coerce.number().min(0).optional(),
    });
    const parsed = z
      .object({
        lineItems: z.array(lineItemSchema).min(1).max(40),
        discountCents: z.coerce.number().int().min(0).optional(),
        discountAmount: z.coerce.number().min(0).optional(),
        notes: z.string().trim().max(1500).default('Tailored luxury decor & event production proposal.'),
        markAsSent: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'At least one valid itemized line item is required for proposal handoff.' });
    }

    const nowIso = new Date().toISOString();
    const outcome = await withTransaction((db) => {
      const consultation = db.consultations.find((c) => c.id === req.params.id);
      if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };
      if (!['Completed', 'Confirmed'].includes(consultation.status)) {
        return {
          ok: false as const,
          status: 409,
          error: 'Proposal handoff requires a Confirmed or Completed consultation.',
        };
      }
      const booking = db.bookings.find((b) => b.id === consultation.bookingId);
      if (!booking) return { ok: false as const, status: 404, error: 'Linked booking record not found.' };

      let subtotalCents = 0;
      const computedItems = parsed.data.lineItems.map((item, index) => {
        const unitCents =
          item.unitPriceCents !== undefined ? item.unitPriceCents : Math.round((item.unitPrice ?? 0) * 100);
        const lineCents = unitCents * item.quantity;
        subtotalCents += lineCents;
        return {
          id: `li-${Date.now()}-${index + 1}`,
          description: item.description,
          division: item.division || consultation.eventCategory,
          quantity: item.quantity,
          unitPrice: unitCents / 100,
        };
      });

      const discountCents =
        parsed.data.discountCents !== undefined
          ? parsed.data.discountCents
          : Math.round((parsed.data.discountAmount ?? 0) * 100);
      if (discountCents > subtotalCents) {
        return { ok: false as const, status: 400, error: 'Discount cannot exceed proposal subtotal.' };
      }

      const totalCents = subtotalCents - discountCents;
      const nextVersion = booking.quotations.length + 1;
      const quote = {
        version: nextVersion,
        createdAt: nowIso,
        items: computedItems,
        discountAmount: discountCents / 100,
        discountApproved: true,
        discountApprovedBy: ctx.session.name,
        totalAmount: totalCents / 100,
        notes: parsed.data.notes,
      };
      booking.quotations.push(quote);
      booking.updatedAt = nowIso;

      if (parsed.data.markAsSent) {
        consultation.crmStage = 'Proposal Sent';
        if (canTransitionBookingStatus(booking.status, 'Quote Sent') || booking.status === 'Consultation Scheduled') {
          booking.status = 'Quote Sent';
          booking.architecturalStage = LEGACY_TO_ARCH_STATUS['Quote Sent'];
        }
      } else {
        consultation.crmStage = 'Proposal Prepared';
      }
      consultation.updatedAt = nowIso;

      const totalFormatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(totalCents / 100);

      if (parsed.data.markAsSent) {
        const propTpl = buildProposalAvailableTemplate({
          clientName: consultation.clientName,
          referenceCode: consultation.referenceCode,
          eventTitle: consultation.eventTitle,
          quoteVersion: nextVersion,
          totalAmountFormatted: totalFormatted,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${consultation.id}:proposal:v${nextVersion}`,
          category: 'proposal_available',
          recipient: consultation.clientEmail,
          bookingReference: consultation.referenceCode,
          subject: propTpl.subject,
          htmlBody: propTpl.htmlBody,
          textBody: propTpl.textBody,
        });

        const staffEmail = (process.env.STAFF_NOTIFICATION_EMAIL || 'maya@celebrationsisters.example.com').trim();
        const staffTpl = buildInternalOperationsAlertTemplate({
          heading: 'Proposal Sent — Awaiting Client Decision',
          referenceCode: consultation.referenceCode,
          clientName: consultation.clientName,
          eventTitle: consultation.eventTitle,
          details: `Proposal v${nextVersion} (${totalFormatted}) delivered to client portal.`,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${consultation.id}:staff_proposal_awaiting:v${nextVersion}`,
          category: 'staff_proposal_awaiting_action',
          recipient: staffEmail,
          bookingReference: consultation.referenceCode,
          subject: staffTpl.subject,
          htmlBody: staffTpl.htmlBody,
          textBody: staffTpl.textBody,
        });
      }

      appendAudit(
        db,
        ctx.session,
        'CONSULTATION_PROPOSAL_HANDOFF',
        'Consultation',
        consultation.referenceCode,
        `Issued proposal v${nextVersion} (${totalFormatted}); CRM stage -> ${consultation.crmStage}`,
      );

      return {
        ok: true as const,
        consultation,
        quote,
        amountsCents: { subtotalCents, discountCents, totalCents },
      };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    await outboxWorker.processOnce().catch(() => {});
    res.status(201).json({
      consultation: sanitizeConsultationForClient(outcome.consultation),
      quotation: {
        ...outcome.quote,
        subtotal: outcome.amountsCents.subtotalCents / 100,
      },
      amountsCents: outcome.amountsCents,
    });
  });

  // 12. Record Client Decision / Final CRM Conversion to Event Booked
  app.post('/api/consultations/:id/decision', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res, 'Planner or Executive clearance required.')) return;

    const parsed = z
      .object({
        decision: z.enum(['Approved', 'Revision Requested', 'Declined']),
        notes: z.string().trim().max(1000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid decision (Approved, Revision Requested, Declined) required.' });

    const nowIso = new Date().toISOString();
    const outcome = await withTransaction((db) => {
      const consultation = db.consultations.find((c) => c.id === req.params.id);
      if (!consultation) return { ok: false as const, status: 404, error: 'Consultation not found.' };
      const booking = db.bookings.find((b) => b.id === consultation.bookingId);

      consultation.clientDecision = parsed.data.decision;
      consultation.clientDecisionNotes = parsed.data.notes;

      if (parsed.data.decision === 'Approved') {
        consultation.crmStage = 'Event Booked';
        if (booking) {
          if (booking.status === 'Quote Sent' || booking.status === 'Awaiting Approval') {
            booking.status = 'Confirmed';
            booking.architecturalStage = LEGACY_TO_ARCH_STATUS['Confirmed'];
          }
          booking.updatedAt = nowIso;
        }
      } else {
        consultation.crmStage = 'Client Decision';
        if (booking && parsed.data.decision === 'Revision Requested') {
          booking.updatedAt = nowIso;
        }
      }
      consultation.updatedAt = nowIso;

      appendAudit(
        db,
        ctx.session,
        'CRM_CLIENT_DECISION_RECORDED',
        'Consultation',
        consultation.referenceCode,
        `Decision: ${parsed.data.decision}; CRM stage: ${consultation.crmStage}${parsed.data.notes ? ` (${parsed.data.notes})` : ''}`,
      );
      return { ok: true as const, consultation };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ consultation: sanitizeConsultationForClient(outcome.consultation) });
  });

  // 13. Staff Availability Rules Management
  app.get('/api/staff/availability', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res)) return;
    res.json({
      studioTimezone: STUDIO_TIMEZONE,
      rules: db.staffAvailabilityRules,
      blackoutDates: db.blackoutDates,
    });
  });

  app.put('/api/staff/availability/:plannerId', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res, 'Planner or Executive clearance required to manage schedules.')) return;

    const ruleInputSchema = z.object({
      dayOfWeek: z.coerce.number().int().min(0).max(6),
      startTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
      endTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
      slotDurationMinutes: z.coerce.number().int().min(15).max(180).default(45),
      bufferBeforeMinutes: z.coerce.number().int().min(0).max(120).default(15),
      bufferAfterMinutes: z.coerce.number().int().min(0).max(120).default(15),
      allowedMethods: z.array(z.enum(['video', 'in_person_columbia', 'phone'])).min(1),
      isActive: z.boolean().default(true),
    });
    const parsed = z.object({ rules: z.array(ruleInputSchema).max(7) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid staff availability schedule rules.' });
    }
    for (const r of parsed.data.rules) {
      if (r.endTimeLocal <= r.startTimeLocal) {
        return res.status(400).json({ error: `End time (${r.endTimeLocal}) must be after start time (${r.startTimeLocal}).` });
      }
    }

    const updated = await withTransaction((db) => {
      const planner = db.users.find(
        (u) => u.id === req.params.plannerId && ['event_planner', 'staff', 'admin'].includes(u.role),
      );
      if (!planner) return null;

      db.staffAvailabilityRules = db.staffAvailabilityRules.filter((r) => r.plannerId !== planner.id);
      const nextRules: StaffAvailabilityRule[] = parsed.data.rules.map((r) => ({
        id: `sar-${planner.id}-${r.dayOfWeek}`,
        plannerId: planner.id,
        plannerName: planner.name,
        dayOfWeek: r.dayOfWeek,
        startTimeLocal: r.startTimeLocal,
        endTimeLocal: r.endTimeLocal,
        timezone: STUDIO_TIMEZONE,
        slotDurationMinutes: r.slotDurationMinutes,
        bufferBeforeMinutes: r.bufferBeforeMinutes,
        bufferAfterMinutes: r.bufferAfterMinutes,
        allowedMethods: r.allowedMethods,
        isActive: r.isActive,
      }));
      db.staffAvailabilityRules.push(...nextRules);
      appendAudit(
        db,
        ctx.session,
        'STAFF_AVAILABILITY_UPDATED',
        'StaffAvailability',
        planner.id,
        `Updated ${nextRules.length} weekly schedule rule(s) for ${planner.name}`,
      );
      return nextRules;
    });

    if (!updated) return res.status(404).json({ error: 'Planner not found.' });
    res.json({ rules: updated });
  });

  // 14. CRM Conversion Pipeline & Follow-Up Tasks
  app.get('/api/crm/pipeline', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res)) return;

    const stageCounts = CRM_PIPELINE_STAGES.map((stage) => ({
      stage,
      count: db.consultations.filter((c) => c.crmStage === stage).length,
    }));
    const totalConsultations = db.consultations.length;
    const completedCount = db.consultations.filter((c) =>
      ['Consultation Completed', 'Proposal Prepared', 'Proposal Sent', 'Client Decision', 'Event Booked'].includes(c.crmStage),
    ).length;
    const bookedCount = db.consultations.filter((c) => c.crmStage === 'Event Booked').length;

    res.json({
      stages: stageCounts,
      conversionMetrics: {
        totalLeads: totalConsultations,
        consultationCompletionRatePct: totalConsultations > 0 ? Math.round((completedCount / totalConsultations) * 100) : 0,
        bookingConversionRatePct: totalConsultations > 0 ? Math.round((bookedCount / totalConsultations) * 100) : 0,
      },
      tasks: db.crmFollowUpTasks,
    });
  });

  app.post('/api/crm/tasks', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res)) return;
    const parsed = z
      .object({
        consultationId: z.string().trim().min(2),
        title: z.string().trim().min(3).max(200),
        dueAt: z.string().datetime(),
        notes: z.string().trim().max(1000).default(''),
        assignedStaffId: z.string().trim().min(2).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid consultationId, title, and dueAt are required.' });

    const nowIso = new Date().toISOString();
    const created = await withTransaction((db) => {
      const consultation = db.consultations.find((c) => c.id === parsed.data.consultationId);
      if (!consultation) return null;
      const staff = db.users.find((u) => u.id === (parsed.data.assignedStaffId || consultation.assignedPlannerId));
      const task: CrmFollowUpTask = {
        id: `crm-task-${crypto.randomUUID().slice(0, 10)}`,
        consultationId: consultation.id,
        bookingId: consultation.bookingId,
        bookingReference: consultation.referenceCode,
        clientName: consultation.clientName,
        assignedToUserId: staff?.id || consultation.assignedPlannerId,
        assignedToName: staff?.name || consultation.assignedPlannerName,
        title: parsed.data.title,
        notes: parsed.data.notes,
        dueAt: parsed.data.dueAt,
        status: 'Open',
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      db.crmFollowUpTasks.unshift(task);
      appendAudit(db, ctx.session, 'CRM_TASK_CREATED', 'CrmTask', task.id, `${task.title} (${consultation.referenceCode})`);
      return task;
    });
    if (!created) return res.status(404).json({ error: 'Consultation not found.' });
    res.status(201).json({ task: created });
  });

  app.patch('/api/crm/tasks/:taskId', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireStaffOrAdminMfa(ctx, res)) return;
    const parsed = z
      .object({
        status: z.enum(['Open', 'Completed', 'Cancelled']),
        notes: z.string().trim().max(1000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid task status required.' });

    const updated = await withTransaction((db) => {
      const task = db.crmFollowUpTasks.find((t) => t.id === req.params.taskId);
      if (!task) return null;
      task.status = parsed.data.status;
      if (parsed.data.notes !== undefined) task.notes = parsed.data.notes;
      task.completedAt = parsed.data.status === 'Completed' ? new Date().toISOString() : undefined;
      task.updatedAt = new Date().toISOString();
      appendAudit(db, ctx.session, 'CRM_TASK_UPDATED', 'CrmTask', task.id, `Status -> ${task.status}`);
      return task;
    });
    if (!updated) return res.status(404).json({ error: 'Follow-up task not found.' });
    res.json({ task: updated });
  });

  // 15. Scheduled Upcoming Consultation Reminder Dispatcher (idempotent 24-48h window)
  app.post('/api/admin/consultations/reminders/dispatch', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;

    const horizonHoursRaw = Number(req.body?.horizonHours ?? 48);
    const horizonHours = Number.isFinite(horizonHoursRaw) ? Math.min(168, Math.max(1, horizonHoursRaw)) : 48;
    const nowMs = Date.now();
    const horizonMs = nowMs + horizonHours * 60 * 60_000;

    const queued = await withTransaction((db) => {
      let count = 0;
      const staffEmail = (process.env.STAFF_NOTIFICATION_EMAIL || 'maya@celebrationsisters.example.com').trim();
      for (const c of db.consultations) {
        if (!['Pending', 'Confirmed', 'Rescheduled'].includes(c.status)) continue;
        const startMs = new Date(c.startUtc).getTime();
        if (startMs < nowMs || startMs > horizonMs) continue;

        const clientTpl = buildConsultationReminderTemplate({
          clientName: c.clientName,
          referenceCode: c.referenceCode,
          eventTitle: c.eventTitle,
          consultationWindow: formatFullDateTimeForTimezone(c.startUtc, c.clientTimezone),
          consultationMethod: formatConsultationMethodLabel(c.method),
          assignedPlanner: c.assignedPlannerName,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${c.id}:reminder:${c.startUtc.slice(0, 13)}`,
          category: 'consultation_reminder',
          recipient: c.clientEmail,
          bookingReference: c.referenceCode,
          subject: clientTpl.subject,
          htmlBody: clientTpl.htmlBody,
          textBody: clientTpl.textBody,
        });

        const staffTpl = buildInternalOperationsAlertTemplate({
          heading: 'Upcoming Consultation Reminder',
          referenceCode: c.referenceCode,
          clientName: c.clientName,
          eventTitle: c.eventTitle,
          details: `Scheduled with ${c.assignedPlannerName} at ${formatFullDateTimeForTimezone(c.startUtc, STUDIO_TIMEZONE)} (${formatConsultationMethodLabel(c.method)}).`,
        });
        enqueueOutboxNotification(db, {
          idempotencyKey: `consultation:${c.id}:staff_upcoming:${c.startUtc.slice(0, 13)}`,
          category: 'staff_upcoming_consultation',
          recipient: staffEmail,
          bookingReference: c.referenceCode,
          subject: staffTpl.subject,
          htmlBody: staffTpl.htmlBody,
          textBody: staffTpl.textBody,
        });
        count += 1;
      }
      appendAudit(
        db,
        ctx.session,
        'CONSULTATION_REMINDERS_DISPATCHED',
        'Consultation',
        'batch',
        `Evaluated ${count} upcoming consultation(s) within ${horizonHours}h`,
      );
      return count;
    });

    const summary = await outboxWorker.processOnce();
    res.json({ remindersEvaluated: queued, outboxSummary: summary });
  });

  // 16. Resend (Svix) Signed Delivery Webhook Endpoint (upgrades ProviderAccepted -> Delivered / Bounced honestly)
  app.post(
    '/api/webhooks/resend',
    rateLimit(120, 60_000, { endpointGroup: 'webhooks:resend', failClosed: false }),
    async (req: Request, res: Response) => {
      const webhookSecret = (process.env.RESEND_WEBHOOK_SECRET || '').trim();
      if (!webhookSecret) {
        return res.status(503).json({
          error: 'Resend webhook verification secret is not configured.',
          code: 'WEBHOOK_NOT_CONFIGURED',
        });
      }

      const rawBody =
        (req as Request & { rawBody?: string }).rawBody ??
        (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
      const svixId = (req.header('svix-id') || '').trim();
      const svixTimestamp = (req.header('svix-timestamp') || '').trim();
      const svixSignature = (req.header('svix-signature') || '').trim();

      const verified = verifyResendWebhookSignature({
        rawBody,
        svixId,
        svixTimestamp,
        svixSignature,
        webhookSecret,
      });

      if (!verified.valid) {
        logStructured('warn', 'resend_webhook_signature_rejected', {
          svixId: svixId || 'missing',
          reason: verified.reason,
        });
        return res.status(401).json({
          error: verified.reason || 'Invalid webhook signature.',
          code: 'INVALID_WEBHOOK_SIGNATURE',
        });
      }

      const payload = (req.body || {}) as {
        type?: string;
        data?: { email_id?: string; id?: string; bounce?: { message?: string } };
      };
      const eventType = typeof payload.type === 'string' ? payload.type : 'unknown';
      const providerMessageId =
        typeof payload.data?.email_id === 'string'
          ? payload.data.email_id
          : typeof payload.data?.id === 'string'
            ? payload.data.id
            : undefined;
      const payloadSha256 = sha256Hex(rawBody);
      const nowIso = new Date().toISOString();

      // Deduplicate webhook delivery by svix-id
      const dupCheck = await withTransaction((db) => {
        const existing = db.notificationWebhookEvents.find((e) => e.svixId === svixId);
        if (existing) {
          return { duplicate: true as const };
        }
        db.notificationWebhookEvents.unshift({
          id: `whk-${crypto.randomUUID().slice(0, 10)}`,
          provider: 'resend',
          svixId,
          eventType,
          providerMessageId,
          signatureVerified: true,
          payloadSha256,
          status:
            eventType === 'email.delivered' || eventType === 'email.bounced' || eventType === 'email.complained'
              ? 'processed'
              : 'ignored',
          receivedAt: nowIso,
        });
        if (db.notificationWebhookEvents.length > 500) {
          db.notificationWebhookEvents = db.notificationWebhookEvents.slice(0, 500);
        }
        return { duplicate: false as const };
      });

      if (dupCheck.duplicate) {
        return res.status(200).json({ received: true, deduplicated: true });
      }

      let reconciled = false;
      if (providerMessageId && eventType === 'email.delivered') {
        const result = await recordProviderDeliveryConfirmation(providerMessageId, 'Delivered');
        reconciled = result.updated;
      } else if (providerMessageId && (eventType === 'email.bounced' || eventType === 'email.complained')) {
        const details = payload.data?.bounce?.message || `Resend event: ${eventType}`;
        const result = await recordProviderDeliveryConfirmation(providerMessageId, 'Bounced', details);
        reconciled = result.updated;
      }

      res.status(200).json({
        received: true,
        deduplicated: false,
        eventType,
        providerMessageId,
        reconciled,
      });
    },
  );

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
      errMsg.includes('TLS_CONFIG_FAILURE') ||
      [
        'ECONNREFUSED',
        'ETIMEDOUT',
        '57P01',
        '57P03',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
      ].includes(errCode)
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
