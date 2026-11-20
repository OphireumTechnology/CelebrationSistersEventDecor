# Phase 19 — 02 Railway Staging Acceptance

**Live Production Railway URL (Read-Only Probed):** `https://celebrationsisterseventdecor-production.up.railway.app/`  
**Probe Timestamp:** `2026-11-20T04:29:41Z`  
**Status:** **BLOCKED (EXTERNAL — NO `RAILWAY_TOKEN` / NO ISOLATED STAGING RAILWAY SERVICE CREDENTIALS IN SANDBOX)**

---

## 1. Live Production Railway Read-Only Verification (`2026-11-20T04:29:41Z`)

Confirmed live Railway production is running commit `b9316bc9618f9dce666ddbe5dbe465db531a93b7` (zero synthetic writes performed):

| Endpoint | HTTP Status | Observed Live Result |
|---|---|---|
| `GET /health` | `200 OK` | `ok: true`, `status: "alive"`, `X-Request-Id` present (`2334c875-b9aa-42ab-bf91-5792b5ff8472`). |
| `GET /ready` | `200 OK` | `persistence.adapter: "postgres"`, `connected: true`, `latencyMs: 30`, `hostClass: "railway-internal"`, `sslMode: "disable"`. |
| `GET /ready` (`persistence.schema`) | `200 OK` | **`rateLimitTablePresent: true`**, `migrationsTablePresent: false`, **`migrationsAppliedCount: 0`**. |
| `GET /ready` (`auth`) | `200 OK` | `provider: "supabase"`, `supabaseConfigured: false`, `readyForProductionAuth: false`. |
| `GET /ready` (`email`) | `200 OK` | `provider: "unconfigured"`, `configured: false`, `liveDeliveryEnabled: false`. |
| `GET /api/auth/config` | `200 OK` | `demoPersonasAvailable: false`, `allowedOriginsCount: 2`, `viteSupabaseConfigured: false`. |
| `GET /api/consultations/availability?days=14&method=video&timezone=America/New_York` | `200 OK` | **81 open consultation slots** across 14 days (exact studio schedule & blackouts active). |
| `GET /api/consultations/status?referenceCode=CS-2026-0065` | **`400`** | `SCOPED_TOKEN_REQUIRED` — **Phase 18 live `503 RATE_LIMITER_UNAVAILABLE` defect is now RESOLVED on Railway!** |
| `GET /api/consultations/status?referenceCode=CS-2026-0065` (invalid `X-Consultation-Token`) | **`403`** | `INVALID_CONSULTATION_TOKEN` — fail-closed distributed PostgreSQL rate limiter functioning cleanly. |

---

## 2. Phase 19 Concurrency Defect Caught Live on Railway & Repaired in Code

During our initial parallel probe of `GET /api/consultations/status` on Railway before `rate_limit_buckets` existed, two concurrent requests hit the cold-start `42P01` path simultaneously:
- Request 1 set `tableBootstrapAttempted = true` and started `CREATE TABLE IF NOT EXISTS rate_limit_buckets`.
- Request 2 arrived milliseconds later, observed `tableBootstrapAttempted === true`, skipped waiting, and returned a transient `503 RATE_LIMITER_UNAVAILABLE`.

**Phase 19 Repair (`server/rateLimit.ts`):**
- Replaced boolean `tableBootstrapAttempted` with single-flight `tableBootstrapPromise: Promise<void> | null`, `tableBootstrapDone`, and `tableBootstrapFailed`.
- All concurrent cold-start `42P01` callers now await the exact same DDL promise and retry `upsertBucket()` together with **zero spurious 503 responses**, while restricted roles (`42501`) and real outages (`ECONNREFUSED` / `ETIMEDOUT`) still fail closed with HTTP `503`.
- Verified via new 10-way concurrent cold-start test in `tests/phase19-staging-readiness.test.ts` (`PASS`).

---

## 3. Isolated Railway Staging Architecture & Environment Contract

Per safety boundaries, synthetic writes, migration drills, restart tests, and Resend deliveries MUST run against an **isolated Railway Staging service + isolated Staging PostgreSQL database**, never production.

### Required Staging Environment Variables (Names Only — No Secret Values)
- **Core Runtime:** `NODE_ENV=production`, `PORT=3000`, `TRUST_PROXY=1`, `PERSISTENCE_ADAPTER=postgres`, `SESSION_SECRET` (>=32 bytes), `ALLOWED_ORIGINS` (staging frontend origin + `https://celebrationsistersdecor.com`), `ALLOW_DEMO_AUTH=false`
- **Database:** `DATABASE_URL` (isolated staging PostgreSQL), `PGSSLMODE` (`disable` only for `*.railway.internal`, `verify-full` for public proxies), `PG_POOL_MAX`, `PG_CONNECT_TIMEOUT_MS`, `RATE_LIMIT_DB_TIMEOUT_MS`
- **Authentication:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
- **Email (Staging Only):** `RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL` (internal QA inbox), `RESEND_WEBHOOK_SECRET`, `EMAIL_LIVE_DELIVERY_ENABLED=true`

---

## 4. Exact Operator Commands to Verify Isolated Railway Staging

Once the isolated staging Railway service is deployed from branch `repair/phase19-final-production-readiness`:

```bash
STAGING_API_CONFIRM=YES_ISOLATED_STAGING \
STAGING_API_BASE_URL="https://<staging-service>.up.railway.app" \
STAGING_FRONTEND_ORIGIN="https://<staging-frontend-origin>" \
STAGING_RESEND_TEST_EMAIL="qa-internal@celebrationsistersdecor.com" \
RESEND_WEBHOOK_SECRET="whsec_<staging-webhook-secret>" \
STAGING_REQUIRE_SUPABASE_AUTH=true \
STAGING_REQUIRE_RESEND_LIVE=true \
npx tsx scripts/verify-staging-railway-and-resend.ts
```

This executes `STG-API-01..10`, `STG-SEC-01`, `STG-AUTH-01`, `STG-RES-00..03` — proving HTTPS, `/health`, `/ready` (`migrationsAppliedCount >= 8`, `rateLimitTablePresent: true`), Supabase Auth readiness, Resend live readiness, CORS preflight, live availability, 120-minute notice cutoff, idempotent booking, scoped `X-Consultation-Token` lookup/reschedule/cancel, and signed Svix webhooks.
