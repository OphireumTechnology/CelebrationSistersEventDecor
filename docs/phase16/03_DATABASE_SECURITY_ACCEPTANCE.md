# Phase 16 — Database Security & Row-Level Security (RLS) Acceptance Report

**Scope:** PostgreSQL Row-Level Security (`FORCE ROW LEVEL SECURITY`), least-privilege worker policies, catalog-guarded vanilla Railway PG compatibility, TLS enforcement, and consultation access token cryptography.

---

## 1. Verified Database Security Controls

| Control | Implementation Location | Verification Method | Status |
| --- | --- | --- | --- |
| 36/36 Public Tables Protected with `ENABLE` + `FORCE ROW LEVEL SECURITY` | `db/migrations/002`, `003`, `005`, `006`, `007`, `008` | `npx tsx scripts/verify-migrations.ts` (`rlsTablesChecked: 36, errors: []`) | **VERIFIED (Static SQL)** |
| Vanilla Railway PostgreSQL Compatibility (0 Unconditional `auth.uid()` Calls) | `app_resolve_provider_uid()` in `002`, `003`, `005`, `007` | Static AST/regex gate in `scripts/verify-migrations.ts` | **VERIFIED (Static SQL)** |
| Least-Privilege `notification_outbox` Worker Policy | `notification_outbox_ops_admin` + `notification_outbox_worker_scoped` (`app_current_role() = 'notification_worker'`) in `008` + transaction-local `SET LOCAL` in `server/repositories/normalizedRepository.ts` | `tests/phase15r-critical-repairs.test.ts` mock-PG context verification + `scripts/verify-migrations.ts` | **VERIFIED (Code & Policy)** |
| Fail-Closed PostgreSQL TLS Verification | `buildPostgresSslConfig()` in `server/repositories/postgresRepository.ts` | Automated tests confirm `rejectUnauthorized: true`, `minVersion: TLSv1.2`, rejection of `PG_SSL_REJECT_UNAUTHORIZED=false`, `sslmode=no-verify`, and public `PGSSLMODE=disable` in production | **VERIFIED** |
| 256-Bit Scoped Consultation Access Token Hashing & Lifecycle | `generateConsultationAccessToken()` (`crypto.randomBytes(32)`), SHA-256 persisted hash, `access_token_expires_at`, `access_token_revoked_at` in `008` & `server/scheduling.ts` | `tests/phase15r-critical-repairs.test.ts` + Chromium self-service rejection/acceptance | **VERIFIED** |
| Immutable Resend Webhook Deduplication & Audit Table | `notification_webhook_events` (`UNIQUE (provider, svix_id)`) in `008` + single-transaction `reconcileResendWebhookAtomic()` | `tests/phase15r-critical-repairs.test.ts` + `tests/phase16-platform-acceptance.test.ts` | **VERIFIED** |
| Live Multi-Role PostgreSQL RLS Proof (`anon`, `client`, `vendor`, `event_planner`, `staff`, `admin`, `notification_worker`) | Live PostgreSQL 16+ database with `NOBYPASSRLS` roles | Requires live staging PostgreSQL engine | **BLOCKED (No live PG in sandbox)** |

---

## 2. Live Staging PostgreSQL RLS Verification SQL (Operator Gate)

To advance database security verification from **CODE_READY** to **STAGING_VERIFIED**, execute the following against the migrated **staging** PostgreSQL database using a `NOBYPASSRLS` application role:

```sql
BEGIN;
-- 1. Unauthenticated / anonymous context must see 0 consultations and 0 outbox rows
SET LOCAL ROLE app_runtime_user; -- NOBYPASSRLS role
SELECT set_config('app.current_user_id', '', true);
SELECT set_config('app.current_role', 'guest', true);
SELECT count(*) AS guest_consultations FROM public.consultations;         -- MUST BE 0
SELECT count(*) AS guest_outbox FROM public.notification_outbox;          -- MUST BE 0

-- 2. Notification worker role may ONLY access notification_outbox, NEVER bookings/users/consultations
SELECT set_config('app.current_role', 'notification_worker', true);
SELECT count(*) AS worker_consultations FROM public.consultations;        -- MUST BE 0
SELECT count(*) AS worker_outbox_visible FROM public.notification_outbox; -- ALLOWED

-- 3. Client role sees ONLY own records, zero cross-client leaks
SELECT set_config('app.current_role', 'client', true);
SELECT set_config('app.current_user_id', '<client_a_uuid>', true);
SELECT count(*) AS cross_client_rows FROM public.consultations WHERE client_id <> '<client_a_uuid>'; -- MUST BE 0
ROLLBACK;
```
