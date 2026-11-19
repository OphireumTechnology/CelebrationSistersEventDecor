# PostgreSQL / Supabase Migration Execution & Rollback Guide

## Migration Inventory (Apply Strictly in Order)

1. `db/migrations/001_initial_schema.sql` — Core relational tables (`roles`, `users`, `user_roles`, `clients`, `leads`, `service_catalog`, `blackout_dates`, `availability_holds`, `bookings`, `consultations`, `quotations`, `quote_items`, `contracts`, `invoices`, `payments`, `vendors`, `vendor_assignments`, `staff_assignments`, `event_tasks`, `inventory_items`, `inventory_reservations`, `messages`, `ai_sessions`, `design_concepts`, `notifications`, `audit_logs`).
2. `db/migrations/002_rls_policies.sql` — Baseline Row-Level Security (RLS) enablement across sensitive tables, redacted vendor view (`v_vendor_booking_briefs`), and restricted audit logs.
3. `db/migrations/003_auth_identity.sql` — Immutable `supabase_user_id` column binding, `event_planner` role addition, `account_status`, `staff_vendor_invitations`, and `auth_security_events` with RLS.
4. `db/migrations/004_production_hardening.sql` — Transactional `app_state_snapshots`, `booking_idempotency_keys`, `notification_deliveries`, `user_mfa_factors`, and `rate_limit_buckets` with RLS.
5. `db/migrations/005_rls_event_planner_and_invoices.sql` — Resolves `app_current_user_id()` via `users.supabase_user_id`, extends RLS policies to `event_planner`, adds missing RLS policies on `quote_items`, `invoices`, and `booking_idempotency_keys`, enables `security_invoker = true` on `v_vendor_booking_briefs`, and records versions in `schema_migrations`.

## Pre-Migration Checklist

1. Run static migration ordering and RLS coverage validation locally or in CI:
   ```bash
   npx tsx scripts/verify-migrations.ts
   ```
2. Take a full logical backup of the target Supabase PostgreSQL database (`pg_dump --format=custom --no-owner "$DATABASE_URL" > pre-migration.dump`).
3. Run the dry-run data integrity audit before importing any JSON records:
   ```bash
   npx tsx scripts/migrate-json-to-postgres.ts --dry-run
   ```
4. Verify `DATABASE_URL` points to an approved staging or disposable test database first; never execute unverified DDL directly against production.

## Forward Execution Procedure

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_rls_policies.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/003_auth_identity.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/004_production_hardening.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/005_rls_event_planner_and_invoices.sql
```

## Post-Migration Verification

1. Verify migration ledger entries:
   ```sql
   SELECT version, filename, applied_at FROM schema_migrations ORDER BY version;
   ```
2. Verify all sensitive tables have RLS enabled and active policies:
   ```sql
   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
   SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
   ```
3. Verify backend readiness endpoint returns HTTP `200` with `persistence.adapter === 'postgres'` and `persistence.connected === true`:
   ```bash
   curl -fsS https://<railway-backend-domain>/ready
   ```

## Rollback Procedure

All migrations `003`, `004`, and `005` are strictly additive. To roll back `004`–`005` without affecting customer bookings:
```sql
ALTER VIEW v_vendor_booking_briefs SET (security_invoker = false);
DROP TABLE IF EXISTS schema_migrations;
DROP TABLE IF EXISTS rate_limit_buckets;
DROP TABLE IF EXISTS user_mfa_factors;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS booking_idempotency_keys;
DROP TABLE IF EXISTS app_state_snapshots;
```
For full point-in-time recovery across `001`–`005`, restore from the pre-migration `pg_dump` archive or Supabase Point-in-Time Recovery (PITR).
