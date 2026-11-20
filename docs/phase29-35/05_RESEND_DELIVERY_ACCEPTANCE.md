# Phase 33 — Resend Email & Notification Acceptance

**Deliverable Mapping:** `PHASE33_RESEND_ACCEPTANCE.md` / `docs/phase29-35/05_RESEND_DELIVERY_ACCEPTANCE.md`  
**Audit Timestamp:** `2026-11-20T13:51Z`  
**Phase 33 Status:** **PARTIALLY VERIFIED (`3/6` — `MAIL-04`, `MAIL-05`, `MAIL-06` BLOCKED on DNS records & Resend staging credentials)**

---

## 1. Live Infrastructure & DNS Evidence

### Live Railway `/ready` Diagnostics (`2026-11-20T13:51:44Z`)
- `email.provider`: `"unconfigured"`
- `email.configured`: `false`
- `email.fromAddressConfigured`: `false`
- `email.staffRecipientConfigured`: `false`
- `email.webhookSecretConfigured`: `false`
- `email.liveDeliveryEnabled`: `false`

### Live Public DNS Audit (`celebrationsistersdecor.com`, `2026-11-20T13:55Z`)
Direct DNS resolution confirmed sender authentication is **NOT YET PUBLISHED**:

| DNS Record | Lookup Host | Live Result | Status |
|---|---|---|---|
| Root SPF TXT | `celebrationsistersdecor.com` | `v=spf1 include:_spf.porkbun.com ~all` | Missing Resend SPF authorization |
| DMARC TXT | `_dmarc.celebrationsistersdecor.com` | `ENOTFOUND` | **MISSING** |
| Resend DKIM TXT | `resend._domainkey.celebrationsistersdecor.com` | `ENOTFOUND` | **MISSING** |
| Resend Return-Path MX | `send.celebrationsistersdecor.com` | `ENOTFOUND` | **MISSING** |

---

## 2. Code-Level Notification Architecture Verified (`MAIL-01..03`)

- **Transactional Outbox (`MAIL-01` — VERIFIED):** Atomic enqueue inside booking/consultation transactions, idempotency deduplication, single-claim lease recovery, exponential backoff with jitter (`0.75x`–`1.25x`), provider timeout guard (`10s`), permanent `4xx`/max-attempt `DeadLetter` routing, and admin safe requeue (`server/outbox.ts`, `tests/phase13-outbox-and-persistence.test.ts`, `tests/production-hardening.test.ts`).
- **Honest Delivery Status (`MAIL-02` — VERIFIED):** HTTP `2xx` from Resend is recorded strictly as `ProviderAccepted` — never `Delivered` until a verified Svix webhook confirms inbox delivery. Unconfigured/paused runs record `Skipped (Unconfigured)` or `Skipped (Unauthorized)`.
- **Signed Svix Webhook Verification (`MAIL-03` — VERIFIED):** `POST /api/webhooks/resend` enforces constant-time HMAC-SHA256 verification (`verifyResendWebhookSignature`), `±300s` replay window rejection (`401`), atomic `svix-id` deduplication, immutable `notification_webhook_events` audit recording, and out-of-order terminal status downgrade protection.
- **Email Workflows Implemented (`server/notifications.ts`):**
  1. New consultation confirmation (`buildConsultationConfirmationTemplate`)
  2. Internal staff alert (`buildStaffAlertTemplate`, `buildInternalOperationsAlertTemplate`)
  3. Appointment confirmed (`buildConsultationConfirmedTemplate`)
  4. Appointment rescheduled (`buildConsultationRescheduledTemplate`)
  5. Appointment cancelled (`buildConsultationCancelledTemplate`)
  6. Appointment reminder (`buildConsultationReminderTemplate`)
  7. Post-consultation follow-up & proposal available (`buildConsultationFollowUpTemplate`, `buildProposalAvailableTemplate`)
  8. Booking status updates (`buildStatusUpdateTemplate`)

---

## 3. Required External Activation Steps (`MAIL-04`, `MAIL-05`, `MAIL-06`)

1. Add `celebrationsistersdecor.com` in Resend and publish the required SPF, DKIM (`resend._domainkey`), return-path (`send`), and DMARC (`_dmarc`) DNS records until Resend marks the domain Verified.
2. Configure staging Railway environment variables: `RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET`, and `EMAIL_LIVE_DELIVERY_ENABLED=true` (staging QA only).
3. Register the staging Resend webhook pointing to `https://<staging-railway-host>/api/webhooks/resend` for `email.delivered`, `email.bounced`, and `email.complained`.
4. Execute `scripts/verify-staging-railway-and-resend.ts` with `STAGING_REQUIRE_RESEND_LIVE=true` using an approved internal QA mailbox and confirm real inbox receipt + webhook status upgrade (`ProviderAccepted` -> `Delivered`).
