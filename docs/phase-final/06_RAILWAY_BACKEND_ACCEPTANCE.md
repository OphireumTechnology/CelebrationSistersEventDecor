# 06 — Railway Backend & API Readiness Acceptance Report (Phase 23)

**Live Production Railway URL (Read-Only Probed):** `https://celebrationsisterseventdecor-production.up.railway.app/`  
**Audit Timestamp:** `2026-11-20T04:59Z`  
**Status:** **PHASE 23 `/ready` VS `/health` SEPARATION IMPLEMENTED & VERIFIED LOCALLY (`99/99` TESTS + COMPILED SMOKE) — ISOLATED STAGING RAILWAY ACCEPTANCE BLOCKED (`RAILWAY_TOKEN` / STAGING URL UNAVAILABLE)**

---

## 1. Phase 23 Critical Readiness Repair Implemented

Previously, `GET /ready` returned HTTP `200 ok: true` solely when PostgreSQL `SELECT 1` succeeded — even while live Railway reported `migrationsAppliedCount: 0`, `auth.readyForProductionAuth: false`, and `email.configured: false`.

### Implemented Separation (`server/app.ts`, `server/repositories/postgresRepository.ts`, `server/outbox.ts`)

| Endpoint | Responsibility | Behavior |
|---|---|---|
| **`GET /health`** | Process Liveness | Always returns `200 { ok: true, status: "alive", service, requestId, timestamp }` so container orchestrators do not crash-loop while downstream services initialize. |
| **`GET /ready`** | Application Readiness | Evaluates 6 explicit readiness gates via `evaluateApplicationReadiness()`: (1) `database` connectivity, (2) `migrations` (`migrationsTablePresent && migrationsAppliedCount >= 8`), (3) `schemaObjects` (`rate_limit_buckets`, `consultations`, `consultation_slot_holds`, `notification_outbox`, `notification_webhook_events`, `crm_follow_up_tasks` + `excl_consultations_planner_buffered_overlap`), (4) `auth` (`readyForProductionAuth`), (5) `email` (`configured && webhookSecretConfigured && staffRecipientConfigured`), (6) `worker` (`workerHealthy`). In `NODE_ENV=production`, returns **HTTP `503` (`ok: false, status: "not_ready"`)** with sanitized `blockingReasons` whenever ANY gate fails; returns `200 ready` only when all 6 pass. Zero secret/URL disclosure verified by sentinel tests. |
| **`GET /api/health`** | API Diagnostic Mirror | Mirrors the same sanitized `checks`, `blockingReasons`, `productionReady`, and `worker` contract. |

---

## 2. Live Production Railway Read-Only Observations (`2026-11-20T04:56:13Z`)

- `GET /health` -> `200 OK` (`status: "alive"`, `X-Request-Id` present).
- `GET /ready` (running pre-Phase 23 commit `63fb9a6fb4`): `persistence.adapter: "postgres"`, `connected: true`, `latencyMs: 5`, `rateLimitTablePresent: true`, `migrationsAppliedCount: 0`, `auth.readyForProductionAuth: false`, `email.configured: false`.
- `GET /api/auth/config` -> `200 OK` (`demoPersonasAvailable: false`, `allowedOriginsCount: 2`).
- `GET /api/consultations/status?referenceCode=CS-2026-0065` -> `400 SCOPED_TOKEN_REQUIRED`; invalid `X-Consultation-Token` -> `403 INVALID_CONSULTATION_TOKEN` (former `503` resolved; single-flight `42P01` bootstrap verified under 10-way concurrency).

---

## 3. Isolated Staging Railway Verification Command (Operator Required)

```bash
STAGING_API_CONFIRM=YES_ISOLATED_STAGING \
STAGING_API_BASE_URL="https://<staging-service>.up.railway.app" \
STAGING_FRONTEND_ORIGIN="https://<staging-frontend-origin>" \
STAGING_RESEND_TEST_EMAIL="<internal-qa-inbox>" \
RESEND_WEBHOOK_SECRET="whsec_<staging-secret>" \
STAGING_REQUIRE_SUPABASE_AUTH=true \
STAGING_REQUIRE_RESEND_LIVE=true \
npx tsx scripts/verify-staging-railway-and-resend.ts
```
