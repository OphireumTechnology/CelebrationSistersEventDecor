# 07 — Railway Infrastructure Audit

**Project:** Celebration Sisters Event Decor  
**Railway Staging Project:** `celebration-sisters-staging` (`786a7d31-23a8-4154-8185-0d5f07914c24`)  
**Railway Staging Environment:** `0ad6480e-6259-4a1a-81f8-a4bc89869cca`  
**Railway Staging Backend Service:** `5ba79779-aa42-4516-b294-900ef137f23c`  
**Railway Staging URL:** `https://celebrationsisterseventdecor-staging-staging.up.railway.app/`  
**Public Frontend URL:** `https://celebrationsistersdecor.com/`  
**Audit Date:** 2026-11-20T22:26:34Z

---

## 1. Live Read-Only Infrastructure Verification (`scripts/verify-deployment-and-rollback.ts`)

Executed live against `https://celebrationsisterseventdecor-staging-staging.up.railway.app/` (`--origin https://celebrationsistersdecor.com --strict`):

| Check ID | Description | Live Observed Result | Status |
| --- | --- | --- | --- |
| `liveness_and_headers` | `GET /health` + security headers | HTTP `200`, `ok: true`, `X-Request-Id`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Powered-By` hidden | **VERIFIED** |
| `readiness_probe` | `GET /ready` | HTTP `200`, `status: "ready"`, `productionReady: true`, `blockingReasons: []`, PostgreSQL latency `4ms`, `migrationsAppliedCount: 8`, `overlapConstraintPresent: true`, `worker.pollingActive: true` | **VERIFIED** |
| `auth_config_guard` | `GET /api/auth/config` | HTTP `200`, `provider: "supabase"`, `demoPersonasAvailable: false`, `readyForProductionAuth: true`, `allowedOriginsCount: 2` | **VERIFIED** |
| `unauth_fail_closed` | Unauthenticated protected endpoints | `/api/bookings` -> `401`, `/api/admin/overview` -> `403` | **VERIFIED** |
| `cors_allowlist` | Cross-origin enforcement | `https://celebrationsistersdecor.com` echoed; untrusted origin rejected (`null`) | **VERIFIED** |
| `consultation_availability` | Live availability calculation | HTTP `200`, `studioTimezone: "America/New_York"`, `days: 7` | **VERIFIED** |
| `canonical_migrations_integrity` | Local canonical SQL integrity | 8 canonical migrations validated with zero errors | **VERIFIED** |
| `rollback_and_dr_scripts` | Recovery tooling inventory | All 5 DR/verification scripts present | **VERIFIED** |

---

## 2. Public GitHub Pages Frontend Availability Check

Live read-only HTTP HEAD check against `https://celebrationsistersdecor.com/`:
- Returned `HTTP/2 200`, `content-type: text/html; charset=utf-8`, served via GitHub Pages (`last-modified: Fri, 20 Nov 2026 18:35:09 GMT`).

---

## 3. Infrastructure Deployment Note & Remaining Blockers

- **Important:** The live Railway staging deployment currently reflects PR #21 commit `de848c890138ee00db72ce08e093a0f337215226` prior to the Phase 21–30 workspace repairs (`ES256` JWKS priority over `SUPABASE_JWT_SECRET`, consolidated external login/session lifecycle, reload-safe non-secret TOTP factor handoff, closed `/api/auth/mfa/recover` & `/revoke` & `/password-reset`, cross-account consultation email isolation fix, and migration advisory lock).
- **Blocked:** Re-deploying this workspace repair commit to Railway staging, inspecting private Railway service environment variables, and verifying production Railway service variables remain **BLOCKED** pending push to GitHub and authorized Railway staging deployment. Production Railway settings were NOT touched.
