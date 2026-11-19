# Phase 13 — Evidence-Backed Defect Register

**Authoritative Baseline:** GitHub `main` @ `37b5a6c5c41c4c83bbeda18d74ddadc4b2745199`  
**Development Branch / Patch:** `development/phase-13-enterprise-hardening` (`docs/release/phase-13-enterprise-hardening.patch`)

---

## Summary Counts

| Severity | Identified | Fixed & Locally Verified | Externally Blocked (Staging Validation) | Unresolved Local |
|---|---:|---:|---:|---:|
| **Critical** | 1 | 1 | 1 (live Docker build on CI/Railway) | 0 |
| **High** | 7 | 7 | 4 (live Supabase/Railway/Resend staging gates) | 0 |
| **Medium** | 4 | 4 | 2 (live Gemini/browser E2E staging gates) | 0 |
| **Total** | **12** | **12** | **7 (external staging checks)** | **0** |

---

## Detailed Defect Records

### D-13-01 — Production Docker Image Fails on Alpine/musl Rolldown Binding & Missing `wget`
- **Severity:** Critical
- **Affected File / Function:** `Dockerfile` (`builder`, `runner`, `HEALTHCHECK`)
- **Reproduction:** Building `Dockerfile` on `node:22-alpine` with `package-lock.json` fails because Vite 8 / Rolldown locks `linux-x64-gnu` (glibc), unavailable on musl. Switching to `node:22-bookworm-slim` without replacing `wget` breaks `HEALTHCHECK`.
- **Root Cause:** Base image libc mismatch + Alpine-specific `wget` health probe.
- **Proposed Correction:** Reconcile PR #6/#7: use `node:22-bookworm-slim`, replace `HEALTHCHECK` with zero-dependency Node `http.get` probe, run container as non-root `USER node`.
- **Regression Test:** `ci.yml` `docker-build` job + Dockerfile static assertions in `tests/phase13-security-and-rate-limit.test.ts`.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED (Local static & config verified; live `docker build` pending GitHub Actions / Railway)**.

### D-13-02 — CI Secret Scanner False Positive on Payment Architecture Documentation
- **Severity:** High
- **Affected File / Function:** `docs/PAYMENT_INTEGRATION_ARCHITECTURE.md`, `docs/release/phase-12-release-integration.patch`, `.github/workflows/ci.yml`
- **Reproduction:** Running the `ci.yml` `grep -rnE '(sk_live_|...)'` check matches the literal live-key prefix example in `docs/PAYMENT_INTEGRATION_ARCHITECTURE.md`.
- **Root Cause:** Example key prefix string matched CI secret regex.
- **Proposed Correction:** Reconcile PR #7 prose update describing test/production Stripe secrets without literal key prefixes; add `bun.lock` rejection to CI hygiene step.
- **Regression Test:** Exact CI hygiene `grep` command verified locally with exit code `0`.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY**.

### D-13-03 — Rate Limiter `X-Forwarded-For` Spoofing & Silent In-Memory Fallback During PostgreSQL Outages
- **Severity:** High
- **Affected File / Function:** `server/rateLimit.ts` (`createRateLimiter`, `PostgresRateLimitStore.consume`), `server/app.ts`
- **Reproduction:** (1) Rotating `X-Forwarded-For` bypasses per-IP rate limits. (2) Express lacked explicit `trust proxy` configuration. (3) During PostgreSQL query failures/timeouts on `/api/auth/mfa/verify` or `/api/auth/mfa/totp/enroll`, `PostgresRateLimitStore` silently fell back to process-local memory instead of failing closed.
- **Root Cause:** Untrusted header extraction, missing proxy trust config, unconditional catch-and-fallback in `PostgresRateLimitStore`, and missing query timeout.
- **Proposed Correction:** Preserve PR #7's `req.ip || req.socket.remoteAddress || 'local'`, explicitly configure Express `trust proxy` (`TRUST_PROXY`), add query timeout + structured error logging (without leaking DB errors), and enforce `failClosed: true` (HTTP `503 RATE_LIMITER_UNAVAILABLE`) on critical auth/MFA/admin endpoints while preserving safe fallback on noncritical endpoints.
- **Regression Test:** `tests/production-hardening.test.ts` + `tests/phase13-security-and-rate-limit.test.ts` (spoofing, multi-instance shared PG store, DB outage fail-closed 503, noncritical fallback, timeout, retry non-bypass).
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY (live multi-replica PG verification pending staging DB)**.

