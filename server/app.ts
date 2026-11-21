import {
  acquireConceptLease,
  assertConceptLeaseOwnership,
  completeConceptLease,
  releaseConceptLease,
  type ConceptLease,
} from './repositories/conceptLeaseRepository.ts';
import { withClockedTransaction } from './store.ts';

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
import {
  AiProviderError,
  generateConceptProposal,
  getGeminiConfigStatus,
  runConciergeTurn,
} from './gemini.ts';
import {
  createSupabasePublicClient,
  createStagingExternalAuthClient,
  getIdentityProviderStatus,
  resolveTrustedUserFromClaims,
  verifyProviderAccessToken,
  type VerifyProviderTokenOptions,
} from './identityProvider.ts';
import { classifyDatabaseError } from './lib/pgErrorClassifier.ts';
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
  getEmailRuntimeConfig,
  getStaffNotificationRecipient,
  verifyResendWebhookSignature,
  type FetchLike,
} from './notifications.ts';
import { logStructured, observability } from './observability.ts';
import {
  enqueueOutboxNotification,
  NotificationOutboxWorker,
  reconcileResendWebhookAtomic,
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
  REQUIRED_CANONICAL_MIGRATION_COUNT,
  type PersistenceReadinessStatus,
} from './repositories/postgresRepository.ts';
import {
  canTransitionConsultationStatus,
  computeConsultationAvailability,
  findPlannerSlotConflict,
  formatFullDateTimeForTimezone,
  generateConsultationAccessToken,
  getStudioTodayIso,
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
import { stagingExternalAuthEnabled, STAGING_ADMIN_SUBJECT } from './stagingExternalAuthPolicy.ts';

export interface SupabaseAuthClientLike {
  auth: {
    signInWithPassword: (credentials: { email: string; password: string }) => Promise<{
      data: { session?: { access_token?: string } | null } | null;
      error: { message?: string } | null;
    }>;
    resetPasswordForEmail: (
      email: string,
      options?: { redirectTo?: string },
    ) => Promise<{
      data: unknown;
      error: { message?: string } | null;
    }>;
  };
}

export interface CreateAppOptions {
  enableRateLimit?: boolean;
  providerVerifyOptions?: VerifyProviderTokenOptions;
  supabaseAuthClient?: SupabaseAuthClientLike | null;
  rateLimitStore?: RateLimitStore;
  notificationFetch?: FetchLike;
  outboxWorker?: NotificationOutboxWorker;
  trustProxy?: boolean | number | string;
}

export interface ReadinessWorkerDiagnostics {
  workerId: string;
  pollingActive: boolean;
  pollingDisabled: boolean;
  healthy: boolean;
  lastHeartbeatAt: string | null;
}

export interface ApplicationReadinessEvaluation {
  ok: boolean;
  httpStatus: 200 | 503;
  status: 'ready' | 'not_ready';
  productionReady: boolean;
  blockingReasons: string[];
  checks: {
    database: boolean;
    migrations: boolean;
    schemaObjects: boolean;
    auth: boolean;
    email: boolean;
    worker: boolean;
  };
}

/**
 * Evaluates full application readiness separately from process liveness (/health).
 * In production (NODE_ENV=production), returns HTTP 503 whenever PostgreSQL connectivity,
 * canonical migrations (001-008), essential schema objects/constraints, Supabase Auth,
 * Resend notification/webhook configuration, or background worker health are unavailable.
 * Never exposes credentials, connection strings, or internal secrets.
 */
export function evaluateApplicationReadiness(params: {
  persistence: PersistenceReadinessStatus;
  auth: ReturnType<typeof getIdentityProviderStatus>;
  email: ReturnType<typeof getEmailProviderStatus>;
  worker: ReadinessWorkerDiagnostics;
  isProduction: boolean;
}): ApplicationReadinessEvaluation {
  const { persistence, auth, email, worker, isProduction } = params;
  const blockingReasons: string[] = [];

  const databaseReady =
    persistence.ready && (persistence.adapter !== 'postgres' || persistence.connected === true);
  if (!databaseReady) {
    blockingReasons.push('Database connectivity is unavailable.');
  }

  let migrationsReady = true;
  let schemaObjectsReady = true;
  if (persistence.adapter === 'postgres') {
    const schema = persistence.schema;
    const applied = schema?.migrationsAppliedCount ?? 0;
    migrationsReady =
      Boolean(schema?.migrationsTablePresent) && applied >= REQUIRED_CANONICAL_MIGRATION_COUNT;
    if (!migrationsReady) {
      blockingReasons.push(
        `Canonical PostgreSQL migrations incomplete (${applied}/${REQUIRED_CANONICAL_MIGRATION_COUNT} applied).`,
      );
    }

    const rateLimitOk = Boolean(schema?.rateLimitTablePresent);
    const essentialTablesOk = schema?.essentialTablesPresent !== false;
    const overlapConstraintOk = schema?.overlapConstraintPresent !== false;
    schemaObjectsReady = Boolean(schema) && rateLimitOk && essentialTablesOk && overlapConstraintOk;
    if (!schemaObjectsReady) {
      const missingTables = schema?.missingEssentialTables?.length
        ? `missing tables: ${schema.missingEssentialTables.join(', ')}`
        : !rateLimitOk
          ? 'missing rate_limit_buckets table'
          : 'required schema objects incomplete';
      const constraintNote =
        schema?.overlapConstraintPresent === false
          ? '; missing consultation overlap exclusion constraint'
          : '';
      blockingReasons.push(`PostgreSQL schema objects not ready (${missingTables}${constraintNote}).`);
    }
  }

  const authReady = auth.readyForProductionAuth;
  if (!authReady) {
    blockingReasons.push('Supabase production authentication is not fully configured.');
  }

  const emailReady =
    email.configured && email.webhookSecretConfigured && email.staffRecipientConfigured;
  if (!emailReady) {
    blockingReasons.push(
      'Notification provider requires RESEND_API_KEY, EMAIL_FROM, STAFF_NOTIFICATION_EMAIL, and RESEND_WEBHOOK_SECRET.',
    );
  }

  const workerPollingBlocked = isProduction && worker.pollingDisabled;
  const workerReady = worker.healthy && !workerPollingBlocked;
  if (!worker.healthy) {
    blockingReasons.push('Background notification outbox worker heartbeat is unhealthy.');
  } else if (workerPollingBlocked) {
    blockingReasons.push(
      'Background notification outbox worker polling is disabled in production (DISABLE_OUTBOX_POLLING=true).',
    );
  }

  const productionReady =
    databaseReady && migrationsReady && schemaObjectsReady && authReady && emailReady && workerReady;

  const ok = isProduction ? productionReady : databaseReady;
  return {
    ok,
    httpStatus: ok ? 200 : 503,
    status: ok ? 'ready' : 'not_ready',
    productionReady,
    blockingReasons,
    checks: {
      database: databaseReady,
      migrations: migrationsReady,
      schemaObjects: schemaObjectsReady,
      auth: authReady,
      email: emailReady,
      worker: workerReady,
    },
  };
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

  // Phase 46F: per-application single-flight coordination.
  // This registry is not a substitute for database idempotency.
  type ConceptGenerationFlight = {
    durableLease?: ConceptLease;
    fingerprint: string;
    proposal: Promise<
      Awaited<ReturnType<typeof generateConceptProposal>> | undefined
    >;
    participants: number;
  };

  const conceptGenerationFlights =
    new Map<string, ConceptGenerationFlight>();

  const MAX_CONCEPT_GENERATION_FLIGHTS = 256;
  const MAX_CONCEPT_FLIGHT_PARTICIPANTS = 16;


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

  async function getAuth(
    req: Request,
    transactionDb?: Awaited<ReturnType<typeof readDb>>,
  ) {
    const db = transactionDb ?? await readDb();
    const ctx = await resolveAuthenticatedContextAsync(
      req,
      db.users,
      options.providerVerifyOptions,
      db.revokedSessionIds,
    );
    // Central fail-closed privilege boundary: ALL protected route handlers receive a
    // non-admin context unless the current request carries genuine external
    // Supabase AAL2 for the pinned immutable staging administrator UUID.
    // AAL1 is permitted ONLY on read-only session inspection (/api/auth/session) and
    // logout (/api/auth/logout) so the client can render the MFA gate and sign out safely.
    if (stagingExternalAuthEnabled(process.env) && ctx.session.role === 'admin') {
      const aal1AllowedPath =
        (req.method === 'GET' && req.path === '/api/auth/session') ||
        (req.method === 'POST' && req.path === '/api/auth/logout');
      const validExternal =
        ctx.authMethod === 'supabase_jwt' &&
        ctx.session.supabaseUserId === STAGING_ADMIN_SUBJECT;
      if (!validExternal || (!aal1AllowedPath && ctx.aal !== 'aal2')) {
        return {
          db,
          ctx: {
            ...ctx,
            session: { ...ctx.session, role: 'guest' as const },
            mfaVerified: false,
            spoofAttemptDetected: true,
          },
        };
      }
    }
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
    // External Auth mode does not accept locally signed admin cookies as proof of AAL2.
    if (stagingExternalAuthEnabled(process.env) &&
        (ctx.authMethod !== 'supabase_jwt' ||
         ctx.session.supabaseUserId !== STAGING_ADMIN_SUBJECT ||
         ctx.aal !== 'aal2')) {
      res.status(403).json({ error: 'Verified external administrator AAL2 session required.', code: 'MFA_REQUIRED' });
      return false;
    }
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
    const metrics = observability.getSnapshot();
    const workerStatus = outboxWorker.getStatus();
    const worker: ReadinessWorkerDiagnostics = {
      ...workerStatus,
      healthy: metrics.notifications.workerHealthy,
      lastHeartbeatAt: metrics.notifications.lastWorkerHeartbeatAt,
    };
    const readiness = evaluateApplicationReadiness({
      persistence,
      auth,
      email,
      worker,
      isProduction: process.env.NODE_ENV === 'production',
    });

    res.status(readiness.httpStatus).json({
      ok: readiness.ok,
      status: readiness.status,
      productionReady: readiness.productionReady,
      blockingReasons: readiness.blockingReasons,
      checks: readiness.checks,
      persistence,
      auth,
      email,
      worker,
      ai: {
        model: ai.model,
        configured: ai.configured,
        modelSource: ai.modelSource,
        thinkingLevel: ai.thinkingLevel,
        abortSignalSupported: ai.abortSignalSupported,
        timeoutMs: ai.timeoutMs,
        maxRetries: ai.maxRetries,
        ...(ai.modelWarning ? { modelWarning: ai.modelWarning } : {}),
      },
      requestId: res.getHeader('X-Request-Id'),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/health', async (_req: Request, res: Response) => {
    const persistence = await checkPersistenceHealth();
    const ai = getGeminiConfigStatus();
    const auth = getIdentityProviderStatus();
    const email = getEmailProviderStatus();
    const metrics = observability.getSnapshot();
    const workerStatus = outboxWorker.getStatus();
    const worker: ReadinessWorkerDiagnostics = {
      ...workerStatus,
      healthy: metrics.notifications.workerHealthy,
      lastHeartbeatAt: metrics.notifications.lastWorkerHeartbeatAt,
    };
    const readiness = evaluateApplicationReadiness({
      persistence,
      auth,
      email,
      worker,
      isProduction: process.env.NODE_ENV === 'production',
    });

    res.status(readiness.httpStatus).json({
      ok: readiness.ok,
      status: readiness.status,
      productionReady: readiness.productionReady,
      blockingReasons: readiness.blockingReasons,
      checks: readiness.checks,
      service: 'Celebration Sisters Event Decor Platform',
      persistence,
      auth,
      email,
      worker,
      ai: {
        model: ai.model,
        configured: ai.configured,
        modelSource: ai.modelSource,
        thinkingLevel: ai.thinkingLevel,
        abortSignalSupported: ai.abortSignalSupported,
        timeoutMs: ai.timeoutMs,
        conciergeTimeoutMs: ai.conciergeTimeoutMs,
        conceptTimeoutMs: ai.conceptTimeoutMs,
        maxRetries: ai.maxRetries,
        ...(ai.modelWarning ? { modelWarning: ai.modelWarning } : {}),
      },
      requestId: res.getHeader('X-Request-Id'),
      timestamp: new Date().toISOString(),
    });
  });

  // Authentication & Signed Session Management
  app.get('/api/auth/config', (_req: Request, res: Response) => {
    const identity = getIdentityProviderStatus();
    res.json({
      ...identity,
      demoPersonasAvailable: process.env.NODE_ENV !== 'production',
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
    const externalStaging = stagingExternalAuthEnabled(process.env);
    res.json({
      user: sanitizeUserForClient(ctx.session),
      mfaVerified: ctx.mfaVerified,
      mfaRequired: ctx.session.role === 'admin' && !ctx.mfaVerified,
      mfaEnrolled: Boolean(ctx.session.mfaEnrolled),
      emailVerified: ctx.emailVerified,
      accountStatus: ctx.accountStatus,
      aal: ctx.aal,
      authMethod: ctx.authMethod,
      externalStagingAuth: externalStaging,
      csrfToken: !externalStaging && ctx.sessionJti ? deriveCsrfToken(ctx.sessionJti) : undefined,
    });
  });

  // Production Email/Password Sign-In via Supabase Auth with cryptographic JWT verification
  // and server-authoritative role resolution (never trusts user_metadata role claims).
  app.post(
    '/api/auth/login',
    rateLimit(10, 60_000, { failClosed: true, endpointGroup: 'auth' }),
    async (req: Request, res: Response) => {
      const parsed = z
        .object({
          email: z.string().trim().email('Valid email address is required').max(180),
          password: z.string().min(6, 'Password must be at least 6 characters').max(128),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Valid email and password are required.' });
      }

      const normalizedEmail = parsed.data.email.toLowerCase();
      const emailHash = sha256Hex(normalizedEmail).slice(0, 16);
      const authClient: SupabaseAuthClientLike | null =
        options.supabaseAuthClient !== undefined ? options.supabaseAuthClient :
          stagingExternalAuthEnabled(process.env) ? createStagingExternalAuthClient() : createSupabasePublicClient();

      if (!authClient) {
        return res.status(503).json({
          error: 'Production identity provider (Supabase Auth) is not configured on this server.',
          code: 'AUTH_PROVIDER_NOT_CONFIGURED',
        });
      }

      let signInResult: {
        data: { session?: { access_token?: string } | null } | null;
        error: { message?: string } | null;
      };
      try {
        signInResult = await authClient.auth.signInWithPassword({
          email: normalizedEmail,
          password: parsed.data.password,
        });
      } catch {
        return res.status(502).json({
          error: 'Identity provider authentication service is temporarily unavailable.',
          code: 'AUTH_PROVIDER_UNAVAILABLE',
        });
      }

      const accessToken = signInResult.data?.session?.access_token;
      if (signInResult.error || !accessToken) {
        await withTransaction((db) => {
          appendSecurityEvent(db, {
            eventType: 'LOGIN_FAILED',
            emailHash,
            outcome: 'denied',
            details: 'Supabase email/password sign-in rejected credentials',
          });
        });
        return res.status(401).json({
          error: 'Invalid email address or password.',
          code: 'INVALID_CREDENTIALS',
        });
      }

      const claims = await verifyProviderAccessToken(
        accessToken,
        stagingExternalAuthEnabled(process.env)
          ? {
              supabaseUrl: 'https://nswxwwmtcasmkjtmrdqg.supabase.co',
              useJwksOnly: true,
              ...(options.providerVerifyOptions?.keyResolver
                ? { keyResolver: options.providerVerifyOptions.keyResolver }
                : {}),
            }
          : options.providerVerifyOptions,
      );
      if (!claims) {
        await withTransaction((db) => {
          appendSecurityEvent(db, {
            eventType: 'TOKEN_REJECTED',
            emailHash,
            outcome: 'denied',
            details: 'Provider access token failed cryptographic verification during /api/auth/login',
          });
        });
        return res.status(401).json({
          error: 'Unable to cryptographically verify identity provider token.',
          code: 'TOKEN_INVALID',
        });
      }

      const dbSnapshot = await readDb();
      const resolved = resolveTrustedUserFromClaims(claims, dbSnapshot.users);

      if (resolved.emailPrivilegeBindBlocked) {
        await withTransaction((db) => {
          appendSecurityEvent(db, {
            eventType: 'EMAIL_PRIVILEGE_BIND_BLOCKED',
            emailHash,
            outcome: 'denied',
            details: 'Blocked email-only privilege login; administrator-verified immutable supabaseUserId binding required',
          });
        });
        return res.status(403).json({
          error: 'Privileged accounts require administrator-verified identity binding.',
          code: 'EMAIL_PRIVILEGE_BIND_BLOCKED',
        });
      }

      if (resolved.accountStatus === 'suspended' || resolved.accountStatus === 'deactivated') {
        await withTransaction((db) => {
          appendSecurityEvent(db, {
            eventType: 'SUSPENDED_ACCOUNT_BLOCKED',
            userId: resolved.user.id,
            emailHash,
            outcome: 'denied',
            details: `Blocked sign-in for ${resolved.accountStatus} account`,
          });
        });
        return res.status(403).json({
          error: 'This account is suspended or deactivated.',
          code: 'ACCOUNT_SUSPENDED',
        });
      }

      if (!resolved.emailVerified) {
        await withTransaction((db) => {
          appendSecurityEvent(db, {
            eventType: 'UNVERIFIED_EMAIL_BLOCKED',
            userId: resolved.user.id,
            emailHash,
            outcome: 'denied',
            details: 'Blocked sign-in until email verification is completed',
          });
        });
        return res.status(403).json({
          error: 'Please verify your email address before signing in.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }

      if (stagingExternalAuthEnabled(process.env) && claims.sub === STAGING_ADMIN_SUBJECT &&
          (resolved.user.role !== 'admin' || resolved.user.supabaseUserId !== STAGING_ADMIN_SUBJECT)) {
        return res.status(403).json({error:'Staging administrator identity has not been securely bound.',code:'STAGING_ADMIN_BINDING_REQUIRED'});
      }
      if (stagingExternalAuthEnabled(process.env) && resolved.user.role === 'admin' &&
          claims.sub !== STAGING_ADMIN_SUBJECT) {
        return res.status(403).json({error:'Administrator identity is not authorized in staging.',code:'STAGING_ADMIN_FORBIDDEN'});
      }

      const authoritativeUser = await withTransaction((db) => {
        let userRecord = db.users.find(
          (u) => u.id === resolved.user.id || (u.supabaseUserId && u.supabaseUserId === claims.sub),
        );
        if (!userRecord && resolved.user.role === 'client') {
          userRecord = {
            id: resolved.user.id,
            supabaseUserId: claims.sub,
            name: resolved.user.name,
            email: resolved.user.email || normalizedEmail,
            role: 'client',
            emailVerified: true,
            accountStatus: 'active',
          };
          db.users.push(userRecord);
        } else if (userRecord && userRecord.role === 'client' && !userRecord.supabaseUserId) {
          userRecord.supabaseUserId = claims.sub;
          userRecord.emailVerified = true;
        }
        const finalUser = userRecord ?? resolved.user;
        appendAudit(
          db,
          finalUser,
          'LOGIN_SUCCESS',
          'AuthSession',
          finalUser.id,
          `Authenticated via Supabase Auth (${finalUser.role}, ${claims.aal})`,
        );
        appendSecurityEvent(db, {
          eventType: 'LOGIN_SUCCESS',
          userId: finalUser.id,
          emailHash,
          outcome: 'allowed',
          details: `Supabase login succeeded for role ${finalUser.role} (${claims.aal})`,
        });
        return finalUser;
      });

      const mfaVerified = authoritativeUser.role === 'admin' ? claims.aal === 'aal2' : true;
      const jti = generateSessionId();
      const csrfToken = deriveCsrfToken(jti);
      const token = signSessionToken({
        jti,
        userId: authoritativeUser.id,
        role: authoritativeUser.role,
        mfaVerified,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 8,
      });

      // In external Auth staging mode return the genuine provider JWT, never a
      // locally signed token that could incorrectly claim provider AAL2.
      if (!stagingExternalAuthEnabled(process.env)) setSessionCookie(res, token, { req, csrfToken });
      return res.json({
        user: sanitizeUserForClient(authoritativeUser),
        token: stagingExternalAuthEnabled(process.env) ? accessToken : token,
        csrfToken: stagingExternalAuthEnabled(process.env) ? undefined : csrfToken,
        mfaRequired: authoritativeUser.role === 'admin' && !mfaVerified,
        mfaVerified,
        mfaEnrolled: Boolean(authoritativeUser.mfaEnrolled),
        aal: mfaVerified ? 'aal2' : 'aal1',
      });
    },
  );

  // Password reset trigger via Supabase Auth (uniform response prevents account enumeration)
  app.post(
    '/api/auth/password-reset',
    rateLimit(5, 60_000, { failClosed: true, endpointGroup: 'auth_recovery' }),
    async (req: Request, res: Response) => {
      if (stagingExternalAuthEnabled(process.env)) {
        return res.status(409).json({
          code: 'EXTERNAL_AUTH_READ_ONLY',
          error: 'Password reset is disabled in isolated staging external-Auth mode to protect external identity accounts.',
        });
      }
      const parsed = z
        .object({
          email: z.string().trim().email('Valid email address is required').max(180),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Valid email address is required.' });
      }

      const authClient: SupabaseAuthClientLike | null =
        options.supabaseAuthClient !== undefined ? options.supabaseAuthClient : createSupabasePublicClient();
      if (!authClient) {
        return res.status(503).json({
          error: 'Production identity provider (Supabase Auth) is not configured on this server.',
          code: 'AUTH_PROVIDER_NOT_CONFIGURED',
        });
      }

      const normalizedEmail = parsed.data.email.toLowerCase();
      const emailHash = sha256Hex(normalizedEmail).slice(0, 16);
      const frontendOrigin = process.env.FRONTEND_PUBLIC_URL?.trim() ||
        (process.env.RAILWAY_ENVIRONMENT_NAME === 'staging' ? '' : 'https://celebrationsistersdecor.com');
      const callbackBase = URL.parse(frontendOrigin);
      if (!callbackBase || callbackBase.protocol !== 'https:' || callbackBase.username || callbackBase.password) {
        return res.status(503).json({
          code: 'AUTH_RECOVERY_NOT_CONFIGURED',
          error: 'Password recovery is not configured for this environment.',
        });
      }
      const redirectTo = new URL('/?auth=recovery', callbackBase).href;
      let providerAccepted = false;
      try {
        const result = await authClient.auth.resetPasswordForEmail(normalizedEmail, {
          redirectTo,
        });
        providerAccepted = !result.error;
      } catch {
        // Preserve the same public response for every account.
      }

      await withTransaction((db) => {
        appendSecurityEvent(db, {
          eventType: 'PASSWORD_RESET_REQUESTED',
          emailHash,
          outcome: providerAccepted ? 'allowed' : 'denied',
          details: providerAccepted
            ? 'Password recovery request accepted by Supabase Auth'
            : 'Password recovery request failed at Supabase Auth',
        });
      });

      return res.json({
        ok: true,
        message: 'If an account matches that email address, check its inbox for password recovery instructions.',
      });
    },
  );

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
      if (stagingExternalAuthEnabled(process.env)) {
        return res.status(409).json({code:'SUPABASE_MFA_REQUIRED',error:'Enroll MFA through Supabase Auth mfa.enroll and mfa.challengeAndVerify in the authenticated client; application-local TOTP is not Supabase AAL2.'});
      }
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
      if (stagingExternalAuthEnabled(process.env)) {
        return res.status(409).json({code:'SUPABASE_MFA_REQUIRED',error:'Use the Supabase Auth challengeAndVerify flow to obtain a genuine AAL2 access token.'});
      }
      const { ctx } = await getAuth(req);
      if (!requireActiveAccount(ctx, res)) return;
      const parsed = z.object({ code: z.string().trim().min(6).max(16) }).safeParse(req.body);
      const normalizedCode = parsed.success ? parsed.data.code.replace(/\s+/g, '') : '';
      const challenge =
        parsed.success && normalizedCode.length >= 6 && normalizedCode.length <= 12
          ? verifyAdminMfaChallenge(ctx.session, normalizedCode)
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
        if (ctx.sessionJti && ctx.sessionJti !== jti) {
          db.revokedSessionIds[ctx.sessionJti] = ctx.sessionExpiresAt ?? Date.now() + 1000 * 60 * 60 * 8;
        }
        appendAudit(
          db,
          ctx.session,
          'MFA_VERIFIED',
          'AuthSession',
          ctx.session.id,
          `Privileged MFA verified (${challenge.method}); rotated session JTI`,
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
      if (stagingExternalAuthEnabled(process.env)) {
        return res.status(409).json({
          code: 'SUPABASE_MFA_REQUIRED',
          error: 'Application-local MFA recovery codes are disabled in external Supabase Auth mode; complete genuine Supabase AAL2 verification.',
        });
      }
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
          `Consumed single-use MFA recovery code (${hashes.length} remaining); rotated session JTI`,
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
      if (stagingExternalAuthEnabled(process.env)) {
        return res.status(409).json({
          code: 'SUPABASE_MFA_REQUIRED',
          error: 'Application-local MFA revocation is disabled in external Supabase Auth mode to protect external Auth factors.',
        });
      }
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
    const todayIso = getStudioTodayIso();
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
        const staffRecipient = getStaffNotificationRecipient();
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

  function sendAiErrorResponse(res: Response, requestId: string, err: unknown, fallbackMessage: string) {
    if (err instanceof AiProviderError) {
      if (err.retryAfterSeconds && err.retryAfterSeconds > 0) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
      }
      return res.status(err.httpStatus).json({
        success: false,
        error: err.userMessage,
        code: err.code,
        retryable: err.retryable,
        ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
        requestId,
        errorDetail: {
          code: err.code,
          message: err.userMessage,
          retryable: err.retryable,
          ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
        },
      });
    }

    const msg = err instanceof Error ? err.message : fallbackMessage;
    if (msg.startsWith('FORBIDDEN:')) {
      const clean = msg.slice(10);
      return res.status(403).json({
        success: false,
        error: clean,
        code: 'FORBIDDEN',
        retryable: false,
        requestId,
        errorDetail: { code: 'FORBIDDEN', message: clean, retryable: false },
      });
    }
    if (msg.startsWith('CONCEPT_LOCKED:')) {
      const clean = msg.slice(15);
      return res.status(409).json({
        success: false,
        error: clean,
        code: 'CONCEPT_ALREADY_APPROVED',
        retryable: false,
        requestId,
        errorDetail: { code: 'CONCEPT_ALREADY_APPROVED', message: clean, retryable: false },
      });
    }
    if (msg.startsWith('AI_TIMEOUT:')) {
      const clean = 'The AI service timed out before completing your request. Please try again.';
      return res.status(504).json({
        success: false,
        error: clean,
        code: 'AI_TIMEOUT',
        retryable: true,
        requestId,
        errorDetail: { code: 'AI_TIMEOUT', message: clean, retryable: true },
      });
    }
    if (msg.startsWith('AI_INVALID_OUTPUT:')) {
      const clean = 'The AI service returned an incomplete response. Please retry.';
      return res.status(502).json({
        success: false,
        error: clean,
        code: 'AI_INVALID_OUTPUT',
        retryable: false,
        requestId,
        errorDetail: { code: 'AI_INVALID_OUTPUT', message: clean, retryable: false },
      });
    }
    return res.status(502).json({
      success: false,
      error: fallbackMessage,
      code: 'AI_PROVIDER_ERROR',
      retryable: false,
      requestId,
      errorDetail: { code: 'AI_PROVIDER_ERROR', message: fallbackMessage, retryable: false },
    });
  }

  // AI Event Concierge (Server-side Gemini API with usage caps, resilience, & session ownership isolation)
  app.post('/api/ai/concierge', rateLimit(15, 60_000), async (req: Request, res: Response) => {
    const requestId = String(res.getHeader('X-Request-Id') || crypto.randomUUID());
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
      const msg = parsed.error.issues[0]?.message || 'Please enter a valid message for the AI Event Concierge.';
      return res.status(400).json({
        success: false,
        error: msg,
        code: 'VALIDATION_ERROR',
        retryable: false,
        requestId,
        errorDetail: { code: 'VALIDATION_ERROR', message: msg, retryable: false },
      });
    }

    const { ctx } = await getAuth(req);
    const callerOwnerId = ctx.session.role === 'guest' ? undefined : ctx.session.id;

    let aiResult: Awaited<ReturnType<typeof runConciergeTurn>>;
    try {
      aiResult = await runConciergeTurn(parsed.data.history, parsed.data.message, {
        requestId,
        endpoint: '/api/ai/concierge',
      });
    } catch (err) {
      return sendAiErrorResponse(
        res,
        requestId,
        err,
        'AI Event Concierge encountered an upstream error. Please try again shortly.',
      );
    }

    try {
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
            id: `ais-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

      logStructured('info', 'ai_concierge_persisted', {
        requestId,
        sessionId: savedSession.id,
        escalatedToHuman: savedSession.escalatedToHuman,
        eventCategory: savedSession.eventCategory,
      });

      return res.json({
        success: true,
        persisted: true,
        requestId,
        sessionId: savedSession.id,
        reply: aiResult.reply,
        extractedLead: aiResult.extractedLead,
      });
    } catch (err) {
      observability.recordAiEvent('persistenceError');
      const dbErr = classifyDatabaseError(err);
      logStructured('error', 'ai_concierge_persistence_failed', {
        requestId,
        dbErrorCode: dbErr?.code ?? 'DB_ERROR',
        httpStatus: dbErr?.httpStatus ?? 500,
      });
      const safeMsg =
        'Your concierge response was generated, but we could not save the session right now. Please try again.';
      return res.status(500).json({
        success: false,
        error: safeMsg,
        code: 'AI_PERSISTENCE_FAILED',
        retryable: true,
        requestId,
        errorDetail: { code: 'AI_PERSISTENCE_FAILED', message: safeMsg, retryable: true },
      });
    }
  });

  // AI Event Concept Studio (Server-side Gemini API with strict concept/booking isolation, idempotency & atomic persistence)
  app.post('/api/ai/concept-studio', rateLimit(12, 60_000), async (req: Request, res: Response) => {
    const requestId = String(res.getHeader('X-Request-Id') || crypto.randomUUID());
    const schema = z.object({
      conceptId: z.string().trim().min(1).optional(),
      bookingId: z.string().trim().min(1).optional(),
      eventType: z.string().trim().min(2, 'Please select an event type.').max(120),
      guestCount: z.coerce
        .number()
        .int('Guest count must be a whole number.')
        .min(10, 'Guest count must be at least 10.')
        .max(2000, 'Guest count cannot exceed 2,000.'),
      venueStyle: z.string().trim().min(2, 'Please describe your venue style.').max(200),
      preferredPalette: z.string().trim().min(2, 'Please enter your preferred color palette.').max(200),
      visionDescription: z.string().trim().min(5, 'Please share a few details about your celebration vision.').max(1500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || 'Please describe your event vision and venue style.';
      return res.status(400).json({
        success: false,
        error: msg,
        code: 'VALIDATION_ERROR',
        retryable: false,
        requestId,
        errorDetail: { code: 'VALIDATION_ERROR', message: msg, retryable: false },
      });
    }

    const { db: preflightDb, ctx } = await getAuth(req);
    // Reject invalid or inactive authenticated contexts before
    // joining an existing operation or invoking the AI provider.
    if (ctx.spoofAttemptDetected || ctx.accountStatus !== 'active') {
      const message = 'Your session is not authorized to generate a concept.';
      return res.status(403).json({
        success: false,
        error: message,
        code: 'FORBIDDEN',
        retryable: false,
        requestId,
        errorDetail: {
          code: 'FORBIDDEN',
          message,
          retryable: false,
        },
      });
    }

    // Prevent shared anonymous proposal retrieval.
    const callerScope =
      ctx.session.role === 'guest' ? undefined : ctx.session.id;

    const rawIdemKey = (req.header('idempotency-key') || '').trim();
    const scopedIdempotencyKey =
      callerScope && rawIdemKey && /^[a-zA-Z0-9_:-]{8,128}$/.test(rawIdemKey)
        ? `${callerScope}:${rawIdemKey}`
        : undefined;


    const { createHash } = await import('node:crypto');

    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify(parsed.data))
      .digest('hex');

    const encodeIdempotencyRecord = (conceptId: string) =>
      `v2:${requestFingerprint}:${conceptId}`;

    const canAccessAttachedBooking = (
      db: typeof preflightDb,
      bookingId: string
    ): boolean => {
      if (
        bookingId === 'unassigned-client-concept' ||
        bookingId === 'public-concierge-preview'
      ) {
        return true;
      }

      const booking = db.bookings.find(
        (b) => b.id === bookingId
      );

      return Boolean(
        booking &&
        isAuthorizedForBooking(
          booking, ctx.session, db.vendors
        )
      );
    };

    const resolveCachedConcept = (
      db: typeof preflightDb,
      record: string
    ) => {
      const prefix = `v2:${requestFingerprint}:`;

      if (!record.startsWith(prefix)) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }

      const existing = db.concepts.find(
        (c) => c.id === record.slice(prefix.length)
      );

      if (!existing) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }

      const authorized =
        hasPlanningClearance(ctx.session) ||
        (ctx.session.role === 'client' &&
          existing.clientId === ctx.session.id);

      if (!authorized) {
        throw new Error('IDEMPOTENCY_FORBIDDEN');
      }

      if (!canAccessAttachedBooking(
        db, existing.bookingId
      )) {
        throw new Error('IDEMPOTENCY_FORBIDDEN');
      }

      return existing;
    };

    const sendIdempotencyError = (err: unknown) => {
      const forbidden =
        err instanceof Error &&
        err.message === 'IDEMPOTENCY_FORBIDDEN';

      const code = forbidden
        ? 'FORBIDDEN'
        : 'IDEMPOTENCY_CONFLICT';

      const message = forbidden
        ? 'Not authorized to access this concept.'
        : 'This request key cannot be reused. Start a new request.';

      return res.status(forbidden ? 403 : 409).json({
        success: false,
        error: message,
        code,
        retryable: false,
        requestId,
        errorDetail: { code, message, retryable: false },
      });
    };

    // Cached results must cross the same fresh authorization
    // and transaction boundary as newly generated proposals.
    const cacheOnlyRequest = Boolean(
      scopedIdempotencyKey &&
      preflightDb.conceptIdempotencyKeys?.[scopedIdempotencyKey]
    );

    if (!cacheOnlyRequest) {
      // Pre-check concept revision & booking authorization BEFORE calling Gemini API
      if (parsed.data.conceptId) {
        const existingCheck = preflightDb.concepts.find((c) => c.id === parsed.data.conceptId);
        if (!existingCheck) {
          return res.status(404).json({
            success: false,
            error: 'The selected concept proposal could not be found. Create a new concept proposal instead.',
            code: 'CONCEPT_NOT_FOUND',
            retryable: false,
            requestId,
            errorDetail: {
              code: 'CONCEPT_NOT_FOUND',
              message: 'The selected concept proposal could not be found.',
              retryable: false,
            },
          });
        }
        const canRevise =
          hasPlanningClearance(ctx.session) ||
          (ctx.session.role === 'client' && existingCheck.clientId === ctx.session.id);
        if (!canRevise) {
          return res.status(403).json({
            success: false,
            error: 'Cannot revise another client concept.',
            code: 'FORBIDDEN',
            retryable: false,
            requestId,
            errorDetail: { code: 'FORBIDDEN', message: 'Cannot revise another client concept.', retryable: false },
          });
        }
        if (!canAccessAttachedBooking(
          preflightDb, existingCheck.bookingId
        )) {
          return sendIdempotencyError(
            new Error('IDEMPOTENCY_FORBIDDEN')
          );
        }

        if (
          parsed.data.bookingId &&
          parsed.data.bookingId !== existingCheck.bookingId
        ) {
          return res.status(409).json({
            success: false,
            code: 'CONCEPT_BOOKING_CONFLICT',
            error: 'An existing concept cannot be reassigned by generating a revision.',
            retryable: false,
            requestId,
          });
        }

        if (existingCheck.clientApproved && existingCheck.staffApproved && !hasPlanningClearance(ctx.session)) {
          return res.status(409).json({
            success: false,
            error: 'This concept proposal has already received dual approval. Create a new concept proposal for a fresh direction.',
            code: 'CONCEPT_ALREADY_APPROVED',
            retryable: false,
            requestId,
            errorDetail: {
              code: 'CONCEPT_ALREADY_APPROVED',
              message: 'This concept proposal has already received dual approval.',
              retryable: false,
            },
          });
        }
      }
      if (parsed.data.bookingId) {
        const bookingCheck = preflightDb.bookings.find((b) => b.id === parsed.data.bookingId);
        if (!bookingCheck || !isAuthorizedForBooking(bookingCheck, ctx.session, preflightDb.vendors)) {
          return res.status(403).json({
            success: false,
            error: 'Not authorized to attach a concept to this booking.',
            code: 'FORBIDDEN',
            retryable: false,
            requestId,
            errorDetail: {
              code: 'FORBIDDEN',
              message: 'Not authorized to attach a concept to this booking.',
              retryable: false,
            },
          });
        }
      }
    }

    const flightKey = scopedIdempotencyKey
      ? JSON.stringify([callerScope, rawIdemKey])
      : undefined;

    let flight: ConceptGenerationFlight | undefined;

    const releaseFlight = async () => {
      if (!flightKey || !flight) return;
      const completed = flight;
      flight = undefined;
      completed.participants -= 1;

      if (
        completed.participants === 0 &&
        conceptGenerationFlights.get(flightKey) === completed
      ) {
        conceptGenerationFlights.delete(flightKey);
        if (completed.durableLease) {
          try {
            await releaseConceptLease(completed.durableLease);
          } catch {
            logStructured('error',
              'ai_concept_lease_cleanup_failed', { requestId });
          }
        }
      }
    };

    let proposal:
      Awaited<ReturnType<typeof generateConceptProposal>> | undefined;

    try {
      if (cacheOnlyRequest) {
        // Never invoke the provider for a known cached request.
        // A missing or unauthorized durable result fails closed
        // inside the final transaction.
        proposal = undefined;
      } else if (flightKey) {
        const existingFlight =
          conceptGenerationFlights.get(flightKey);

        if (
          existingFlight &&
          existingFlight.fingerprint !== requestFingerprint
        ) {
          return sendIdempotencyError(
            new Error('IDEMPOTENCY_CONFLICT'),
          );
        }

        if (existingFlight) {
          if (
            existingFlight.participants >=
            MAX_CONCEPT_FLIGHT_PARTICIPANTS
          ) {
            const message =
              'Too many requests are waiting for this proposal. Please retry shortly.';

            return res.status(503).json({
              success: false,
              error: message,
              code: 'AI_SERVICE_BUSY',
              retryable: true,
              requestId,
              errorDetail: {
                code: 'AI_SERVICE_BUSY',
                message,
                retryable: true,
              },
            });
          }

          flight = existingFlight;
          flight.participants += 1;

          logStructured('info', 'ai_concept_singleflight_joined', {
            requestId,
          });
        } else {
          if (
            conceptGenerationFlights.size >=
            MAX_CONCEPT_GENERATION_FLIGHTS
          ) {
            const message =
              'Concept Studio is busy. Please retry shortly.';

            return res.status(503).json({
              success: false,
              error: message,
              code: 'AI_SERVICE_BUSY',
              retryable: true,
              requestId,
              errorDetail: {
                code: 'AI_SERVICE_BUSY',
                message,
                retryable: true,
              },
            });
          }

          // Defer execution until the coordination entry is registered.
          // This closes the local stale-preflight snapshot window.
          const sharedProposal = Promise.resolve().then(async () => {
            const {
              db: latestDb,
              ctx: latestCtx,
            } = await getAuth(req);

            if (
              latestCtx.spoofAttemptDetected ||
              latestCtx.accountStatus !== 'active' ||
              latestCtx.session.id !== ctx.session.id ||
              latestCtx.session.role !== ctx.session.role ||
              latestCtx.authMethod !== ctx.authMethod ||
              latestCtx.sessionJti !== ctx.sessionJti ||
              latestCtx.mfaVerified !== ctx.mfaVerified ||
              latestCtx.aal !== ctx.aal ||
              JSON.stringify(latestCtx.session) !==
                JSON.stringify(ctx.session)
            ) {
              throw new Error('AI_AUTHORIZATION_CHANGED');
            }

            // A previous operation may have committed after the
            // original preflight snapshot was collected.
            const durableRecord = scopedIdempotencyKey
              ? latestDb.conceptIdempotencyKeys?.[
                  scopedIdempotencyKey
                ]
              : undefined;

            if (durableRecord) {
              resolveCachedConcept(latestDb, durableRecord);

              logStructured(
                'info',
                'ai_concept_fresh_snapshot_deduplicated',
                { requestId },
              );

              // The final transaction independently resolves
              // the durable result for every participant.
              return undefined;
            }

            if (!scopedIdempotencyKey) {
              throw new Error('AI_LEASE_ACQUISITION_FAILED');
            }

            const acquisition = await acquireConceptLease(
  scopedIdempotencyKey,
  requestFingerprint,

async (db) => {
const { ctx: freshCtx } = await getAuth(req, db);

        if (
          freshCtx.spoofAttemptDetected ||
          freshCtx.session.id !== ctx.session.id ||
          freshCtx.session.role !== ctx.session.role ||
          freshCtx.accountStatus !== ctx.accountStatus ||
          freshCtx.accountStatus !== 'active' ||
          freshCtx.authMethod !== ctx.authMethod ||
          freshCtx.sessionJti !== ctx.sessionJti ||
          freshCtx.mfaVerified !== ctx.mfaVerified ||
          freshCtx.aal !== ctx.aal ||
          JSON.stringify(freshCtx.session) !==
            JSON.stringify(ctx.session)
        ) {
          throw new Error('AI_AUTHORIZATION_CHANGED');
        }

  // Validate explicit booking access.
  if (parsed.data.bookingId) {
    const booking = db.bookings.find(
      (b) => b.id === parsed.data.bookingId,
    );

    if (!booking || !isAuthorizedForBooking(
      booking, ctx.session, db.vendors,
    )) {
      throw new Error('IDEMPOTENCY_FORBIDDEN');
    }
  }

  // Preserve durable replay semantics.
  const cachedRecord = scopedIdempotencyKey
    ? db.conceptIdempotencyKeys?.[scopedIdempotencyKey]
    : undefined;

  if (cachedRecord) {
    resolveCachedConcept(db, cachedRecord);
    return;
  }

  // Revalidate revision permissions before generation.
  if (parsed.data.conceptId) {
    const existing = db.concepts.find(
      (c) => c.id === parsed.data.conceptId,
    );

    if (!existing) {
      throw new Error('CONCEPT_REVISION_MISSING');
    }

    const canRevise =
      hasPlanningClearance(ctx.session) ||
      (
        ctx.session.role === 'client' &&
        existing.clientId === ctx.session.id
      );

    if (!canRevise) {
      throw new Error(
        'FORBIDDEN:Cannot revise another client concept.',
      );
    }

    if (
      existing.clientApproved &&
      existing.staffApproved &&
      !hasPlanningClearance(ctx.session)
    ) {
      throw new Error(
        'CONCEPT_LOCKED:This concept proposal has already received dual approval.',
      );
    }

    if (!canAccessAttachedBooking(
      db, existing.bookingId,
    )) {
      throw new Error('IDEMPOTENCY_FORBIDDEN');
    }

    if (
      parsed.data.bookingId &&
      parsed.data.bookingId !== existing.bookingId
    ) {
      throw new Error('CONCEPT_BOOKING_CONFLICT');
    }
  } else {
    const safeBookingId = parsed.data.bookingId
      ? parsed.data.bookingId
      : ctx.session.role === 'client'
        ? db.bookings.find(
            (b) => b.clientId === ctx.session.id,
          )?.id || 'unassigned-client-concept'
        : 'public-concierge-preview';

    if (!canAccessAttachedBooking(db, safeBookingId)) {
      throw new Error('IDEMPOTENCY_FORBIDDEN');
    }
  }
}
,
).catch((error: unknown) => {
  if (error instanceof Error && (
    [
      'AI_AUTHORIZATION_CHANGED',
      'IDEMPOTENCY_CONFLICT',
      'IDEMPOTENCY_FORBIDDEN',
      'CONCEPT_REVISION_MISSING',
      'CONCEPT_BOOKING_CONFLICT',
    ].includes(error.message) ||
    error.message.startsWith('FORBIDDEN:') ||
    error.message.startsWith('CONCEPT_LOCKED:')
  )) {
    throw error;
  }
  throw new Error('AI_LEASE_ACQUISITION_FAILED');
});

            if (acquisition.status === 'conflict') {
              throw new Error('IDEMPOTENCY_CONFLICT');
            }

            if (acquisition.status === 'completed') {
              return undefined;
            }

            if (acquisition.status !== 'acquired') {
              throw new Error('AI_DURABLE_LEASE_BUSY');
            }

            const activeFlight =
              conceptGenerationFlights.get(flightKey);

            if (!activeFlight) {
              await releaseConceptLease(acquisition.lease);
              throw new Error('AI_LEASE_ACQUISITION_FAILED');
            }

            activeFlight.durableLease = acquisition.lease;

            logStructured('info',
              'ai_concept_durable_lease_acquired', { requestId });

            return generateConceptProposal(parsed.data, {
              requestId,
              endpoint: '/api/ai/concept-studio',
            });
          });

          flight = {
            fingerprint: requestFingerprint,
            proposal: sharedProposal,
            participants: 1,
          };

          conceptGenerationFlights.set(flightKey, flight);
        }

        proposal = await flight.proposal;
      } else {
        // Anonymous or unkeyed requests remain independent.
        proposal = await generateConceptProposal(parsed.data, {
          requestId,
          endpoint: '/api/ai/concept-studio',
        });
      }
    } catch (err) {
      // A provider timeout does not prove that upstream
      // generation has stopped. Retain durable ownership
      // until its database-clock expiry to prevent immediate
      // duplicate generation across backend replicas.
      if (
        flight?.durableLease &&
        err instanceof Error &&
        (
          ('code' in err && err.code === 'AI_TIMEOUT') ||
          err.message.startsWith('AI_TIMEOUT:')
        )
      ) {
        flight.durableLease = undefined;

        logStructured(
          'warn',
          'ai_concept_timeout_lease_retained',
          { requestId },
        );
      }

      await releaseFlight();

      if (err instanceof Error) {
        if (err.message === 'CONCEPT_REVISION_MISSING') {
          return res.status(404).json({
            success: false,
            code: 'CONCEPT_NOT_FOUND',
            error: 'The selected concept no longer exists.',
            retryable: false,
            requestId,
          });
        }

        if (err.message === 'CONCEPT_BOOKING_CONFLICT') {
          return res.status(409).json({
            success: false,
            code: 'CONCEPT_BOOKING_CONFLICT',
            error: 'The concept booking association has changed.',
            retryable: false,
            requestId,
          });
        }

        if (
          err.message.startsWith('FORBIDDEN:') ||
          err.message.startsWith('CONCEPT_LOCKED:')
        ) {
          return sendAiErrorResponse(
            res, requestId, err,
            'Unable to update concept proposal.',
          );
        }
      }


      if (err instanceof Error &&
          ['AI_DURABLE_LEASE_BUSY',
           'AI_LEASE_ACQUISITION_FAILED'].includes(err.message)) {
        const busy = err.message === 'AI_DURABLE_LEASE_BUSY';
        const code = busy ? 'AI_SERVICE_BUSY' : 'AI_PERSISTENCE_FAILED';
        const message = busy
          ? 'A matching proposal is being processed. Please retry shortly.'
          : 'Proposal coordination is unavailable. Please retry.';

        if (busy) res.setHeader('Retry-After', '3');

        return res.status(busy ? 503 : 500).json({
          success: false, code, error: message,
          retryable: true, requestId,
          errorDetail: { code, message, retryable: true },
        });
      }

      if (
        err instanceof Error &&
        (
          err.message === 'IDEMPOTENCY_CONFLICT' ||
          err.message === 'IDEMPOTENCY_FORBIDDEN'
        )
      ) {
        return sendIdempotencyError(err);
      }

      if (
        err instanceof Error &&
        err.message === 'AI_AUTHORIZATION_CHANGED'
      ) {
        const code = 'AI_AUTHORIZATION_CHANGED';
        const message =
          'Authorization changed. Sign in again before retrying.';

        return res.status(403).json({
          success: false,
          error: message,
          code,
          retryable: false,
          requestId,
          errorDetail: {
            code,
            message,
            retryable: false,
          },
        });
      }

      return sendAiErrorResponse(
        res,
        requestId,
        err,
        'Concept Studio AI service could not generate a proposal right now. Please try again.',
      );
    }

    try {
      const outcome = await withClockedTransaction(async (db, clock) => {
        // Revalidate the original credential against the locked
        // database state before saving any generated concept.
        const { ctx: freshCtx } = await getAuth(req, db);

        if (
          freshCtx.spoofAttemptDetected ||
          freshCtx.session.id !== ctx.session.id ||
          freshCtx.session.role !== ctx.session.role ||
          freshCtx.accountStatus !== ctx.accountStatus ||
          freshCtx.accountStatus !== 'active' ||
          freshCtx.authMethod !== ctx.authMethod ||
          freshCtx.sessionJti !== ctx.sessionJti ||
          freshCtx.mfaVerified !== ctx.mfaVerified ||
          freshCtx.aal !== ctx.aal ||
          JSON.stringify(freshCtx.session) !==
            JSON.stringify(ctx.session)
        ) {
          throw new Error('AI_AUTHORIZATION_CHANGED');
        }


        if (parsed.data.bookingId) {
          const booking = db.bookings.find(
            (b) => b.id === parsed.data.bookingId
          );

          if (!booking || !isAuthorizedForBooking(
            booking, ctx.session, db.vendors
          )) {
            throw new Error('IDEMPOTENCY_FORBIDDEN');
          }
        }

        db.conceptIdempotencyKeys = db.conceptIdempotencyKeys || {};
        if (scopedIdempotencyKey && db.conceptIdempotencyKeys[scopedIdempotencyKey]) {
          const existingConcept = resolveCachedConcept(
            db,
            db.conceptIdempotencyKeys[scopedIdempotencyKey]
          );
          if (existingConcept) {
            return { concept: existingConcept, deduplicated: true };
          }
        }

        // A cache-only operation may never create a new concept
        // if its durable record disappears before finalization.
        if (!proposal) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }

        const ownedLease = flight?.durableLease;

        if (scopedIdempotencyKey) {
          if (!ownedLease) {
            throw new Error('AI_CONCEPT_LEASE_LOST');
          }

          assertConceptLeaseOwnership(
            db, ownedLease, scopedIdempotencyKey,
            requestFingerprint, await clock(),
          );
        }

        const completeOwnedLease = async () => {
          if (scopedIdempotencyKey && ownedLease) {
            completeConceptLease(
              db, ownedLease, scopedIdempotencyKey,
              requestFingerprint, await clock(),
            );
          }
        };

        const existing = parsed.data.conceptId
          ? db.concepts.find((c) => c.id === parsed.data.conceptId)
          : undefined;

        if (parsed.data.conceptId && !existing) {
          throw new Error('CONCEPT_REVISION_MISSING');
        }

        if (existing) {
          const canRevise =
            hasPlanningClearance(ctx.session) ||
            (ctx.session.role === 'client' && existing.clientId === ctx.session.id);
          if (!canRevise) {
            throw new Error('FORBIDDEN:Cannot revise another client concept.');
          }
          if (existing.clientApproved && existing.staffApproved && !hasPlanningClearance(ctx.session)) {
            throw new Error(
              'CONCEPT_LOCKED:This concept proposal has already received dual approval. Create a new concept proposal instead.',
            );
          }
          if (!canAccessAttachedBooking(
            db, existing.bookingId
          )) {
            throw new Error('IDEMPOTENCY_FORBIDDEN');
          }

          if (
            parsed.data.bookingId &&
            parsed.data.bookingId !== existing.bookingId
          ) {
            throw new Error('CONCEPT_BOOKING_CONFLICT');
          }

          const nextVer = existing.currentVersion + 1;
          existing.currentVersion = nextVer;
          existing.eventType = parsed.data.eventType;
          existing.title = `${proposal.themeName} Concept`;
          existing.clientApproved = false;
          existing.staffApproved = false;
          existing.revisions.unshift({
            version: nextVer,
            createdAt: new Date().toISOString(),
            ...proposal,
          });
          if (scopedIdempotencyKey) {
            db.conceptIdempotencyKeys[scopedIdempotencyKey] = encodeIdempotencyRecord(existing.id);
          }
          appendAudit(db, ctx.session, 'CONCEPT_REVISED', 'DesignConcept', existing.id, `Created revision v${nextVer}`);
          await completeOwnedLease();
          return { concept: existing, deduplicated: false };
        }

        const safeBookingId = parsed.data.bookingId
          ? parsed.data.bookingId
          : ctx.session.role === 'client'
            ? db.bookings.find((b) => b.clientId === ctx.session.id)?.id || 'unassigned-client-concept'
            : 'public-concierge-preview';

        if (!canAccessAttachedBooking(
          db, safeBookingId
        )) {
          throw new Error('IDEMPOTENCY_FORBIDDEN');
        }

        const nowIso = new Date().toISOString();
        const newConcept = {
          id: `cnc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
              createdAt: nowIso,
              ...proposal,
            },
          ],
          clientApproved: false,
          staffApproved: false,
          isConceptualVisualization: true as const,
          createdAt: nowIso,
        };
        db.concepts.unshift(newConcept);
        if (scopedIdempotencyKey) {
          db.conceptIdempotencyKeys[scopedIdempotencyKey] = encodeIdempotencyRecord(newConcept.id);
        }
        appendAudit(db, ctx.session, 'CONCEPT_GENERATED', 'DesignConcept', newConcept.id, `Generated conceptual visualization (${proposal.themeName})`);
        await completeOwnedLease();
        return { concept: newConcept, deduplicated: false };
      });

      // A successful non-deduplicated transaction has
      // atomically persisted the proposal and completed its lease.
      // Never issue a redundant lease-release transaction.
      if (!outcome.deduplicated && flight?.durableLease) {
        flight.durableLease = undefined;
      }

      await releaseFlight();

      logStructured('info', 'ai_concept_persisted', {
        requestId,
        conceptId: outcome.concept.id,
        currentVersion: outcome.concept.currentVersion,
        eventType: outcome.concept.eventType,
        deduplicated: outcome.deduplicated,
        paletteCount: outcome.concept.revisions[0]?.colorPalette.length ?? 0,
        recommendedDivisionsCount: outcome.concept.revisions[0]?.recommendedDivisions.length ?? 0,
      });

      return res.json({
        success: true,
        persisted: true,
        deduplicated: outcome.deduplicated,
        requestId,
        concept: outcome.concept,
      });
    } catch (err) {
      await releaseFlight();

      if (
        err instanceof Error &&
        err.message === 'AI_AUTHORIZATION_CHANGED'
      ) {
        const message =
          'Your session or authorization changed during generation. Sign in again before continuing.';

        return res.status(403).json({
          success: false,
          error: message,
          code: 'AI_AUTHORIZATION_CHANGED',
          retryable: false,
          requestId,
          errorDetail: {
            code: 'AI_AUTHORIZATION_CHANGED',
            message,
            retryable: false,
          },
        });
      }


      if (err instanceof Error &&
          ['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_FORBIDDEN'].includes(err.message)) {
        return sendIdempotencyError(err);
      }

      if (err instanceof Error &&
          err.message === 'CONCEPT_BOOKING_CONFLICT') {
        return res.status(409).json({
          success: false,
          code: 'CONCEPT_BOOKING_CONFLICT',
          error: 'The concept booking association has changed.',
          retryable: false,
          requestId,
        });
      }

      if (err instanceof Error &&
          err.message === 'CONCEPT_REVISION_MISSING') {
        const code = 'CONCEPT_NOT_FOUND';
        const message = 'The selected concept no longer exists.';

        return res.status(404).json({
          success: false,
          error: message,
          code,
          retryable: false,
          requestId,
          errorDetail: { code, message, retryable: false },
        });
      }

      if (err instanceof Error && (err.message.startsWith('FORBIDDEN:') || err.message.startsWith('CONCEPT_LOCKED:'))) {
        return sendAiErrorResponse(res, requestId, err, 'Unable to update concept proposal.');
      }
      if (err instanceof Error &&
          err.message === 'AI_CONCEPT_LEASE_LOST') {
        const code = 'AI_SERVICE_BUSY';
        const message = 'Proposal ownership changed. Please retry.';
        res.setHeader('Retry-After', '3');

        return res.status(503).json({
          success: false, code, error: message,
          retryable: true, requestId,
          errorDetail: { code, message, retryable: true },
        });
      }

      observability.recordAiEvent('persistenceError');
      const dbErr = classifyDatabaseError(err);
      logStructured('error', 'ai_concept_persistence_failed', {
        requestId,
        dbErrorCode: dbErr?.code ?? 'DB_ERROR',
        httpStatus: dbErr?.httpStatus ?? 500,
      });
      const safeMsg =
        'Your concept proposal was generated, but we could not save it to the database right now. Your details are preserved — please click Retry.';
      return res.status(500).json({
        success: false,
        error: safeMsg,
        code: 'AI_PERSISTENCE_FAILED',
        retryable: true,
        requestId,
        errorDetail: { code: 'AI_PERSISTENCE_FAILED', message: safeMsg, retryable: true },
      });
    } finally {
      await releaseFlight();
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
    const persistence = await checkPersistenceHealth();
    const auth = getIdentityProviderStatus();
    const email = getEmailProviderStatus();
    const metricsSnapshot = observability.getSnapshot();
    const workerStatus = outboxWorker.getStatus();
    const worker: ReadinessWorkerDiagnostics = {
      ...workerStatus,
      healthy: metricsSnapshot.notifications.workerHealthy,
      lastHeartbeatAt: metricsSnapshot.notifications.lastWorkerHeartbeatAt,
    };
    const readiness = evaluateApplicationReadiness({
      persistence,
      auth,
      email,
      worker,
      isProduction: process.env.NODE_ENV === 'production',
    });
    const queueDepth = db.notificationOutbox.filter(
      (j) => j.status === 'Pending' || j.status === 'Retrying' || j.status === 'Claimed',
    ).length;
    const deadLetterCount = db.notificationOutbox.filter((j) => j.status === 'DeadLetter').length;
    const activeSlotHolds = db.consultationSlotHolds.filter(
      (h) => new Date(h.expiresAt).getTime() > Date.now(),
    ).length;
    res.json({
      metrics: metricsSnapshot,
      outbox: {
        queueDepth,
        deadLetterCount,
      },
      scheduling: {
        activeSlotHolds,
        totalConsultations: db.consultations.length,
      },
      readiness: {
        status: readiness.status,
        productionReady: readiness.productionReady,
        checks: readiness.checks,
        blockingReasons: readiness.blockingReasons,
        worker,
        email: {
          provider: email.provider,
          configured: email.configured,
          webhookSecretConfigured: email.webhookSecretConfigured,
          staffRecipientConfigured: email.staffRecipientConfigured,
          liveDeliveryEnabled: email.liveDeliveryEnabled,
        },
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
          : getStudioTodayIso();
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

  // 2b. Release a client's active temporary consultation slot hold immediately
  app.delete(
    '/api/consultations/holds',
    rateLimit(30, 60_000, { endpointGroup: 'consultations:holds', failClosed: false }),
    async (req: Request, res: Response) => {
      const rawHolderKey =
        (typeof req.body?.holderKey === 'string' ? req.body.holderKey : '') ||
        (typeof req.query?.holderKey === 'string' ? req.query.holderKey : '') ||
        (req.header('x-hold-key') || '');
      const holderKey = rawHolderKey.trim();
      if (holderKey.length < 6 || holderKey.length > 160) {
        return res.status(400).json({ error: 'Valid holderKey is required to release a slot hold.' });
      }
      const holderHash = sha256Hex(holderKey);
      const nowMs = Date.now();
      const releasedCount = await withTransaction((db) => {
        const before = db.consultationSlotHolds.length;
        db.consultationSlotHolds = db.consultationSlotHolds.filter(
          (h) => new Date(h.expiresAt).getTime() > nowMs && h.holderFingerprintHash !== holderHash,
        );
        return Math.max(0, before - db.consultationSlotHolds.length);
      });
      res.json({ ok: true, releasedCount });
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
      const todayIso = getStudioTodayIso();
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
        const bookedStartMs = new Date(newConsultation.startUtc).getTime();
        const bookedEndMs = new Date(newConsultation.endUtc).getTime();
        db.consultationSlotHolds = db.consultationSlotHolds.filter((h) => {
          if (new Date(h.expiresAt).getTime() <= nowMs) return false;
          if (holderHash && h.holderFingerprintHash === holderHash) return false;
          if (h.plannerId === chosenPlannerId) {
            const hStart = new Date(h.slotStartUtc).getTime();
            const hEnd = new Date(h.slotEndUtc).getTime();
            if (hStart < bookedEndMs && bookedStartMs < hEnd) return false;
          }
          return true;
        });

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

        const staffEmail = getStaffNotificationRecipient();
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
        observability.recordBookingOutcome(false);
        const httpStatus = result.code === 'SLOT_CONFLICT' || result.code === 'BLACKOUT' ? 409 : 400;
        return res.status(httpStatus).json({
          error: result.error,
          code: result.code,
          suggestedSlots: result.suggestedSlots,
        });
      }

      observability.recordBookingOutcome(true);
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
        observability.recordAuthFailure('invalidConsultationToken403');
        return res.status(403).json({
          error: 'Consultation record not found or verification token is invalid.',
          code: 'INVALID_CONSULTATION_TOKEN',
        });
      }
      const tokenCheck = validateConsultationTokenAccess(consultation, accessToken);
      if (!tokenCheck.valid) {
        observability.recordAuthFailure('invalidConsultationToken403');
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

        const staffEmail = getStaffNotificationRecipient();
        if (staffEmail) {
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
        }

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

        const staffEmail = getStaffNotificationRecipient();
        if (staffEmail) {
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
        }

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
      if (c.clientId && c.clientId === ctx.session.id) return true;
      // Never match another authenticated user's bound clientId by email alone;
      // allow email fallback strictly for unbound public lead records when caller email is verified.
      const isUnboundLead = !c.clientId || c.clientId.startsWith('lead:');
      return (
        isUnboundLead &&
        ctx.emailVerified &&
        Boolean(ctx.session.email) &&
        c.clientEmail.toLowerCase() === ctx.session.email.toLowerCase()
      );
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

      const staffEmail = getStaffNotificationRecipient();
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

        const staffEmail = getStaffNotificationRecipient();
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
      const staffEmail = getStaffNotificationRecipient();
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
      const { webhookSecret } = getEmailRuntimeConfig();
      if (!webhookSecret) {
        observability.recordWebhookEvent('unconfigured503');
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
        observability.recordWebhookEvent('rejectedSignature');
        logStructured('warn', 'resend_webhook_signature_rejected', {
          svixId: svixId || 'missing',
          reason: verified.reason,
        });
        return res.status(401).json({
          error: verified.reason || 'Invalid webhook signature.',
          code: 'INVALID_WEBHOOK_SIGNATURE',
        });
      }

      observability.recordWebhookEvent('received');

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
      const bounceDetails = payload.data?.bounce?.message;

      // Deduplicate svix-id, record immutable audit row, and reconcile outbox job atomically in ONE transaction
      const atomicResult = await reconcileResendWebhookAtomic({
        svixId,
        eventType,
        providerMessageId,
        payloadSha256,
        bounceDetails,
      });

      if (atomicResult.deduplicated) {
        observability.recordWebhookEvent('deduplicated');
        return res.status(200).json({ received: true, deduplicated: true, reconciled: false });
      }

      if (atomicResult.reconciled) {
        observability.recordWebhookEvent('reconciled');
      }

      res.status(200).json({
        received: true,
        deduplicated: false,
        eventType,
        providerMessageId,
        reconciled: atomicResult.reconciled,
      });
    },
  );

  // Global safe error handler — prevents hung sockets, unhandled rejections, stack trace leaks, or raw SQL errors
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const isSyntax = err instanceof SyntaxError && 'status' in err;
    if (isSyntax) {
      res.status(400).json({ error: 'Malformed JSON request payload.', code: 'BAD_JSON' });
      return;
    }
    const classified = classifyDatabaseError(err);
    if (classified) {
      if (classified.httpStatus === 409 && req.path.startsWith('/api/consultations')) {
        observability.recordBookingOutcome(false);
      }
      res.status(classified.httpStatus).json({
        error: classified.message,
        code: classified.code,
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
