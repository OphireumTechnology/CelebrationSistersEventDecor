# Phase 15.3 — Database, Migration & RLS Validation Report

**Project:** Celebration Sisters Event Decor  
**Database Engine:** PostgreSQL (Railway Managed PostgreSQL / Supabase PostgreSQL compatible)  
**Migration Set:** `db/migrations/001_initial_schema.sql` through `db/migrations/008_phase15_token_lifecycle_and_webhook_audit.sql`  
**Verification Classification:** **Code Ready / Static & Structural Audit Passed** — Live PostgreSQL execution against staging/production databases is pending external staging execution (no `postgres`/`psql` daemon exists inside the AI Studio sandbox).

---

## 1. Migration Inventory (`001`–`008`)

| Order | Migration File | Scope | Idempotency & Destructive DDL Audit |
| :--- | :--- | :--- | :--- |
| `001` | `001_initial_schema.sql` | Core tables (`app_state`, `users`, `bookings`, `quotations`, `invoices`, `contracts`, `audit_logs`, etc.) | Additive `CREATE TABLE IF NOT EXISTS` |
| `002` | `002_rls_policies.sql` | Baseline RLS policies and `app.current_user_id` session context | Additive policies |
| `003` | `003_auth_identity.sql` | Identity, MFA, sessions, verification records, password resets | Additive `IF NOT EXISTS` |
| `004` | `004_production_hardening.sql` | Hardening indexes, idempotency, rate limit buckets | Additive `IF NOT EXISTS` |
| `005` | `005_rls_event_planner_and_invoices.sql` | Event planner role and invoice RLS expansion | Additive policies |
| `006` | `006_normalized_and_outbox.sql` | Normalized entities, `notification_outbox`, `security_invoker` views | Additive `IF NOT EXISTS` |
| `007` | `007_consultation_scheduling_and_railway_rls.sql` | `consultations`, `staff_availability_rules`, `consultation_slot_holds`, `crm_follow_up_tasks`, `blackout_dates`, `public.auth_uid_safe()`, exclusion/conflict indexes | Additive `IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION` |
| `008` | `008_phase15_token_lifecycle_and_webhook_audit.sql` | Adds `event_theme`, `access_token_expires_at`, `access_token_revoked_at`, `contact_updated_at` to `consultations`; creates `notification_webhook_events` with `ENABLE` + `FORCE ROW LEVEL SECURITY`; applies `FORCE ROW LEVEL SECURITY` to `consultations` and `notification_outbox`; adds composite lookup indexes; records `'008'` in `schema_migrations`. | Fully additive & idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`) |

---

## 2. Migration 008 Schema & Security Highlights

- **Consultation Token Lifecycle Columns (`consultations`):**
  - `event_theme TEXT NOT NULL DEFAULT ''`
  - `access_token_expires_at TIMESTAMPTZ`
  - `access_token_revoked_at TIMESTAMPTZ`
  - `contact_updated_at TIMESTAMPTZ`
  - Partial index `idx_consultations_token_expiry` covering non-revoked tokens with expiration timestamps.
- **Resend Webhook Audit & Deduplication Table (`notification_webhook_events`):**
  - Primary key `id`, `provider` (`'resend'`), unique `svix_id` for replay/duplicate webhook idempotency, `event_type`, `provider_message_id`, `signature_verified`, `payload_sha256`, `status` (`'processed' | 'ignored' | 'duplicate'`), `received_at`, plus composite lookup index `idx_notification_webhook_msg`.
  - Protected with both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, restricted to operational roles (`admin`, `staff`, `event_planner`) via `app_current_role()`.
- **Mandatory `FORCE ROW LEVEL SECURITY` Hardening:**
  - Applied to `consultations`, `notification_outbox`, and `notification_webhook_events` so table owners cannot accidentally bypass row-level isolation unless explicitly running as superuser during migrations.

---

## 3. Vanilla Railway PostgreSQL Bootstrap Compatibility Finding

During our Phase 15 audit of historical migrations `001`–`008`, we verified an important deployment prerequisite:
- Historical migrations `002_rls_policies.sql` (line 9), `003_auth_identity.sql` (line 79), and `005_rls_event_planner_and_invoices.sql` (lines 21–22) reference `auth.uid()` directly inside policy helper functions, whereas `007_consultation_scheduling_and_railway_rls.sql` introduces `public.auth_uid_safe()` (which checks `current_setting('app.current_user_id', true)` and only falls back to `auth.uid()` if the Supabase `auth` schema exists).
- **Supabase PostgreSQL:** Already defines `auth.uid()`, so `001`–`008` execute cleanly in order.
- **Fresh Vanilla Railway PostgreSQL (no `auth` schema):** Before applying `002` on a brand-new vanilla Railway PostgreSQL instance, run the following non-destructive 4-line compatibility shim once (without altering or weakening RLS):

```sql
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;
```

Then apply `001` through `008` in exact lexical order:

```bash
for f in db/migrations/00*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

---

## 4. Verification Results

- `npx tsx scripts/verify-migrations.ts`: Verified **8 ordered migrations (`001`–`008`)**, **0 destructive DDL violations**, **36/36 tables with RLS enabled**, and `security_invoker = true` on public reporting views.
- `npx tsx scripts/reconcile-snapshot-to-normalized.ts`: Dry-run verified deterministic mapping between snapshot and normalized PostgreSQL structures.
- **Pending Staging Verification:** Execute `001`–`008` twice (initial + idempotent re-run) against Railway staging PostgreSQL and run `EXPLAIN ANALYZE` on consultation slot conflict queries and RLS-scoped client queries.
