import crypto from 'node:crypto';
import type { NotificationDeliveryRecord, OutboxNotificationJob } from '../src/types/domain.ts';
import {
  getEmailRuntimeConfig,
  isReservedPlaceholderEmail,
  type FetchLike,
  type SendNotificationInput,
} from './notifications.ts';
import { logStructured, observability } from './observability.ts';
import type { DatabaseSchema } from './store.ts';
import { appendAudit, withTransaction } from './store.ts';

export interface OutboxEnqueueResult {
  job: OutboxNotificationJob;
  deduplicated: boolean;
}

export interface OutboxWorkerOptions {
  workerId?: string;
  fetchImpl?: FetchLike;
  apiKey?: string;
  fromAddress?: string;
  liveDeliveryEnabled?: boolean;
  providerTimeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  claimLeaseMs?: number;
  batchSize?: number;
  jitterFn?: () => number;
  nowFn?: () => number;
}

export interface OutboxProcessSummary {
  workerId: string;
  claimed: number;
  accepted: number;
  retried: number;
  deadLettered: number;
  skipped: number;
}

/**
 * Exponential backoff with bounded jitter (0.75x - 1.25x) to prevent thundering herds
 * across multiple Railway workers retrying after Resend 429 or transient 5xx outages.
 */
export function computeBackoffDelayMs(
  attempt: number,
  baseMs = 5_000,
  maxMs = 300_000,
  jitterFn: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, attempt);
  const raw = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  const jitterFactor = 0.75 + Math.max(0, Math.min(1, jitterFn())) * 0.5;
  return Math.max(1, Math.round(raw * jitterFactor));
}

function mapOutboxStatusToDeliveryStatus(
  status: OutboxNotificationJob['status'],
): NotificationDeliveryRecord['status'] {
  switch (status) {
    case 'ProviderAccepted':
      return 'ProviderAccepted';
    case 'Delivered':
      return 'Delivered';
    case 'DeadLetter':
      return 'Failed';
    case 'Skipped (Unconfigured)':
      return 'Skipped (Unconfigured)';
    case 'Skipped (Unauthorized)':
      return 'Skipped (Unauthorized)';
    default:
      return 'Queued';
  }
}

