# Phase 17F — Live Staging PostgreSQL Acceptance (`REQ-PG-01`)

**Target Database Engine:** Isolated Railway Staging PostgreSQL 16+  
**Canonical Runner:** `scripts/run-migrations.ts`  
**Canonical Live Verifier:** `scripts/verify-staging-postgres.ts`  
**Requirement Status:** **`BLOCKED`** *(all local/static/runner/harness controls verified; live Railway Staging PostgreSQL 16+ execution blocked by missing database binary & staging `DATABASE_URL` in sandbox)*

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

## 2. Phase 17F Code & Harness Enhancements Verified Locally

| Verification Item | Executed Command / Test | Result |
| :--- | :--- | :--- |
| Static Migration & 36-Table `FORCE RLS` Audit | `npx tsx scripts/verify-migrations.ts` | **PASS** (`8` files, `36` tables, `0` errors) |
| Deterministic SHA-256 Migration Ledger | `npx tsx scripts/run-migrations.ts --dry-run` | **PASS** (`8/8` checksums verified) |
| Transactional Rollback & Checksum Tamper Guard | `tests/phase16-platform-acceptance.test.ts` | **PASS** |
| Production-URL Rejection & `STAGING_DB_CONFIRM` Guard | `tests/phase17f-staging-harnesses.test.ts` + `--self-check` | **PASS** (rejects missing confirmation and rejects `prod`/`production`-labeled hostnames/paths) |
| Snapshot-to-Normalized Financial Parity | `npx tsx scripts/reconcile-snapshot-to-normalized.ts` | **PASS** (`44` entities, `0` anomalies) |
| Sanitized PG Connection Interruption Handling (`08001`/`08006`/`57P01`) | `server/lib/pgErrorClassifier.ts` + `tests/phase17f` | **PASS** (maps cleanly to HTTP `503 DATABASE_UNAVAILABLE` with zero SQL leakage) |
| Optional Backup/Restore Drill Support | `scripts/verify-staging-postgres.ts --backup-restore-drill` | **IMPLEMENTED** (`pg_dump --format=custom` + `pg_restore --clean` into isolated `STAGING_RESTORE_DATABASE_URL`) |

---

## 3. Exact Operator Command to Close `REQ-PG-01`

Run against an **isolated Railway Staging PostgreSQL 16+** database (never production):

```bash
export STAGING_DB_CONFIRM="YES_ISOLATED_STAGING"
export DATABASE_URL="postgresql://<staging-nobyprls-user>:<pass>@<railway-staging-host>:<port>/<staging-db>?sslmode=require"
export STAGING_RESTORE_DATABASE_URL="postgresql://<staging-nobyprls-user>:<pass>@<railway-staging-host>:<port>/<staging-restore-scratch-db>?sslmode=require"

npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill
```

Record the resulting JSON report (`serverVersionNum >= 160000`, `migrationsRun1.applied`, `migrationsRun2.skipped === 8`, `forcedRlsTables >= 36`, `exclusionConstraintPresent: true`, `backupRestoreResult.passed: true`) to flip `REQ-PG-01` to **`VERIFIED`**.
