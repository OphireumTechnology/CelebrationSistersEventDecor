# Phase 17F — Railway Staging Backend & Live Availability Acceptance (`REQ-RAIL-01`)

**Public Website Probed Live (`2026-11-19`):** https://celebrationsistersdecor.com/  
**Live Bundle Verified:** `/assets/index-bdbFLwYt.js` (deployed from GitHub `main` SHA `5f1982df7a86b9c49da9ce0781b8215b79a97f1e` via Run `44621911905`)  
**Turnkey Staging Verifiers:** `scripts/verify-staging-railway-and-resend.ts`, `scripts/phase16-browser-acceptance.ts` (`TARGET_FRONTEND_URL` + `TARGET_API_BASE_URL` + portable Chromium resolution enabled)  
**Requirement Status:** **`BLOCKED`** *(live website zero-404 repair verified in real Chromium on `https://celebrationsistersdecor.com/`; live Railway staging deployment & `VITE_API_BASE_URL` cutover blocked by missing Railway credentials and GitHub repository variable write access in sandbox)*

---

## 1. Live Headless Chromium Verification on `https://celebrationsistersdecor.com/` (`VERIFIED`)

After commit `5f1982df7a86b9c49da9ce0781b8215b79a97f1e` deployed via Run `44621911905`, real headless Chromium directly loaded `https://celebrationsistersdecor.com/` and clicked "Book a Consultation":

```json
{
  "httpStatus": 200,
  "url": "https://celebrationsistersdecor.com/",
  "title": "Celebration Sisters Event Decor — Luxury Event Planning & Design",
  "scripts": [
    "/assets/index-bdbFLwYt.js"
  ],
  "dialogVisible": true,
  "apiResponses": [],
  "api404Count": 0,
  "consoleErrors": [],
  "pageErrors": []
}
```

**Confirmed Resolution of Live Console `404` Defects:**
- Previously observed `/api/auth/personas` (`404`) and `/api/auth/session` (`404`) requests are **100% eliminated** on the live public website.
- Consultation modal opens cleanly with zero console errors and zero fabricated studio availability.
- **Remaining Infrastructure Step:** `VITE_API_BASE_URL` is still unset in GitHub Actions repository variables, so live studio consultation availability will activate as soon as the Railway backend HTTPS origin is configured in GitHub repository variable `VITE_API_BASE_URL` and `deploy-pages.yml` rebuilds.

---

## 2. Sandbox Environment Probe (Factual Blocker Evidence)

- `railway`: `ABSENT`
- `RAILWAY_TOKEN` / `RAILWAY_API_TOKEN`: `UNSET`
- `VITE_API_BASE_URL` / `STAGING_API_BASE_URL`: `UNSET`

---

## 3. Turnkey Staging Verification Tooling Built & Verified Locally (`VERIFIED`)

1. **`scripts/verify-staging-railway-and-resend.ts` (13 checks):**
   - Verified end-to-end against a live Express server in `tests/phase17f-staging-harnesses.test.ts` (Test 3 — **13/13 checks passed**: `/health`, `/ready`, `/api/auth/config`, CORS preflight with `X-Consultation-Token` + `Idempotency-Key`, live `/api/consultations/availability`, 120-minute notice rejection, booking creation + outbox queuing, `Idempotency-Key` replay, wrong-token `403` vs valid-token `200`, reschedule + cancel release, plus 3 Svix webhook security checks).
2. **`scripts/phase16-browser-acceptance.ts` (20 Playwright scenarios):**
   - Supports `TARGET_FRONTEND_URL` + `TARGET_API_BASE_URL` and portable Chromium resolution (works both inside the AI Studio sandbox and on standard macOS/Linux/CI Playwright installations).
   - Local compiled execution passed **20 / 20** (`0` console errors, `0` pageerrors).

---

## 4. Exact Operator Commands to Close `REQ-RAIL-01`

```bash
# 1. Deploy Railway Staging service with NODE_ENV=production, PERSISTENCE_ADAPTER=postgres,
#    DATABASE_URL=<staging-pg>, SESSION_SECRET=<secret>, ALLOWED_ORIGINS=https://celebrationsistersdecor.com,...
# 2. Verify live Railway Staging API + CORS + Availability + Booking Lifecycle:
export STAGING_API_CONFIRM="YES_ISOLATED_STAGING"
export STAGING_API_BASE_URL="https://<verified-railway-staging-domain>"
export STAGING_FRONTEND_ORIGIN="https://celebrationsistersdecor.com"
npx tsx scripts/verify-staging-railway-and-resend.ts

# 3. Set GitHub Actions variable VITE_API_BASE_URL=https://<verified-railway-staging-domain>
#    (never append /api — frontend paths already begin with /api/) and trigger staging Pages build.
# 4. Run full 20-scenario Playwright suite against real staging HTTPS services:
TARGET_FRONTEND_URL="https://<staging-frontend-url>" \
TARGET_API_BASE_URL="https://<verified-railway-staging-domain>" \
npx tsx scripts/phase16-browser-acceptance.ts
```
