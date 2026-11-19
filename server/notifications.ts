import crypto from 'node:crypto';
import type { NotificationCategory, NotificationDeliveryRecord } from '../src/types/domain.ts';

export type { NotificationCategory };

export interface EmailRuntimeConfig {
  apiKey: string;
  fromAddress: string;
  staffNotificationEmail: string;
  liveDeliveryEnabled: boolean;
  webhookSecret: string;
}

/**
 * Single authoritative email & Resend environment variable contract across API routes,
 * outbox workers, health diagnostics, and webhook verification:
 *   - RESEND_API_KEY
 *   - EMAIL_FROM
 *   - EMAIL_LIVE_DELIVERY_ENABLED ('true' to enable outbound sends)
 *   - RESEND_WEBHOOK_SECRET
 *   - STAFF_NOTIFICATION_EMAIL
 */
export const DEFAULT_STAFF_NOTIFICATION_EMAIL = 'directors@celebrationsisters.example.com';

export function getEmailRuntimeConfig(env: NodeJS.ProcessEnv = process.env): EmailRuntimeConfig {
  return {
    apiKey: (env.RESEND_API_KEY || '').trim(),
    fromAddress: (env.EMAIL_FROM || '').trim(),
    staffNotificationEmail: (env.STAFF_NOTIFICATION_EMAIL || '').trim(),
    liveDeliveryEnabled: env.EMAIL_LIVE_DELIVERY_ENABLED === 'true',
    webhookSecret: (env.RESEND_WEBHOOK_SECRET || '').trim(),
  };
}

export function getStaffNotificationRecipient(env: NodeJS.ProcessEnv = process.env): string {
  const configured = getEmailRuntimeConfig(env).staffNotificationEmail;
  return configured || DEFAULT_STAFF_NOTIFICATION_EMAIL;
}

export interface EmailProviderStatus {
  provider: 'resend' | 'unconfigured';
  configured: boolean;
  fromAddressConfigured: boolean;
  staffRecipientConfigured: boolean;
  webhookSecretConfigured: boolean;
  liveDeliveryEnabled: boolean;
  reason: string;
}

