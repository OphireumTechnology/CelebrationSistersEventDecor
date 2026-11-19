# Phase 15.5 — Resend Email Delivery & PostgreSQL TLS Remediation Report

**Project:** Celebration Sisters Event Decor  
**Primary Modules:** `server/repositories/postgresRepository.ts`, `server/notifications.ts`, `server/outbox.ts`, `server/app.ts`  
**Verification Tier:** **Code Ready & Isolated TLS/Webhook Automated Verified** — Live Railway PostgreSQL + Live Resend inbox delivery remain **Pending Staging Verification**.

---

## 1. Root Cause Analysis: PostgreSQL TLS Certificate-Chain Failure

### Identified Defect (Post-Phase-14)
In the Phase 14 baseline of `server/repositories/postgresRepository.ts`:
1. The `pg` pool enabled TLS with `rejectUnauthorized: true`, but provided **no mechanism to load a managed provider's root CA certificate** (`DATABASE_CA_CERT`, `DATABASE_CA_CERT_BASE64`, or `PGSSLROOTCERT`). Managed PostgreSQL services (such as Railway public proxy endpoints or Supabase poolers) frequently present chains signed by a provider CA not bundled in Node's default Mozilla trust store, causing `SELF_SIGNED_CERT_IN_CHAIN` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE` errors when the outbox worker or API queries PostgreSQL.
2. Query parameters like `?sslmode=require` in `DATABASE_URL` were passed directly into `pg`'s `connectionString`, which in `pg-connection-string` can override programmatic `ssl` options.
3. The environment template still referenced `PG_SSL_REJECT_UNAUTHORIZED`, creating risk of operators weakening TLS verification as a workaround.

### Secure Phase 15 Remediation (Zero Security Downgrades)
`buildPostgresSslConfig()` in `server/repositories/postgresRepository.ts` now enforces:
- **Mandatory Certificate Verification:** `rejectUnauthorized: true` and `minVersion: 'TLSv1.2'` are always enforced whenever TLS is active.
- **Explicit Prohibition of Unsafe Downgrades:** Setting `PG_SSL_REJECT_UNAUTHORIZED=false` or `sslmode=no-verify` throws `TLS_CONFIG_FAILURE` immediately on startup. Setting `PGSSLMODE=disable` on a public-network host in `NODE_ENV=production` also throws `TLS_CONFIG_FAILURE`.
- **Verified Custom CA Bundle Support:** Loads PEM certificates from:
  1. `DATABASE_CA_CERT` (supports raw multiline PEM or Railway single-line `\n`-escaped PEM)
  2. `DATABASE_CA_CERT_BASE64` (base64-encoded PEM)
  3. `PGSSLROOTCERT` (file path to mounted CA bundle)
  Validates PEM structure (`-----BEGIN CERTIFICATE-----`) before handing to TLS.
- **URL Parameter Sanitization:** Parses and strips `?sslmode=` from `sanitizedConnectionString` so `pg` never silently overrides verified `ssl` options.
- **Private Internal Network Support:** Recognizes `.railway.internal` private WireGuard hosts (`hostClass: 'railway-internal'`); defaults to `verify-full`, while permitting explicit `PGSSLMODE=disable` only on private/localhost hosts when the platform terminates encryption at the WireGuard mesh layer.
- **Redacted TLS Diagnostics:** `/ready` and `NotificationOutboxWorker.startPolling()` emit redacted TLS diagnostics (`enabled`, `rejectUnauthorized`, `caSource`, `hostClass`, `sslMode`) and actionable remediation messages without ever logging credentials or certificate payloads.

### Isolated TLS Verification Evidence
`tests/phase15-e2e-and-hardening.test.ts` spins up a **real local Node.js `tls.createServer`** with an ephemeral OpenSSL-generated Root CA and leaf certificate (`CN=localhost`, `SAN=DNS:localhost,IP:127.0.0.1`) and proves:
- Default TLS (without CA) fails closed with a certificate-chain verification error.
- `DATABASE_CA_CERT` (`\n`-escaped), `DATABASE_CA_CERT_BASE64`, and `PGSSLROOTCERT` each complete the real TLS handshake cleanly with `rejectUnauthorized: true`.
- `PG_SSL_REJECT_UNAUTHORIZED=false`, `sslmode=no-verify`, and `PGSSLMODE=disable` on public hosts in production all fail closed with `TLS_CONFIG_FAILURE`.

---

## 2. Transactional Email Outbox & Resend Webhook Reconciliation

### Covered Email Templates (`server/notifications.ts`)
1. Client consultation booking confirmation (`buildConsultationConfirmationTemplate`)
2. Studio confirmation notice (`buildConsultationConfirmedTemplate`)
3. Reschedule confirmation (`buildConsultationRescheduledTemplate`)
4. Cancellation notice (`buildConsultationCancelledTemplate`)
5. Pre-consultation 48h reminder (`buildConsultationReminderTemplate`)
6. Post-consultation follow-up (`buildConsultationFollowUpTemplate`)
7. Proposal available notice (`buildProposalAvailableTemplate`)
8. Internal planner/studio operations alert (`buildInternalOperationsAlertTemplate`)

### Honest Delivery Lifecycle
- `Pending` -> `Retrying` (exponential backoff on transient 5xx/network failure) -> `DeadLetter` (after `maxAttempts`)
- `Pending` -> `Skipped` (when `RESEND_API_KEY` is missing or `EMAIL_LIVE_DELIVERY_ENABLED !== 'true'`)
- `Pending` -> `ProviderAccepted` (HTTP 2xx from Resend API with `providerMessageId`)
- `ProviderAccepted` -> `Delivered` / `Bounced` (ONLY upon verified Svix-signed Resend webhook event)

### Svix Webhook Security (`POST /api/webhooks/resend`)
- Exact wire payload captured in `req.rawBody` via `express.json({ verify })`.
- `verifyResendWebhookSignature()` validates `svix-id`, `svix-timestamp` (strict ±300s replay window), and `svix-signature` (`v1,<base64-hmac-sha256>`) using `crypto.timingSafeEqual`.
- Deduplicates events by `svix-id` in `notificationWebhookEvents` (`public.notification_webhook_events`) so repeated webhook deliveries are idempotent.
- Reconciles `email.delivered` -> `Delivered`, `email.bounced` / `email.complained` -> `Bounced`.

### Administrative Dead-Letter Recovery (`POST /api/admin/outbox/:jobId/retry`)
- Requires authenticated Admin session with verified MFA.
- Requeues `DeadLetter` or `Skipped` jobs back to `Pending` (`attempts = 0`), appends `NOTIFICATION_JOB_REQUEUED` audit event, and optionally processes immediately.
- Exposed directly in the Admin Command Center **Email Outbox** tab with status filter buttons and per-row **Retry** action.

---

## 3. Staging Checklist for Live Resend & PostgreSQL Cutover

To move from **Code Ready** to **Staging Verified**:
1. Configure `RESEND_API_KEY`, `EMAIL_FROM` (verified sender domain `celebrationsistersdecor.com`), `EMAIL_LIVE_DELIVERY_ENABLED=true`, and `RESEND_WEBHOOK_SECRET` in Railway staging variables.
2. Configure `DATABASE_URL` and `DATABASE_CA_CERT` (or `DATABASE_CA_CERT_BASE64`) in Railway staging variables.
3. Register `https://<staging-backend-domain>/api/webhooks/resend` in the Resend Webhook Dashboard for `email.delivered`, `email.bounced`, and `email.complained`.
4. Submit a staging consultation booking, verify inbox delivery, confirm `ProviderAccepted -> Delivered` transition via signed webhook, and inspect `/ready` TLS diagnostics.
