import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  BOOKING_STATUSES,
  type BookingRecord,
  type BookingStatus,
  type UserRole,
  type UserSession,
} from './src/types/domain.ts';
import { generateConceptProposal, runConciergeTurn } from './server/gemini.ts';
import {
  appendAudit,
  canTransitionBookingStatus,
  hasRole,
  isAuthorizedForBooking,
  readDb,
  sanitizeBookingForRole,
  withTransaction,
} from './server/store.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Simple per-IP rate limiter for AI & booking write endpoints
const rateBucket = new Map<string, { count: number; resetAt: number }>();
function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
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

const GUEST_SESSION: UserSession = {
  id: 'guest-public',
  name: 'Public Visitor',
  email: 'visitor@celebrationsisters.example.com',
  role: 'guest',
};

async function resolveSession(req: Request): Promise<UserSession> {
  const requestedUserId = req.header('x-user-id');
  if (!requestedUserId || requestedUserId === 'guest-public') {
    return GUEST_SESSION;
  }
  const db = await readDb();
  const matched = db.users.find((u) => u.id === requestedUserId);
  return matched ?? GUEST_SESSION;
}

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'Celebration Sisters Event Decor Platform',
    timestamp: new Date().toISOString(),
  });
});

// Personas for Portal Access & Role Testing
app.get('/api/auth/personas', async (_req: Request, res: Response) => {
  const db = await readDb();
  res.json({
    personas: db.users,
  });
});

// Public availability check (returns date/venue conflicts without leaking client details)
app.get('/api/availability', async (req: Request, res: Response) => {
  const date = String(req.query.date || '').trim();
  const venue = String(req.query.venue || '').trim().toLowerCase();
  if (!date) {
    return res.status(400).json({ error: 'Event date is required to check availability.' });
  }
  const db = await readDb();
  const activeStatuses: BookingStatus[] = ['Confirmed', 'Planning', 'In Progress', 'Contract Pending', 'Payment Pending'];
  const sameDateCount = db.bookings.filter(
    (b) => b.eventDate === date && b.status !== 'Cancelled',
  ).length;
  const exactVenueConflict = venue
    ? db.bookings.some(
        (b) =>
          b.eventDate === date &&
          b.venueName.toLowerCase() === venue &&
          activeStatuses.includes(b.status),
      )
    : false;

  res.json({
    date,
    available: !exactVenueConflict && sameDateCount < 3,
    capacityNote: exactVenueConflict
      ? 'This venue and date are already reserved in our production calendar.'
      : sameDateCount >= 3
        ? 'Production capacity for this date is currently full. Please select an alternate date or request director review.'
        : 'Date is currently open for consultation and preliminary hold.',
  });
});

// Bookings list (strictly isolated by server-side RBAC)
app.get('/api/bookings', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (session.role === 'guest') {
    return res.status(401).json({ error: 'Authentication required to view booking records.' });
  }
  const db = await readDb();
  const visible = db.bookings
    .filter((b) => isAuthorizedForBooking(b, session, db.vendors))
    .map((b) => sanitizeBookingForRole(b, session));
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
  const session = await resolveSession(req);

  try {
    const created = await withTransaction(async (db) => {
      // Concurrency-safe duplicate booking / capacity guard
      const duplicate = db.bookings.find(
        (b) =>
          b.status !== 'Cancelled' &&
          b.eventDate === input.eventDate &&
          b.venueName.toLowerCase() === input.venueName.toLowerCase() &&
          b.clientEmail.toLowerCase() === input.clientEmail.toLowerCase(),
      );
      if (duplicate) {
        throw new Error(`DUPLICATE:An active inquiry (${duplicate.referenceCode}) already exists for this venue and date.`);
      }

      const sameDateBookings = db.bookings.filter(
        (b) => b.eventDate === input.eventDate && b.status !== 'Cancelled',
      );
      if (sameDateBookings.length >= 3) {
        throw new Error('CAPACITY:Our production calendar for this date has reached maximum simultaneous events.');
      }

      const nextNum = 65 + db.bookings.length;
      const refCode = `CS-2026-0${nextNum}`;
      const id = `bkg-${Date.now()}`;
      const initialStatus: BookingStatus = input.requestConsultation ? 'Consultation Requested' : 'Inquiry';
      const clientId = session.role === 'client' ? session.id : 'user-client-camille';

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
        notes: input.notes,
        assignedLeadPlanner: 'Maya Jenkins',
        assignedVendorIds: [],
        quotations: [],
        contract: {
          id: `ctr-${Date.now()}`,
          bookingId: id,
          title: `Event Production Proposal Agreement — ${refCode}`,
          termsSummary: `Preliminary production framework for ${input.eventTitle} on ${input.eventDate} at ${input.venueName}. Final itemized quotation required prior to execution.`,
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
        session,
        'BOOKING_INQUIRY_CREATED',
        'Booking',
        refCode,
        `Created ${initialStatus} for ${input.eventTitle} (${input.eventDate})`,
      );
      return newBooking;
    });

    res.status(201).json({ booking: created });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to save booking inquiry.';
    if (msg.startsWith('DUPLICATE:') || msg.startsWith('CAPACITY:')) {
      return res.status(409).json({ error: msg.split(':').slice(1).join(':') });
    }
    return res.status(500).json({ error: msg });
  }
});

