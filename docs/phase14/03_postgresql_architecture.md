# Phase 14 — Block 14.3: PostgreSQL Database Architecture & Railway Compatibility

## Additive Migration `007_consultation_scheduling_and_railway_rls.sql`
Migration `007` preserves full backward compatibility with migrations `001–006` while introducing enterprise consultation scheduling tables, database-layer concurrency guarantees, and Railway PostgreSQL RLS reconciliation.

## Railway PostgreSQL vs. Supabase `auth.uid()` Reconciliation
Earlier migrations (`002:9`, `003:79`, `005:21-22`) referenced `auth.uid()` unconditionally, which fails on vanilla Railway PostgreSQL where Supabase's `auth` schema does not exist.

Migration `007` resolves this cleanly **without disabling RLS or installing insecure auth shims**:
- Defines `app_resolve_provider_uid()` in `PL/pgSQL`, which inspects `to_regprocedure('auth.uid()')` before invoking `auth.uid()`, returning `NULL` safely on vanilla PostgreSQL.
- Updates `app_current_user_id()` to resolve `current_setting('app.current_user_id', true)` first, falling back to `app_resolve_provider_uid()` only when present, and **failing closed (`NULL`)** whenever neither session context nor provider UID is set.
- Re-issues `users_self_or_admin_select` on `users` to delegate to `app_current_user_id()` rather than calling `auth.uid()` directly.

### Operator Bootstrap Note for Brand-New Vanilla Railway PostgreSQL
On a fresh Railway PostgreSQL instance where `002`, `003`, and `005` have never run:
1. Provision a dedicated non-superuser application database role (e.g., `cs_app_user`) so PostgreSQL `FORCE ROW LEVEL SECURITY` is strictly enforced at runtime (superusers bypass RLS unless restricted).
2. Run migrations `001` through `007` sequentially in a controlled maintenance window. Because `002`/`003`/`005` contain historical `auth.uid()` references, on vanilla PostgreSQL (non-Supabase) either execute a read-only `auth.uid()` no-op stub returning `NULL::uuid` owned by `postgres` during migration replay OR apply `007`'s `app_resolve_provider_uid()` immediately after `001` before `002–006`. Never grant `BYPASSRLS` to the application role.
3. Verify RLS enforcement by executing queries under `cs_app_user` with `SET LOCAL app.current_user_id` and `SET LOCAL app.current_role`.

## Schema Additions & Integrity Constraints
1. **`consultations` (Additive Alterations):**
   - Columns: `reference_code`, `client_id`, `assigned_planner_id`, `status` (`Draft | Pending | Confirmed | Rescheduled | Completed | Cancelled | No-show`), `consultation_start_utc`, `consultation_end_utc`, `buffer_before_minutes`, `buffer_after_minutes`, `client_timezone`, `preferred_contact_method`, `privacy_consent_at`, `privacy_consent_version`, `access_token_hash`, `idempotency_key`, `outcome_summary`, `crm_stage`, `follow_up_due_at`, `rescheduled_from_id`, `cancelled_at`, `cancel_reason`, `updated_at`.
   - Concurrency Protection:
     - `CREATE EXTENSION IF NOT EXISTS btree_gist;`
     - `excl_consultations_planner_buffered_overlap`: `EXCLUDE USING gist` over `(assigned_planner_id WITH =, tstzrange(consultation_start_utc, consultation_end_utc + buffer_after, '[)') WITH &&) WHERE (status IN ('Pending','Confirmed','Rescheduled'))`.
     - Unique indexes: `uq_consultations_idempotency_key`, `uq_consultations_reference_code`, `uq_consultations_active_planner_slot`.
2. **`staff_availability_rules`:** Weekly planner operating windows (`day_of_week`, `start_time_local`, `end_time_local`, `timezone`, `slot_duration_minutes`, `buffer_before_minutes`, `buffer_after_minutes`, `allowed_channels`, `is_active`), with `ENABLE` and `FORCE ROW LEVEL SECURITY`.
3. **`consultation_slot_holds`:** Temporary 10-minute soft slot locks keyed by `holder_fingerprint_hash` and `expires_at`, with `ENABLE` and `FORCE ROW LEVEL SECURITY`.
4. **`crm_follow_up_tasks`:** Staff follow-up tasks linked to consultations and bookings (`status` in `Open | Completed | Cancelled`, `due_at`), with `ENABLE` and `FORCE ROW LEVEL SECURITY`.
5. **`notification_outbox`:** Expanded `category` CHECK constraint supporting all 16 customer and internal studio notification categories.

## Atomic Normalized Repository (`server/repositories/normalizedRepository.ts`)
- `createConsultationAtomic()`: Runs inside `BEGIN ... COMMIT` (with `ROLLBACK` on conflict/error), deduplicates by `idempotency_key`, locks overlapping buffered windows via `FOR UPDATE`, inserts the consultation, and atomically enqueues outbox notifications in the same transaction.
- `listConsultationsForActor()`: Applies `SET LOCAL app.current_user_id` and `SET LOCAL app.current_role` before querying `consultations` so PostgreSQL RLS governs row visibility.

## Rollback Runbook
To roll back `007` in staging (before production traffic):
1. Drop new tables `crm_follow_up_tasks`, `consultation_slot_holds`, `staff_availability_rules`.
2. Drop exclusion constraint `excl_consultations_planner_buffered_overlap` and `uq_consultations_*` indexes.
3. Delete `'007'` from `schema_migrations`.
(Keep `app_resolve_provider_uid()` / `app_current_user_id()` in place on Railway PostgreSQL to retain RLS compatibility.)
