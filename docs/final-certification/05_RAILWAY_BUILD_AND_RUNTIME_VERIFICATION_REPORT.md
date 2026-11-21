# 05 — Railway Build and Runtime Verification Report

**Project:** Celebration Sisters Event Decor  
**Railway Staging Service URL:** `https://celebrationsisterseventdecor-staging-staging.up.railway.app/`  
**Public Website URL:** `https://celebrationsistersdecor.com/`  
**Probe Timestamp:** 2026-11-20T22:48:43Z

---

## 1. Live Read-Only HTTPS Runtime Probes Executed

All read-only probes were executed directly against live Railway staging (`scripts/verify-deployment-and-rollback.ts` + targeted negative route checks):

| Endpoint / Check | HTTP Status | Observed Live Response / Contract | Result |
| --- | --- | --- | --- |
| `GET /health` | `200` | `ok: true`, `status: "alive"`, `X-Request-Id`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Powered-By` hidden | **PASS** |
| `GET /api/health` | `200` | Health alias responds cleanly | **PASS** |
| `GET /ready` | `200` | `status: "ready"`, `productionReady: true`, `blockingReasons: []`, PostgreSQL `connected: true` (`4ms`), `migrationsAppliedCount: 8`, `overlapConstraintPresent: true`, `worker.pollingActive: true`, `email.liveDeliveryEnabled: false` | **PASS** |
| `GET /api/auth/config` | `200` | `provider: "supabase"`, `demoPersonasAvailable: false`, `readyForProductionAuth: true`, `allowedOriginsCount: 2` | **PASS** |
| `GET /api/consultations/availability` | `200` | `studioTimezone: "America/New_York"`, `days: 7` | **PASS** |
| `GET /api/auth/session` (unauth) | `200` | Safe public guest context | **PASS** |
| `GET /api/bookings` (unauth) | `401` | Fail-closed unauthorized | **PASS** |
| `GET /api/consultations` (unauth) | `401` | Fail-closed unauthorized | **PASS** |
| `GET /api/staff/checklists` (unauth) | `401` | Fail-closed unauthorized | **PASS** |
| `GET /api/inventory` (unauth) | `401` | Fail-closed unauthorized | **PASS** |
| `GET /api/admin/overview` (unauth) | `403` | Fail-closed forbidden | **PASS** |
| `GET /api/admin/overview` (spoofed `x-user-id` & `x-user-role: admin`) | `403` | Spoofed headers strictly ignored & rejected | **PASS** |
| `GET /api/nonexistent` | `404` | Clean 404 JSON error (zero HTTP 500s) | **PASS** |
| CORS allowlist (`https://celebrationsistersdecor.com` vs untrusted) | `200` | Trusted origin echoed; untrusted origin rejected (`null`) | **PASS** |
| Public Frontend `HEAD https://celebrationsistersdecor.com/` | `200` | Served via GitHub Pages (`text/html; charset=utf-8`) | **PASS** |

---

## 2. Unverified / Blocked Runtime Visibility

- **Railway Build Logs, Runtime Container Logs, and Private Environment Variable Inspection:** **BLOCKED** (no `RAILWAY_API_TOKEN` or Railway CLI session in sandbox).
- **Post-Deploy Verification of the New Phase 21–40 Reconciled Commit on Railway Staging:** **BLOCKED** until Phase 32 push and Phase 34 deployment complete.
