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
  isCsrfOriginValid,
  requireActiveAccount,
  requireAdminWithMfa,
  requireRoles,
} from './authz.ts';
import { generateConceptProposal, getGeminiConfigStatus, runConciergeTurn } from './gemini.ts';
import { getIdentityProviderStatus, type VerifyProviderTokenOptions } from './identityProvider.ts';
import {
  buildConsultationConfirmationTemplate,
  buildStaffAlertTemplate,
  buildStatusUpdateTemplate,
  dispatchEmailNotification,
  getEmailProviderStatus,
  type FetchLike,
} from './notifications.ts';
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

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Security headers (OWASP ASVS aligned) & request correlation IDs
  app.use((req: Request, res: Response, next: NextFunction) => {
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

  async function getAuth(req: Request) {
    const db = await readDb();
    const ctx = await resolveAuthenticatedContextAsync(req, db.users, options.providerVerifyOptions);
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

  // Cookie-authenticated state-changing request CSRF Origin/Referer protection
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
      if (!isCsrfOriginValid(req, ctx.authMethod)) {
        await withTransaction((wdb) => {
          appendSecurityEvent(wdb, {
            eventType: 'CSRF_REJECTED',
            userId: ctx.session.id !== 'guest-public' ? ctx.session.id : undefined,
            outcome: 'denied',
            details: `Rejected cookie-authenticated ${req.method} ${req.path} from untrusted origin/referer`,
          });
          appendAudit(wdb, ctx.session, 'CSRF_ORIGIN_REJECTED', 'API', req.path, 'Cross-site cookie mutation rejected');
        });
        return res.status(403).json({
          error: 'Cross-site state-changing request rejected by CSRF origin policy.',
          code: 'CSRF_ORIGIN_REJECTED',
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
    });
  });

  app.post('/api/auth/switch', rateLimit(20, 60_000), async (req: Request, res: Response) => {
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

    const token = signSessionToken({
      userId: user.id,
      role: user.role,
      mfaVerified: user.role !== 'admin',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 8,
    });

    setSessionCookie(res, token);
    res.json({
      user: sanitizeUserForClient(user),
      token,
      mfaRequired: user.role === 'admin',
      mfaVerified: user.role !== 'admin',
    });
  });

  // Enroll RFC 6238 TOTP factor for authenticated administrator
  app.post('/api/auth/mfa/totp/enroll', rateLimit(5, 60_000), async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireActiveAccount(ctx, res)) return;
    if (ctx.session.role !== 'admin') {
      return res.status(403).json({ error: 'Executive director clearance required to enroll admin TOTP MFA.' });
    }

    const secret = generateTotpSecret();
    const otpauthUri = buildTotpProvisioningUri(ctx.session.email, secret);

    await withTransaction((db) => {
      const target = db.users.find((u) => u.id === ctx.session.id);
      if (target) {
        target.totpSecret = secret;
        target.mfaEnrolled = true;
      }
      appendAudit(db, ctx.session, 'MFA_TOTP_ENROLLED', 'AuthSession', ctx.session.id, 'Enrolled RFC 6238 TOTP authenticator factor');
    });

    res.json({
      enrolled: true,
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
      secret,
      otpauthUri,
    });
  });

  app.post('/api/auth/mfa/verify', rateLimit(10, 60_000), async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!requireActiveAccount(ctx, res)) return;
    const parsed = z.object({ code: z.string().min(6).max(12) }).safeParse(req.body);
    const challenge = parsed.success ? verifyAdminMfaChallenge(ctx.session, parsed.data.code) : { verified: false, method: 'none' as const };
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

    const token = signSessionToken({
      userId: ctx.session.id,
      role: ctx.session.role,
      mfaVerified: true,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 8,
    });
    setSessionCookie(res, token);
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
      mfaVerified: true,
      mfaRequired: false,
      method: challenge.method,
    });
  });

  app.post('/api/auth/logout', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    clearSessionCookie(res);
    if (ctx.session.role !== 'guest') {
      await withTransaction((db) => {
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

        const nextNum = 65 + db.bookings.length;
        const refCode = `CS-2026-0${nextNum}`;
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

      if (!outcome.deduplicated) {
        const createdBooking = outcome.booking;
        const clientTpl = buildConsultationConfirmationTemplate({
          clientName: createdBooking.clientName,
          referenceCode: createdBooking.referenceCode,
          eventTitle: createdBooking.eventTitle,
          eventDate: createdBooking.eventDate,
          venueName: createdBooking.venueName,
          location: createdBooking.location,
        });
        const staffRecipient =
          (process.env.STAFF_NOTIFICATION_EMAIL || '').trim() || 'directors@celebrationsisters.example.com';
        const staffTpl = buildStaffAlertTemplate({
          referenceCode: createdBooking.referenceCode,
          clientName: createdBooking.clientName,
          eventTitle: createdBooking.eventTitle,
          eventDate: createdBooking.eventDate,
          venueName: createdBooking.venueName,
          budgetRange: createdBooking.budgetRange,
        });

        const snapshot = await readDb();
        const [clientDelivery, staffDelivery] = await Promise.all([
          dispatchEmailNotification(
            {
              idempotencyKey: `booking-confirm:${createdBooking.id}`,
              category: 'consultation_confirmation',
              recipient: createdBooking.clientEmail,
              bookingReference: createdBooking.referenceCode,
              ...clientTpl,
            },
            snapshot.notificationDeliveries,
            { fetchImpl: options.notificationFetch },
          ),
          dispatchEmailNotification(
            {
              idempotencyKey: `booking-staff-alert:${createdBooking.id}`,
              category: 'staff_new_booking_alert',
              recipient: staffRecipient,
              bookingReference: createdBooking.referenceCode,
              ...staffTpl,
            },
            snapshot.notificationDeliveries,
            { fetchImpl: options.notificationFetch },
          ),
        ]);

        await withTransaction((db) => {
          if (!clientDelivery.deduplicated) {
            db.notificationDeliveries.unshift(clientDelivery.record);
          }
          if (!staffDelivery.deduplicated) {
            db.notificationDeliveries.unshift(staffDelivery.record);
          }
          if (db.notificationDeliveries.length > 500) {
            db.notificationDeliveries = db.notificationDeliveries.slice(0, 500);
          }
        });
      }

      res.status(outcome.deduplicated ? 200 : 201).json({
        booking: outcome.booking,
        deduplicated: outcome.deduplicated,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save booking inquiry.';
      if (msg.startsWith('DUPLICATE:') || msg.startsWith('CAPACITY:') || msg.startsWith('BLACKOUT:')) {
        return res.status(409).json({ error: msg.split(':').slice(1).join(':') });
      }
      return res.status(500).json({ error: msg });
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
        const tpl = buildStatusUpdateTemplate({
          clientName: updated.booking.clientName,
          referenceCode: updated.booking.referenceCode,
          eventTitle: updated.booking.eventTitle,
          previousStatus: updated.previousStatus,
          newStatus: updated.booking.status,
        });
        const snapshot = await readDb();
        const delivery = await dispatchEmailNotification(
          {
            idempotencyKey: `booking-status:${updated.booking.id}:${updated.booking.status}`,
            category: 'booking_status_update',
            recipient: updated.booking.clientEmail,
            bookingReference: updated.booking.referenceCode,
            ...tpl,
          },
          snapshot.notificationDeliveries,
          { fetchImpl: options.notificationFetch },
        );
        if (!delivery.deduplicated) {
          await withTransaction((db) => {
            db.notificationDeliveries.unshift(delivery.record);
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
      return res.status(500).json({ error: msg });
    }
  });

  // Create itemized quotation version (Planner/Staff/Admin only; discounts approved by Admin)
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
            description: z.string().min(2),
            division: z.string().min(2),
            quantity: z.coerce.number().int().min(1),
            unitPrice: z.coerce.number().min(0),
          }),
        )
        .min(1),
      discountAmount: z.coerce.number().min(0).default(0),
      discountReason: z.string().optional(),
      notes: z.string().default(''),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid quotation items.' });
    }

    try {
      const updated = await withTransaction(async (db) => {
        const booking = db.bookings.find((b) => b.id === req.params.id);
        if (!booking) throw new Error('NOT_FOUND:Booking not found.');

        const subtotal = parsed.data.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
        const discountApproved = parsed.data.discountAmount === 0 || ctx.session.role === 'admin';
        const total = Math.max(0, subtotal - (discountApproved ? parsed.data.discountAmount : 0));
        const nextVersion = booking.quotations.length + 1;

        booking.quotations.push({
          version: nextVersion,
          createdAt: new Date().toISOString(),
          items: parsed.data.items.map((item, idx) => ({ ...item, id: `qi-${Date.now()}-${idx}` })),
          discountAmount: parsed.data.discountAmount,
          discountReason: parsed.data.discountReason,
          discountApproved,
          discountApprovedBy: discountApproved && parsed.data.discountAmount > 0 ? ctx.session.name : undefined,
          totalAmount: total,
          notes: parsed.data.notes,
        });

        if (booking.payments.length === 0) {
          booking.payments.push(
            {
              id: `pay-${Date.now()}-1`,
              label: '50% Retainer Deposit',
              amount: Math.round(total * 0.5),
              dueDate: booking.eventDate,
              status: 'Pending',
            },
            {
              id: `pay-${Date.now()}-2`,
              label: '50% Final Production Balance',
              amount: total - Math.round(total * 0.5),
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
        appendAudit(db, ctx.session, 'QUOTATION_ISSUED', 'Booking', booking.referenceCode, `Issued Quote v${nextVersion} ($${total})`);
        return booking;
      });
      res.json({ booking: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to issue quote.';
      return res.status(404).json({ error: msg });
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
      return res.status(400).json({ error: msg });
    }
  });

  // Record payment milestone (Staging Verification Mode)
  app.post('/api/bookings/:id/payments/:paymentId/pay', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (
      !requireRoles(
        ctx,
        ['client', 'event_planner', 'staff', 'admin'],
        res,
        'Not authorized to process payment milestones.',
      )
    ) {
      return;
    }
    try {
      const updated = await withTransaction(async (db) => {
        const booking = db.bookings.find((b) => b.id === req.params.id);
        if (!booking) throw new Error('NOT_FOUND:Booking not found.');
        if (!isAuthorizedForBooking(booking, ctx.session, db.vendors)) {
          throw new Error('FORBIDDEN:Access denied.');
        }

        const milestone = booking.payments.find((p) => p.id === req.params.paymentId);
        if (!milestone) throw new Error('NOT_FOUND:Payment milestone not found.');
        if (milestone.status === 'Paid') {
          return booking; // Idempotent guard
        }
        milestone.status = 'Paid';
        milestone.paidAt = new Date().toISOString();
        milestone.reference = `STG-${Math.floor(10000 + Math.random() * 90000)}`;

        if (booking.status === 'Payment Pending' && booking.contract.clientSigned && booking.contract.staffCountersigned) {
          booking.status = 'Confirmed';
          booking.architecturalStage = LEGACY_TO_ARCH_STATUS['Confirmed'];
        }
        booking.updatedAt = new Date().toISOString();
        appendAudit(db, ctx.session, 'PAYMENT_MILESTONE_RECORDED', 'Payment', booking.referenceCode, `Recorded $${milestone.amount} (${milestone.label})`);
        return booking;
      });
      res.json({ booking: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Payment error.';
      if (msg.startsWith('FORBIDDEN:')) return res.status(403).json({ error: msg.slice(10) });
      return res.status(400).json({ error: msg });
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

  // AI Event Concierge (Server-side Gemini API with usage caps)
  app.post('/api/ai/concierge', rateLimit(15, 60_000), async (req: Request, res: Response) => {
    const schema = z.object({
      sessionId: z.string().optional(),
      clientName: z.string().optional(),
      message: z.string().trim().min(1).max(1500),
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string(),
          }),
        )
        .max(20)
        .default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please enter a valid message for the AI Event Concierge.' });
    }

    try {
      const aiResult = await runConciergeTurn(parsed.data.history, parsed.data.message);
      const now = new Date().toISOString();

      const savedSession = await withTransaction(async (db) => {
        let existing = parsed.data.sessionId
          ? db.aiSessions.find((s) => s.id === parsed.data.sessionId)
          : undefined;

        if (!existing) {
          existing = {
            id: `ais-${Date.now()}`,
            createdAt: now,
            clientName: parsed.data.clientName || 'Prospective Client',
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
      const status = msg.startsWith('AI_TIMEOUT:') ? 504 : 502;
      return res.status(status).json({ error: msg });
    }
  });

  // AI Event Concept Studio (Server-side Gemini API)
  app.post('/api/ai/concept-studio', rateLimit(12, 60_000), async (req: Request, res: Response) => {
    const schema = z.object({
      conceptId: z.string().optional(),
      bookingId: z.string().optional(),
      eventType: z.string().min(2),
      guestCount: z.coerce.number().int().min(10).max(2000),
      venueStyle: z.string().min(2),
      preferredPalette: z.string().min(2),
      visionDescription: z.string().min(5).max(1500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please describe your event vision and venue style.' });
    }

    const { ctx } = await getAuth(req);

    try {
      const proposal = await generateConceptProposal(parsed.data);

      const savedConcept = await withTransaction(async (db) => {
        const existing = parsed.data.conceptId
          ? db.concepts.find((c) => c.id === parsed.data.conceptId)
          : undefined;

        if (existing) {
          if (ctx.session.role === 'client' && existing.clientId !== ctx.session.id) {
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
          return existing;
        }

        const newConcept = {
          id: `cnc-${Date.now()}`,
          bookingId: parsed.data.bookingId || 'bkg-101',
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
        return newConcept;
      });

      res.json({ concept: savedConcept });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Concept Studio AI service error.';
      if (msg.startsWith('FORBIDDEN:')) return res.status(403).json({ error: msg.slice(10) });
      const status = msg.startsWith('AI_TIMEOUT:') ? 504 : 502;
      return res.status(status).json({ error: msg });
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

  app.get('/api/admin/notifications', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (!requireAdminMfa(ctx, res)) return;
    res.json({
      provider: getEmailProviderStatus(),
      deliveries: db.notificationDeliveries,
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

  // Global safe error handler — prevents leaking stack traces, secrets, or raw SQL errors
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const isSyntax = err instanceof SyntaxError && 'status' in err;
    if (isSyntax) {
      res.status(400).json({ error: 'Malformed JSON request payload.', code: 'BAD_JSON' });
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