### D-13-04 — CSRF Bypass via Arbitrary Custom Header & Post-Logout Session Reuse
- **Severity:** High
- **Affected File / Function:** `server/authz.ts` (`isCsrfOriginValid`), `server/auth.ts` (`signSessionToken`, `verifySessionToken`, `resolveAuthenticatedContext`), `server/app.ts` (`POST /api/auth/logout`, CSRF middleware), `src/lib/apiClient.ts`
- **Reproduction:** (1) Sending a cookie-authenticated `POST` without `Origin`/`Referer` but with forged `X-Requested-With: fake` or `X-CSRF-Token: bogus` bypassed CSRF protection. (2) Replaying a `cs_session` cookie or Bearer HMAC token after `POST /api/auth/logout` still succeeded because tokens lacked `jti` revocation.
- **Root Cause:** Permissive missing-Origin branch trusting arbitrary custom headers; stateless HMAC tokens with no server-side revocation registry.
- **Proposed Correction:** Add unique `jti` to every signed session token, derive cryptographic HMAC synchronizer CSRF tokens (`deriveCsrfToken(jti)` / `verifyCsrfToken`), persist revoked `jti`s on logout (`db.revokedSessionIds`), reject forged/invalid `X-CSRF-Token` and arbitrary `X-Requested-With` when Origin/Referer are absent, enforce trusted Origin/Referer or verified cryptographic CSRF token on all cookie mutations, and forward `X-CSRF-Token` from `src/lib/apiClient.ts`.
- **Regression Test:** `tests/phase13-security-and-rate-limit.test.ts` (10 CSRF & session test scenarios covering all Block 13.3 requirements).
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY**.

### D-13-05 — Admin TOTP Factor Overwrite Without Step-Up Auth, Missing Recovery/Revocation & Missing Account Suspension Control
- **Severity:** High
- **Affected File / Function:** `server/app.ts` (`POST /api/auth/mfa/totp/enroll`, `/api/auth/mfa/recover`, `/api/auth/mfa/totp/revoke`, `PATCH /api/admin/users/:id/status`), `server/identityProvider.ts` (`verifyProviderAccessToken`), `server/store.ts` (`sanitizeUserForClient`)
- **Reproduction:** An `aal1` admin session could call `POST /api/auth/mfa/totp/enroll` to replace an already-enrolled TOTP secret without step-up MFA verification. No recovery codes or authenticated factor revocation existed. JWTs without an `exp` claim were not explicitly rejected.
- **Root Cause:** Missing existing-factor step-up check, incomplete MFA lifecycle endpoints, missing `exp` claim presence check.
- **Proposed Correction:** Require `ctx.mfaVerified` (or valid single-use recovery code) to replace an already-enrolled TOTP factor; generate 8 SHA-256-hashed single-use recovery codes returned only during enrollment; add `POST /api/auth/mfa/recover`, `POST /api/auth/mfa/totp/revoke` (`aal2`), and `PATCH /api/admin/users/:id/status` (with self-suspension guard); strip `mfaRecoveryCodeHashes` in `sanitizeUserForClient`; require numeric `exp` on verified JWTs; emit audit & security events for all factor/status changes.
- **Regression Test:** `tests/phase13-security-and-rate-limit.test.ts`.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY**.

