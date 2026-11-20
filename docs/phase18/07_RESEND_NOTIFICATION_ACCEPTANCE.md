# Phase 18.7 — Resend Notification & Transactional Outbox Acceptance

**Modules:** `server/notifications.ts`, `server/outbox.ts`, `server/app.ts` (`POST /api/webhooks/resend`, `GET /api/admin/outbox`, `POST /api/admin/outbox/process`, `POST /api/admin/outbox/:jobId/retry`)

---

## 1. Live Railway Email Provider Status (`2026-11-20T04:16Z`)

Live `GET /ready` returned:
```json
{
  "email": {
    "provider": "unconfigured",
    "configured": false,
    "fromAddressConfigured": false,
    "staffRecipientConfigured": false,
    "webhookSecretConfigured": false,
    "liveDeliveryEnabled": false,
    "reason": "RESEND_API_KEY and EMAIL_FROM are not configured; notifications are audited without claiming email delivery."
  }
}
```
- **Honest Non-Fabrication Behavior Confirmed:** Because Resend credentials are not yet configured on Railway, the backend and frontend never fabricate inbox delivery. Notifications are atomically enqueued into `notification_outbox` inside the booking/reschedule/cancel transaction and marked `Skipped (Unconfigured)` when processed until Resend secrets are provisioned.
- **Consistency Hardening Applied in Phase 18:** Added `if (staffEmail)` guards in `POST /api/consultations/:id/reschedule` and `POST /api/consultations/:id/cancel` in `server/app.ts` to match `POST /api/consultations`.

---

## 2. Verified Outbox & Signed Svix Webhook Mechanics (Automated Suite)

- **Atomic Outbox Enqueue:** Client confirmation, reschedule, cancellation, confirmation, reminder, follow-up, proposal-ready, and staff operations alerts enqueue inside `withTransaction()` with deterministic `idempotencyKey` deduplication.
- **Worker Lease & Retry/Backoff:** `NotificationOutboxWorker` claims due jobs atomically, applies exponential backoff + bounded jitter on Resend `429` / `5xx` / timeouts, transitions permanent `4xx` or exhausted attempts to `DeadLetter` with audit logging, and supports MFA-gated admin requeue.
- **Provider Acceptance vs Inbox Delivery:** Resend `2xx` records `ProviderAccepted` (never `Delivered`). Only a cryptographically verified Svix webhook (`POST /api/webhooks/resend`) with valid `svix-id`, `svix-timestamp` within ±300s replay window, and constant-time HMAC-SHA256 `svix-signature` upgrades `ProviderAccepted -> Delivered` or `DeadLetter` (bounced/complained), deduplicated atomically by `svix-id`.
- **Fail-Closed Webhook Endpoint:** Unconfigured `RESEND_WEBHOOK_SECRET` returns `503 WEBHOOK_NOT_CONFIGURED`; invalid or expired signatures return `401 INVALID_WEBHOOK_SIGNATURE`.

---

## 3. Operator Checklist to Unblock `LB-17` & `LB-18` (Staging -> Production)

1. Verify sending domain DNS (`SPF`, `DKIM`, `DMARC`) for `celebrationsistersdecor.com` in Resend.
2. Configure Railway **staging** variables:
   - `RESEND_API_KEY=<staging key>`
   - `EMAIL_FROM="Celebration Sisters <bookings@celebrationsistersdecor.com>"`
   - `STAFF_NOTIFICATION_EMAIL=<internal staging test inbox>`
   - `RESEND_WEBHOOK_SECRET=whsec_<staging signing secret>`
   - `EMAIL_LIVE_DELIVERY_ENABLED=true` (staging ONLY until verified)
3. Register Resend webhook URL `https://<staging-railway-host>/api/webhooks/resend` for `email.delivered`, `email.bounced`, `email.complained`.
4. Run `scripts/verify-staging-railway-and-resend.ts` against staging to verify live Resend acceptance, signed Svix webhook upgrade (`ProviderAccepted -> Delivered`), and duplicate `svix-id` idempotency.
5. Do NOT enable `EMAIL_LIVE_DELIVERY_ENABLED=true` in production until staging delivery and webhook reconciliation pass and explicit executive approval is granted.
