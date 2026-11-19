# Phase 17 — Resend Email & Svix Webhook Staging Acceptance Report

**Email Provider:** Resend (`server/lib/emailService.ts`)  
**Outbox & Worker:** `server/lib/notificationWorker.ts`, `notification_outbox`, `email_webhook_events` (`006` & `008`)  
**Code, Contract & Webhook Security Status:** `VERIFIED` (80/80 tests passing)  
**Live Resend Staging Controlled Send & Live Svix Callback Status:** `BLOCKED` (no staging Resend API key or live webhook secret in sandbox; production customer delivery remains strictly paused)

---

## 1. Canonical 5-Variable Resend Configuration Contract (`VERIFIED`)

All email configuration reads are centralized exclusively through `server/lib/emailService.ts` (`getEmailRuntimeStatus()`, `getStaffNotificationRecipient()`), with zero stray `STAFF_NOTIFICATION_EMAIL` reads across routes or services:

| Variable | Role | Production Guardrail |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | Provider authentication credential | Secret; never logged or returned in API responses. When absent, notifications pause cleanly in `notification_outbox` without claiming delivery. |
| `EMAIL_FROM` | Verified studio sender address | Must belong to a verified SPF/DKIM/DMARC sending domain. |
| `EMAIL_REPLY_TO` | Client reply routing address | Applied to outbound client confirmations, reminders, reschedules, and cancellations. |
| `STAFF_NOTIFICATION_EMAIL` | Internal studio notification inbox | Centralized via `getStaffNotificationRecipient()`; verified across all 7 notification call sites. |
| `RESEND_WEBHOOK_SECRET` | Svix HMAC-SHA256 signing secret | Required for `POST /api/webhooks/resend` signature verification; fails closed with HTTP `401`/`503` when invalid or unconfigured. |

---

## 2. Verified Email Lifecycle, Outbox & Webhook Defenses (`VERIFIED`)

| Control | Test / Verification Coverage | Outcome |
| :--- | :--- | :--- |
| Unconfigured Pause & Honest Outbox Status | `tests/phase14` + Chromium `P16-BA-09` | **PASS** — never claims delivery when unconfigured; records honest outbox audit state visible in Admin Command Center. |
| Provider Acceptance, Retry Backoff & Terminal Failure | `tests/phase14` & `tests/phase15` | **PASS** — transient 5xx/network errors schedule exponential retry; terminal 4xx records dead-letter state without losing payload. |
| Idempotency & Duplicate Send Suppression | `tests/phase14` & `tests/phase15` | **PASS** — duplicate event keys do not emit duplicate emails. |
| Svix HMAC-SHA256 Verification (`svix-id`, `svix-timestamp`, `svix-signature`) | `tests/phase15` & `tests/phase16` | **PASS** — valid signatures accepted (`200`); tampered payloads/signatures rejected (`401`). |
| Svix Replay-Window Guard (`> 300s` Timestamp Skew) | `tests/phase17-staging-and-api-routing.test.ts` (Test 5) | **PASS** — signatures with stale timestamps (`> 300s` old) rejected fail-closed with HTTP `401`. |
| Atomic Webhook Deduplication & Out-of-Order Terminal Protection | `tests/phase15` & `tests/phase16` | **PASS** — duplicate `svix-id` returns `duplicate: true` cleanly; late `email.sent` cannot overwrite terminal `delivered`/`bounced`/`complained` states. |
| Stale Worker Lease Recovery | `tests/phase15` & `tests/phase16` | **PASS** — expired worker leases (`locked_at` past lease TTL) are reclaimed cleanly by surviving replicas. |
| Sensitive Header / Secret Log Redaction | `tests/phase16` | **PASS** — structured logs strip authorization headers, tokens, and API credentials. |

---

## 3. Blocked External Staging Gate & Controlled Staging Validation Plan (`REQ-RES-01`)

**Why `BLOCKED`:** No staging Resend API key, verified staging sender domain, or live Railway HTTPS webhook URL is configured inside this build sandbox.

**Operator Staging Validation Procedure (Strictly Non-Customer Test Inboxes Only):**
1. Verify SPF, DKIM, and DMARC DNS records for the studio sending domain in Resend.
2. Configure Railway Staging with staging `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `STAFF_NOTIFICATION_EMAIL=<internal-staging-inbox>`, and `RESEND_WEBHOOK_SECRET`.
3. Register `https://<railway-staging-domain>/api/webhooks/resend` in Resend Webhooks for `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, and `email.delivery_delayed`.
4. Submit one controlled staging consultation booking using an internal QA test email address:
   - Verify client confirmation + staff alert arrive with valid ICS calendar attachment and scoped `csa_` manage link.
   - Confirm `notification_outbox` transitions `queued -> sent -> delivered` via live Svix webhook callback.
   - Verify `/api/admin/metrics` increments `webhooks.verified` and `bookings.created`.
5. Keep production customer email delivery paused until explicit production approval.
