# Phase 15R — Repair 03: PostgreSQL Migrations `001`–`008` & RLS Security Hardening

**Project:** Celebration Sisters Event Decor  
**Live PostgreSQL Execution Status:** `BLOCKED` (Environment lacks `postgres`, `psql`, `initdb`, `pg_ctl`, and `docker` daemons)  
**Static Migration & Worker Scoping Audit:** `PASSED` (`scripts/verify-migrations.ts` + `tests/phase15r-critical-repairs.test.ts` `REPAIR 03`)  
**Modified Files:** `db/migrations/002_rls_policies.sql`, `003_auth_identity.sql`, `005_rls_event_planner_and_invoices.sql`, `008_phase15_token_lifecycle_and_webhook_audit.sql`, `server/repositories/normalizedRepository.ts`, `scripts/verify-migrations.ts`

---

## 1. SQL & RLS Defects Repaired

### Defect A: Unconditional `auth.uid()` Failures on Fresh Vanilla Railway PostgreSQL
- **Root Cause:** Historical migrations `002_rls_policies.sql` (line 9), `003_auth_identity.sql` (line 79), and `005_rls_event_planner_and_invoices.sql` (lines 21–22) invoked `auth.uid()` unconditionally. On a clean vanilla Railway PostgreSQL instance (which does not ship a Supabase `auth` schema), executing `002` failed immediately before `007` could run.
- **Secure Repair (Zero Insecure `auth` Schema Shim):**
  - Defined `app_resolve_provider_uid()` in `002_rls_policies.sql` using catalog detection (`IF to_regprocedure('auth.uid()') IS NOT NULL THEN EXECUTE 'SELECT auth.uid()' INTO v_uid; RETURN v_uid; END IF; RETURN NULL;`).
  - Updated `002_rls_policies.sql`, `003_auth_identity.sql`, and `005_rls_event_planner_and_invoices.sql` to call `app_resolve_provider_uid()` identically to `007`.
  - Result: Fails closed (`NULL`) when unauthenticated on both vanilla Railway PostgreSQL and Supabase PostgreSQL, with **zero manual `auth` schema shim** required.

### Defect B: `FORCE ROW LEVEL SECURITY` on `notification_outbox` Lacked Ops & Worker Policies
- **Root Cause:** `006_normalized_and_outbox.sql` defined only a `FOR SELECT` admin policy on `notification_outbox`, while `008` enabled `FORCE ROW LEVEL SECURITY`. Under a non-superuser application role, `INSERT`/`UPDATE` claims from `PostgresNormalizedRepository.claimDueOutboxJobs()` would be blocked unless a least-privilege policy existed.
- **Secure Repair:**
  - Added `notification_outbox_ops_admin` (`FOR ALL` for `app_current_role() IN ('admin', 'staff', 'event_planner')`) and `notification_outbox_worker_scoped` (`FOR ALL` for `app_current_role() = 'notification_worker'` strictly scoped to `notification_outbox`) in `008_phase15_token_lifecycle_and_webhook_audit.sql`.
  - Updated `PostgresNormalizedRepository.claimDueOutboxJobs()` in `server/repositories/normalizedRepository.ts` to call `applyTransactionActorContext(client, { userId: '00000000-0000-0000-0000-000000000000', role: 'notification_worker' })` (`set_config(..., true)` = transaction-local `SET LOCAL`), which automatically clears upon `COMMIT` or `ROLLBACK` before the pooled connection returns to the pool.

---

## 2. Independently Executed Local Verification

1. `npx tsx scripts/verify-migrations.ts`:
   - `passed: true`
   - 8 contiguous migrations (`001`–`008`), zero destructive DDL (`DROP TABLE` / `TRUNCATE TABLE`)
   - **Zero unconditional `auth.uid()` calls** across all 8 files
   - **36/36 sensitive tables** verified with `ENABLE ROW LEVEL SECURITY` + active `CREATE POLICY`
   - `notification_outbox_worker_scoped` policy verified
   - `excl_consultations_planner_buffered_overlap` exclusion constraint verified
   - `v_vendor_booking_briefs` `security_invoker = true` verified
2. `tests/phase15r-critical-repairs.test.ts` (`REPAIR 03`):
   - Verified `PostgresNormalizedRepository.claimDueOutboxJobs()` executes `BEGIN` -> `set_config('app.current_user_id', ..., true)` -> `set_config('app.current_role', 'notification_worker', true)` -> `FOR UPDATE SKIP LOCKED` -> `COMMIT` in exact order.

---

## 3. Honest Blocker & Reproducible Live PostgreSQL Acceptance Script

**Why Live PostgreSQL Verification Is `BLOCKED` Here:** This sandbox container contains no PostgreSQL server binary (`postgres`, `initdb`, `pg_ctl`), no `psql` client, and no Docker engine (`docker`). Therefore live SQL execution and non-superuser RLS query execution **cannot** be claimed as `VERIFIED` here.

### Operator Reproducible Commands (Run on Local Docker Postgres 16 or Railway Staging)

```bash
# 1. Start a fresh vanilla PostgreSQL 16 instance (no Supabase auth schema)
docker run --rm --name cs-pg16-test -e POSTGRES_PASSWORD=postgres -p 55432:5432 -d postgres:16
export TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:55432/postgres"

# 2. Apply migrations 001–008 cleanly on first pass
for f in db/migrations/00*.sql; do
  psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

# 3. Re-run 001–008 to verify idempotency (008 + idempotent helpers)
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/008_phase15_token_lifecycle_and_webhook_audit.sql

# 4. Create non-superuser app role and verify RLS enforcement
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE cs_app_runtime LOGIN PASSWORD 'runtime_test_pw' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO cs_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cs_app_runtime;
SQL

# 5. Connect as non-superuser `cs_app_runtime` and verify:
#    - Unauthenticated session (no SET LOCAL) returns 0 rows from clients, bookings, consultations, notification_outbox
#    - SET LOCAL app.current_role = 'client' + Client A UUID sees ONLY Client A rows (0 rows for Client B)
#    - SET LOCAL app.current_role = 'vendor' sees ONLY assigned bookings via v_vendor_booking_briefs (0 financial rows)
#    - SET LOCAL app.current_role = 'notification_worker' can claim notification_outbox rows, and sees 0 rows on clients/bookings/consultations
#    - Transaction-local SET LOCAL resets cleanly after COMMIT (next transaction sees guest / 0 rows)
```