### D-13-06 — Booking Reference Collision Risk, Floating-Point Quotation Math & Financial/Workflow Edge Cases
- **Severity:** High
- **Affected File / Function:** `server/app.ts` (`POST /api/bookings`, `POST /api/bookings/:id/quotes`, `POST /api/bookings/:id/contract/sign`, `PATCH /api/bookings/:id/status`, `PATCH /api/bookings/:id/assignments`, `POST /api/bookings/:id/payments/:paymentId/refund`), `src/types/domain.ts`
- **Reproduction:** (1) `CS-2026-0${65 + db.bookings.length}` breaks formatting/collides beyond 99 or after deletion. (2) Floating-point quote math lacked integer-cent precision; discount could exceed subtotal; quote error handler returned `404` for non-404 errors; admin discount approval skipped MFA check. (3) Contract signing succeeded on `Cancelled` bookings. (4) No planner/vendor assignment or manual-ledger refund workflow existed.
- **Root Cause:** Array-length reference counter, float arithmetic, catch-all 404, missing cancelled-state guard and operational endpoints.
- **Proposed Correction:** Collision-free sequential reference generator (`CS-YYYY-NNNN`), integer-cent quotation math + `discount <= subtotal` validation + admin MFA gate for discount approval + accurate HTTP status codes, block contract signing on `Cancelled` bookings, cancel pending milestones on booking cancellation, add `PATCH /api/bookings/:id/assignments` and MFA-admin `POST /api/bookings/:id/payments/:paymentId/refund` (manual staging ledger only; live Stripe remains disabled).
- **Regression Test:** `tests/phase13-outbox-and-persistence.test.ts`.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY**.

### D-13-07 — Non-Transactional Inline Email Dispatch Vulnerable to Crash Loss & Missing Outbox Worker
- **Severity:** High
- **Affected File / Function:** `server/app.ts` (`POST /api/bookings`, `PATCH /api/bookings/:id/status`), `server/outbox.ts`, `db/migrations/006_normalized_and_outbox.sql`
- **Reproduction:** Booking creation committed before calling Resend inline; an app crash between commit and network dispatch lost notification intent permanently, with no durable retry schedule, worker lease recovery, or dead-letter queue.
- **Root Cause:** Inline side-effect outside database transaction.
- **Proposed Correction:** Introduce additive SQL migration `006_normalized_and_outbox.sql` (`notification_outbox` table + RLS) and `server/outbox.ts` (`enqueueOutboxNotification` executed inside the booking/status `withTransaction`, plus `NotificationOutboxWorker` with atomic leasing, crash-timeout reclaim, exponential backoff with jitter, idempotency keys, provider timeout, HTTP 429/5xx retries, `DeadLetter` terminal state, and approval gates).
- **Regression Test:** `tests/phase13-outbox-and-persistence.test.ts` (all 13 Block 13.7 scenarios).
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY (live Resend staging send pending approval & secrets)**.

### D-13-08 — Monolithic PostgreSQL Snapshot Bottleneck Without Normalized Repository Abstraction
- **Severity:** High
- **Affected File / Function:** `server/repositories/postgresRepository.ts`, `server/repositories/normalizedRepository.ts`, `scripts/reconcile-snapshot-to-normalized.ts`
- **Reproduction:** All entities persist inside a single `app_state_snapshots` JSONB row locked via `FOR UPDATE`, creating global write contention under concurrency and preventing relational FK/index enforcement.
- **Root Cause:** Phase 11/12 prioritized transactional safety on existing schema before normalized repository transition.
- **Proposed Correction:** Introduce `NormalizedPersistenceRepository` interface and `PostgresNormalizedRepository` implementing transactional relational CRUD, row-level locking, cent-exact financials, tenant isolation, and `FOR UPDATE SKIP LOCKED` outbox claiming, plus `scripts/reconcile-snapshot-to-normalized.ts` reconciliation & benchmark script — preserving `app_state_snapshots` untouched for safe zero-loss staging transition and rollback.
- **Regression Test:** `tests/phase13-outbox-and-persistence.test.ts`.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY (live staging PostgreSQL cutover pending owner approval)**.

### D-13-09 — Supabase RLS `app_current_role()` Defaulting to `guest` for Direct Auth JWTs & Uncovered Operational Tables
- **Severity:** High
- **Affected File / Function:** `db/migrations/002_rls_policies.sql`, `db/migrations/006_normalized_and_outbox.sql`, `scripts/verify-migrations.ts`
- **Reproduction:** `app_current_role()` only read `current_setting('app.current_role', true)` and defaulted to `'guest'`, ignoring authoritative `user_roles`/`roles` records for authenticated Supabase `auth.uid()` sessions. Seven tables from migration `001` (`leads`, `consultations`, `vendors`, `staff_assignments`, `event_tasks`, `inventory_reservations`, `notifications`) did not have RLS enabled.
- **Root Cause:** Helper function designed for backend `SET LOCAL` without fallback to relational `user_roles`.
- **Proposed Correction:** Update `app_current_role()` in additive migration `006` to resolve from `SET LOCAL app.current_role` OR authoritative `user_roles` JOIN `roles` for `app_current_user_id()` (never JWT `user_metadata`), enable RLS + explicit policies on all newly added and previously uncovered tables (32 total tables), and enforce them in `scripts/verify-migrations.ts`. Document service-role RLS bypass and app-layer enforcement boundary.
- **Regression Test:** `scripts/verify-migrations.ts` + `tests/migration-dryrun.test.ts`.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY (live Supabase RLS execution pending staging DB)**.

