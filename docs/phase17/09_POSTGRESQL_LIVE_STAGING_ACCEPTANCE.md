# Phase 17F — Live Staging PostgreSQL Acceptance (`REQ-PG-01`)

**Target Database Engine:** Isolated Railway Staging PostgreSQL 16+  
**Canonical Runner:** `scripts/run-migrations.ts`  
**Canonical Live Verifier:** `scripts/verify-staging-postgres.ts`  
**Requirement Status:** **`BLOCKED`** *(all local/static/runner/harness controls verified and two critical real-PostgreSQL defects in `run-migrations.ts` and `verify-staging-postgres.ts` repaired; live Railway Staging PostgreSQL 16+ execution blocked by missing database binary & staging `DATABASE_URL` in sandbox)*

---

## 1. Sandbox Environment Probe (Factual Blocker Evidence)

Direct binary and environment inspection executed `2026-11-19`:
- `psql`: `ABSENT`
- `pg_dump`: `ABSENT`
- `pg_restore`: `ABSENT`
- `postgres` / `initdb`: `ABSENT` (`/usr/lib/postgresql` absent)
- `docker`: `ABSENT`
- `DATABASE_URL`: `UNSET`
- `STAGING_DATABASE_URL`: `UNSET`

Because neither a local PostgreSQL 16+ server nor an authorized Railway Staging `DATABASE_URL` is available inside this sandbox, live PostgreSQL 16+ migration execution and `pg_dump`/`pg_restore` recovery drills remain honestly **`BLOCKED`**.

---

## 2. Critical Real-PostgreSQL Defects Discovered & Repaired in Phase 17F

1. **`scripts/run-migrations.ts` `schema_migrations` Table Schema Collision with Migrations `005`–`008`:**
   - **Root Cause:** `run-migrations.ts` previously created `public.schema_migrations (version TEXT PRIMARY KEY, checksum_sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ)` without a `filename` column, whereas `db/migrations/005_rls_event_planner_and_invoices.sql` (and `006`, `007`, `008`) execute `INSERT INTO schema_migrations (version, filename) ... ON CONFLICT (version) DO NOTHING`. On a fresh PostgreSQL 16 database, Migration `005` would have crashed with `column "filename" does not exist` and `NOT NULL` violation on `checksum_sha256`. On a pre-existing database where `005` ran first, `run-migrations.ts` would have crashed on missing `checksum_sha256` and `NOT NULL` `filename`.
   - **Repair:** Updated `scripts/run-migrations.ts` to create/alter `public.schema_migrations` with `filename TEXT NOT NULL DEFAULT ''` and nullable `checksum_sha256 TEXT`, and upsert `(version, checksum_sha256, filename)` via `ON CONFLICT (version) DO UPDATE`. Guarded by regression test in `tests/phase17f-staging-harnesses.test.ts`.
2. **`scripts/verify-staging-postgres.ts` Backup/Restore Post-Restore Application Connectivity Verification:**
   - **Root Cause:** `--backup-restore-drill` previously ran `pg_dump` and `pg_restore` without connecting to the restored database to verify migrations, exclusion constraints, and RLS catalog integrity.
   - **Repair:** `runBackupRestoreDrill` now connects to `STAGING_RESTORE_DATABASE_URL` with `buildPostgresSslConfig`, verifying `schema_migrations >= 8`, `excl_consultations_planner_buffered_overlap` presence, and `rlsEnabledCount >= 36`.

---

## 3. Local Verification Matrix (`VERIFIED`)

| Verification Item | Executed Command / Test | Result |
| :--- | :--- | :--- |
| Static Migration & 36-Table RLS Audit | `npx tsx scripts/verify-migrations.ts` | **PASS** (`8` files, `36` RLS tables, `0` errors) |
| Deterministic SHA-256 Migration Ledger | `npx tsx scripts/run-migrations.ts --dry-run` | **PASS** (`8/8` checksums verified) |
| `schema_migrations` Coexistence with `005`–`008` | `tests/phase17f-staging-harnesses.test.ts` Test 5 | **PASS** |
| Transactional Rollback & Checksum Tamper Guard | `tests/phase16-platform-acceptance.test.ts` | **PASS** |
| Production-URL Rejection & `STAGING_DB_CONFIRM` Guard | `tests/phase17f-staging-harnesses.test.ts` Test 2 + `--self-check` | **PASS** |
| Snapshot-to-Normalized Financial Parity | `npx tsx scripts/reconcile-snapshot-to-normalized.ts` | **PASS** (`44` entities, `0` anomalies) |
| Sanitized PG Connection Interruption Handling (`08001`/`08006`/`57P01`) | `server/lib/pgErrorClassifier.ts` + `tests/phase17f` Test 1 | **PASS** (HTTP `503 DATABASE_UNAVAILABLE`, zero SQL leakage) |

---

## 4. Exact Operator Command to Close `REQ-PG-01`

Run against an **isolated Railway Staging PostgreSQL 16+** database (never production):

```bash
export STAGING_DB_CONFIRM="YES_ISOLATED_STAGING"
export DATABASE_URL="postgresql://<staging-nobyprls-user>:<pass>@<railway-staging-host>:<port>/<staging-db>?sslmode=require"
export STAGING_RESTORE_DATABASE_URL="postgresql://<staging-nobyprls-user>:<pass>@<railway-staging-host>:<port>/<staging-restore-scratch-db>?sslmode=require"

npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill
```

Record the resulting JSON report (`serverVersionNum >= 160000`, `migrationsRun1`, `migrationsRun2.skipped === 8`, `rlsEnabledTables >= 36`, `missingCoreForceTables: []`, `exclusionConstraintPresent: true`, `backupRestoreResult.passed: true`, `backupRestoreResult.restoredConnectivityVerified: true`) to flip `REQ-PG-01` to **`VERIFIED`**.
