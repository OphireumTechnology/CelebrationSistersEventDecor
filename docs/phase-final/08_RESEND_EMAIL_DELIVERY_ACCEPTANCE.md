# 08 — Resend Email Delivery & Webhook Acceptance Report (Phase 25)

**Audit Timestamp:** `2026-11-20T04:59:23Z`  
**Status:** **OUTBOX, TEMPLATES, BACKOFF, DEAD-LETTER & SVIX HMAC VERIFICATION PASSED LOCALLY — LIVE STAGING RESEND DELIVERY & DNS VERIFICATION BLOCKED (NO RESEND CREDENTIALS OR DNS ACCESS IN SANDBOX)**

---

## 1. Live Production Email Posture (`2026-11-20T04:56:13Z`)

Railway `GET /ready` reported:
- `email.provider: "unconfigured"`, `configured: false`, `fromAddressConfigured: false`, `staffRecipientConfigured: false`, `webhookSecretConfigured: false`, `liveDeliveryEnabled: false`.
- Real customer email delivery remains safely disabled (`EMAIL_LIVE_DELIVERY_ENABLED` is not enabled).

---

## 2. Verified Notification & Webhook Controls (`99 / 99` Automated Tests)

- **Templates Verified (`server/notifications.ts`):** Client booking confirmation, confirmed appointment, reschedule, cancellation, reminder, post-consultation follow-up, proposal available, internal staff alert, operations alert, and status update — all HTML-escaped via `escapeHtml()`.
- **Transactional Outbox (`server/outbox.ts`):** Atomic transaction enqueue alongside booking writes, idempotency deduplication, stale-claim lease recovery, exponential backoff with jitter (`computeBackoffDelayMs`), permanent 4xx / max-attempt `DeadLetter` routing, and honest `Skipped (Unconfigured)` / `Skipped (Unauthorized)` recording (never fabricates `Delivered`).
- **Signed Svix Webhook Engine (`POST /api/webhooks/resend`):**
  - Constant-time HMAC-SHA256 verification (`crypto.timingSafeEqual`) over `svix-id.svix-timestamp.rawBody`.
  - Rejects invalid signature (`401`, `STG-RES-01`) and expired timestamp >300s (`401`, `STG-RES-02`).
  - Accepts valid signed delivery events (`200`), persists provider status atomically, suppresses duplicate `svix-id` replays (`deduplicated: true`, `STG-RES-03`), and prevents out-of-order terminal status downgrades.

---

## 3. External Prerequisites to Unblock Live Staging Email Acceptance

1. Verify SPF, DKIM, and DMARC records for the sender domain in Resend.
2. Configure staging Railway variables (`RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL` pointing strictly to an approved internal QA mailbox, `RESEND_WEBHOOK_SECRET`, `EMAIL_LIVE_DELIVERY_ENABLED=true`).
3. Point Resend staging webhook to `https://<staging-service>.up.railway.app/api/webhooks/resend`.
4. Run `scripts/verify-staging-railway-and-resend.ts` with `STAGING_REQUIRE_RESEND_LIVE=true` and inspect real QA inbox receipt, recorded Resend message ID, and webhook-driven `Delivered` transition in staging PostgreSQL.