function syncDeliveryLedgerFromJob(db: DatabaseSchema, job: OutboxNotificationJob): void {
  const mappedStatus = mapOutboxStatusToDeliveryStatus(job.status);
  const existing = db.notificationDeliveries.find((d) => d.idempotencyKey === job.idempotencyKey);
  const provider: 'resend' | 'unconfigured' =
    job.status === 'Skipped (Unconfigured)' ? 'unconfigured' : 'resend';

  if (existing) {
    existing.status = mappedStatus;
    existing.attempts = job.attempts;
    existing.providerMessageId = job.providerMessageId ?? existing.providerMessageId;
    existing.lastError = job.lastError;
    existing.updatedAt = job.updatedAt;
    existing.provider = provider;
  } else {
    db.notificationDeliveries.unshift({
      id: `ntf-${job.id}`,
      idempotencyKey: job.idempotencyKey,
      category: job.category,
      channel: job.channel,
      provider,
      recipient: job.recipient,
      bookingReference: job.bookingReference,
      subject: job.subject,
      status: mappedStatus,
      providerMessageId: job.providerMessageId,
      attempts: job.attempts,
      lastError: job.lastError,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
    if (db.notificationDeliveries.length > 500) {
      db.notificationDeliveries = db.notificationDeliveries.slice(0, 500);
    }
  }
}

/**
 * Enqueues a durable notification job INSIDE the caller's database transaction
 * so notification intent commits atomically alongside booking creation or workflow changes.
 * Strictly deduplicates by idempotencyKey to prevent duplicate client/staff emails.
 */
export function enqueueOutboxNotification(
  db: DatabaseSchema,
  input: SendNotificationInput,
  options?: { maxAttempts?: number; nowMs?: number },
): OutboxEnqueueResult {
  const existing = db.notificationOutbox.find((j) => j.idempotencyKey === input.idempotencyKey);
  if (existing) {
    return { job: existing, deduplicated: true };
  }

  const nowIso = new Date(options?.nowMs ?? Date.now()).toISOString();
  const job: OutboxNotificationJob = {
    id: `obx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    idempotencyKey: input.idempotencyKey,
    category: input.category,
    channel: 'Email',
    recipient: input.recipient,
    bookingReference: input.bookingReference,
    subject: input.subject,
    htmlBody: input.htmlBody,
    textBody: input.textBody,
    status: 'Pending',
    attempts: 0,
    maxAttempts: Math.max(1, Math.min(options?.maxAttempts ?? 5, 10)),
    nextAttemptAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  db.notificationOutbox.unshift(job);
  if (db.notificationOutbox.length > 1000) {
    db.notificationOutbox = db.notificationOutbox.slice(0, 1000);
  }
  syncDeliveryLedgerFromJob(db, job);
  observability.recordNotificationEnqueued(1);
  return { job, deduplicated: false };
}

function applyProviderDeliveryEventInTx(
  db: DatabaseSchema,
  providerMessageId: string | undefined,
  eventStatus: 'Delivered' | 'Bounced',
  details?: string,
): { updated: boolean; job?: OutboxNotificationJob } {
  if (!providerMessageId || !providerMessageId.trim()) {
    return { updated: false };
  }
  const job = db.notificationOutbox.find((j) => j.providerMessageId === providerMessageId);
  if (!job) return { updated: false };

  // Out-of-order and duplicate terminal-state safety:
  // - Never downgrade or re-mutate an already Delivered record on duplicate Delivered events
  // - Never re-mutate an already DeadLetter record on duplicate Bounced events
  // - Never downgrade an already Delivered job if a stale non-bounce/non-complaint event arrives
  if (job.status === 'Delivered' && eventStatus === 'Delivered') {
    return { updated: false, job };
  }
  if (job.status === 'DeadLetter' && eventStatus === 'Bounced') {
    return { updated: false, job };
  }

  job.status = eventStatus === 'Delivered' ? 'Delivered' : 'DeadLetter';
  job.lastError = eventStatus === 'Bounced' ? details || 'Recipient bounced at email provider.' : undefined;
  job.updatedAt = new Date().toISOString();
  syncDeliveryLedgerFromJob(db, job);
  observability.recordNotificationOutcome(eventStatus === 'Delivered' ? 'delivered' : 'dead_letter');
  return { updated: true, job: { ...job } };
}

/**
 * Records downstream provider delivery confirmation (e.g., from a verified Resend webhook)
 * idempotently without ever fabricating delivery on HTTP 2xx submission alone.
 */
export async function recordProviderDeliveryConfirmation(
  providerMessageId: string,
  eventStatus: 'Delivered' | 'Bounced',
  details?: string,
): Promise<{ updated: boolean; job?: OutboxNotificationJob }> {
  return withTransaction((db) =>
    applyProviderDeliveryEventInTx(db, providerMessageId, eventStatus, details),
  );
}

/**
 * Atomically deduplicates a verified Resend webhook event by `svix-id`, persists the
 * immutable webhook audit entry, and reconciles the matching outbox job inside ONE
 * serialized transaction so concurrent webhook replays can never double-process or
 * mutate unrelated outbox records.
 */
export async function reconcileResendWebhookAtomic(params: {
  svixId: string;
  eventType: string;
  providerMessageId?: string;
  payloadSha256: string;
  bounceDetails?: string;
  nowIso?: string;
}): Promise<{ deduplicated: boolean; reconciled: boolean; job?: OutboxNotificationJob }> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  return withTransaction((db) => {
    const existing = db.notificationWebhookEvents.find((e) => e.svixId === params.svixId);
    if (existing) {
      return { deduplicated: true, reconciled: false };
    }

    const isDeliveryTerminalEvent =
      params.eventType === 'email.delivered' ||
      params.eventType === 'email.bounced' ||
      params.eventType === 'email.complained' ||
      params.eventType === 'email.failed';
    const isDeliveryDelayedEvent = params.eventType === 'email.delivery_delayed';

    let reconciled = false;
    let job: OutboxNotificationJob | undefined;

    if (params.providerMessageId && params.eventType === 'email.delivered') {
      const result = applyProviderDeliveryEventInTx(db, params.providerMessageId, 'Delivered');
      reconciled = result.updated;
      job = result.job;
    } else if (
      params.providerMessageId &&
      (params.eventType === 'email.bounced' ||
        params.eventType === 'email.complained' ||
        params.eventType === 'email.failed')
    ) {
      const details = params.bounceDetails || `Resend event: ${params.eventType}`;
      const result = applyProviderDeliveryEventInTx(db, params.providerMessageId, 'Bounced', details);
      reconciled = result.updated;
      job = result.job;
    } else if (params.providerMessageId && isDeliveryDelayedEvent) {
      const target = db.notificationOutbox.find((j) => j.providerMessageId === params.providerMessageId);
      if (target && target.status !== 'Delivered' && target.status !== 'DeadLetter') {
        target.lastError = params.bounceDetails || 'Resend reported temporary email.delivery_delayed.';
        target.updatedAt = nowIso;
        syncDeliveryLedgerFromJob(db, target);
        reconciled = true;
        job = { ...target };
        logStructured('warn', 'outbox_notification_delivery_delayed', {
          jobId: target.id,
          providerMessageId: params.providerMessageId,
          bookingReference: target.bookingReference,
        });
      }
    }

    db.notificationWebhookEvents.unshift({
      id: `whk-${crypto.randomUUID().slice(0, 10)}`,
      provider: 'resend',
      svixId: params.svixId,
      eventType: params.eventType,
      providerMessageId: params.providerMessageId,
      signatureVerified: true,
      payloadSha256: params.payloadSha256,
      status: (isDeliveryTerminalEvent || isDeliveryDelayedEvent) && reconciled ? 'processed' : 'ignored',
      receivedAt: nowIso,
    });
    if (db.notificationWebhookEvents.length > 500) {
      db.notificationWebhookEvents = db.notificationWebhookEvents.slice(0, 500);
    }

    return { deduplicated: false, reconciled, job };
  });
}

/**
 * Administrative safe requeue for DeadLetter or Skipped outbox notification jobs.
 * Never fabricates delivery; resets status to Pending and appends an immutable audit record.
 */
export async function requeueOutboxJob(
  jobId: string,
  actor: { id: string; name: string; email: string; role: 'guest' | 'client' | 'vendor' | 'event_planner' | 'staff' | 'admin' },
  reason?: string,
): Promise<{ ok: boolean; error?: string; job?: OutboxNotificationJob }> {
  return withTransaction((db) => {
    const job = db.notificationOutbox.find((j) => j.id === jobId);
    if (!job) return { ok: false, error: 'Outbox notification job not found.' };
    if (job.status === 'Delivered' || job.status === 'ProviderAccepted') {
      return { ok: false, error: `Job is already ${job.status} and cannot be requeued.` };
    }
    const nowIso = new Date().toISOString();
    job.status = 'Pending';
    job.attempts = 0;
    job.nextAttemptAt = nowIso;
    job.claimedBy = undefined;
    job.claimedAt = undefined;
    job.lastError = undefined;
    job.updatedAt = nowIso;
    syncDeliveryLedgerFromJob(db, job);
    appendAudit(
      db,
      actor,
      'NOTIFICATION_JOB_REQUEUED',
      'OutboxNotification',
      job.id,
      `Manually requeued ${job.category} (${job.bookingReference || 'general'})${reason ? ` — ${reason}` : ''}`,
    );
    return { ok: true, job: { ...job } };
  });
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`PROVIDER_TIMEOUT: Email provider exceeded ${timeoutMs}ms timeout.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transactional Outbox Notification Worker (Block 13.7).
 * - Claims due Pending/Retrying jobs (and reclaims stale Claimed jobs after worker crash lease expiry)
 *   inside an atomic transaction so concurrent workers never double-claim the same job.
 * - Dispatches to Resend HTTPS API with durable Idempotency-Key.
 * - Schedules exponential backoff + jitter on 429, 5xx, timeouts, and network errors.
 * - Routes permanent 4xx or max-attempt exhaustions to DeadLetter.
 * - Respects EMAIL_LIVE_DELIVERY_ENABLED approval gate and unconfigured-provider honesty.
 */
export class NotificationOutboxWorker {
  readonly workerId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly options: OutboxWorkerOptions;

  constructor(options: OutboxWorkerOptions = {}) {
    this.workerId = options.workerId || `outbox-worker-${crypto.randomBytes(4).toString('hex')}`;
    this.options = options;
  }

  private now(): number {
    return this.options.nowFn ? this.options.nowFn() : Date.now();
  }

  async claimBatch(): Promise<OutboxNotificationJob[]> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseMs = this.options.claimLeaseMs ?? 60_000;
    const staleThresholdIso = new Date(nowMs - leaseMs).toISOString();
    const batchSize = this.options.batchSize ?? 10;

    return withTransaction((db) => {
      const claimed: OutboxNotificationJob[] = [];
      for (const job of db.notificationOutbox) {
        if (claimed.length >= batchSize) break;
        const isDue =
          (job.status === 'Pending' || job.status === 'Retrying') &&
          job.nextAttemptAt <= nowIso;
        const isStaleClaim =
          job.status === 'Claimed' &&
          Boolean(job.claimedAt) &&
          (job.claimedAt as string) <= staleThresholdIso;

        if (isDue || isStaleClaim) {
          job.status = 'Claimed';
          job.claimedBy = this.workerId;
          job.claimedAt = nowIso;
          job.updatedAt = nowIso;
          claimed.push({ ...job });
        }
      }
      return claimed;
    });
  }

  async processOnce(): Promise<OutboxProcessSummary> {
    observability.recordWorkerHeartbeat();
    const summary: OutboxProcessSummary = {
      workerId: this.workerId,
      claimed: 0,
      accepted: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
    };

    const claimedJobs = await this.claimBatch();
    summary.claimed = claimedJobs.length;
    if (claimedJobs.length === 0) {
      return summary;
    }

    const runtimeCfg = getEmailRuntimeConfig();
    const apiKey = (this.options.apiKey ?? runtimeCfg.apiKey).trim();
    const fromAddress = (this.options.fromAddress ?? runtimeCfg.fromAddress).trim();
    const liveEnabled = this.options.liveDeliveryEnabled ?? runtimeCfg.liveDeliveryEnabled;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const providerTimeoutMs = this.options.providerTimeoutMs ?? 10_000;
    const baseBackoffMs = this.options.baseBackoffMs ?? 5_000;
    const maxBackoffMs = this.options.maxBackoffMs ?? 300_000;

    for (const job of claimedJobs) {
      const attemptNum = job.attempts + 1;
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();

      // Approval & configuration gates
      if (!apiKey || !fromAddress) {
        await this.finalizeJob(job.id, {
          status: 'Skipped (Unconfigured)',
          attempts: attemptNum,
          lastError: 'RESEND_API_KEY or EMAIL_FROM not configured.',
          updatedAt: nowIso,
        });
        summary.skipped += 1;
        continue;
      }

      if (!liveEnabled) {
        await this.finalizeJob(job.id, {
          status: 'Skipped (Unauthorized)',
          attempts: attemptNum,
          lastError: 'Outbound email paused until EMAIL_LIVE_DELIVERY_ENABLED=true is explicitly approved.',
          updatedAt: nowIso,
        });
        summary.skipped += 1;
        continue;
      }

      if (process.env.NODE_ENV === 'production' && isReservedPlaceholderEmail(job.recipient)) {
        await this.finalizeJob(job.id, {
          status: 'Skipped (Unconfigured)',
          attempts: attemptNum,
          lastError:
            'Outbound transmission blocked for RFC 2606 placeholder recipient in production. Configure STAFF_NOTIFICATION_EMAIL or a real recipient address.',
          updatedAt: nowIso,
        });
        summary.skipped += 1;
        continue;
      }

      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          'https://api.resend.com/emails',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': job.idempotencyKey,
            },
            body: JSON.stringify({
              from: fromAddress,
              to: [job.recipient],
              subject: job.subject,
              html: job.htmlBody,
              text: job.textBody,
            }),
          },
          providerTimeoutMs,
        );

        if (response.ok) {
          const body = (await response.json().catch(() => ({}))) as { id?: string };
          const providerMessageId = typeof body.id === 'string' ? body.id : undefined;
          await this.finalizeJob(job.id, {
            status: 'ProviderAccepted',
            attempts: attemptNum,
            providerMessageId,
            lastError: undefined,
            updatedAt: new Date(this.now()).toISOString(),
          });
          observability.recordNotificationOutcome('accepted');
          logStructured('info', 'outbox_notification_provider_accepted', {
            workerId: this.workerId,
            jobId: job.id,
            category: job.category,
            bookingReference: job.bookingReference,
            attempts: attemptNum,
            providerMessageId,
          });
          summary.accepted += 1;
          continue;
        }

        const errText = await response.text().catch(() => '');
        const lastError = `Resend HTTP ${response.status}${errText ? `: ${errText.slice(0, 160)}` : ''}`;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attemptNum < job.maxAttempts) {
          const delayMs = computeBackoffDelayMs(attemptNum, baseBackoffMs, maxBackoffMs, this.options.jitterFn);
          await this.finalizeJob(job.id, {
            status: 'Retrying',
            attempts: attemptNum,
            nextAttemptAt: new Date(this.now() + delayMs).toISOString(),
            lastError,
            updatedAt: new Date(this.now()).toISOString(),
          });
          observability.recordNotificationOutcome('failed');
          logStructured('warn', 'outbox_notification_retry_scheduled', {
            workerId: this.workerId,
            jobId: job.id,
            statusCode: response.status,
            attempts: attemptNum,
            delayMs,
          });
          summary.retried += 1;
        } else {
          await this.finalizeJob(job.id, {
            status: 'DeadLetter',
            attempts: attemptNum,
            lastError,
            updatedAt: new Date(this.now()).toISOString(),
          });
          observability.recordNotificationOutcome('dead_letter');
          logStructured('error', 'outbox_notification_dead_letter', {
            workerId: this.workerId,
            jobId: job.id,
            statusCode: response.status,
            attempts: attemptNum,
            retryable,
          });
          summary.deadLettered += 1;
        }
      } catch (err) {
        const lastError = err instanceof Error ? err.message : 'Network error contacting email provider.';
        if (attemptNum < job.maxAttempts) {
          const delayMs = computeBackoffDelayMs(attemptNum, baseBackoffMs, maxBackoffMs, this.options.jitterFn);
          await this.finalizeJob(job.id, {
            status: 'Retrying',
            attempts: attemptNum,
            nextAttemptAt: new Date(this.now() + delayMs).toISOString(),
            lastError,
            updatedAt: new Date(this.now()).toISOString(),
          });
          observability.recordNotificationOutcome('failed');
          logStructured('warn', 'outbox_notification_network_retry', {
            workerId: this.workerId,
            jobId: job.id,
            attempts: attemptNum,
            delayMs,
          });
          summary.retried += 1;
        } else {
          await this.finalizeJob(job.id, {
            status: 'DeadLetter',
            attempts: attemptNum,
            lastError,
            updatedAt: new Date(this.now()).toISOString(),
          });
          observability.recordNotificationOutcome('dead_letter');
          logStructured('error', 'outbox_notification_dead_letter', {
            workerId: this.workerId,
            jobId: job.id,
            attempts: attemptNum,
          });
          summary.deadLettered += 1;
        }
      }
    }

    return summary;
  }

  private async finalizeJob(
    jobId: string,
    patch: {
      status: OutboxNotificationJob['status'];
      attempts: number;
      nextAttemptAt?: string;
      providerMessageId?: string;
      lastError?: string;
      updatedAt: string;
    },
  ): Promise<void> {
    await withTransaction((db) => {
      const target = db.notificationOutbox.find((j) => j.id === jobId);
      if (!target) return;
      target.status = patch.status;
      target.attempts = patch.attempts;
      if (patch.nextAttemptAt) target.nextAttemptAt = patch.nextAttemptAt;
      if (patch.providerMessageId !== undefined) target.providerMessageId = patch.providerMessageId;
      target.lastError = patch.lastError;
      target.claimedBy = undefined;
      target.claimedAt = undefined;
      target.updatedAt = patch.updatedAt;
      syncDeliveryLedgerFromJob(db, target);

      if (patch.status === 'DeadLetter') {
        appendAudit(
          db,
          {
            id: 'system-outbox-worker',
            name: 'Notification Outbox Worker',
            email: 'system@celebrationsisters.example.com',
            role: 'admin',
          },
          'NOTIFICATION_DEAD_LETTERED',
          'OutboxNotification',
          target.id,
          `${target.category} (${target.bookingReference || 'general'}) moved to DeadLetter after ${patch.attempts} attempt(s)`,
        );
      }
    });
  }

  startPolling(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processOnce().catch((err) => {
        const message = err instanceof Error ? err.message : 'Unknown worker error';
        const code =
          typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : undefined;
        const isTlsFailure =
          code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
          code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
          code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
          message.includes('TLS_CONFIG_FAILURE');
        logStructured('error', isTlsFailure ? 'outbox_worker_pg_tls_error' : 'outbox_worker_poll_error', {
          workerId: this.workerId,
          code,
          error: isTlsFailure
            ? 'PostgreSQL TLS certificate chain verification failed; configure DATABASE_CA_CERT, DATABASE_CA_CERT_BASE64, or PGSSLROOTCERT.'
            : message,
        });
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): { workerId: string; pollingActive: boolean; pollingDisabled: boolean } {
    return {
      workerId: this.workerId,
      pollingActive: Boolean(this.timer),
      pollingDisabled: process.env.DISABLE_OUTBOX_POLLING === 'true',
    };
  }
}