// Status transition endpoint with strict state machine & confirmation guard
app.patch('/api/bookings/:id/status', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['staff', 'admin'])) {
    return res.status(403).json({ error: 'Only authorized staff or directors may advance booking workflow statuses.' });
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
      booking.updatedAt = new Date().toISOString();
      appendAudit(db, session, 'BOOKING_STATUS_UPDATED', 'Booking', booking.referenceCode, `${prev} -> ${targetStatus}`);
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
  const session = await resolveSession(req);
  if (!hasRole(session, ['staff', 'admin'])) {
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
      const discountApproved = parsed.data.discountAmount === 0 || session.role === 'admin';
      const total = Math.max(0, subtotal - (discountApproved ? parsed.data.discountAmount : 0));
      const nextVersion = booking.quotations.length + 1;

      booking.quotations.push({
        version: nextVersion,
        createdAt: new Date().toISOString(),
        items: parsed.data.items.map((item, idx) => ({ ...item, id: `qi-${Date.now()}-${idx}` })),
        discountAmount: parsed.data.discountAmount,
        discountReason: parsed.data.discountReason,
        discountApproved,
        discountApprovedBy: discountApproved && parsed.data.discountAmount > 0 ? session.name : undefined,
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
      }
      booking.updatedAt = new Date().toISOString();
      appendAudit(db, session, 'QUOTATION_ISSUED', 'Booking', booking.referenceCode, `Issued Quote v${nextVersion} ($${total})`);
      return booking;
    });
    res.json({ booking: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to issue quote.';
    return res.status(404).json({ error: msg });
  }
});

// Digital Contract Signature
app.post('/api/bookings/:id/contract/sign', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (session.role === 'guest' || session.role === 'vendor') {
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
      if (!isAuthorizedForBooking(booking, session, db.vendors)) {
        throw new Error('FORBIDDEN:Record-level access denied.');
      }

      if (session.role === 'client') {
        booking.contract.clientSigned = true;
        booking.contract.clientSignedBy = parsed.data.signatureName;
        booking.contract.clientSignedAt = new Date().toISOString();
        if (booking.status === 'Quote Sent' || booking.status === 'Awaiting Approval' || booking.status === 'Contract Pending') {
          booking.status = 'Payment Pending';
        }
      } else {
        booking.contract.staffCountersigned = true;
        booking.contract.staffCountersignedBy = parsed.data.signatureName;
      }

      booking.updatedAt = new Date().toISOString();
      appendAudit(db, session, 'CONTRACT_SIGNED', 'Contract', booking.referenceCode, `Signed by ${parsed.data.signatureName}`);
      return booking;
    });
    res.json({ booking: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Signing failed.';
    if (msg.startsWith('FORBIDDEN:')) return res.status(403).json({ error: msg.slice(10) });
    return res.status(400).json({ error: msg });
  }
});