export interface SendNotificationInput {
  idempotencyKey: string;
  category: NotificationCategory;
  recipient: string;
  bookingReference?: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

export interface NotificationDispatchResult {
  record: NotificationDeliveryRecord;
  deduplicated: boolean;
}

export type FetchLike = typeof fetch;

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ResendWebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verifies Resend (Svix) webhook HMAC-SHA256 signatures with constant-time comparison
 * and replay-window enforcement (±5 minutes by default).
 */
export function verifyResendWebhookSignature(params: {
  rawBody: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  webhookSecret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): ResendWebhookVerificationResult {
  const { rawBody, svixId, svixTimestamp, svixSignature, webhookSecret } = params;
  if (!webhookSecret || !webhookSecret.trim()) {
    return { valid: false, reason: 'RESEND_WEBHOOK_SECRET is not configured.' };
  }
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { valid: false, reason: 'Missing required svix-id, svix-timestamp, or svix-signature headers.' };
  }

  const tsSec = Number(svixTimestamp);
  if (!Number.isFinite(tsSec)) {
    return { valid: false, reason: 'Invalid svix-timestamp header.' };
  }
  const nowSec = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = params.toleranceSeconds ?? 300;
  if (Math.abs(nowSec - tsSec) > tolerance) {
    return { valid: false, reason: 'Webhook timestamp outside allowed replay tolerance window.' };
  }

  const cleanSecret = webhookSecret.trim().startsWith('whsec_')
    ? webhookSecret.trim().slice('whsec_'.length)
    : webhookSecret.trim();
  const keyBytes = Buffer.from(cleanSecret, 'base64');
  if (keyBytes.length === 0) {
    return { valid: false, reason: 'Invalid webhook signing secret encoding.' };
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedBase64 = crypto.createHmac('sha256', keyBytes).update(signedContent, 'utf8').digest('base64');
  const expectedBuf = Buffer.from(expectedBase64, 'utf8');

  const candidates = svixSignature
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const [version, sigValue] = candidate.split(',');
    if (version !== 'v1' || !sigValue) continue;
    const providedBuf = Buffer.from(sigValue, 'utf8');
    if (providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'Webhook HMAC signature verification failed.' };
}

export function getEmailProviderStatus(env: NodeJS.ProcessEnv = process.env): EmailProviderStatus {
  const cfg = getEmailRuntimeConfig(env);

  if (cfg.apiKey && cfg.fromAddress) {
    return {
      provider: 'resend',
      configured: true,
      fromAddressConfigured: true,
      staffRecipientConfigured: Boolean(cfg.staffNotificationEmail),
      webhookSecretConfigured: Boolean(cfg.webhookSecret),
      liveDeliveryEnabled: cfg.liveDeliveryEnabled,
      reason: cfg.liveDeliveryEnabled
        ? 'Resend API key and verified sender configured; provider acceptance tracked (delivery requires webhook confirmation).'
        : 'Resend API key configured, but EMAIL_LIVE_DELIVERY_ENABLED is not true; outbound sends remain safely paused.',
    };
  }

  return {
    provider: 'unconfigured',
    configured: false,
    fromAddressConfigured: Boolean(cfg.fromAddress),
    staffRecipientConfigured: Boolean(cfg.staffNotificationEmail),
    webhookSecretConfigured: Boolean(cfg.webhookSecret),
    liveDeliveryEnabled: false,
    reason: 'RESEND_API_KEY and EMAIL_FROM are not configured; notifications are audited without claiming email delivery.',
  };
}

function wrapLuxuryEmailHtml(title: string, bodyHtml: string): string {
  return `
    <div style="font-family:Georgia,serif;color:#292929;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e6dfd5;background:#FFFFFF;">
      <h1 style="color:#4B2087;font-size:22px;margin:0 0 6px;">Celebration Sisters Event Decor</h1>
      <p style="font-family:sans-serif;font-size:12px;color:#9C7835;margin:0 0 18px;letter-spacing:0.04em;">${escapeHtml(title)}</p>
      <div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#292929;">
        ${bodyHtml}
      </div>
      <p style="font-family:sans-serif;font-size:12px;color:#595550;margin-top:24px;padding-top:14px;border-top:1px solid #E8E1D6;">
        Celebration Sisters Event Decor · Columbia, South Carolina · https://celebrationsistersdecor.com
      </p>
    </div>
  `.trim();
}

export function buildConsultationConfirmationTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  eventDate: string;
  venueName: string;
  location: string;
  consultationWindow?: string;
  consultationMethod?: string;
  assignedPlanner?: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Celebration Sisters Consultation Request Received — ${params.referenceCode}`;
  const rows = [
    `<tr><td style="padding:8px 12px;color:#595550;">Reference Code</td><td style="padding:8px 12px;font-weight:bold;color:#4B2087;">${escapeHtml(params.referenceCode)}</td></tr>`,
    `<tr><td style="padding:8px 12px;color:#595550;">Target Event Date</td><td style="padding:8px 12px;">${escapeHtml(params.eventDate)}</td></tr>`,
    `<tr><td style="padding:8px 12px;color:#595550;">Venue &amp; Location</td><td style="padding:8px 12px;">${escapeHtml(params.venueName)} (${escapeHtml(params.location)})</td></tr>`,
  ];
  if (params.consultationWindow) {
    rows.push(
      `<tr><td style="padding:8px 12px;color:#595550;">Consultation Schedule</td><td style="padding:8px 12px;font-weight:600;">${escapeHtml(params.consultationWindow)}</td></tr>`,
    );
  }
  if (params.consultationMethod) {
    rows.push(
      `<tr><td style="padding:8px 12px;color:#595550;">Appointment Method</td><td style="padding:8px 12px;">${escapeHtml(params.consultationMethod)}</td></tr>`,
    );
  }
  if (params.assignedPlanner) {
    rows.push(
      `<tr><td style="padding:8px 12px;color:#595550;">Lead Planner</td><td style="padding:8px 12px;">${escapeHtml(params.assignedPlanner)}</td></tr>`,
    );
  }

  const htmlBody = wrapLuxuryEmailHtml(
    'Private Consultation Request Received',
    `
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>We have received your private consultation booking for <strong>${escapeHtml(params.eventTitle)}</strong>.</p>
      <table style="font-size:13px;width:100%;border-collapse:collapse;margin:16px 0;background:#FAF8F4;">
        ${rows.join('')}
      </table>
      <p>A lead planner from our Columbia, South Carolina studio has reserved your requested time window and will follow up with your confirmation details.</p>
    `,
  );

  const textBody = [
    'Celebration Sisters Event Decor — Consultation Request Received',
    `Dear ${params.clientName},`,
    `Reference Code: ${params.referenceCode}`,
    `Event: ${params.eventTitle}`,
    `Target Event Date: ${params.eventDate}`,
    `Venue: ${params.venueName} (${params.location})`,
    params.consultationWindow ? `Consultation Schedule: ${params.consultationWindow}` : null,
    params.consultationMethod ? `Appointment Method: ${params.consultationMethod}` : null,
    params.assignedPlanner ? `Lead Planner: ${params.assignedPlanner}` : null,
    'A Columbia, SC lead planner will verify details and confirm your private consultation.',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, htmlBody, textBody };
}

export function buildConsultationConfirmedTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  consultationWindow: string;
  consultationMethod: string;
  assignedPlanner: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Private Consultation Confirmed — ${params.referenceCode}`;
  const htmlBody = wrapLuxuryEmailHtml(
    'Appointment Confirmed',
    `
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>Your private consultation for <strong>${escapeHtml(params.eventTitle)}</strong> (${escapeHtml(params.referenceCode)}) is now confirmed.</p>
      <table style="font-size:13px;width:100%;border-collapse:collapse;margin:16px 0;background:#FAF8F4;">
        <tr><td style="padding:8px 12px;color:#595550;">Confirmed Time</td><td style="padding:8px 12px;font-weight:bold;color:#4B2087;">${escapeHtml(params.consultationWindow)}</td></tr>
        <tr><td style="padding:8px 12px;color:#595550;">Method</td><td style="padding:8px 12px;">${escapeHtml(params.consultationMethod)}</td></tr>
        <tr><td style="padding:8px 12px;color:#595550;">Lead Planner</td><td style="padding:8px 12px;">${escapeHtml(params.assignedPlanner)}</td></tr>
      </table>
    `,
  );
  const textBody = `Consultation Confirmed (${params.referenceCode})\nEvent: ${params.eventTitle}\nTime: ${params.consultationWindow}\nMethod: ${params.consultationMethod}\nLead Planner: ${params.assignedPlanner}`;
  return { subject, htmlBody, textBody };
}

export function buildConsultationRescheduledTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  previousWindow: string;
  newWindow: string;
  consultationMethod: string;
  assignedPlanner: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Consultation Rescheduled — ${params.referenceCode}`;
  const htmlBody = wrapLuxuryEmailHtml(
    'Appointment Rescheduled',
    `
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>Your consultation for <strong>${escapeHtml(params.eventTitle)}</strong> (${escapeHtml(params.referenceCode)}) has been rescheduled.</p>
      <table style="font-size:13px;width:100%;border-collapse:collapse;margin:16px 0;background:#FAF8F4;">
        <tr><td style="padding:8px 12px;color:#595550;">Previous Time</td><td style="padding:8px 12px;text-decoration:line-through;">${escapeHtml(params.previousWindow)}</td></tr>
        <tr><td style="padding:8px 12px;color:#595550;">New Time</td><td style="padding:8px 12px;font-weight:bold;color:#4B2087;">${escapeHtml(params.newWindow)}</td></tr>
        <tr><td style="padding:8px 12px;color:#595550;">Method</td><td style="padding:8px 12px;">${escapeHtml(params.consultationMethod)}</td></tr>
        <tr><td style="padding:8px 12px;color:#595550;">Lead Planner</td><td style="padding:8px 12px;">${escapeHtml(params.assignedPlanner)}</td></tr>
      </table>
    `,
  );
  const textBody = `Consultation Rescheduled (${params.referenceCode})\nPrevious: ${params.previousWindow}\nNew: ${params.newWindow}\nMethod: ${params.consultationMethod}\nPlanner: ${params.assignedPlanner}`;
  return { subject, htmlBody, textBody };
}

export function buildConsultationCancelledTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  cancelledWindow: string;
  reason?: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Consultation Cancelled — ${params.referenceCode}`;
  const htmlBody = wrapLuxuryEmailHtml(
    'Appointment Cancelled',
    `
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>Your consultation for <strong>${escapeHtml(params.eventTitle)}</strong> (${escapeHtml(params.referenceCode)}) previously scheduled for ${escapeHtml(params.cancelledWindow)} has been cancelled and the time slot has been released.</p>
      ${params.reason ? `<p><strong>Reason:</strong> ${escapeHtml(params.reason)}</p>` : ''}
      <p>Whenever you are ready, you may reserve a new private consultation time directly through our website.</p>
    `,
  );
  const textBody = `Consultation Cancelled (${params.referenceCode})\nEvent: ${params.eventTitle}\nReleased Slot: ${params.cancelledWindow}${params.reason ? `\nReason: ${params.reason}` : ''}`;
  return { subject, htmlBody, textBody };
}

