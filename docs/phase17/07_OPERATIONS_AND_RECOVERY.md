# Phase 17 — Operations, Observability, Recovery & Incident Runbook

**Service:** Celebration Sisters Event Decor Platform (`dist-server/server.mjs` + GitHub Pages Frontend)  
**Operational Telemetry & Code Controls:** `VERIFIED`  
**Live Staging Backup/Restore & Alert Drill:** `BLOCKED` (dependent on live Railway Staging PostgreSQL & Railway deployment)

---

## 1. Health, Readiness & Admin Telemetry Endpoints (`VERIFIED`)

| Endpoint | Access | Verified Response Behavior |
| :--- | :--- | :--- |
| `GET /health` | Public (Liveness Probe) | Returns `200 OK` JSON (`ok: true`, `status: "alive"`, `requestId`, `timestamp`). |
| `GET /ready` | Public (Readiness Probe) | Executes live DB readiness check (`SELECT 1` on PostgreSQL); returns `200 OK` when healthy or `503 Service Unavailable` on DB outage (verified in `tests/phase14` + compiled smoke). |
| `GET /api/auth/config` | Public (Bootstrap) | Returns safe non-secret auth posture including `demoPersonasAvailable` (`false` in production) and `allowedOriginsCount`. |
| `GET /api/admin/metrics` | MFA-Authenticated Admin Only (`403` otherwise) | Returns structured operational counters across `bookings` (`created`, `conflicts`, `rescheduled`, `cancelled`, `idempotentReplays`), `webhooks` (`received`, `verified`, `rejected`, `duplicates`), `auth` (`loginSuccess`, `loginFailure`, `mfaFailure`, `unauthorizedAdmin`), and outbox queue depths. |

Every HTTP response emits an `X-Request-Id` correlation header, and structured JSON server logs automatically redact credentials, cookies, tokens, and authorization headers (`tests/phase16-platform-acceptance.test.ts`).

---

## 2. Recommended Production Alert Thresholds

| Signal | Warning Threshold | Critical / Page Threshold | Primary Action |
| :--- | :--- | :--- | :--- |
| `GET /ready` non-200 | > 1 consecutive failure (30s) | > 3 consecutive failures (90s) | Check Railway PostgreSQL connectivity, TLS cert, and connection pool saturation. |
| HTTP 5xx error rate | > 1% over 5 minutes | > 5% over 5 minutes | Inspect structured logs by `X-Request-Id`; evaluate immediate rollback. |
| `webhooks.rejected` spike | > 5 in 5 minutes | > 20 in 5 minutes | Verify `RESEND_WEBHOOK_SECRET` alignment and inspect Svix timestamp skew. |
| `notification_outbox` dead-letter/failed | >= 1 failed email | >= 5 failed emails in 15m | Inspect Resend domain health, rate limits, and `notification_outbox.last_error`. |
| `auth.unauthorizedAdmin` / `auth.mfaFailure` | > 10 in 5 minutes | > 25 in 5 minutes | Review source IPs, confirm rate-limiter `429` enforcement, audit admin sessions. |
| `bookings.conflicts` (`409`) | > 15% of attempts | > 40% of attempts | Confirm availability cache freshness and inspect planner working-hours configuration. |

---

## 3. Graceful Shutdown & Zero-Downtime Restart (`VERIFIED`)

Compiled `dist-server/server.mjs` was directly tested with `kill -TERM`:
- Stops accepting new HTTP connections cleanly.
- Halts background notification worker sweep loop cleanly without orphaning in-flight leases.
- Closes PostgreSQL pool and exits cleanly (`exit 0`).

---

## 4. Backup, Restore & Rollback Procedures

### PostgreSQL Backup & Restore (Staging Drill Required Pre-Production)
1. Enable automated daily Railway PostgreSQL snapshots + point-in-time recovery (PITR) retention (>= 14 days).
2. Before any schema migration on staging or production, capture an on-demand logical backup (`pg_dump --format=custom --no-owner --no-privileges`).
3. Verify restore into an isolated temporary staging database and confirm row counts + `SELECT count(*) FROM schema_migrations` match source.

### Application Rollback Procedure
- **Backend (Railway):** Re-deploy the previous immutable Railway deployment release (Docker image built from last known-good Git commit SHA). Never run destructive down-migrations on active booking tables; migrations `001`–`008` are additive and forward-compatible.
- **Frontend (GitHub Pages):** Re-run `deploy-pages.yml` on the previous known-good `main` commit SHA (verify `vars.VITE_API_BASE_URL` remains populated).

### Secret Rotation Procedure
- **`SESSION_SECRET`:** Rotate in Railway secrets and restart service; active sessions invalidate cleanly requiring fresh MFA login.
- **`RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`:** Generate new credential in Resend, update Railway secret, redeploy, confirm `/api/webhooks/resend` passes verified webhook test, then revoke old credential.
- **`DATABASE_URL`:** Rotate application role password in Railway PostgreSQL, update `DATABASE_URL`, confirm `/ready` returns `200 OK`.