// Record payment milestone (Simulated Staging Verification — never live financial card charge)
app.post('/api/bookings/:id/payments/:paymentId/pay', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (session.role === 'guest' || session.role === 'vendor') {
    return res.status(403).json({ error: 'Not authorized to process payment milestones.' });
  }
  try {
    const updated = await withTransaction(async (db) => {
      const booking = db.bookings.find((b) => b.id === req.params.id);
      if (!booking) throw new Error('NOT_FOUND:Booking not found.');
      if (!isAuthorizedForBooking(booking, session, db.vendors)) {
        throw new Error('FORBIDDEN:Access denied.');
      }

      const milestone = booking.payments.find((p) => p.id === req.params.paymentId);
      if (!milestone) throw new Error('NOT_FOUND:Payment milestone not found.');
      milestone.status = 'Paid';
      milestone.paidAt = new Date().toISOString();
      milestone.reference = `STG-${Math.floor(10000 + Math.random() * 90000)}`;

      if (booking.status === 'Payment Pending' && booking.contract.clientSigned && booking.contract.staffCountersigned) {
        booking.status = 'Confirmed';
      }
      booking.updatedAt = new Date().toISOString();
      appendAudit(db, session, 'PAYMENT_MILESTONE_RECORDED', 'Payment', booking.referenceCode, `Recorded $${milestone.amount} (${milestone.label})`);
      return booking;
    });
    res.json({ booking: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Payment error.';
    return res.status(400).json({ error: msg });
  }
});

// Toggle planning milestone
app.patch('/api/bookings/:id/milestones/:milestoneId', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (session.role === 'guest' || session.role === 'vendor') {
    return res.status(403).json({ error: 'Unauthorized.' });
  }
  const updated = await withTransaction(async (db) => {
    const booking = db.bookings.find((b) => b.id === req.params.id);
    if (!booking || !isAuthorizedForBooking(booking, session, db.vendors)) return null;
    const ms = booking.milestones.find((m) => m.id === req.params.milestoneId);
    if (!ms) return null;
    ms.completed = !ms.completed;
    booking.updatedAt = new Date().toISOString();
    return booking;
  });
  if (!updated) return res.status(404).json({ error: 'Milestone not found.' });
  res.json({ booking: updated });
});

// Post portal message
app.post('/api/bookings/:id/messages', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (session.role === 'guest') return res.status(401).json({ error: 'Sign in required.' });
  const parsed = z.object({ text: z.string().trim().min(1).max(1000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Message cannot be empty.' });

  const updated = await withTransaction(async (db) => {
    const booking = db.bookings.find((b) => b.id === req.params.id);
    if (!booking || !isAuthorizedForBooking(booking, session, db.vendors)) return null;
    booking.messages.push({
      id: `msg-${Date.now()}`,
      sender: session.name,
      role: session.role,
      text: parsed.data.text,
      createdAt: new Date().toISOString(),
    });
    booking.updatedAt = new Date().toISOString();
    return booking;
  });
  if (!updated) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ booking: updated });
});

// Concept Studio endpoints
app.get('/api/concepts', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  const db = await readDb();
  const visible =
    session.role === 'admin' || session.role === 'staff'
      ? db.concepts
      : session.role === 'client'
        ? db.concepts.filter((c) => c.clientId === session.id)
        : [];
  res.json({ concepts: visible });
});

app.post('/api/concepts/:id/approve', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['client', 'staff', 'admin'])) {
    return res.status(403).json({ error: 'Unauthorized to approve design concepts.' });
  }
  const updated = await withTransaction(async (db) => {
    const concept = db.concepts.find((c) => c.id === req.params.id);
    if (!concept) return null;
    if (session.role === 'client' && concept.clientId !== session.id) return 'FORBIDDEN' as const;

    if (session.role === 'client') {
      concept.clientApproved = true;
      concept.clientApprovedAt = new Date().toISOString();
    } else {
      concept.staffApproved = true;
      concept.staffApprovedBy = session.name;
      concept.staffApprovedAt = new Date().toISOString();
    }
    appendAudit(db, session, 'CONCEPT_APPROVED', 'DesignConcept', concept.id, `${session.role} approval recorded`);
    return concept;
  });
  if (updated === 'FORBIDDEN') return res.status(403).json({ error: 'Record-level access denied.' });
  if (!updated) return res.status(404).json({ error: 'Concept not found.' });
  res.json({ concept: updated });
});