export function buildConsultationReminderTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  consultationWindow: string;
  consultationMethod: string;
  assignedPlanner: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Reminder: Upcoming Private Consultation — ${params.referenceCode}`;
  const htmlBody = wrapLuxuryEmailHtml(
    'Upcoming Consultation Reminder',
    `
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>This is a courtesy reminder of your upcoming private consultation with <strong>${escapeHtml(params.assignedPlanner)}</strong> for <strong>${escapeHtml(params.eventTitle)}</strong>.</p>
      <p><strong>Scheduled Time:</strong> ${escapeHtml(params.consultationWindow)}<br/><strong>Method:</strong> ${escapeHtml(params.consultationMethod)}</p>
    `,
  );
  const textBody = `Upcoming Consultation Reminder (${params.referenceCode})\nEvent: ${params.eventTitle}\nTime: ${params.consultationWindow}\nMethod: ${params.consultationMethod}\nPlanner: ${params.assignedPlanner}`;
  return { subject, htmlBody, textBody };
}

export function buildConsultationFollowUpTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  outcomeSummary: string;
  assignedPlanner: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Thank You for Consulting With Celebration Sisters — ${params.referenceCode}`;
  const htmlBody = wrapLuxuryEmailHtml(
    'Post-Consultation Follow-Up',
    `
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>Thank you for meeting with ${escapeHtml(params.assignedPlanner)} regarding <strong>${escapeHtml(params.eventTitle)}</strong>.</p>
      <p><strong>Consultation Summary:</strong> ${escapeHtml(params.outcomeSummary)}</p>
      <p>Our Columbia studio is preparing your tailored design direction and itemized proposal.</p>
    `,
  );
  const textBody = `Post-Consultation Follow-Up (${params.referenceCode})\nEvent: ${params.eventTitle}\nPlanner: ${params.assignedPlanner}\nSummary: ${params.outcomeSummary}`;
  return { subject, htmlBody, textBody };
}

