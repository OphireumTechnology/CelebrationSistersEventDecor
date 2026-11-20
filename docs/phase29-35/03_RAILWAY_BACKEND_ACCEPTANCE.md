# Phase 31 — Railway Backend Production Hardening & Acceptance

**Deliverable Mapping:** `PHASE31_RAILWAY_ACCEPTANCE.md` / `docs/phase29-35/03_RAILWAY_BACKEND_ACCEPTANCE.md`  
**Live Railway URL:** `https://celebrationsisterseventdecor-production.up.railway.app/`  
**Audit Timestamp:** `2026-11-20T13:51Z`  
**Phase 31 Status:** **PARTIALLY VERIFIED (`5/6` — `BE-06` BLOCKED on isolated staging Railway deployment & credentials)**

---

## 1. Live Railway Read-Only Verification Results

| Probe | Endpoint | HTTP Status | Verified Behavior |
|---|---|---:|---|
| Process Liveness | `GET /health` | `200` | `{"ok":true,"status":"alive","service":"Celebration Sisters Event Decor Platform","requestId":"bf3cb841-a63e-4ad5-aa94-86592c7e7455"}` |
| Application Readiness | `GET /ready` | `503` | Correctly fails closed (`status: "not_ready"`, `productionReady: false`) with 4 accurate `blockingReasons` (0/8 migrations, missing tables/constraint, Supabase unconfigured, Resend unconfigured) and zero secret leakage |
| Auth Config | `GET /api/auth/config` | `200` | `demoPersonasAvailable: false`, `allowedOriginsCount: 2`, `readyForProductionAuth: false` |
| Demo Persona Guard | `GET /api/auth/personas` | `404` | Blocked in production (`Demo personas are unavailable in production.`) |
| Live Availability | `GET /api/consultations/availability?timezone=America/New_York` | `200` | Returns live Columbia, SC studio slots across upcoming days |
| Self-Service Missing Token | `GET /api/consultations/status?referenceCode=CS-2026-0001` | `400` | `SCOPED_TOKEN_REQUIRED` |
| Self-Service Invalid Token | `GET /api/consultations/status` + bad `X-Consultation-Token` | `403` | `INVALID_CONSULTATION_TOKEN` |
| Unauthenticated Protected Routes | `GET /api/consultations`, `GET /api/bookings` | `401` | `AUTH_REQUIRED` |
| Unauthenticated Admin Routes | `GET /api/admin/metrics`, `GET /api/admin/outbox` | `403` | `ADMIN_REQUIRED` |
| CORS Allowed Origin | `OPTIONS /api/consultations` (`Origin: https://celebrationsistersdecor.com`) | `204` | Exact `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, allows `X-Consultation-Token` & `Idempotency-Key` |
| CORS Disallowed Origin | `OPTIONS /api/consultations` (`Origin: https://evil.example.com`) | `403` | `CORS_ORIGIN_DENIED` |

---

## 2. Backend Hardening Verification & Phase 31 Repairs

- **Dockerfile & Startup Contract (`Dockerfile`, `railway.json`, `server.ts`):** Multi-stage `node:22-bookworm-slim` build, non-root `USER node`, `CMD ["node", "dist-server/server.mjs"]`, HTTP timeouts (`requestTimeout=30s`, `headersTimeout=35s`, `keepAliveTimeout=65s`), graceful `SIGTERM`/`SIGINT` pool & worker shutdown verified locally (`SMOKE_SIGTERM_EXIT=0`).
- **Fail-Closed Startup:** Confirmed `NODE_ENV=production node dist-server/server.mjs` exits non-zero when `DATABASE_URL` or `SESSION_SECRET` is absent (`PERSISTENCE_READINESS_FAILURE`).
- **Phase 31 Readiness Repair (`server/app.ts`):** `evaluateApplicationReadiness()` now also fails closed (`503`, `checks.worker: false`) in production if `DISABLE_OUTBOX_POLLING=true`.
- **Phase 31 Startup Log Repair (`server/observability.ts`):** `server_startup_diagnostics` now logs `emailProvider` and `emailLiveEnabled` accurately instead of `"[REDACTED]"`.
- **Rate Limiting & Error Classification:** Single-flight PostgreSQL `42P01` bootstrap (`PostgresRateLimitStore`) and SQLSTATE classifier (`23P01`/`23505`/`40001` -> `409`, `42501` -> `403`, `08006` -> `503`) verified by automated tests (`102/102`).

---

## 3. Remaining External Blocker (`BE-06`)

Executing full write-capable staging API acceptance (`STG-API-01..10`, `STG-SEC-01`, `GET /ready -> 200 ready` against a live Railway PostgreSQL + Supabase + Resend staging instance) is **BLOCKED** because `RAILWAY_TOKEN` and an isolated `STAGING_API_BASE_URL` are not available in this sandbox.

### Authorized Staging Verification Command

```bash
STAGING_API_CONFIRM=YES_ISOLATED_STAGING \
STAGING_API_BASE_URL="https://<isolated-staging-railway-host>" \
STAGING_FRONTEND_ORIGIN="https://celebrationsistersdecor.com" \
STAGING_RESEND_TEST_EMAIL="<approved-qa-inbox>" \
RESEND_WEBHOOK_SECRET="<staging-whsec>" \
STAGING_REQUIRE_SUPABASE_AUTH=true \
STAGING_REQUIRE_RESEND_LIVE=true \
npx tsx scripts/verify-staging-railway-and-resend.ts
```
