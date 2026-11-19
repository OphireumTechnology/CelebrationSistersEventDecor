# PostgreSQL / Supabase Migration Execution & Rollback Guide

## Migration Inventory (Apply Strictly in Order)

1. `db/migrations/001_initial_schema.sql` — Core relational tables (`roles`, `users`, `user_roles`, `clients`, `leads`, `service_catalog`, `blackout_dates`, `availability_holds`, `bookings`, `consultations`, `quotations`, `quote_items`, `contracts`, `invoices`, `payments`, `vendors`, `vendor_assignments`, `staff_assignments`, `event_tasks`, `inventory_items`, `inventory_reservations`, `messages`, `ai_sessions`, `design_concepts`, `notifications`, `audit_logs`).
2. `db/migrations/002_rls_policies.sql` — Row-Level Security (RLS) policies enforcing client isolation, vendor assignment scoping, redacted vendor view (`v_vendor_booking_briefs`), and restricted audit logs.
3. `db/migrations/003_auth_identity.sql` — Immutable `supabase_user_id` column binding, `event_planner` role addition, `account_status`, `staff_vendor_invitations`, and `auth_security_events` with RLS.
4. `db/migrations/004_production_hardening.sql` — Transactional `app_state_snapshots`, `booking_idempotency_keys`, `notification_deliveries`, `user_mfa_factors`, and `rate_limit_buckets` with RLS.

## Pre-Migration Checklist

1. Take a full logical backup of the target Supabase PostgreSQL database (`pg_dump --format=custom --no-owner "$DATABASE_URL" > pre-migration.dump`).
2. Run the dry-run data integrity audit before importing any JSON records:
   ```bash
   npx tsx scripts/migrate-json-to-postgres.ts --dry-run
   ```
3. Verify `DATABASE_URL` points to a staging or disposable test database first; never execute unverified DDL directly against production.

## Forward Execution Procedure

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_rls_policies.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/003_auth_identity.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/004_production_hardening.sql
```

## Post-Migration Verification

1. Verify all tables have RLS enabled:
   ```sql
   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
   ```
2. Verify backend readiness endpoint returns HTTP `200` with `persistence.adapter === 'postgres'` and `persistence.connected === true`:
   ```bash
   curl -fsS https://<railway-backend-domain>/ready
   ```

## Rollback Procedure

All migrations `003` and `004` are strictly additive. To roll back `004` without affecting customer bookings:
```sql
DROP TABLE IF EXISTS rate_limit_buckets;
DROP TABLE IF EXISTS user_mfa_factors;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS booking_idempotency_keys;
DROP TABLE IF EXISTS app_state_snapshots;
```
For full point-in-time recovery across `001`–`004`, restore from the pre-migration `pg_dump` archive or Supabase Point-in-Time Recovery (PITR).
