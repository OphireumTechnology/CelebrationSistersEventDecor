import crypto from 'node:crypto';
import type { PgClientLike, PgPoolLike } from './postgresRepository.ts';
import { observability } from '../observability.ts';
import type { UserRole } from '../../src/types/domain.ts';

/**
 * Normalized PostgreSQL Persistence Layer (Block 13.5).
 * Provides granular, transaction-safe relational CRUD over migrations 001-006
 * without disturbing existing app_state_snapshots data during phased rollout.
 */

export interface NormalizedActorContext {
  userId: string;
  role: UserRole;
  clientId?: string;
}

export interface CreateNormalizedBookingInput {
  idempotencyKey?: string;
  clientId: string;
  eventTitle: string;
  eventType: string;
  packageTier: string;
  eventDate: string;
  location: string;
  venueName: string;
  guestCount: number;
  budgetRange: string;
  notes: string;
  legacyStatus: string;
  architecturalStage: string;
  outboxJobs?: {
    idempotencyKey: string;
    category: string;
    recipient: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }[];
}

export interface NormalizedBookingRow {
  id: string;
  reference_code: string;
  client_id: string;
  event_title: string;
  event_type: string;
  package_tier: string;
  event_date: string;
  location: string;
  venue_name: string;
  guest_count: number;
  budget_range: string;
  legacy_status: string;
  architectural_stage: string;
  notes: string;
}

export interface CreateNormalizedQuoteInput {
  bookingId: string;
  items: {
    description: string;
    divisionTitle: string;
    quantity: number;
    unitPriceCents: number;
  }[];
  discountCents: number;
  discountReason?: string;
  discountApproved: boolean;
  discountApprovedBy?: string;
  notes: string;
}

export interface ClaimedOutboxRow {
  id: string;
  idempotency_key: string;
  category: string;
  recipient: string;
  booking_reference: string | null;
  subject: string;
  html_body: string;
  text_body: string;
  status: string;
  attempts: number;
  max_attempts: number;
}

export interface CreateNormalizedConsultationInput {
  idempotencyKey?: string;
  bookingId: string;
  clientId: string;
  referenceCode: string;
  assignedPlannerId: string;
  method: 'in_person_columbia' | 'video' | 'phone';
  startUtc: string;
  endUtc: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  clientTimezone: string;
  preferredContactMethod: 'email' | 'phone' | 'sms';
  privacyConsentAt: string;
  privacyConsentVersion: string;
  accessTokenHash: string;
  plannerNotes: string;
  outboxJobs?: {
    idempotencyKey: string;
    category: string;
    recipient: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }[];
}

export interface NormalizedConsultationRow {
  id: string;
  reference_code: string;
  booking_id: string;
  client_id: string;
  assigned_planner_id: string | null;
  status: string;
  meeting_channel: string;
  consultation_start_utc: string;
  consultation_end_utc: string;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  client_timezone: string;
  crm_stage: string;
}

export interface NormalizedPersistenceRepository {
  createBookingAtomic(input: CreateNormalizedBookingInput): Promise<{ booking: NormalizedBookingRow; deduplicated: boolean }>;
  listBookingsForActor(actor: NormalizedActorContext): Promise<NormalizedBookingRow[]>;
  createQuotationAtomic(input: CreateNormalizedQuoteInput): Promise<{ quotationId: string; versionNumber: number; subtotalCents: number; totalCents: number }>;
  claimDueOutboxJobs(workerId: string, batchSize?: number, leaseSeconds?: number): Promise<ClaimedOutboxRow[]>;
  createConsultationAtomic(
    input: CreateNormalizedConsultationInput,
  ): Promise<{ consultation: NormalizedConsultationRow; deduplicated: boolean }>;
  listConsultationsForActor(actor: NormalizedActorContext): Promise<NormalizedConsultationRow[]>;
}

/**
 * Sets transaction-scoped PostgreSQL RLS session variables (`SET LOCAL`) so even when
 * connecting through an application role, RLS helper functions evaluate the verified actor context.
 */
export async function applyTransactionActorContext(
  client: PgClientLike,
  actor: NormalizedActorContext,
): Promise<void> {
  await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [actor.userId]);
  await client.query(`SELECT set_config('app.current_role', $1, true)`, [actor.role]);
}