### D-13-10 — Gemini AI Missing Output Token Caps, Prompt-Injection Delimiter Isolation & Secret-Leakage Scrubber
- **Severity:** Medium
- **Affected File / Function:** `server/gemini.ts`, `server/app.ts`
- **Reproduction:** Gemini requests lacked explicit `maxOutputTokens` caps, concatenated user messages directly without delimiter framing, and did not verify AI outputs against secret/credential leakage patterns or record AI failure metrics.
- **Root Cause:** Initial Gemini integration focused on schema validation and timeout guards.
- **Proposed Correction:** Add explicit `maxOutputTokens` caps (`1024` Concierge, `2048` Concept Studio), wrap user input in `<client_input>` delimiters with explicit anti-injection instructions, scrub/reject secret patterns in AI outputs, and record AI call/failure telemetry + audit logs.
- **Regression Test:** `tests/phase13-outbox-and-persistence.test.ts` + `tests/ai-and-studio.test.ts`.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY (live Gemini staging verification pending `GEMINI_API_KEY`)**.

### D-13-11 — Frontend CSRF Synchronizer Header Forwarding & Accessibility Gaps
- **Severity:** Medium
- **Affected File / Function:** `src/lib/apiClient.ts`, `src/App.tsx`, `src/components/ConsultationModal.tsx`, `src/components/LuxuryHeader.tsx`
- **Reproduction:** Browser client did not forward cryptographic `X-CSRF-Token`; no skip-to-main-content link existed for keyboard users; `ConsultationModal` did not dismiss on `Escape` or expose `role="alert"` / `aria-live="polite"` feedback regions; `LuxuryHeader` lacked `aria-current="page"` and `Escape` dismissal for mobile drawer.
- **Root Cause:** Accessibility polish and synchronizer token wiring not yet implemented.
- **Proposed Correction:** Add CSRF token management in `src/lib/apiClient.ts` + `src/App.tsx`, add skip link in `src/App.tsx`, add keyboard Escape dismissal and ARIA live/alert regions in `ConsultationModal.tsx` and `LuxuryHeader.tsx` while strictly preserving approved luxury branding (`#4B2087`, `#B99045`, Playfair Display, Montserrat).
- **Regression Test:** `tests/api-client.test.ts` + `npm run lint` + `npm run build`.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY (cross-browser Playwright E2E pending staging browsers)**.

### D-13-12 — Missing Structured Request Logging, Secret Redaction, Metrics & Server HTTP Timeouts
- **Severity:** Medium
- **Affected File / Function:** `server/observability.ts`, `server/app.ts`, `server.ts`
- **Reproduction:** Express did not emit structured request logs with correlation IDs and latency, did not track error rates / DB latency / booking failures / outbox depth / AI failures, and `server.ts` did not enforce HTTP `requestTimeout`/`headersTimeout`/`keepAliveTimeout`.
- **Root Cause:** Operational observability and server timeout controls had not yet been modularized.
- **Proposed Correction:** Create `server/observability.ts` with secret redaction, structured JSON logging, and sliding operational metrics exposed to MFA-verified admins (`GET /api/admin/metrics`) and summarized in `/ready`; configure explicit HTTP server timeouts and graceful outbox worker shutdown in `server.ts`.
- **Regression Test:** `tests/phase13-outbox-and-persistence.test.ts` + compiled server smoke test.
- **Repair Commit:** Phase 13 patch (`development/phase-13-enterprise-hardening`).
- **Verification Result:** **FIXED & VERIFIED LOCALLY**.
