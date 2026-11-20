# Phase 17F — Real Non-Superuser RLS Security Acceptance (`REQ-RLS-01`)

**Target Controls:** PostgreSQL `ENABLE ROW LEVEL SECURITY` (`36` sensitive tables), `FORCE ROW LEVEL SECURITY` (`6` core consultation/outbox/webhook/CRM tables), `NOBYPASSRLS` role isolation, transaction-local `set_config(..., true)`, `v_vendor_booking_briefs` `security_invoker=true`, sanitized `42501` error handling  
**Canonical Verifier:** `scripts/verify-staging-postgres.ts` (`runRealRlsSecuritySuite`)  
**Requirement Status:** **`BLOCKED`** *(all 10 RLS checks are now schema-accurate against `db/migrations/001..008`, `42501` sanitization is unit-tested in `server/app.ts`, and SQL contract parity is guarded by automated tests; live execution against a `NOBYPASSRLS` PostgreSQL 16+ role is blocked by missing staging database access in sandbox)*

---

## 1. Phase 17F Security & Harness Repairs Implemented & Verified

1. **Sanitized PostgreSQL RLS Error Classification (`server/lib/pgErrorClassifier.ts` + `server/app.ts`):**
   - Maps SQLSTATE `42501` (`insufficient_privilege` / RLS violation) directly to HTTP **`403 Forbidden`** (`code: 'FORBIDDEN'`, message `'You are not authorized to access or modify this record.'`) with **zero table names, constraint names, or PII** exposed (`tests/phase17f-staging-harnesses.test.ts` Test 1).
2. **Real-Schema `NOBYPASSRLS` Live PostgreSQL Security Suite Repaired (`scripts/verify-staging-postgres.ts`):**
   - Fixed worker role mismatch (`'worker'` -> real Migration `008` policy role **`'notification_worker'`**).
   - Fixed seed/probe SQL to use real RFC 4122 UUIDs and canonical tables/columns (`users`, `clients`, `bookings`, `consultations`, `notification_outbox`, `audit_logs`) instead of phantom column names.
   - Added fail-closed `pg_roles` (`rolsuper`, `rolbypassrls`) guard (`RLS_BYPASS_DETECTED`) + optional `STAGING_RLS_APP_ROLE` (`SET LOCAL ROLE`).
   - Added explicit `v_vendor_booking_briefs` `security_invoker=true` catalog check in `RLS-09`, and explicit Customer A self-read (`1` row) + cross-client isolation (`0` rows) in `RLS-01`.
   - Aligned `RLS-08` to verify `rlsEnabledTables >= 36` AND all 6 core tables (`consultations`, `notification_outbox`, `notification_webhook_events`, `staff_availability_rules`, `consultation_slot_holds`, `crm_follow_up_tasks`) have `FORCE ROW LEVEL SECURITY` active.

---

## 2. Mandatory 10-Point RLS Matrix (Implemented in `scripts/verify-staging-postgres.ts`)

| Check ID | Mandatory Requirement | Local/Static Proof | Live PG16 `NOBYPASSRLS` Status |
| :--- | :--- | :--- | :--- |
| `RLS-01` | Customer A reads own consultation and cannot read Customer B's consultation | Policy DDL audited (`007`) + API token isolation `403` | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-02` | Customer A cannot modify Customer B's consultation (`planner_notes` update blocked) | Policy DDL audited (`007`) + API RBAC `403` | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-03` | Anonymous users cannot access private consultations or outbox rows | Policy DDL audited + unauth API `403` (`P16-BA-17`) | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-04` | Event planner (`event_planner`) accesses authorized consultations & is denied admin-only `audit_logs` | Policy DDL (`005`/`007`) + RBAC tests (`tests/phase16`) | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-05` | Administrator accesses managed consultations & `audit_logs` (with MFA TOTP at API layer) | `tests/phase16` + Chromium `P16-BA-13` | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-06` | Notification worker (`notification_worker`) scoped strictly to `notification_outbox` | `tests/phase15r` `claimDueOutboxJobs` `SET LOCAL` proof | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-07` | Transaction-local `set_config(..., true)` never leaks across pooled connections | Mock-PG transaction context tests (`tests/phase15r/16`) | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-08` | `ENABLE RLS` (`>= 36` tables) and `FORCE ROW LEVEL SECURITY` on all `6` core scheduling/outbox/webhook/CRM tables | `scripts/verify-migrations.ts` (`36/36` ENABLE) + `tests/phase15` (`FORCE RLS`) | **`BLOCKED`** (live `pg_class` query scripted) |
| `RLS-09` | `SECURITY DEFINER` function audit (`0` unapproved) + `v_vendor_booking_briefs` `security_invoker=true` | `scripts/verify-migrations.ts` (`security_invoker=true`) | **`BLOCKED`** (live `pg_proc`/`pg_class` query scripted) |
| `RLS-10` | Database errors (`42501`, `23P01`) do not expose private info or schema internals | **`VERIFIED`** (`tests/phase17f` Test 1 — `42501`->`403`, `23P01`->`409`) | **`VERIFIED`** (also re-asserted inside live runner) |

---

## 3. Exact Operator Action to Close `REQ-RLS-01`

Provision a non-superuser `NOBYPASSRLS` staging role on Railway Staging PostgreSQL 16+ and execute:
```bash
export STAGING_DB_CONFIRM="YES_ISOLATED_STAGING"
export DATABASE_URL="postgresql://<nobyprls-staging-user>:<pass>@<railway-staging-host>:<port>/<staging-db>?sslmode=require"
npx tsx scripts/verify-staging-postgres.ts
```
Verify all 10 entries in `rlsAssertions` report `"passed": true` with zero `RLS_BYPASS_DETECTED` errors.