// AI Event Concierge (Server-side Gemini API)
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
    return res.status(502).json({ error: msg });
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

  const session = await resolveSession(req);

  try {
    const proposal = await generateConceptProposal(parsed.data);

    const savedConcept = await withTransaction(async (db) => {
      const existing = parsed.data.conceptId
        ? db.concepts.find((c) => c.id === parsed.data.conceptId)
        : undefined;

      if (existing) {
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
        clientId: session.role === 'client' ? session.id : 'user-client-camille',
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
    return res.status(502).json({ error: msg });
  }
});

// Vendors & Staff Operations
app.get('/api/vendors', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['vendor', 'staff', 'admin'])) {
    return res.status(403).json({ error: 'Vendor or operations clearance required.' });
  }
  const db = await readDb();
  const vendors =
    session.role === 'vendor'
      ? db.vendors.filter((v) => v.email.toLowerCase() === session.email.toLowerCase() || v.contactName === session.name)
      : db.vendors;
  res.json({ vendors });
});

app.patch('/api/vendors/:id/deliverables/:delivId', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['vendor', 'staff', 'admin'])) {
    return res.status(403).json({ error: 'Unauthorized.' });
  }
  const parsed = z.object({ status: z.enum(['Pending', 'In Progress', 'Completed']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid deliverable status.' });

  const updated = await withTransaction(async (db) => {
    const vendor = db.vendors.find((v) => v.id === req.params.id);
    if (!vendor) return null;
    if (session.role === 'vendor' && vendor.email.toLowerCase() !== session.email.toLowerCase()) {
      return 'FORBIDDEN' as const;
    }
    const deliv = vendor.deliverables.find((d) => d.id === req.params.delivId);
    if (!deliv) return null;
    deliv.status = parsed.data.status;
    appendAudit(db, session, 'VENDOR_DELIVERABLE_UPDATED', 'Vendor', vendor.id, `${deliv.task} -> ${deliv.status}`);
    return vendor;
  });
  if (updated === 'FORBIDDEN') return res.status(403).json({ error: 'Access denied.' });
  if (!updated) return res.status(404).json({ error: 'Deliverable not found.' });
  res.json({ vendor: updated });
});

app.get('/api/staff/checklists', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['staff', 'admin'])) {
    return res.status(403).json({ error: 'Staff clearance required.' });
  }
  const db = await readDb();
  res.json({ checklists: db.staffChecklists });
});

app.patch('/api/staff/checklists/:id/tasks/:taskId', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['staff', 'admin'])) return res.status(403).json({ error: 'Staff clearance required.' });
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
  const session = await resolveSession(req);
  if (!hasRole(session, ['staff', 'admin'])) return res.status(403).json({ error: 'Staff clearance required.' });
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
    appendAudit(db, session, 'EVENT_DAY_ISSUE_REPORTED', 'StaffChecklist', chk.id, `[${parsed.data.severity}] ${parsed.data.summary}`);
    return chk;
  });
  if (!updated) return res.status(404).json({ error: 'Checklist not found.' });
  res.json({ checklist: updated });
});

// Inventory
app.get('/api/inventory', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['staff', 'admin'])) {
    return res.status(403).json({ error: 'Operations clearance required.' });
  }
  const db = await readDb();
  res.json({ inventory: db.inventory });
});

app.patch('/api/inventory/:id', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['staff', 'admin'])) return res.status(403).json({ error: 'Unauthorized.' });
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

// Executive Admin Dashboard Overview
app.get('/api/admin/overview', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['admin'])) {
    return res.status(403).json({ error: 'Executive director clearance required.' });
  }
  const db = await readDb();
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
    users: db.users,
  });
});

app.patch('/api/admin/automation/:id', async (req: Request, res: Response) => {
  const session = await resolveSession(req);
  if (!hasRole(session, ['admin'])) return res.status(403).json({ error: 'Executive clearance required.' });
  const parsed = z.object({ authorizedEnabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid toggle payload.' });

  const updated = await withTransaction(async (db) => {
    const wf = db.automationWorkflows.find((w) => w.id === req.params.id);
    if (!wf) return null;
    wf.authorizedEnabled = parsed.data.authorizedEnabled;
    appendAudit(
      db,
      session,
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
  const session = await resolveSession(req);
  if (!hasRole(session, ['admin'])) return res.status(403).json({ error: 'Executive clearance required.' });

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

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Celebration Sisters Event Decor server running on http://localhost:${PORT}`);
  });
}

startServer();