export class PostgresNormalizedRepository implements NormalizedPersistenceRepository {
  constructor(private readonly pool: PgPoolLike) {}

  private async runTx<T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      observability.recordDbQuery(Date.now() - startedAt, false);
      return result;
    } catch (err) {
      observability.recordDbQuery(Date.now() - startedAt, true);
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve original error
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async createBookingAtomic(
    input: CreateNormalizedBookingInput,
  ): Promise<{ booking: NormalizedBookingRow; deduplicated: boolean }> {
    return this.runTx(async (client) => {
      if (input.idempotencyKey) {
        const existingKey = await client.query<{ booking_id: string }>(
          'SELECT booking_id FROM booking_idempotency_keys WHERE idempotency_key = $1',
          [input.idempotencyKey],
        );
        if (existingKey.rows[0]?.booking_id) {
          const existingBooking = await client.query<NormalizedBookingRow>(
            'SELECT * FROM bookings WHERE id = $1',
            [existingKey.rows[0].booking_id],
          );
          if (existingBooking.rows[0]) {
            return { booking: existingBooking.rows[0], deduplicated: true };
          }
        }
      }

      // Lock date-scoped active bookings to enforce capacity & venue uniqueness transactionally
      const activeSameDate = await client.query<{ id: string; venue_name_normalized: string }>(
        `SELECT id, LOWER(TRIM(venue_name)) AS venue_name_normalized
         FROM bookings
         WHERE event_date = $1
           AND architectural_stage NOT IN ('CANCELLED', 'EXPIRED', 'DECLINED')
         FOR UPDATE`,
        [input.eventDate],
      );

      const normalizedVenue = input.venueName.trim().toLowerCase();
      if (activeSameDate.rows.some((r) => r.venue_name_normalized === normalizedVenue)) {
        throw new Error(`DUPLICATE:An active booking already exists for ${input.venueName} on ${input.eventDate}.`);
      }
      if (activeSameDate.rows.length >= 3) {
        throw new Error('CAPACITY:Our production calendar for this date has reached maximum simultaneous events.');
      }

      const year = input.eventDate.slice(0, 4) || String(new Date().getUTCFullYear());
      const suffix = crypto.randomInt(1000, 9999);
      const referenceCode = `CS-${year}-${suffix}`;

      const inserted = await client.query<NormalizedBookingRow>(
        `INSERT INTO bookings (
           reference_code, client_id, event_title, event_type, package_tier,
           event_date, location, venue_name, guest_count, budget_range,
           legacy_status, architectural_stage, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          referenceCode,
          input.clientId,
          input.eventTitle,
          input.eventType,
          input.packageTier,
          input.eventDate,
          input.location,
          input.venueName,
          input.guestCount,
          input.budgetRange,
          input.legacyStatus,
          input.architecturalStage,
          input.notes,
        ],
      );

      const booking = inserted.rows[0];
      if (!booking) {
        throw new Error('Failed to insert normalized booking record.');
      }

      if (input.idempotencyKey) {
        await client.query(
          `INSERT INTO booking_idempotency_keys (idempotency_key, booking_id, reference_code)
           VALUES ($1, $2, $3)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [input.idempotencyKey, booking.id, booking.reference_code],
        );
      }

      // Persist notification intent atomically in the exact same database transaction
      for (const job of input.outboxJobs || []) {
        await client.query(
          `INSERT INTO notification_outbox (
             idempotency_key, category, channel, recipient, booking_reference,
             subject, html_body, text_body, status
           ) VALUES ($1, $2, 'Email', $3, $4, $5, $6, $7, 'Pending')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            job.idempotencyKey,
            job.category,
            job.recipient,
            booking.reference_code,
            job.subject,
            job.htmlBody,
            job.textBody,
          ],
        );
      }

      return { booking, deduplicated: false };
    });
  }

  async listBookingsForActor(actor: NormalizedActorContext): Promise<NormalizedBookingRow[]> {
    return this.runTx(async (client) => {
      await applyTransactionActorContext(client, actor);

      if (actor.role === 'admin' || actor.role === 'staff' || actor.role === 'event_planner') {
        const res = await client.query<NormalizedBookingRow>(
          'SELECT * FROM bookings ORDER BY created_at DESC',
        );
        return res.rows;
      }

      if (actor.role === 'client') {
        const res = await client.query<NormalizedBookingRow>(
          `SELECT b.*
           FROM bookings b
           JOIN clients c ON c.id = b.client_id
           WHERE c.user_id = $1
           ORDER BY b.created_at DESC`,
          [actor.userId],
        );
        return res.rows;
      }

      if (actor.role === 'vendor') {
        const res = await client.query<NormalizedBookingRow>(
          `SELECT DISTINCT b.id, b.reference_code, b.event_title, b.event_type, b.package_tier,
                  b.event_date, b.location, b.venue_name, b.guest_count,
                  'Protected'::TEXT AS budget_range, b.legacy_status, b.architectural_stage,
                  ''::TEXT AS notes, b.client_id
           FROM bookings b
           JOIN vendor_assignments va ON va.booking_id = b.id
           JOIN vendors v ON v.id = va.vendor_id
           WHERE v.user_id = $1
           ORDER BY b.event_date ASC`,
          [actor.userId],
        );
        return res.rows;
      }

      return [];
    });
  }

  async createQuotationAtomic(
    input: CreateNormalizedQuoteInput,
  ): Promise<{ quotationId: string; versionNumber: number; subtotalCents: number; totalCents: number }> {
    return this.runTx(async (client) => {
      const subtotalCents = input.items.reduce(
        (sum, item) => sum + Math.round(item.quantity) * Math.round(item.unitPriceCents),
        0,
      );
      if (input.discountCents < 0 || input.discountCents > subtotalCents) {
        throw new Error('INVALID_DISCOUNT:Discount cannot exceed quotation subtotal.');
      }
      const appliedDiscount = input.discountApproved ? input.discountCents : 0;
      const totalCents = Math.max(0, subtotalCents - appliedDiscount);

      const verRes = await client.query<{ next_ver: number }>(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver
         FROM quotations
         WHERE booking_id = $1`,
        [input.bookingId],
      );
      const versionNumber = Number(verRes.rows[0]?.next_ver ?? 1);

      const qRes = await client.query<{ id: string }>(
        `INSERT INTO quotations (
           booking_id, version_number, subtotal_cents, discount_cents,
           discount_reason, discount_approved, discount_approved_by, total_cents, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          input.bookingId,
          versionNumber,
          subtotalCents,
          input.discountCents,
          input.discountReason ?? null,
          input.discountApproved,
          input.discountApprovedBy ?? null,
          totalCents,
          input.notes,
        ],
      );
      const quotationId = qRes.rows[0]?.id;
      if (!quotationId) {
        throw new Error('Failed to create normalized quotation record.');
      }

      for (const item of input.items) {
        await client.query(
          `INSERT INTO quote_items (quotation_id, description, division_title, quantity, unit_price_cents)
           VALUES ($1, $2, $3, $4, $5)`,
          [quotationId, item.description, item.divisionTitle, item.quantity, item.unitPriceCents],
        );
      }

      return { quotationId, versionNumber, subtotalCents, totalCents };
    });
  }

  async claimDueOutboxJobs(
    workerId: string,
    batchSize = 10,
    leaseSeconds = 60,
  ): Promise<ClaimedOutboxRow[]> {
    return this.runTx(async (client) => {
      const res = await client.query<ClaimedOutboxRow>(
        `WITH candidate AS (
           SELECT id
           FROM notification_outbox
           WHERE (status IN ('Pending', 'Retrying') AND next_attempt_at <= NOW())
              OR (status = 'Claimed' AND claimed_at <= NOW() - ($3 * INTERVAL '1 second'))
           ORDER BY next_attempt_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE notification_outbox o
         SET status = 'Claimed',
             claimed_by = $1,
             claimed_at = NOW(),
             updated_at = NOW()
         FROM candidate c
         WHERE o.id = c.id
         RETURNING o.id, o.idempotency_key, o.category, o.recipient, o.booking_reference,
                   o.subject, o.html_body, o.text_body, o.status, o.attempts, o.max_attempts`,
        [workerId, batchSize, leaseSeconds],
      );
      return res.rows;
    });
  }

  async createConsultationAtomic(
    input: CreateNormalizedConsultationInput,
  ): Promise<{ consultation: NormalizedConsultationRow; deduplicated: boolean }> {
    return this.runTx(async (client) => {
      if (input.idempotencyKey) {
        const existing = await client.query<NormalizedConsultationRow>(
          'SELECT * FROM consultations WHERE idempotency_key = $1',
          [input.idempotencyKey],
        );
        if (existing.rows[0]) {
          return { consultation: existing.rows[0], deduplicated: true };
        }
      }

      // Lock planner's active consultations to prevent simultaneous slot races before INSERT
      const conflicts = await client.query<{ id: string }>(
        `SELECT id
         FROM consultations
         WHERE assigned_planner_id = $1
           AND status IN ('Pending', 'Confirmed', 'Rescheduled')
           AND (
             tstzrange(
               consultation_start_utc - (buffer_before_minutes * INTERVAL '1 minute'),
               consultation_end_utc + (buffer_after_minutes * INTERVAL '1 minute'),
               '[)'
             ) && tstzrange($2::timestamptz, $3::timestamptz, '[)')
             OR tstzrange(consultation_start_utc, consultation_end_utc, '[)') && tstzrange(
               $2::timestamptz - ($4 * INTERVAL '1 minute'),
               $3::timestamptz + ($5 * INTERVAL '1 minute'),
               '[)'
             )
           )
         FOR UPDATE`,
        [
          input.assignedPlannerId,
          input.startUtc,
          input.endUtc,
          input.bufferBeforeMinutes,
          input.bufferAfterMinutes,
        ],
      );

      if (conflicts.rows.length > 0) {
        throw new Error('SLOT_CONFLICT:Selected consultation slot overlaps an existing scheduled appointment.');
      }

      const inserted = await client.query<NormalizedConsultationRow>(
        `INSERT INTO consultations (
           reference_code, booking_id, client_id, assigned_planner_id, status,
           meeting_channel, scheduled_for, consultation_start_utc, consultation_end_utc,
           buffer_before_minutes, buffer_after_minutes, client_timezone,
           preferred_contact_method, privacy_consent_at, privacy_consent_version,
           access_token_hash, idempotency_key, planner_notes, crm_stage
         ) VALUES (
           $1, $2, $3, $4, 'Pending',
           $5, $6, $6, $7,
           $8, $9, $10,
           $11, $12, $13,
           $14, $15, $16, 'Consultation Scheduled'
         )
         RETURNING *`,
        [
          input.referenceCode,
          input.bookingId,
          input.clientId,
          input.assignedPlannerId,
          input.method,
          input.startUtc,
          input.endUtc,
          input.bufferBeforeMinutes,
          input.bufferAfterMinutes,
          input.clientTimezone,
          input.preferredContactMethod,
          input.privacyConsentAt,
          input.privacyConsentVersion,
          input.accessTokenHash,
          input.idempotencyKey ?? null,
          input.plannerNotes,
        ],
      );

      const consultation = inserted.rows[0];
      if (!consultation) {
        throw new Error('Failed to insert normalized consultation record.');
      }

      for (const job of input.outboxJobs || []) {
        await client.query(
          `INSERT INTO notification_outbox (
             idempotency_key, category, channel, recipient, booking_reference,
             subject, html_body, text_body, status
           ) VALUES ($1, $2, 'Email', $3, $4, $5, $6, $7, 'Pending')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            job.idempotencyKey,
            job.category,
            job.recipient,
            input.referenceCode,
            job.subject,
            job.htmlBody,
            job.textBody,
          ],
        );
      }

      return { consultation, deduplicated: false };
    });
  }

  async listConsultationsForActor(actor: NormalizedActorContext): Promise<NormalizedConsultationRow[]> {
    return this.runTx(async (client) => {
      await applyTransactionActorContext(client, actor);

      if (actor.role === 'admin' || actor.role === 'staff' || actor.role === 'event_planner') {
        const res = await client.query<NormalizedConsultationRow>(
          'SELECT * FROM consultations ORDER BY consultation_start_utc ASC NULLS LAST, created_at DESC',
        );
        return res.rows;
      }

      if (actor.role === 'client') {
        const res = await client.query<NormalizedConsultationRow>(
          `SELECT con.*
           FROM consultations con
           JOIN clients c ON c.id = con.client_id
           WHERE c.user_id = $1
           ORDER BY con.consultation_start_utc DESC NULLS LAST`,
          [actor.userId],
        );
        return res.rows;
      }

      return [];
    });
  }
}
