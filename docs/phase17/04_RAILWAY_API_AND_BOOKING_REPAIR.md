# Phase 17 — Railway API Integration & Live Consultation Booking Repair Report

**Public Website Probed:** https://celebrationsistersdecor.com/  
**Live Bundle Inspected:** `/assets/index-DGQbbIrc.js` (459,649 bytes, deployed via Run `44614486936`)  
**Code Repairs Status:** `VERIFIED` (unit tests 80/80 + Chromium E2E 20/20 + Static Pages zero-404 Chromium proof)  
**Live Railway Deployment & GitHub `VITE_API_BASE_URL` Cutover Status:** `BLOCKED` (awaiting operator Railway deploy + GitHub Actions repository variable configuration)

---

## 1. Forensic Root-Cause Analysis of Live Production Symptoms

Direct HTTP inspection of `https://celebrationsistersdecor.com/` during Phase 17 uncovered the exact combined infrastructure + frontend root cause of both reported live defects:

1. **Defect A — `"Unable to load studio consultation availability."`:**
   - Probing `https://celebrationsistersdecor.com/assets/index-DGQbbIrc.js` returned **`BACKEND URL HITS IN LIVE JS: []`** — proving GitHub Actions repository variable `vars.VITE_API_BASE_URL` was **empty/unset** during `deploy-pages.yml`.
   - Probing `GET https://celebrationsistersdecor.com/api/consultations/availability` and `/health` returned **GitHub Pages static HTML `404 Not Found`** (`content-type: text/html; charset=utf-8`).
   - **Frontend Code Bug #1 (`src/lib/apiClient.ts`):** Static-host detection previously relied only on `viteBase !== '/'`. When the custom apex domain (`celebrationsistersdecor.com`) switched Vite `base` to `'/'`, `onStaticPages` evaluated to `false`, causing `isBackendConfigured` to become falsely `true` and sending relative `fetch('/api/...')` calls straight into GitHub Pages static HTML hosting.

2. **Defect B — Browser Console HTTP `404` Errors for `/api/auth/personas` and `/api/auth/session`:**
   - **On unconfigured static Pages:** Because `isBackendConfigured` was falsely `true`, `App.tsx` immediately fired `GET /api/auth/session` and `GET /api/auth/personas` against GitHub Pages -> guaranteed HTML `404`s.
   - **Even after connecting Railway in production (`NODE_ENV=production`):** `server/app.ts` intentionally returns `404` on `GET /api/auth/personas` in production (fail-closed demo-persona protection), yet `src/App.tsx` previously fetched `/api/auth/personas` unconditionally on every page load!

---

## 2. Permanent Phase 17 Repairs Implemented & Verified

