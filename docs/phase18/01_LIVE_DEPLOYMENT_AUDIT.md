# Phase 18.1 — Live Deployment Audit

**Project:** Celebration Sisters Event Decor  
**Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Public Website:** `https://celebrationsistersdecor.com/` (GitHub Pages)  
**Railway Backend:** `https://celebrationsisterseventdecor-production.up.railway.app/`  
**Audit Timestamp:** `2026-11-20T04:16Z`

---

## 1. GitHub Source-of-Truth Verification

- **Verified `main` HEAD:** `3576b513682757192c4ab3548adac882881be42d` (`2026-11-20T04:03:02Z`)
- **Latest Merge Commit:** PR #17 — `Fix consultation booking: embed Railway API origin in GitHub Pages build`
- **PR #17 Diff Scope:** Modified `.github/workflows/deploy-pages.yml` (+4 / -3 lines) to default `VITE_API_BASE_URL` to `https://celebrationsisterseventdecor-production.up.railway.app` and fail closed (`exit 1`) if empty.
- **Workspace Synchronization:** Local `.github/workflows/deploy-pages.yml` was synced to match PR #17 so subsequent feature branches never regress the Railway API origin default.

### Hosted GitHub Actions Verification (`3576b513682757192c4ab3548adac882881be42d`)
| Workflow | Run ID | Status | Conclusion |
|---|---|---|---|
| `CI Verification & Production Hardening Checks` | `44671776407` | `completed` | `success` |
| `Deploy Celebration Sisters frontend to GitHub Pages` | `44671776421` | `completed` | `success` |

---

## 2. Live Frontend & Bundle Audit (`https://celebrationsistersdecor.com/`)

- **Live Compiled Bundle:** `/assets/index-DeJX_fAg.js`
- **Embedded Railway Origin:** Verified `https://celebrationsisterseventdecor-production.up.railway.app` is embedded in the deployed static asset bundle.
- **API Client Routing (`src/lib/apiClient.ts`):** 100% of frontend `/api/*` calls route through `apiFetch('/api/...')` (zero raw relative `fetch('/api/...')` calls anywhere in `src/`). No `/api/api` duplication occurs because `normalizeApiBaseUrl()` strips trailing slashes and callers pass `/api/...` paths.
- **Live Browser Verification (Read-Only):**
  - Desktop (`1440x900`) & Mobile (`390x844`): 6/6 API requests hit `celebrationsisterseventdecor-production.up.railway.app` with HTTP `200`, `0` console errors, `0` page errors, `0` failed requests, `0px` horizontal page/modal overflow.

---

## 3. Live Railway Backend Audit (`https://celebrationsisterseventdecor-production.up.railway.app/`)

All live probes were strictly read-only (`GET` / `OPTIONS`) to honor production authorization boundaries.

| Endpoint | Method | Origin Header | HTTP Status | Observed Result |
|---|---|---|---|---|
| `/health` | `GET` | `https://celebrationsistersdecor.com` | `200` | `{"ok":true,"status":"alive"}`, `X-Request-Id` present, `ACAO` matched |
| `/ready` | `GET` | `https://celebrationsistersdecor.com` | `200` | PostgreSQL `connected: true`, `latencyMs: 2`, `adapter: "postgres"`, `hostClass: "railway-internal"` |
| `/api/auth/config` | `GET` | `https://celebrationsistersdecor.com` | `200` | `demoPersonasAvailable: false`, `allowedOriginsCount: 2`, `supabaseConfigured: false` |
| `/api/auth/session` | `GET` | `https://celebrationsistersdecor.com` | `200` | Guest session cleanly returned |
| `/api/consultations/availability` | `GET` | `https://celebrationsistersdecor.com` | `200` | Real 14-day schedule, 88 open slots, Thanksgiving `2026-11-26` blackout active |
| `/api/consultations/availability?timezone=Mars/Olympus` | `GET` | `https://celebrationsistersdecor.com` | `400` | Rejected invalid IANA timezone |
| `/api/consultations/availability?method=teleport` | `GET` | `https://celebrationsistersdecor.com` | `400` | Rejected invalid consultation method |
| `/api/consultations` | `GET` | `https://celebrationsistersdecor.com` | `401` | `AUTH_REQUIRED` (fail-closed) |
| `/api/admin/overview`, `/api/admin/outbox`, `/api/admin/metrics` | `GET` | `https://celebrationsistersdecor.com` | `403` | `ADMIN_REQUIRED` (fail-closed) |
| `/api/consultations` | `OPTIONS` | `https://www.celebrationsistersdecor.com` | `204` | `ACAO` matched, `ACAC: true`, `X-Consultation-Token` & `Idempotency-Key` allowed |
| `/api/consultations/availability` | `OPTIONS` | `https://evil-attacker.example.com` | `403` | `CORS_ORIGIN_DENIED`, no `ACAO` header |
| `/api/consultations/status?referenceCode=CS-2026-0065` | `GET` | `https://celebrationsistersdecor.com` | **`503` (DEFECT FOUND)** | `RATE_LIMITER_UNAVAILABLE` — see Section 4 |

---

## 4. Critical Live Defects & Unconfigured Production Dependencies Found

1. **CRITICAL LIVE DEFECT — `HTTP 503 RATE_LIMITER_UNAVAILABLE` on All `failClosed: true` Endpoints:**
   - **Observed:** `GET /api/consultations/status` on live Railway returned `HTTP 503` (`code: "RATE_LIMITER_UNAVAILABLE"`).
   - **Root Cause:** Railway PostgreSQL had `app_state_snapshots` auto-created on boot by `ensureStateTable()`, but database migrations `001`–`008` have not yet been applied to the live Railway PostgreSQL database, so `rate_limit_buckets` (from `db/migrations/004_production_hardening.sql`) does not exist (`42P01`). Every `failClosed: true` route (`/api/consultations/status`, `reschedule`, `cancel`, `client-details`, `token/revoke`, `/api/bookings/track`, `/api/auth/*`) immediately fails closed with `503`.
   - **Code Repair Applied:** Updated `PostgresRateLimitStore` (`server/rateLimit.ts`) to idempotently bootstrap `rate_limit_buckets` once on `42P01` (matching `004_production_hardening.sql` DDL) while keeping real DB outages (`ECONNREFUSED`, timeouts) and restricted roles (`42501`) strictly fail-closed (`503`). Enhanced `checkPersistenceHealth()` (`GET /ready`) to report `schema.rateLimitTablePresent`, `schema.migrationsTablePresent`, and `schema.migrationsAppliedCount`.
   - **Required Operator Action:** Run `npx tsx scripts/run-migrations.ts` against Railway PostgreSQL (`001`–`008`) and deploy the Phase 18 branch after PR review.
2. **Production Supabase Auth Unconfigured on Railway (`/ready`):**
   - `auth.supabaseConfigured: false`, `auth.readyForProductionAuth: false`. Admin/staff/client sign-in cannot execute in production until `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_JWT_SECRET`) are provisioned on Railway and `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are set in GitHub Actions variables.
3. **Production Resend Email Unconfigured on Railway (`/ready`):**
   - `email.provider: "unconfigured"`, `email.configured: false`, `email.liveDeliveryEnabled: false`. Notifications are safely persisted in the studio outbox without claiming delivery until `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `STAFF_NOTIFICATION_EMAIL`, and (after staging verification) `EMAIL_LIVE_DELIVERY_ENABLED=true` are configured.
