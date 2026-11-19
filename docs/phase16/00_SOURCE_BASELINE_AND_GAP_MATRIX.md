# Phase 16 — Source Baseline & Gap Matrix

**Project:** Celebration Sisters Event Decor (`https://celebrationsistersdecor.com/`)  
**GitHub Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Audit Date:** 2026-11-19  
**Live GitHub `main` Reference SHA:** `f2ea737d249ad83889705ed41b19b8083ac14a92` (verified via GitHub REST API)  
**Target Development Branch:** `feature/phase16-complete-platform-integration`

---

## 1. Execution Environment & Capability Inventory

| Capability / Tool | Availability | Evidence / Impact |
| --- | --- | --- |
| GitHub Public REST API (`https://api.github.com`) | **AVAILABLE** | Queried live `main` SHA, open PRs (#14, #15, #16), file diffs, and GitHub Actions run status. |
| Node.js v22, `npm`, `tsx`, `tsc`, `oxlint`, `esbuild`, `vite` | **AVAILABLE** | Executed typecheck, lint, 75 automated tests, builds, and compiled production smoke tests. |
| Preinstalled Headless Chromium (`playwright-core`) | **AVAILABLE** | Executed 20-scenario real Chromium browser acceptance across Desktop `1440x900` and Mobile `390x844`. |
| Local `.git` directory / authenticated GitHub push token / `gh` CLI | **BLOCKED (Sandbox)** | No `.git` metadata or write credentials exist in `/app/applet`; branch sync & PR creation must be performed from an authenticated developer clone. |
| Native PostgreSQL server / `psql` / `docker` daemon | **BLOCKED (Sandbox)** | No `postgres`, `psql`, `initdb`, `pg_ctl`, or `docker` binary in container; live SQL execution, live PG RLS role proofs, and Docker build are `BLOCKED` until run against Railway Staging PG / GitHub Actions runner. |
| Railway Staging credentials & live Resend staging API key | **BLOCKED (External)** | Not present in sandbox; production secrets and live customer sends remain strictly untouched per safety policy. |

---

## 2. Phase 16 Initial Gap Discovery & Remediation Matrix

| Gap ID | Domain | Finding at Phase 16 Start | Phase 16 Action Taken | Final Status |
| --- | --- | --- | --- | --- |
| `GAP-16-01` | CI / Lockfile Hygiene | Obsolete `/bun.lock` (42,321 bytes) existed alongside `package-lock.json`, and `package-lock.json` was missing `playwright-core@1.65.1` causing `npm ci` to fail (matching live `main` CI failures `44569280436` / `44569280255`). | Deleted `/bun.lock`; resynchronized `package-lock.json` via `npm install --package-lock-only`; verified `npm ci --dry-run --no-audit --no-fund` succeeds. | **VERIFIED** |
| `GAP-16-02` | Split-Origin CORS | `server/authz.ts` omitted `X-Consultation-Token` from `Access-Control-Allow-Headers`, which would block cross-origin GitHub Pages -> Railway client self-service portal preflights. | Added `X-Consultation-Token` to `Access-Control-Allow-Headers` and added automated split-origin CORS preflight regression test. | **VERIFIED** |
| `GAP-16-03` | Resend Config Single Source of Truth | 7 direct `process.env.STAFF_NOTIFICATION_EMAIL` reads existed in `server/app.ts` with inconsistent fallbacks (`directors@...` vs `maya@...`). | Added canonical `getStaffNotificationRecipient()` in `server/notifications.ts` backed by `getEmailRuntimeConfig()`; replaced all 7 reads in `server/app.ts`; enforced 0 direct email env reads outside `server/notifications.ts` via automated test. | **VERIFIED** |
| `GAP-16-04` | Operational Observability & Alerting | `POST /api/consultations` did not record `observability.recordBookingOutcome()`; `ObservabilityMetrics` lacked dedicated `webhooks` and `auth` security failure counters. | Added `webhooks` (`received`, `reconciled`, `deduplicated`, `rejectedSignature`, `unconfigured503`) and `auth` (`unauthorized401`, `forbidden403`, `mfaRequired403`, `invalidConsultationToken403`) to `server/observability.ts`, wired across `server/app.ts` and `server/authz.ts`, verified via `/api/admin/metrics`. | **VERIFIED** |
| `GAP-16-05` | Ordered SQL Migration Runner | Workspace had static migration validator (`scripts/verify-migrations.ts`) but lacked a canonical, transactional, checksum-tracked SQL migration runner for `001`–`008`. | Created `scripts/run-migrations.ts` with `schema_migrations` checksum verification, per-file `BEGIN/COMMIT/ROLLBACK`, `--dry-run`, and fail-closed TLS via `buildPostgresSslConfig()`; verified offline dry-run and mock-PG transaction/rollback/drift tests. | **VERIFIED (Runner) / BLOCKED (Live PG Execution)** |
| `GAP-16-06` | Booking Concurrency, DST & Crash Recovery | Needed explicit 2/3/10/25-way slot contention tests, US DST transition validation, and stale `Claimed` outbox worker crash-recovery verification. | Implemented and passed all concurrency, Idempotency-Key, DST spring-forward/fall-back, and worker lease-reclamation tests in `tests/phase16-platform-acceptance.test.ts`. | **VERIFIED (App/JSON Adapter) / BLOCKED (Live PG MVCC)** |
| `GAP-16-07` | Full 20-Scenario Browser Acceptance | Phase 15R browser suite covered 18 checks; lacked public navigation traversal, planner reassignment reload persistence, CRM stage/outcome reload persistence, Proposal Handoff UI, and unauthorized admin API checks. | Created and passed all **20/20** scenarios in `scripts/phase16-browser-acceptance.ts` across real headless Chromium (`1440x900` + `390x844`). | **VERIFIED (Local Bundle) / BLOCKED (PG-Backed Staging)** |
| `GAP-16-08` | External Staging & Live Infrastructure | Live PostgreSQL 16+ migration & RLS role execution, Railway live staging deploy, Resend live staging send/webhook, Docker daemon image build, and GitHub PR push cannot execute inside the isolated sandbox. | Documented exact runbooks, SQL verification commands, and strict `BLOCKED` gates without fabricating completion. | **BLOCKED (External Infrastructure)** |
