# Phase 17F — Resend Delivery & Signed Svix Webhook Acceptance (`REQ-RES-01`)

**Email Provider & Templates:** `server/notifications.ts`  
**Durable Outbox & Worker:** `server/outbox.ts` (`NotificationOutboxWorker`, `reconcileResendWebhookAtomic`)  
**Webhook Endpoint:** `POST /api/webhooks/resend` (Svix HMAC-SHA256 + 300-second replay window + atomic deduplication + terminal status protection)  
**Turnkey Staging Verifier:** `scripts/verify-staging-railway-and-resend.ts` (`STG-RES-01`, `STG-RES-02`, `STG-RES-03`)  
**Requirement Status:** **`BLOCKED`** *(all code, Svix cryptographic signature, replay-window, deduplication, retry, dead-letter, and terminal-state controls verified in automated tests; live email delivery to an internal QA inbox & live Resend Svix callback blocked by missing staging Resend credentials in sandbox)*

---

## 1. Sandbox Environment Probe (Factual Blocker Evidence)

Direct environment check executed `2026-11-19`:
- `RESEND_API_KEY`: `UNSET`
- `RESEND_WEBHOOK_SECRET`: `UNSET`
- `EMAIL_FROM`: `UNSET`
- `STAFF_NOTIFICATION_EMAIL`: `UNSET`

In strict compliance with authorization boundaries, no emails were sent to real customers and no unverified delivery claims were recorded.

---

## 2. Verified Email Outbox & Svix Webhook Security Controls (`VERIFIED`)

| Control | Test Coverage | Actual Result |
| :--- | :--- | :--- |
| Canonical 5-Var Resend Contract & Centralized Staff Recipient | `server/notifications.ts` + `tests/phase15r/16` | **PASS** — single contract (`RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_LIVE_DELIVERY_ENABLED`, `RESEND_WEBHOOK_SECRET`, `STAFF_NOTIFICATION_EMAIL`) |
| Unconfigured Honest Pause (No False Delivery Claim) | `tests/phase14` + Chromium `P16-BA-09` | **PASS** — outbox records honest `Skipped (Unconfigured)` status |
| Provider Acceptance, Exponential Retry & Dead-Letter | `server/outbox.ts` + `tests/phase14` & `tests/phase15` | **PASS** |
| Invalid Svix HMAC Signature Rejection (`401`) | `tests/phase15/16` + `tests/phase17f` (`STG-RES-01`) | **PASS** — logged `resend_webhook_signature_rejected`, HTTP `401` |
| Expired Svix Timestamp Rejection (`> 300s`, `401`) | `tests/phase17` + `tests/phase17f` (`STG-RES-02`) | **PASS** — logged replay-window violation, HTTP `401` |
| Signed Svix Webhook Acceptance (`200`) & Duplicate `svix-id` Suppression | `tests/phase15/16` + `tests/phase17f` (`STG-RES-03`) | **PASS** — first `200`, replay `200` with `deduplicated: true` |
| Out-of-Order Terminal Status Protection | `server/outbox.ts` + `tests/phase15/16` | **PASS** — late `email.sent` cannot downgrade `Delivered`/`DeadLetter` |
| Stale Worker Lease Recovery | `server/outbox.ts` + `tests/phase15/16` | **PASS** — expired worker locks reclaimed cleanly |

---

## 3. Exact Operator Command to Close `REQ-RES-01`

Configure Railway Staging with verified sender domain (`EMAIL_FROM`), staging `RESEND_API_KEY`, `EMAIL_LIVE_DELIVERY_ENABLED=true` (strictly for isolated staging QA), internal QA `STAFF_NOTIFICATION_EMAIL`, and `RESEND_WEBHOOK_SECRET` (subscribed to `https://<verified-railway-staging-domain>/api/webhooks/resend`), then execute:

```bash
export STAGING_API_CONFIRM="YES_ISOLATED_STAGING"
export STAGING_API_BASE_URL="https://<verified-railway-staging-domain>"
export STAGING_RESEND_TEST_EMAIL="<authorized-internal-qa-inbox>"
export RESEND_WEBHOOK_SECRET="<staging-svix-webhook-secret>"

npx tsx scripts/verify-staging-railway-and-resend.ts
```

**Strict Verification Requirement:** Confirm actual receipt in the authorized internal QA inbox AND confirm `notification_outbox` transitions `Pending -> ProviderAccepted -> Delivered` via a live Resend `email.delivered` Svix webhook event (provider acceptance alone does not close `REQ-RES-01`).
