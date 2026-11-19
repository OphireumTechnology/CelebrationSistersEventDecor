# Phase 16 — Resend Transactional Email & Webhook Integration Report

**Provider Adapter:** `server/notifications.ts`  
**Durable Outbox & Atomic Reconciliation:** `server/outbox.ts`  
**Webhook Endpoint:** `POST /api/webhooks/resend`

---

## 1. Canonical Environment Contract (Single Source of Truth)

All email configuration reads across the entire backend now route exclusively through `getEmailRuntimeConfig()` and `getStaffNotificationRecipient()` in `server/notifications.ts`:

- `RESEND_API_KEY`
- `EMAIL_FROM`
- `EMAIL_LIVE_DELIVERY_ENABLED` (must equal `'true'` to permit outbound HTTP sends; defaults to safely paused)
- `RESEND_WEBHOOK_SECRET`
- `STAFF_NOTIFICATION_EMAIL` (falls back deterministically to `directors@celebrationsisters.example.com`)

**Verified by automated test:** `tests/phase16-platform-acceptance.test.ts` scans every `.ts` file under `server/` and asserts **0 direct `process.env` reads** for any of the five email variables outside `server/notifications.ts` (eliminating all 7 direct reads previously scattered in `server/app.ts`).

---

## 2. Verified Email Lifecycle, Safety & Webhook Controls

| Control | Evidence | Status |
| --- | --- | --- |
| **Safe Pause by Default (Zero Unapproved Live Sends)** | When `EMAIL_LIVE_DELIVERY_ENABLED !== 'true'`, outbox jobs record honest `Skipped (Unauthorized)` / `Skipped (Unconfigured)` states without contacting Resend. Verified in unit tests & Chromium Admin Outbox UI (`P16-BA-09`). | **VERIFIED** |
| **Honest Provider Status Semantics** | Resend HTTP 2xx records `ProviderAccepted` (never fabricated as final inbox `Delivered`); only cryptographically verified `email.delivered` webhook promotes status to `Delivered`. | **VERIFIED** |
| **Transactional Outbox Atomicity** | Booking/consultation commits and notification outbox inserts occur in the same transaction; worker retries transient 429/5xx with bounded exponential backoff and transitions exhausted jobs to `DeadLetter`. | **VERIFIED** |
| **Svix HMAC-SHA256 Webhook Verification & Replay Protection** | `verifyResendWebhookSignature()` enforces constant-time comparison and ±5-minute timestamp window; invalid signatures return `401` and increment `observability.webhooks.rejectedSignature`. | **VERIFIED** |
| **Single-Transaction Webhook Deduplication & Out-of-Order Terminal Protection** | `reconcileResendWebhookAtomic()` inserts `(provider, svix_id)` into `notification_webhook_events`, reconciles outbox & delivery records atomically, deduplicates replayed `svix-id`s (`deduplicated: true`), and prevents late `email.sent` from regressing terminal `Delivered`/`Bounced`/`Complained` states. | **VERIFIED** |
| **Live Resend Staging Domain Verification (SPF/DKIM/DMARC) & Controlled Test Send** | Requires live staging Resend API key, verified `celebrationsistersdecor.com` sender domain, and explicit staging approval. | **BLOCKED (External Credentials / Safety Policy)** |
