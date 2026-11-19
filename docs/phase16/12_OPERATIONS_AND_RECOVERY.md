# Phase 16 — Operations, Monitoring & Incident Recovery Runbook

---

## 1. Operational Monitoring Endpoints & Telemetry

| Endpoint | Auth Requirement | Signals Exposed |
| --- | --- | --- |
| `GET /health` | Public (Railway liveness probe) | `ok`, `status: "alive"`, `requestId` (`X-Request-Id` header) |
| `GET /ready` | Public (Railway readiness probe) | `ok`, `persistence.ready` (`SELECT 1` live PostgreSQL check; returns `503` on outage), `requestId` |
| `GET /api/auth/config` | Public (safe non-secret runtime metadata) | Identity provider mode, `allowedOriginsCount`, non-secret feature flags |
| `GET /api/admin/metrics` | Executive Admin + MFA (`requireAdminWithMfa`) | `http` (total, 4xx, 5xx, errorRate%, avg/p95 ms), `database` (queries, errors, avg/p95 ms), `bookings` (attempts, succeeded, failed, failureRate%), `notifications` (enqueued, accepted, delivered, failed, deadLettered, workerHealthy), `ai`, `rateLimiter`, `webhooks` (received, reconciled, deduplicated, rejectedSignature, unconfigured503), `auth` (unauthorized401, forbidden403, mfaRequired403, invalidConsultationToken403), `outbox` (queueDepth, deadLetterCount) |
| `GET /api/admin/outbox` | Executive Admin + MFA | Queue depth, dead-letter count, inspectable outbox jobs |
| `POST /api/admin/outbox/:jobId/retry` | Executive Admin + MFA | Audited manual requeue of dead-lettered/failed jobs |

**Verified in Phase 16:** `X-Request-Id` correlation headers are returned on all success and error responses (`tests/phase16-platform-acceptance.test.ts`), and `webhooks`, `auth`, and `bookings` counters increment accurately across live API flows without leaking PII or secrets into structured logs.

---

## 2. Recommended Production Alert Thresholds

- **API Availability:** Alert if `/ready` returns non-200 for `>= 2` consecutive 15-second probes or `http.errorRatePercent > 2%` over 5 minutes.
- **Booking Failures:** Alert if `bookings.failureRatePercent > 10%` (excluding expected 409 slot races) or `/api/consultations` latency p95 `> 1,500 ms`.
- **Email Outbox Backlog / Dead-Letters:** Alert if `outbox.deadLetterCount > 0`, `outbox.queueDepth > 50`, or `notifications.workerHealthy === false` (heartbeat stale `> 120s`).
- **Security Anomalies:** Alert on sudden spikes in `webhooks.rejectedSignature`, `auth.invalidConsultationToken403`, or `rateLimiter.blocked429`.

---

## 3. Incident Recovery & Rollback Procedures

1. **Application Rollback (Railway & GitHub Pages):**
   - Revert the offending PR on `main` (never force-push) or promote the previous known-good Railway container release.
   - Verify `/health` (`200`), `/ready` (`200`), and `GET /api/consultations/availability` (`200`).
2. **Database Recovery:**
   - Migrations `001`–`008` are strictly forward-only and additive; before any staging/production migration run, capture a point-in-time PostgreSQL snapshot (`pg_dump` or Railway backup snapshot).
   - If a migration fails mid-file, `scripts/run-migrations.ts` automatically issues `ROLLBACK` for that migration transaction; diagnose the SQL error and restore snapshot if needed before re-running.
3. **Outbox Dead-Letter Recovery:**
   - Inspect dead-lettered records in `GET /api/admin/outbox`, resolve upstream provider/configuration cause (e.g., Resend sender/API key), and trigger audited replay via `POST /api/admin/outbox/:jobId/retry`.
4. **Emergency Email Pause:**
   - Set `EMAIL_LIVE_DELIVERY_ENABLED=false` in Railway environment variables to immediately pause outbound provider calls while preserving 100% of durable outbox records for later replay.
