import crypto from 'node:crypto';
import type { NotificationDeliveryRecord } from '../src/types/domain.ts';

export type NotificationCategory =
  | 'consultation_confirmation'
  | 'staff_new_booking_alert'
  | 'booking_status_update'
  | 'admin_security_alert';

export interface EmailProviderStatus {
  provider: 'resend' | 'unconfigured';
  configured: boolean;
  fromAddressConfigured: boolean;
  staffRecipientConfigured: boolean;
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

export function getEmailProviderStatus(): EmailProviderStatus {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const fromAddress = (process.env.EMAIL_FROM || '').trim();
  const staffRecipient = (process.env.STAFF_NOTIFICATION_EMAIL || '').trim();
  const liveEnabled = process.env.EMAIL_LIVE_DELIVERY_ENABLED === 'true';

  if (apiKey && fromAddress) {
    return {
      provider: 'resend',
      configured: true,
      fromAddressConfigured: true,
      staffRecipientConfigured: Boolean(staffRecipient),
      liveDeliveryEnabled: liveEnabled,
      reason: liveEnabled
        ? 'Resend API key and verified sender configured; provider acceptance tracked (delivery requires webhook confirmation).'
        : 'Resend API key configured, but EMAIL_LIVE_DELIVERY_ENABLED is not true; outbound sends remain safely paused.',
    };
  }

  return {
    provider: 'unconfigured',
    configured: false,
    fromAddressConfigured: Boolean(fromAddress),
    staffRecipientConfigured: Boolean(staffRecipient),
    liveDeliveryEnabled: false,
    reason: 'RESEND_API_KEY and EMAIL_FROM are not configured; notifications are audited without claiming email delivery.',
  };
}

export function buildConsultationConfirmationTemplate(params: {
  clientName: string;
  referenceCode: string;
  eventTitle: string;
  eventDate: string;
  venueName: string;
  location: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `Celebration Sisters Consultation Request Received — ${params.referenceCode}`;
  const safeName = escapeHtml(params.clientName);
  const safeRef = escapeHtml(params.referenceCode);
  const safeTitle = escapeHtml(params.eventTitle);
  const safeDate = escapeHtml(params.eventDate);
  const safeVenue = escapeHtml(params.venueName);
  const safeLocation = escapeHtml(params.location);

  const htmlBody = `
    <div style="font-family:Georgia,serif;color:#292929;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e6dfd5;">
      <h1 style="color:#4B2087;font-size:22px;margin:0 0 12px;">Celebration Sisters Event Decor</h1>
      <p style="font-family:sans-serif;font-size:14px;line-height:1.6;">Dear ${safeName},</p>
      <p style="font-family:sans-serif;font-size:14px;line-height:1.6;">
        We have received your consultation inquiry for <strong>${safeTitle}</strong>.
      </p>
      <table style="font-family:sans-serif;font-size:13px;width:100%;border-collapse:collapse;margin:16px 0;background:#FAF8F4;">
        <tr><td style="padding:8px 12px;color:#666;">Reference Code</td><td style="padding:8px 12px;font-weight:bold;color:#4B2087;">${safeRef}</td></tr>
        <tr><td style="padding:8px 12px;color:#666;">Target Date</td><td style="padding:8px 12px;">${safeDate}</td></tr>
        <tr><td style="padding:8px 12px;color:#666;">Venue &amp; Location</td><td style="padding:8px 12px;">${safeVenue} (${safeLocation})</td></tr>
      </table>
      <p style="font-family:sans-serif;font-size:13px;color:#555;line-height:1.6;">
        A lead planner from our Columbia, South Carolina studio will confirm date capacity and coordinate your private consultation.
      </p>
    </div>
  `.trim();

  const textBody = [
    'Celebration Sisters Event Decor — Consultation Request Received',
    `Dear ${params.clientName},`,
    `Reference Code: ${params.referenceCode}`,
    `Event: ${params.eventTitle}`,
    `Target Date: ${params.eventDate}`,
    `Venue: ${params.venueName} (${params.location})`,
    'A Columbia, SC lead planner will verify date capacity and reach out to confirm your consultation time.',
  ].join('\n');

  return { subject, htmlBody, textBody };
}

export function buildStaffAlertTemplate(params: {
  referenceCode: string;
  clientName: string;
  eventTitle: string;
  eventDate: string;
  venueName: string;
  budgetRange: string;
}): { subject: string; htmlBody: string; textBody: string } {
  const subject = `[Studio Alert] New Consultation ${params.referenceCode} — ${params.eventDate}`;
  const htmlBody = `
    <div style="font-family:sans-serif;color:#292929;max-width:600px;padding:20px;border:1px solid #e6dfd5;">
      <h2 style="color:#4B2087;margin:0 0 10px;">New Consultation Request Logged</h2>
      <p><strong>Reference:</strong> ${escapeHtml(params.referenceCode)}</p>
      <p><strong>Client:</strong> ${escapeHtml(params.clientName)}</p>
      <p><strong>Celebration:</strong> ${escapeHtml(params.eventTitle)}</p>
      <p><strong>Date &amp; Venue:</strong> ${escapeHtml(params.eventDate)} at ${escapeHtml(params.venueName)}</p>
      <p><strong>Estimated Budget:</strong> ${escapeHtml(params.budgetRange)}</p>
    </div>
  `.trim();

  const textBody = `New Consultation ${params.referenceCode}\nClient: ${params.clientName}\nEvent: ${params.eventTitle}\nDate: ${params.eventDate}\nVenue: ${params.venueName}\nBudget: ${params.budgetRange}`;
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
  const htmlBody = `
    <div style="font-family:sans-serif;color:#292929;max-width:600px;padding:20px;border:1px solid #e6dfd5;">
      <h2 style="color:#4B2087;margin:0 0 10px;">Booking Status Updated</h2>
      <p>Dear ${escapeHtml(params.clientName)},</p>
      <p>Your booking <strong>${escapeHtml(params.eventTitle)}</strong> (${escapeHtml(params.referenceCode)}) has transitioned from <em>${escapeHtml(params.previousStatus)}</em> to <strong>${escapeHtml(params.newStatus)}</strong>.</p>
    </div>
  `.trim();

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
  const apiKey = (options?.apiKey ?? process.env.RESEND_API_KEY ?? '').trim();
  const fromAddress = (options?.fromAddress ?? process.env.EMAIL_FROM ?? '').trim();
  const liveEnabled = options?.liveDeliveryEnabled ?? process.env.EMAIL_LIVE_DELIVERY_ENABLED === 'true';

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
