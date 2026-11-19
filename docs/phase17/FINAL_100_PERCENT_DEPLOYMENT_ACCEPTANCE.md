# Phase 17F — Final 72-Requirement Pre-Deployment Acceptance Report

**Project:** Celebration Sisters Event Decor  
**Repository:** https://github.com/OphireumTechnology/CelebrationSistersEventDecor  
**Public Website:** https://celebrationsistersdecor.com/  
**Execution Date:** `2026-11-19`  
**Verified Live `main` Commit SHA:** `6b540d458257f5566c2c2fc916fb92154f980142` (`2026-11-19T21:28:42Z`)  
**Target PR Branch for Phase 17F Additions:** `feature/phase17-staging-production-acceptance`

---

## 1. Honest Scorecard vs Target

| Metric | Phase 17F Target | Actual Executed Result (`2026-11-19`) |
| :--- | :---: | :---: |
| **VERIFIED** | 72 | **66** |
| **BLOCKED (External Infrastructure / Credentials Unavailable in Sandbox)** | 0 | **6** |
| **FAILED** | 0 | **0** |
| **NOT TESTED** | 0 | **0** |
| **Pre-Deployment Readiness Percentage** | 100.0% | **91.7%** (`66 / 72`) |
| **Final Release Classification** | `PRODUCTION_APPROVAL_REQUIRED` | **`CODE_READY` / `STAGING_READY`** |

> **Strict Evidence & Truthfulness Certification:** Zero externally blocked requirements were converted into `VERIFIED`. All 66 verified requirements are backed by executed tests, live GitHub REST API workflow runs (`44619161583`, `44619161406`), and real headless Chromium runs (`20/20` local compiled + live `https://celebrationsistersdecor.com/` zero-404 check). The remaining 6 requirements are factually blocked solely by missing external credentials/binaries inside the AI Studio build sandbox (`.git`/`GITHUB_TOKEN`, `DATABASE_URL`/`psql`/`pg_dump`/`postgres`, `RAILWAY_TOKEN`/`railway`, `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET`). All turnkey verification harnesses and source repairs required to close all 6 gates in one operator pass are now complete and verified locally (`84/84` automated tests passing).

---

## 2. Key Milestones Achieved in Phase 17F

1. **Live GitHub & Public Site Verification (`6b540d458257f5566c2c2fc916fb92154f980142`):**
   - Confirmed all 18 Phase 17 files landed on GitHub `main` (`6b540d45`), passing CI Run `44619161583` (`verify` + `Docker Production Image Build Check`) and GitHub Pages Run `44619161406` (`build` + `deploy`).
   - Verified directly in headless Chromium on `https://celebrationsistersdecor.com/` that live `/api/auth/personas` and `/api/auth/session` HTTP `404` errors are now **completely eliminated (`api404Count: 0`, `consoleErrors: []`, `pageErrors: []`)**.
2. **Real PostgreSQL SQLSTATE Error Classification Defect Found & Repaired (`server/lib/pgErrorClassifier.ts` + `server/app.ts`):**
   - Mapped PostgreSQL `23P01` (`exclusion_violation`), `23505` (`unique_violation`), `40001` (`serialization_failure`), `40P01` (`deadlock_detected`) -> HTTP **`409 Conflict`** (`SLOT_CONFLICT`).
   - Mapped PostgreSQL `42501` (`insufficient_privilege` / RLS rejection) -> HTTP **`403 Forbidden`** (`FORBIDDEN`) with zero SQL/schema/PII leakage.
   - Mapped PostgreSQL connection interruption codes (`08001`/`08003`/`08006`/`57P01`/`57P02`/`57P03`/`ECONNRESET`) -> HTTP **`503 Service Unavailable`** (`DATABASE_UNAVAILABLE`).
3. **Complete Turnkey Staging Acceptance Harnesses Implemented & Tested (`84/84` passing):**
   - `scripts/verify-staging-postgres.ts`: Full 10-point `NOBYPASSRLS` RLS isolation suite (with fail-closed superuser/BYPASSRLS detection), 2/3/10/25-way multi-connection MVCC races (`23P01`), reschedule-conflict + cancel-release + DST UTC checks, production-label URL safeguard, and optional `--backup-restore-drill`.
   - `scripts/verify-staging-railway-and-resend.ts`: Complete 13-check Railway Staging API + Resend signed Svix webhook verifier (executed live against Express in `tests/phase17f-staging-harnesses.test.ts` — 13/13 checks passed).
   - `scripts/phase16-browser-acceptance.ts`: Upgraded with `TARGET_FRONTEND_URL` + `TARGET_API_BASE_URL` live staging rerun support while passing **20 / 20** locally.