export function buildProposalAvailableTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  quoteVersion: number;
  totalAmountFormatted: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Your Tailored Event Proposal (v${params.quoteVersion}) Is Ready — ${params.referenceCode}`;
  const htmlBody = wrapLuxuryEmailHtml(
    'Proposal & Quotation Available',
    `
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>Your itemized proposal (Version ${params.quoteVersion}) for <strong>${escapeHtml(params.eventTitle)}</strong> (${escapeHtml(params.referenceCode)}) is now ready for review in your private client portal.</p>
      <p><strong>Total Proposal Investment:</strong> ${escapeHtml(params.totalAmountFormatted)}</p>
    `,
  );
  const textBody = `Proposal Ready (${params.referenceCode}) — Version ${params.quoteVersion}\nEvent: ${params.eventTitle}\nTotal: ${params.totalAmountFormatted}`;
  return { subject, htmlBody, textBody };
}

export function buildStaffAlertTemplate(params: {
  referenceCode: string;
  clientName: string;
  eventTitle: string;
  eventDate: string;
  venueName: string;
  budgetRange: string;
  consultationWindow?: string;
  assignedPlanner?: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `[Studio Alert] New Consultation ${params.referenceCode} — ${params.eventDate}`;
  const htmlBody = wrapLuxuryEmailHtml(
    'Internal Studio Alert · New Consultation',
    `
      <p><strong>Reference:</strong> ${escapeHtml(params.referenceCode)}</p>
      <p><strong>Client:</strong> ${escapeHtml(params.clientName)}</p>
      <p><strong>Celebration:</strong> ${escapeHtml(params.eventTitle)}</p>
      <p><strong>Event Date &amp; Venue:</strong> ${escapeHtml(params.eventDate)} at ${escapeHtml(params.venueName)}</p>
      ${params.consultationWindow ? `<p><strong>Consultation Slot:</strong> ${escapeHtml(params.consultationWindow)}</p>` : ''}
      ${params.assignedPlanner ? `<p><strong>Assigned Planner:</strong> ${escapeHtml(params.assignedPlanner)}</p>` : ''}
      <p><strong>Estimated Budget:</strong> ${escapeHtml(params.budgetRange)}</p>
    `,
  );

  const textBody = [
    `New Consultation ${params.referenceCode}`,
    `Client: ${params.clientName}`,
    `Event: ${params.eventTitle}`,
    `Event Date: ${params.eventDate}`,
    `Venue: ${params.venueName}`,
    params.consultationWindow ? `Consultation Slot: ${params.consultationWindow}` : null,
    params.assignedPlanner ? `Assigned Planner: ${params.assignedPlanner}` : null,
    `Budget: ${params.budgetRange}`,
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, htmlBody, textBody };
}

export function buildInternalOperationsAlertTemplate(params: {
  heading: string;
  referenceCode: string;
  clientName: string;
  eventTitle: string;
  details: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `[Studio Ops] ${params.heading} — ${params.referenceCode}`;
  const htmlBody = wrapLuxuryEmailHtml(
    `Internal Operations · ${params.heading}`,
    `
      <p><strong>Reference:</strong> ${escapeHtml(params.referenceCode)}</p>
      <p><strong>Client:</strong> ${escapeHtml(params.clientName)}</p>
      <p><strong>Event:</strong> ${escapeHtml(params.eventTitle)}</p>
      <p><strong>Action Details:</strong> ${escapeHtml(params.details)}</p>
    `,
  );
  const textBody = `[Studio Ops] ${params.heading} (${params.referenceCode})\nClient: ${params.clientName}\nEvent: ${params.eventTitle}\nDetails: ${params.details}`;
  return { subject, htmlBody, textBody };
}

export function buildStatusUpdateTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  previousStatus: string;
  newStatus: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Celebration Sisters Update (${params.referenceCode}): ${params.newStatus}`;
  const htmlBody = wrapLuxuryEmailHtml(
    'Booking Status Updated',
    `
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>Your booking <strong>${escapeHtml(params.eventTitle)}</strong> (${escapeHtml(params.referenceCode)}) has transitioned from <em>${escapeHtml(params.previousStatus)}</em> to <strong>${escapeHtml(params.newStatus)}</strong>.</p>
    `,
  );

  const textBody = `Booking ${params.referenceCode} (${params.eventTitle}) status updated: ${params.previousStatus} -> ${params.newStatus}.`;
  return { subject, htmlBody, textBody };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispatches an email notification via Resend with idempotency suppression and bounded retries.
 * IMPORTANT: A 2xx response from Resend is recorded as 'ProviderAccepted' (never fabricated as final inbox 'Delivered').
 */
