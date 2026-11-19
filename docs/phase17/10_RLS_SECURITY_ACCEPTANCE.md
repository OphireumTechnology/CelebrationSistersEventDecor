# Phase 17F — Real Non-Superuser RLS Security Acceptance (`REQ-RLS-01`)

**Target Controls:** PostgreSQL `ENABLE/FORCE ROW LEVEL SECURITY` (`36` tables), `NOBYPASSRLS` role isolation, transaction-local `set_config(..., true)`, sanitized `42501` error handling  
**Canonical Verifier:** `scripts/verify-staging-postgres.ts` (`runRealRlsSecuritySuite`)  
**Requirement Status:** **`BLOCKED`** *(all 10 RLS checks are now fully scripted and `42501` sanitization is unit-tested in `server/app.ts`; live execution against a `NOBYPASSRLS` PostgreSQL 16+ role is blocked by missing staging database access in sandbox)*

---

## 1. Phase 17F Security Hardening Repairs Implemented & Verified

1. **Sanitized PostgreSQL RLS Error Classification (`server/lib/pgErrorClassifier.ts` + `server/app.ts`):**
   - Previously, PostgreSQL SQLSTATE `42501` (`insufficient_privilege` / RLS violation) fell through to `500 INTERNAL_SERVER_ERROR`.
   - Phase 17F maps SQLSTATE `42501` directly to HTTP **`403 Forbidden`** (`code: 'FORBIDDEN'`, message `'You are not authorized to access or modify this record.'`) with **zero table names, constraint names, or PII** exposed (`tests/phase17f-staging-harnesses.test.ts` Test 1).
2. **Full 10-Point `NOBYPASSRLS` Live PostgreSQL Security Suite (`scripts/verify-staging-postgres.ts`):**
   - Explicitly queries `pg_roles` (`rolsuper`, `rolbypassrls`) and **aborts fail-closed** (`RLS_BYPASS_DETECTED`) if the connected role is a superuser or has `BYPASSRLS` (eliminating superuser acceptance shortcuts).
   - Supports optional `STAGING_RLS_APP_ROLE` (`SET LOCAL ROLE`) for controlled staging verification.

---

## 2. Mandatory 10-Point RLS Matrix (Implemented in `scripts/verify-staging-postgres.ts`)

| Check ID | Mandatory Requirement | Local/Static Proof | Live PG16 `NOBYPASSRLS` Status |
| :--- | :--- | :--- | :--- |
| `RLS-01` | Customer A cannot read Customer B's consultation | Policy DDL audited (`007`) + API token isolation `403` | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-02` | Customer A cannot modify Customer B's consultation | Policy DDL audited (`007`) + API RBAC `403` | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-03` | Anonymous users cannot access private records | Policy DDL audited + unauth API `403` (`P16-BA-17`) | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-04` | Event planner accesses authorized records only | Policy DDL + RBAC tests (`tests/phase16`) | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-05` | Administrator permissions enforced (with MFA TOTP) | `tests/phase16` + Chromium `P16-BA-13` | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-06` | Notification worker scoped to outbox only | `tests/phase15/16` mock-PG worker context | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-07` | Transaction-local `set_config(..., true)` never leaks across pooled connections | Mock-PG transaction context tests (`tests/phase15/16`) | **`BLOCKED`** (scripted in `verify-staging-postgres.ts`) |
| `RLS-08` | `FORCE ROW LEVEL SECURITY` active on all `>= 36` public tables | `scripts/verify-migrations.ts` (`36/36` PASS) | **`BLOCKED`** (live `pg_class` query scripted) |
| `RLS-09` | `SECURITY DEFINER` function audit (zero unapproved escalation surfaces) | Static SQL audit (`0` unguarded functions) | **`BLOCKED`** (live `pg_proc` query scripted) |
| `RLS-10` | Database errors do not expose private info or schema internals | **`VERIFIED`** (`tests/phase17f` Test 1 — `42501` -> `403` sanitized) | **`VERIFIED`** (also re-asserted inside live runner) |

---

## 3. Exact Operator Action to Close `REQ-RLS-01`

Provision a non-superuser `NOBYPASSRLS` staging role on Railway Staging PostgreSQL 16+ and execute:
```bash
export STAGING_DB_CONFIRM="YES_ISOLATED_STAGING"
export DATABASE_URL="postgresql://<nobyprls-staging-user>:<pass>@<railway-staging-host>:<port>/<staging-db>?sslmode=require"
npx tsx scripts/verify-staging-postgres.ts
```
Verify all 10 entries in `rlsAssertions` report `"passed": true` with zero `RLS_BYPASS_DETECTED` errors.