---

## 3. Complete 72-Requirement Acceptance Ledger

All `VERIFIED` rows below were executed on **`2026-11-19`** against live `main` commit **`6b540d458257f5566c2c2fc916fb92154f980142`** (plus local Phase 17F verified additions where noted).

| Req ID | Responsible Component | Status | Test Name / Verification Method | Environment | Actual Result | Evidence Location |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `REQ-01` | `src/App.tsx` (Branding) | `VERIFIED` | `P16-BA-01` Chromium Brand Check | Local Compiled + Live Edge | Official title & branding visible | `docs/phase17/06_*.md`, `14_*.md` |
| `REQ-02` | `src/App.tsx` (Navigation) | `VERIFIED` | `P16-BA-02` Chromium Navigation | Local Compiled Chromium | `Services -> Portfolio -> AI Studio -> Home` | `docs/phase17/06_*.md` |
| `REQ-03` | `ConsultationModal.tsx` | `VERIFIED` | `P16-BA-03` Accessible Modal Focus | Local Compiled Chromium | Focus trapped + Escape close/reopen | `docs/phase17/06_*.md` |
| `REQ-04` | `ConsultationModal.tsx` | `VERIFIED` | `P16-BA-04` Step 1 Discovery & Theme | Local Compiled Chromium | Date guard + Event Theme persisted | `docs/phase17/06_*.md` |
| `REQ-05` | `server/scheduling.ts` | `VERIFIED` | `P16-BA-05` + `STG-API-05` Availability | Local Compiled Chromium | Real studio slots loaded & selectable | `docs/phase17/06_*.md`, `12_*.md` |
| `REQ-06` | `server/app.ts` / Modal | `VERIFIED` | `P16-BA-06` Consent & Past-Slot Guard | Local Compiled Chromium | Missing consent blocked + past slot `400` | `docs/phase17/06_*.md` |
| `REQ-07` | `server/app.ts` (Booking) | `VERIFIED` | `P16-BA-07` Valid Booking Persistence | Local Compiled Chromium | Persisted `CS-2027-0065` cleanly | `docs/phase17/06_*.md` |
| `REQ-08` | `server/app.ts` (Tokens) | `VERIFIED` | `P16-BA-08` Scoped `csa_` Token Display | Local Compiled Chromium | `tokenLen=47`, SHA-256 stored | `docs/phase17/06_*.md` |
| `REQ-09` | `server/app.ts` (Token Auth) | `VERIFIED` | `tests/phase17` Test 4 Expired/Revoked | Node Test Runner | HTTP `403` on expired & revoked tokens | `tests/phase17-staging-and-api-routing.test.ts` |
| `REQ-10` | `ConsultationModal.tsx` | `VERIFIED` | `P16-BA-10` + `STG-API-09` Self-Service | Local Compiled Chromium | Wrong token `403`; valid token opens booking | `docs/phase17/06_*.md`, `12_*.md` |
| `REQ-11` | `server/app.ts` (Reschedule) | `VERIFIED` | `P16-BA-11` + `tests/phase17f` Test 4 | Local Compiled Chromium | Slot moved cleanly; conflict rejected `409` | `docs/phase17/06_*.md`, `11_*.md` |
| `REQ-12` | `server/app.ts` (Cancel) | `VERIFIED` | `P16-BA-12` + `tests/phase17f` Test 4 | Local Compiled Chromium | Status -> `Cancelled`, slot released for rebook | `docs/phase17/06_*.md`, `11_*.md` |
| `REQ-13` | `server/email.ts` (ICS) | `VERIFIED` | `tests/phase14/15` ICS Calendar Test | Node Test Runner | Valid RFC 5545 VCALENDAR/VEVENT emitted | `tests/phase15-e2e-and-hardening.test.ts` |
| `REQ-14` | `server/app.ts` (Idempotency) | `VERIFIED` | `tests/phase14/16` + `STG-API-08` | Node Test Runner | Duplicate key returns `200`, `deduplicated: true` | `tests/phase17f-staging-harnesses.test.ts` |
| `REQ-15` | `server/scheduling.ts` | `VERIFIED` | `tests/phase16` 2-Way Booking Race | Node Test Runner | Exactly `1` `201`, `1` `409` | `docs/phase17/11_CONCURRENCY_ACCEPTANCE.md` |
| `REQ-16` | `server/scheduling.ts` | `VERIFIED` | `tests/phase16` 3-Way Booking Race | Node Test Runner | Exactly `1` `201`, `2` `409` | `docs/phase17/11_CONCURRENCY_ACCEPTANCE.md` |
| `REQ-17` | `server/scheduling.ts` | `VERIFIED` | `tests/phase16` 10-Way Booking Race | Node Test Runner | Exactly `1` `201`, `9` `409` | `docs/phase17/11_CONCURRENCY_ACCEPTANCE.md` |
| `REQ-18` | `server/scheduling.ts` | `VERIFIED` | `tests/phase16` 25-Way Booking Race | Node Test Runner | Exactly `1` `201`, `24` `409` | `docs/phase17/11_CONCURRENCY_ACCEPTANCE.md` |
| `REQ-19` | `server/scheduling.ts` | `VERIFIED` | `tests/phase14/16` Buffer Overlap + `120m` Notice | Node Test Runner | Buffers & `MIN_CONSULTATION_NOTICE_MINUTES=120` enforced | `tests/phase17f-staging-harnesses.test.ts` |
| `REQ-20` | `server/scheduling.ts` | `VERIFIED` | `tests/phase16` DST Spring/Fall Boundary | Node Test Runner | Canonical UTC slot integrity across DST | `docs/phase17/11_CONCURRENCY_ACCEPTANCE.md` |
| `REQ-21` | `ConsultationModal.tsx` | `VERIFIED` | `P16-BA-18` HTTP `503` Outage Test | Local Compiled Chromium | Actionable alert; zero false confirmations | `docs/phase17/06_*.md` |
| `REQ-22` | `src/lib/apiClient.ts` | `VERIFIED` | `tests/phase17` Test 1 Apex Static Guard | Node Test Runner | `celebrationsistersdecor.com` static detected | `tests/phase17-staging-and-api-routing.test.ts` |
| `REQ-23` | `src/lib/apiClient.ts` / CI | `VERIFIED` | `tests/phase17` Test 2 + Pages Build | Node + Vite Build | Cross-origin `VITE_API_BASE_URL` embedded cleanly | `docs/phase17/04_*.md` |
| `REQ-24` | `server/app.ts` / `App.tsx` | `VERIFIED` | `tests/phase17` Test 3 + Live Probe | Live Edge + Node | `demoPersonasAvailable` removes `404 personas` | `docs/phase17/12_*.md` |
| `REQ-25` | `src/lib/apiClient.ts` | `VERIFIED` | Live Chromium Probe on `celebrationsistersdecor.com` | Live Public Website | `api404Count: 0`, `consoleErrors: []`, `pageErrors: []` | `docs/phase17/12_*.md` |
| `REQ-26` | `ConsultationModal.tsx` | `VERIFIED` | Non-JSON / `503` Availability Handling | Local Compiled + Live | Checks `Content-Type` JSON; zero fake slots | `docs/phase17/04_*.md` |
| `REQ-27` | `server/totp.ts` / `auth.ts` | `VERIFIED` | `tests/phase14` + `P16-BA-13` RFC 6238 | Local Compiled Chromium | TOTP enrollment/verify; static code forbidden in prod | `docs/phase17/06_*.md` |
| `REQ-28` | `AdminConsultationCommandCenter` | `VERIFIED` | `P16-BA-13` Admin Confirm Flow | Local Compiled Chromium | Confirmed `CS-2027-0066` cleanly | `docs/phase17/06_*.md` |
| `REQ-29` | `server/app.ts` (CRM) | `VERIFIED` | `P16-BA-14` Planner Assignment Reload | Local Compiled Chromium | `user-admin-director` persisted across reload | `docs/phase17/06_*.md` |
| `REQ-30` | `server/app.ts` (CRM) | `VERIFIED` | `P16-BA-15` Outcome & CRM Stage Reload | Local Compiled Chromium | `Consultation Completed` persisted across reload | `docs/phase17/06_*.md` |
| `REQ-31` | `server/app.ts` (Proposals) | `VERIFIED` | `P16-BA-16` Proposal Handoff | Local Compiled Chromium | Itemized quotation issued; `Proposal Sent` | `docs/phase17/06_*.md` |
| `REQ-32` | `server/authz.ts` | `VERIFIED` | `P16-BA-17` Unauth Admin API Probe | Local Compiled Chromium | `/api/admin/metrics` & `/outbox` -> `403` | `docs/phase17/06_*.md` |
| `REQ-33` | `AdminConsultationCommandCenter` | `VERIFIED` | `P16-BA-09` Admin Outbox Audit UI | Local Compiled Chromium | `CS-2027-0066` outbox row visible with honest status | `docs/phase17/06_*.md` |
| `REQ-34` | `src/` Responsive CSS | `VERIFIED` | `P16-BA-19` Mobile `390x844` Check | Local Compiled Chromium | `pageOverflow=0px`, `modalOverflow=0px`, `ctaHeight=44px` | `docs/phase17/06_*.md` |
| `REQ-35` | Full Frontend Bundle | `VERIFIED` | `P16-BA-20` Zero Console/Page Errors | Local Compiled + Live | `0` console errors, `0` uncaught pageerrors | `docs/phase17/06_*.md`, `12_*.md` |
| `REQ-36` | `server/authz.ts` (CORS) | `VERIFIED` | `STG-API-04` + Compiled `OPTIONS` | Local Compiled Express | Exact origin + credentials + `X-Consultation-Token` | `docs/phase17/12_*.md` |
| `REQ-37` | `server/authz.ts` (CSRF) | `VERIFIED` | `tests/` CSRF Origin & Token Suite | Node Test Runner | Mutating requests enforce CSRF protections | `tests/` (`84/84`) |
| `REQ-38` | `server/auth.ts` (Cookies) | `VERIFIED` | Malformed Cookie & Prototype Key Test | Node Test Runner | Never crashes session parser or routes | `tests/` (`84/84`) |
| `REQ-39` | `PostgresRateLimitStore` | `VERIFIED` | Rate Limit `429` + `Retry-After` Test | Node Test Runner | Request caps enforced + `Retry-After` header | `tests/` (`84/84`) |
| `REQ-40` | `server/app.ts` (Headers) | `VERIFIED` | Security Headers & Error Sanitization | Node Test Runner | Security headers + SQLSTATE `23P01`/`42501` sanitized | `server/lib/pgErrorClassifier.ts` |
| `REQ-41` | `server.ts` / `app.ts` | `VERIFIED` | Compiled Production Fail-Closed Startup | Local Compiled Binary | Exits non-zero without `DATABASE_URL` in prod | `docs/phase17/02_*.md` |
| `REQ-42` | `postgresRepository.ts` | `VERIFIED` | `buildPostgresSslConfig` TLS Audit | Node Test Runner | Verified TLS enforced; insecure downgrade rejected | `docs/phase17/02_*.md` |
| `REQ-43` | `supabase/migrations/` | `VERIFIED` | `scripts/verify-migrations.ts` | Local Sandbox | `8` ordered SQL migrations verified, `0` errors | `docs/phase17/09_*.md` |
| `REQ-44` | `supabase/migrations/` | `VERIFIED` | `scripts/verify-migrations.ts` RLS Check | Local Sandbox | `36 / 36` tables enforce `ENABLE + FORCE RLS` | `docs/phase17/10_*.md` |
| `REQ-45` | `scripts/run-migrations.ts` | `VERIFIED` | `--dry-run` + `tests/phase16` Runner Suite | Local Sandbox | `8/8` SHA-256 checksums, rollback & tamper detection | `docs/phase17/09_*.md` |
| `REQ-46` | `verify-staging-postgres.ts` | `VERIFIED` | `--self-check` + `tests/phase17f` Test 2 | Local Sandbox | Enforces `STAGING_DB_CONFIRM` + rejects prod URLs | `tests/phase17f-staging-harnesses.test.ts` |
| `REQ-47` | `reconcile-snapshot-to-normalized.ts` | `VERIFIED` | Financial & Entity Parity Audit | Local Sandbox | `44` entities, `0` anomalies, exact cent parity | `docs/phase17/09_*.md` |
| `REQ-48` | `server/repositories/` | `VERIFIED` | `tests/phase15/16` `SET LOCAL` Context | Node Test Runner | Transaction-scoped RLS context verified | `docs/phase17/10_*.md` |
| `REQ-49` | `postgresRepository.ts` | `VERIFIED` | `SELECT 1` + `FOR UPDATE` + `ROLLBACK` | Node Test Runner | Atomic lock + rollback + `/ready` `503` on error | `tests/` (`84/84`) |
| `REQ-50` | `server/lib/emailService.ts` | `VERIFIED` | 5-Var Resend Contract & Recipient Audit | Local Sandbox | Zero stray `STAFF_NOTIFICATION_EMAIL` reads | `docs/phase17/13_*.md` |
| `REQ-51` | `server/lib/emailService.ts` | `VERIFIED` | Honest Unconfigured Email Pause | Node + Chromium | Audits honestly without claiming delivery | `docs/phase17/13_*.md` |
| `REQ-52` | `notificationWorker.ts` | `VERIFIED` | Retry Backoff & Dead-Letter Suite | Node Test Runner | Transient retries & dead-letter recording pass | `docs/phase17/13_*.md` |
| `REQ-53` | `server/app.ts` (Webhooks) | `VERIFIED` | `STG-RES-01` + `tests/phase15/16` HMAC | Node Test Runner | Valid `200`, tampered `401` | `docs/phase17/13_*.md` |
| `REQ-54` | `server/app.ts` (Webhooks) | `VERIFIED` | `STG-RES-02` + `tests/phase17` Replay | Node Test Runner | Timestamp `> 300s` rejected fail-closed (`401`) | `docs/phase17/13_*.md` |
| `REQ-55` | `server/app.ts` (Webhooks) | `VERIFIED` | `STG-RES-03` Dedup & Terminal Lock | Node Test Runner | Duplicate `svix-id` deduped; terminal status locked | `docs/phase17/13_*.md` |
| `REQ-56` | `notificationWorker.ts` | `VERIFIED` | Stale Worker Lease Recovery Test | Node Test Runner | Expired locks reclaimed cleanly | `docs/phase17/13_*.md` |
| `REQ-57` | `server/observability.ts` | `VERIFIED` | `tests/phase16` Metrics & `X-Request-Id` | Local Compiled | Booking/webhook/auth metrics + correlation IDs | `docs/phase17/07_*.md` |
| `REQ-58` | `server/observability.ts` | `VERIFIED` | Structured Log Secret Redaction Test | Node Test Runner | Credentials/tokens stripped from structured logs | `docs/phase17/07_*.md` |
| `REQ-59` | `server.ts` | `VERIFIED` | Compiled Binary `SIGTERM` Smoke Test | Local Compiled | Graceful HTTP & worker shutdown (`exit 0`) | `docs/phase17/07_*.md` |
| `REQ-60` | `package-lock.json` | `VERIFIED` | `npm ci --dry-run` + `bun.lock` Absence | Local + GitHub `6b540d45` | `package-lock.json` sole lockfile; `up to date` | `docs/phase17/08_*.md` |
| `REQ-61` | Codebase (`src/server/tests`) | `VERIFIED` | `npm run typecheck && npm run lint` | Local + Hosted CI | `0` TS errors, `0` ESLint/Oxlint warnings | `docs/phase17/14_*.md` |
| `REQ-62` | `tests/*.test.ts` | `VERIFIED` | `npm test` Full Suite | Local Sandbox | **`84 / 84` passed**, `0` failed, `0` skipped | `docs/phase17/14_*.md` |
| `REQ-63` | Dependencies & Source | `VERIFIED` | `npm audit --audit-level=high` + Secret Scan | Local + Hosted CI | `0` high vulnerabilities, `0` hardcoded secrets | `docs/phase17/14_*.md` |
| `REQ-64` | `.github/workflows/ci.yml` | `VERIFIED` | Hosted CI Run `44619161583` (`verify`) | Hosted GitHub (`6b540d45`) | `completed / success` | `docs/phase17/08_*.md` |
| `REQ-65` | `Dockerfile` | `VERIFIED` | Hosted CI Run `44619161583` (`docker-build`) | Hosted GitHub (`6b540d45`) | `completed / success` | `docs/phase17/08_*.md` |
| `REQ-66` | `.github/workflows/deploy-pages.yml` | `VERIFIED` | Hosted Pages Run `44619161406` + Live Probe | Live Edge (`6b540d45`) | `build` + `deploy` `success`; live HTTP `200`, `0` 404s | `docs/phase17/08_*.md`, `12_*.md` |
| `REQ-GH-05` (`REQ-67`) | GitHub Remote & PRs | **`BLOCKED`** | Phase 17F Branch Push & PR + Legacy PR Cleanup | External GitHub | Phase 17 @ `6b540d45` is live/green; Phase 17F push blocked (no `.git`/`GITHUB_TOKEN`) | `docs/phase17/08_GITHUB_SYNC_ACCEPTANCE.md` |
| `REQ-PG-01` (`REQ-68`) | Railway Staging PG 16+ | **`BLOCKED`** | `scripts/verify-staging-postgres.ts --backup-restore-drill` | External Railway PG16 | Harness ready & tested; no `DATABASE_URL`/`psql`/`pg_dump` in sandbox | `docs/phase17/09_POSTGRESQL_LIVE_STAGING_ACCEPTANCE.md` |
| `REQ-RLS-01` (`REQ-69`) | PostgreSQL `NOBYPASSRLS` | **`BLOCKED`** | 10-Point Live `NOBYPASSRLS` RLS Suite | External Railway PG16 | All 10 checks scripted + `42501`->`403` tested; needs live staging PG16 | `docs/phase17/10_RLS_SECURITY_ACCEPTANCE.md` |
| `REQ-CONC-01` (`REQ-70`) | PostgreSQL `EXCLUDE USING gist` | **`BLOCKED`** | Multi-Connection 2/3/10/25-Way MVCC + DST Races | External Railway PG16 | Harness scripted + `23P01`->`409` tested; needs live staging PG16 | `docs/phase17/11_CONCURRENCY_ACCEPTANCE.md` |
| `REQ-RAIL-01` (`REQ-71`) | Railway Backend + Pages Var | **`BLOCKED`** | `verify-staging-railway-and-resend.ts` + Live Staging Playwright | External Railway + Pages | 13-check verifier & 20-check Playwright ready; needs Railway deploy + `VITE_API_BASE_URL` | `docs/phase17/12_RAILWAY_STAGING_ACCEPTANCE.md` |
| `REQ-RES-01` (`REQ-72`) | Resend + Live Svix Callback | **`BLOCKED`** | Controlled Internal QA Email Delivery & Reconciliation | External Resend + Railway | Svix HMAC/`300s`/dedup/terminal verified; needs staging Resend keys & QA inbox receipt | `docs/phase17/13_RESEND_DELIVERY_ACCEPTANCE.md` |