| Component | Repair Implemented | Verification Proof |
| :--- | :--- | :--- |
| `vite.config.ts` | Defines `import.meta.env.VITE_GITHUB_PAGES` (`'true'` when `GITHUB_PAGES=true`). | `GITHUB_PAGES=true GITHUB_PAGES_CUSTOM_DOMAIN=true npm run build:client` preserves `dist/CNAME` and root-relative `/assets/` while flagging static Pages mode. |
| `src/lib/apiClient.ts` | Updates `resolveApiEnvironment()` to detect static Pages builds via `staticPagesBuild` (`VITE_GITHUB_PAGES === 'true'`) AND `isStaticPagesHostname()` (`celebrationsistersdecor.com`, `www.celebrationsistersdecor.com`, `*.github.io`). When `VITE_API_BASE_URL` is empty on static Pages, `backendConfigured` is `false` and `apiFetch()` returns deterministic JSON `503 BACKEND_NOT_CONFIGURED` instead of issuing HTML `404` network calls. When `VITE_API_BASE_URL` is configured, all `/api/*` requests target the cross-origin Railway backend with `credentials: 'include'`. | `tests/phase17-staging-and-api-routing.test.ts` (Tests 1 & 2) + Static Pages Zero-404 Chromium proof (`api404Count: 0`, `consoleErrorCount: 0`). |
| `server/app.ts` | Adds `demoPersonasAvailable: process.env.NODE_ENV !== 'production'` to `GET /api/auth/config` while keeping `GET /api/auth/personas` fail-closed (`404`) in production. | `tests/phase17-staging-and-api-routing.test.ts` (Test 3) + compiled runtime `/api/auth/config` smoke check. |
| `src/App.tsx` | Skips auth bootstrap fetches when `!isBackendConfigured`; calls `/api/auth/config` + `/api/auth/session` (`200 OK` in all modes) and only fetches `/api/auth/personas` when `demoPersonasAvailable === true`. | Zero `/api/auth/personas` `404` calls in production AND zero `/api/*` `404` calls on unconfigured static Pages. |
| `src/components/ConsultationModal.tsx` | Validates `application/json` `Content-Type` on availability responses and displays clear, honest diagnostics for `503 BACKEND_NOT_CONFIGURED` or non-JSON `404` responses without fabricating studio availability. | Chromium `P16-BA-05`, `P16-BA-18`, and Static Pages dialog check. |
| `.github/workflows/deploy-pages.yml` | Adds explicit build-time `VITE_API_BASE_URL` validation step: logs a visible GitHub Actions `::warning::` if unset, validates `https://` scheme when set, and asserts the backend origin is embedded into `dist/assets/*.js`. | Local build verification with `VITE_API_BASE_URL=https://staging-api.celebrationsistersdecor.com` confirmed origin embedded into `dist/assets/*.js`. |
| `.env.example` | Updates `ALLOWED_ORIGINS` template to include `https://celebrationsistersdecor.com,https://www.celebrationsistersdecor.com,https://ophireumtechnology.github.io`. | CORS `OPTIONS` preflight test against compiled `dist-server/server.mjs` returned `204 No Content` with `Access-Control-Allow-Origin: https://celebrationsistersdecor.com`, `Access-Control-Allow-Credentials: true`, and `X-Consultation-Token` + `Idempotency-Key` in `Access-Control-Allow-Headers`. |

---

## 3. Blocked External Staging Gate & Exact Operator Cutover Steps (`REQ-RAIL-01`)

**Why `BLOCKED`:** No Railway CLI token or live Railway staging URL is available inside this sandbox.

**Operator Staging Cutover Checklist:**
1. Provision isolated Railway **Staging** service + **Staging PostgreSQL 16+** database.
2. Configure Staging Railway environment variables:
   - `NODE_ENV=production`
   - `PERSISTENCE_ADAPTER=postgres`
   - `DATABASE_URL=<railway-staging-postgres-url>`
   - `SESSION_SECRET=<32+-byte-random-secret>`
   - `ALLOWED_ORIGINS=https://celebrationsistersdecor.com,https://www.celebrationsistersdecor.com,https://ophireumtechnology.github.io`
   - `ENABLE_NOTIFICATION_WORKER=true`
   - `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `STAFF_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET` (staging values only)
3. Deploy Railway staging backend and confirm over HTTPS:
   - `GET https://<railway-staging-domain>/health` -> `200 OK`
   - `GET https://<railway-staging-domain>/ready` -> `200 OK` with `persistence.adapter: "postgres"` and `persistence.connected: true`
   - `GET https://<railway-staging-domain>/api/auth/config` -> `200 OK` with `demoPersonasAvailable: false`
   - `GET https://<railway-staging-domain>/api/consultations/availability?date=2027-06-15&timezone=America/New_York` -> `200 OK` with studio slots
4. Set GitHub Repository Variable `VITE_API_BASE_URL=https://<railway-staging-domain>` (for staging validation, or production Railway URL only after explicit production approval) and re-run `Deploy Celebration Sisters frontend to GitHub Pages`.
5. Confirm `deploy-pages.yml` passes the embedded-origin check and reload the deployed site to verify live studio consultation slots load with `0` console errors and `0` `404`s.
