import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  BOOKING_STATUSES,
  type BookingRecord,
  type BookingStatus,
} from '../src/types/domain.ts';
import { LEGACY_TO_ARCH_STATUS } from '../src/types/lifecycle.ts';
import {
  clearSessionCookie,
  resolveAuthenticatedContext,
  setSessionCookie,
  sha256Hex,
  signSessionToken,
  verifyAdminMfaCode,
} from './auth.ts';
import { generateConceptProposal, getGeminiConfigStatus, runConciergeTurn } from './gemini.ts';
import { getPersistenceStatus } from './repositories/postgresRepository.ts';
import {
  appendAudit,
  canTransitionBookingStatus,
  hasRole,
  isAuthorizedForBooking,
  readDb,
  sanitizeBookingForRole,
  withTransaction,
} from './store.ts';

export interface CreateAppOptions {
  enableRateLimit?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const enableRateLimit = options.enableRateLimit ?? true;
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Security headers (OWASP ASVS aligned)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const rateBucket = new Map<string, { count: number; resetAt: number }>();
  function rateLimit(maxRequests: number, windowMs: number) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!enableRateLimit) return next();
      const key = `${req.ip || 'local'}:${req.path}`;
      const now = Date.now();
      const entry = rateBucket.get(key);
      if (!entry || entry.resetAt <= now) {
        rateBucket.set(key, { count: 1, resetAt: now + windowMs });
        return next();
      }
      if (entry.count >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests. Please wait a moment before trying again.' });
      }
      entry.count += 1;
      return next();
    };
  }

  async function getAuth(req: Request) {
    const db = await readDb();
    const ctx = resolveAuthenticatedContext(req, db.users);
    return { db, ctx };
  }

  function requireAdminMfa(ctx: ReturnType<typeof resolveAuthenticatedContext>, res: Response): boolean {
    if (ctx.session.role !== 'admin') {
      res.status(403).json({ error: 'Executive director clearance required.' });
      return false;
    }
    if (!ctx.mfaVerified) {
      res.status(403).json({
        error: 'MFA_REQUIRED: Executive director session requires multi-factor verification before accessing administrative controls.',
        mfaRequired: true,
      });
      return false;
    }
    return true;
  }

  // Health & Infrastructure Readiness
  app.get('/api/health', (_req: Request, res: Response) => {
    const persistence = getPersistenceStatus();
    const ai = getGeminiConfigStatus();
    res.status(persistence.ready ? 200 : 503).json({
      ok: persistence.ready,
      service: 'Celebration Sisters Event Decor Platform',
      persistence,
      ai: { model: ai.model, configured: ai.configured, timeoutMs: ai.timeoutMs },
      timestamp: new Date().toISOString(),
    });
  });

  // Authentication & Signed Session Management
  app.get('/api/auth/personas', async (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Demo personas are unavailable.' });
    }
    const db = await readDb();
    res.json({ personas: db.users });
  });

  app.get('/api/auth/session', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    res.json({
      user: ctx.session,
      mfaVerified: ctx.mfaVerified,
      mfaRequired: ctx.session.role === 'admin' && !ctx.mfaVerified,
      authMethod: ctx.authMethod,
    });
  });

  app.post('/api/auth/switch', async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Demo account switching is unavailable.' });
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

    const token = signSessionToken({
      userId: user.id,
      role: user.role,
      mfaVerified: user.role !== 'admin',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 8,
    });

    setSessionCookie(res, token);
    res.json({
      user,
      token,
      mfaRequired: user.role === 'admin',
      mfaVerified: user.role !== 'admin',
    });
  });

  app.post('/api/auth/mfa/verify', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (ctx.session.role === 'guest') {
      return res.status(401).json({ error: 'Sign in before verifying MFA.' });
    }
    const parsed = z.object({ code: z.string().min(4) }).safeParse(req.body);
    if (!parsed.success || !verifyAdminMfaCode(parsed.data.code)) {
      await withTransaction((db) => {
        appendAudit(db, ctx.session, 'MFA_VERIFICATION_FAILED', 'AuthSession', ctx.session.id, 'Invalid MFA code entered');
      });
      return res.status(403).json({ error: 'Invalid director MFA verification code.' });
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
      appendAudit(db, ctx.session, 'MFA_VERIFIED', 'AuthSession', ctx.session.id, 'Privileged MFA verified');
    });

    res.json({ user: ctx.session, token, mfaVerified: true, mfaRequired: false });
  });

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
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

  // Bookings list (strictly isolated by verified signed session)
  app.get('/api/bookings', async (req: Request, res: Response) => {
    const { db, ctx } = await getAuth(req);
    if (ctx.spoofAttemptDetected) {
      await withTransaction((wdb) => {
        appendAudit(wdb, ctx.session, 'PRIVILEGE_SPOOF_BLOCKED', 'API', '/api/bookings', 'Rejected unverified identity/role header');
      });
    }
    if (ctx.session.role === 'guest') {
      return res.status(401).json({ error: 'Authentication required to view booking records.' });
    }
    const visible = db.bookings
      .filter((b) => isAuthorizedForBooking(b, ctx.session, db.vendors))
      .map((b) => sanitizeBookingForRole(b, ctx.session));
    res.json({ bookings: visible });
  });

  const createBookingSchema = z.object({
    clientName: z.string().trim().min(2, 'Full name is required'),
    clientEmail: z.string().trim().email('Valid email address is required'),
    clientPhone: z.string().trim().min(7, 'Phone number is required'),
    eventTitle: z.string().trim().min(3, 'Event title is required'),
    eventType: z.string().trim().min(2),
    serviceDivisionIds: z.array(z.string()).min(1, 'Select at least one service division'),
    packageTier: z.string().trim().default('Custom Consultation Package'),
    eventDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD date format'),
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
    const { ctx } = await getAuth(req);

    try {
      const created = await withTransaction(async (db) => {
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
        const clientId = ctx.session.role === 'client' ? ctx.session.id : 'user-client-camille';
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
        appendAudit(
          db,
          ctx.session,
          'BOOKING_INQUIRY_CREATED',
          'Booking',
          refCode,
          `Created ${initialStatus} (${newBooking.architecturalStage}) for ${input.eventTitle} (${input.eventDate})`,
        );
        return newBooking;
      });

      res.status(201).json({ booking: created });
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
    if (!hasRole(ctx.session, ['staff', 'admin'])) {
      return res.status(403).json({ error: 'Only authorized staff or directors may advance booking workflow statuses.' });
    }
    if (ctx.session.role === 'admin' && !ctx.mfaVerified) {
      return res.status(403).json({ error: 'MFA verification required for executive status transitions.' });
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
        return booking;
      });
      res.json({ booking: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Status update failed.';
      if (msg.startsWith('NOT_FOUND:')) return res.status(404).json({ error: msg.slice(10) });
      if (msg.startsWith('INVALID_STATE:') || msg.startsWith('GUARD:')) {
        return res.status(422).json({ error: msg.split(':').slice(1).join(':') });
      }
      return res.status(500).json({ error: msg });
    }
  });

  // Create itemized quotation version (Admin/Staff only)
  app.post('/api/bookings/:id/quotes', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!hasRole(ctx.session, ['staff', 'admin'])) {
      return res.status(403).json({ error: 'Only authorized staff or directors can issue quotations.' });
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
    if (ctx.session.role === 'guest' || ctx.session.role === 'vendor') {
      return res.status(403).json({ error: 'Not authorized to sign this contract.' });
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
    if (ctx.session.role === 'guest' || ctx.session.role === 'vendor') {
      return res.status(403).json({ error: 'Not authorized to process payment milestones.' });
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
    if (ctx.session.role === 'guest' || ctx.session.role === 'vendor') {
      return res.status(403).json({ error: 'Unauthorized.' });
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
    if (ctx.session.role === 'guest') return res.status(401).json({ error: 'Sign in required.' });
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
    if (ctx.session.role === 'guest') {
      return res.status(401).json({ error: 'Sign in required to view saved concepts.' });
    }
    const visible =
      ctx.session.role === 'admin' || ctx.session.role === 'staff'
        ? db.concepts
        : ctx.session.role === 'client'
          ? db.concepts.filter((c) => c.clientId === ctx.session.id)
          : [];
    res.json({ concepts: visible });
  });

  app.post('/api/concepts/:id/approve', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!hasRole(ctx.session, ['client', 'staff', 'admin'])) {
      return res.status(403).json({ error: 'Unauthorized to approve design concepts.' });
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
          clientId: ctx.session.role === 'client' ? ctx.session.id : 'user-client-camille',
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
    if (!hasRole(ctx.session, ['vendor', 'staff', 'admin'])) {
      return res.status(403).json({ error: 'Vendor or operations clearance required.' });
    }
    const vendors =
      ctx.session.role === 'vendor'
        ? db.vendors.filter((v) => v.email.toLowerCase() === ctx.session.email.toLowerCase() || v.contactName === ctx.session.name)
        : db.vendors;
    res.json({ vendors });
  });

  app.patch('/api/vendors/:id/deliverables/:delivId', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!hasRole(ctx.session, ['vendor', 'staff', 'admin'])) {
      return res.status(403).json({ error: 'Unauthorized.' });
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
    if (!hasRole(ctx.session, ['staff', 'admin'])) {
      return res.status(403).json({ error: 'Staff clearance required.' });
    }
    res.json({ checklists: db.staffChecklists });
  });

  app.patch('/api/staff/checklists/:id/tasks/:taskId', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!hasRole(ctx.session, ['staff', 'admin'])) return res.status(403).json({ error: 'Staff clearance required.' });
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
    if (!hasRole(ctx.session, ['staff', 'admin'])) return res.status(403).json({ error: 'Staff clearance required.' });
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
    if (!hasRole(ctx.session, ['staff', 'admin'])) {
      return res.status(403).json({ error: 'Operations clearance required.' });
    }
    res.json({ inventory: db.inventory });
  });

  app.patch('/api/inventory/:id', async (req: Request, res: Response) => {
    const { ctx } = await getAuth(req);
    if (!hasRole(ctx.session, ['staff', 'admin'])) return res.status(403).json({ error: 'Unauthorized.' });
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
      blackoutDates: db.blackoutDates,
      availabilityHolds: db.availabilityHolds,
      users: db.users,
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

  return app;
}
