# 01 — Master Source Code Audit (Phases 21–28)

**Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Audited Live `main` Commit:** `63fb9a6fb4425a32cd4780c4099b9dd42c6e5d6a` (`2026-11-20T04:35:47Z`, `"feat(infra): implement single-flight rate-limit bootstrapping"`)  
**Audited Upstream Draft PRs:** PR #19 (`efc5d362fbc7e699d03322eac89ef02bdf9e5a15`), PR #20 (`0eab455a9fa98b3ba4664053beff7357d47b5a29`)  
**Audit Timestamp:** `2026-11-20T04:59Z`

---

## 1. Repository Architecture Inventory

| Layer | Key Modules Inspected | Audit Findings |
|---|---|---|
| **Frontend (React / Vite / TS)** | `src/components/ConsultationModal.tsx`, `src/services/apiClient.ts`, `src/types/domain.ts`, `vite.config.ts` | Live GitHub Pages bundle (`/assets/index-DnJ4NpsP.js`, `461,720 bytes`) embeds Railway API origin, transmits scoped tokens via `X-Consultation-Token` header (zero URL query-string leak), includes `Retry Availability` & `Reserving Slot...` guards, and contains zero server/service-role secrets. |
| **Backend API (Express / TS)** | `server.ts`, `server/app.ts`, `server/rateLimit.ts`, `server/observability.ts`, `server/lib/pgErrorClassifier.ts` | Single-flight PostgreSQL `42P01` rate-limit bootstrap active; SQLSTATE error classifier sanitizes `23P01`/`23505`/`40001`/`42501`/`08006`; **Phase 23 defect found & repaired:** `GET /ready` previously returned `200 ok: true` solely from `SELECT 1` even with `0` migrations, unconfigured Supabase Auth, and unconfigured Resend. |
| **PostgreSQL Persistence & Migrations** | `db/migrations/001`–`008`, `server/repositories/postgresRepository.ts`, `scripts/run-migrations.ts`, `scripts/verify-migrations.ts`, `scripts/verify-staging-postgres.ts`, `scripts/reconcile-snapshot-to-normalized.ts` | All 8 canonical migrations ordered with valid SHA-256 checksums and 36-table RLS coverage. Integrated PR #20's strictly read-only (`SELECT`-only) connected dry-run repair into `scripts/run-migrations.ts` and expanded `checkPersistenceHealth()` to check essential tables and `excl_consultations_planner_buffered_overlap`. |
| **Identity & Authorization** | `server/identityProvider.ts`, `server/auth.ts`, `server/authz.ts`, `server/totp.ts` | Cryptographic Supabase JWT verification (`jose` JWKS/HS256), immutable `supabaseUserId === sub` binding, `emailPrivilegeBindBlocked` protection, AAL2/TOTP admin MFA, durable session revocation, double-submit HMAC CSRF, production `demoPersonasAvailable: false`. |
| **Email & Outbox Operations** | `server/notifications.ts`, `server/outbox.ts` | Atomic transactional outbox enqueue, idempotency deduplication, exponential backoff with jitter, DeadLetter routing, honest unconfigured/paused statuses, constant-time Svix HMAC-SHA256 webhook verification with ±300s replay guard and `svix-id` deduplication. Added `getStatus()` on `NotificationOutboxWorker` for readiness diagnostics. |
| **Payments Boundary** | `server/app.ts` (`POST /api/bookings/:id/payments/:paymentId/pay`), `docs/PAYMENT_INTEGRATION_ARCHITECTURE.md` | Live payment processing is intentionally unimplemented; production fails closed with HTTP `501 PAYMENT_PROVIDER_NOT_INTEGRATED` (`liveProcessorVerified: false`) preventing clients from self-marking milestones as paid. |
| **CI/CD & Container** | `.github/workflows/ci.yml`, `.github/workflows/deploy-pages.yml`, `Dockerfile`, `.env.example` | Multi-stage `node:22-bookworm-slim` Dockerfile (`npm ci`, non-root `node` user, `/health` HEALTHCHECK). Integrated PR #19's secret-scan doc fix to clear CI Run `44675475930` failure on `main`. |

---

## 2. Reconciled Code Changes Made in This Cycle (Phases 21–23)

1. **`docs/phase19/08_REGRESSION_AND_SECURITY_ACCEPTANCE.md` (PR #19 integration):** Replaced literal credential prefix strings in documentation prose so `.github/workflows/ci.yml` secret scan passes cleanly (`CI_SECRET_SCAN=PASS`).
2. **`scripts/run-migrations.ts` + `tests/phase20-migration-readonly.test.ts` (PR #20 integration):** Connected `--dry-run` now executes strictly read-only `SELECT to_regclass(...)` and `SELECT version, checksum_sha256 FROM public.schema_migrations`, never executing `CREATE TABLE` or `ALTER TABLE`.
3. **`server/repositories/postgresRepository.ts` (Phase 23):** Added `REQUIRED_CANONICAL_MIGRATION_COUNT = 8` and extended catalog diagnostics (`essentialTablesPresent`, `missingEssentialTables`, `overlapConstraintPresent`, `canonicalSchemaReady`).
4. **`server/outbox.ts` (Phase 23):** Added `NotificationOutboxWorker.getStatus()` exposing `workerId`, `pollingActive`, and `pollingDisabled`.
5. **`server/app.ts` + `scripts/verify-staging-railway-and-resend.ts` + `tests/phase23-readiness-and-hardening.test.ts` (Phase 23):** Added `evaluateApplicationReadiness()` and separated `GET /health` (liveness `200`) from production `GET /ready` (`503 not_ready` whenever database, 8 canonical migrations, essential tables/overlap constraint, Supabase Auth, Resend/webhook/staff email, or worker heartbeat are missing/unhealthy; `200 ready` only when all required production dependencies pass; zero secret disclosure).