export async function dispatchEmailNotification(
  input: SendNotificationInput,
  existingDeliveries: NotificationDeliveryRecord[],
  options?: {
    fetchImpl?: FetchLike;
    maxAttempts?: number;
    baseBackoffMs?: number;
    apiKey?: string;
    fromAddress?: string;
    liveDeliveryEnabled?: boolean;
  },
): Promise<NotificationDispatchResult> {
  const duplicate = existingDeliveries.find((d) => d.idempotencyKey === input.idempotencyKey);
  if (duplicate) {
    return { record: duplicate, deduplicated: true };
  }

  const nowIso = new Date().toISOString();
  const runtimeCfg = getEmailRuntimeConfig();
  const apiKey = (options?.apiKey ?? runtimeCfg.apiKey).trim();
  const fromAddress = (options?.fromAddress ?? runtimeCfg.fromAddress).trim();
  const liveEnabled = options?.liveDeliveryEnabled ?? runtimeCfg.liveDeliveryEnabled;

  const baseRecord: NotificationDeliveryRecord = {
    id: `ntf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    idempotencyKey: input.idempotencyKey,
    category: input.category,
    channel: 'Email',
    provider: apiKey ? 'resend' : 'unconfigured',
    recipient: input.recipient,
    bookingReference: input.bookingReference,
    subject: input.subject,
    status: 'Queued',
    attempts: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (!apiKey || !fromAddress) {
    baseRecord.status = 'Skipped (Unconfigured)';
    baseRecord.lastError = 'RESEND_API_KEY or EMAIL_FROM not configured.';
    baseRecord.updatedAt = new Date().toISOString();
    return { record: baseRecord, deduplicated: false };
  }

  if (!liveEnabled) {
    baseRecord.status = 'Skipped (Unauthorized)';
    baseRecord.lastError = 'Outbound email paused until EMAIL_LIVE_DELIVERY_ENABLED=true is explicitly approved.';
    baseRecord.updatedAt = new Date().toISOString();
    return { record: baseRecord, deduplicated: false };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, Math.min(options?.maxAttempts ?? 3, 5));
  const baseBackoffMs = options?.baseBackoffMs ?? 200;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    baseRecord.attempts = attempt;
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [input.recipient],
          subject: input.subject,
          html: input.htmlBody,
          text: input.textBody,
        }),
      });

      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { id?: string };
        baseRecord.status = 'ProviderAccepted';
        baseRecord.providerMessageId = typeof body.id === 'string' ? body.id : undefined;
        baseRecord.lastError = undefined;
        baseRecord.updatedAt = new Date().toISOString();
        return { record: baseRecord, deduplicated: false };
      }

      const errText = await response.text().catch(() => '');
      baseRecord.lastError = `Resend HTTP ${response.status}${errText ? `: ${errText.slice(0, 160)}` : ''}`;

      // Retry only on transient rate-limit or 5xx upstream errors
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        baseRecord.status = 'Failed';
        baseRecord.updatedAt = new Date().toISOString();
        return { record: baseRecord, deduplicated: false };
      }
    } catch (err) {
      baseRecord.lastError = err instanceof Error ? err.message : 'Network error contacting email provider.';
      if (attempt === maxAttempts) {
        baseRecord.status = 'Failed';
        baseRecord.updatedAt = new Date().toISOString();
        return { record: baseRecord, deduplicated: false };
      }
    }

    await sleep(baseBackoffMs * 2 ** (attempt - 1));
  }

  baseRecord.status = 'Failed';
  baseRecord.updatedAt = new Date().toISOString();
  return { record: baseRecord, deduplicated: false };
}