---

## 4. Operator Fast-Path to Close All 6 Blockers (`91.7% -> 100.0%` & `PRODUCTION_APPROVAL_REQUIRED`)

Execute these four commands from an authorized workstation with GitHub, Railway Staging PostgreSQL 16+, Railway Staging Backend, and Resend Staging credentials:

1. **Close `REQ-GH-05`:** Sync Phase 17F files onto `feature/phase17-staging-production-acceptance`, push, open PR targeting `main`, close superseded PRs `#2`–`#16`, and verify hosted `ci.yml` (`verify` + `docker-build`) passes green.
2. **Close `REQ-PG-01`, `REQ-RLS-01`, `REQ-CONC-01` in one command:**
   ```bash
   STAGING_DB_CONFIRM=YES_ISOLATED_STAGING \
   DATABASE_URL="<railway-staging-nobyprls-url>" \
   STAGING_RESTORE_DATABASE_URL="<railway-staging-restore-scratch-url>" \
   npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill
   ```
3. **Close `REQ-RAIL-01` & `REQ-RES-01`:** Deploy Railway Staging backend, set GitHub Actions variable `VITE_API_BASE_URL=https://<verified-railway-staging-domain>` (no `/api` suffix), verify Resend staging webhook `https://<verified-railway-staging-domain>/api/webhooks/resend`, then run:
   ```bash
   STAGING_API_CONFIRM=YES_ISOLATED_STAGING \
   STAGING_API_BASE_URL="https://<verified-railway-staging-domain>" \
   STAGING_RESEND_TEST_EMAIL="<authorized-internal-qa-inbox>" \
   RESEND_WEBHOOK_SECRET="<staging-svix-secret>" \
   npx tsx scripts/verify-staging-railway-and-resend.ts

   TARGET_FRONTEND_URL="https://<staging-frontend-url>" \
   TARGET_API_BASE_URL="https://<verified-railway-staging-domain>" \
   npx tsx scripts/phase16-browser-acceptance.ts
   ```
4. **Executive Production Promotion Gate:** Once all 72/72 requirements pass with live staging evidence, update status to `PRODUCTION_APPROVAL_REQUIRED` and request explicit authorization before merging to `main`, running production migrations, or activating live customer notifications.
