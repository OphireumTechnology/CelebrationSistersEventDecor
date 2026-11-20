# 06 — Database Migration Certification

**Project:** Celebration Sisters Event Decor  
**Canonical Migrations:** `db/migrations/001_initial_schema.sql` through `008_phase15_token_lifecycle_and_webhook_audit.sql` (8 files)  
**Runner:** `scripts/run-migrations.ts`  
**Audit Date:** 2026-11-20

---

## 1. Migration Runner Safety Controls (`scripts/run-migrations.ts`)

| Control | Implementation | Verification Result |
| --- | --- | --- |
| **Pure Read-Only Dry-Run (`--dry-run`)** | Executes ONLY `SELECT to_regclass('public.schema_migrations')` and (when table exists) `SELECT version, checksum_sha256 FROM public.schema_migrations`. Zero `CREATE`, `ALTER`, `INSERT`, or locks. | **VERIFIED** (`tests/phase20-migration-readonly.test.ts`) |
| **Concurrent Execution Protection** | Non-dry-run mode acquires PostgreSQL session advisory lock `pg_try_advisory_lock(728491034218)` before any DDL; fails closed with `MIGRATION_LOCK_CONTENTION` if `acquired !== true`; releases via `pg_advisory_unlock` in `finally`. | **VERIFIED** (`tests/phase21-30-certification.test.ts`) |
| **Checksum Drift & NULL Checksum Fail-Closed** | Both dry-run and apply modes verify SHA-256 of every already-recorded migration; NULL or mismatched checksums abort with `MIGRATION_CHECKSUM_MISMATCH`. | **VERIFIED** (`tests/phase20-migration-readonly.test.ts`, `tests/phase21-30-certification.test.ts`) |
| **Transactional Atomicity & Rollback** | Every pending migration runs inside `BEGIN ... COMMIT` with explicit `ROLLBACK` on error, preventing partial migration records. | **VERIFIED** (`tests/phase21-30-certification.test.ts`) |
| **Idempotent Rerun** | Re-executing `runMigrationsOnClient` after full apply skips all 8 migrations with zero duplicate inserts. | **VERIFIED** (`tests/phase21-30-certification.test.ts`) |
| **Canonical Schema Validation** | Static verification confirms `001`–`008` include `ENABLE/FORCE ROW LEVEL SECURITY`, consultation overlap exclusion constraint (`consultations_no_overlapping_active_slots`), and outbox/webhook audit tables. | **VERIFIED** (`scripts/verify-deployment-and-rollback.ts`, `tests/phase29-35-deficiency-remediation.test.ts`) |

---

## 2. Live Staging Database Evidence Observed via `/ready`

Live read-only probe of `https://celebrationsisterseventdecor-staging-staging.up.railway.app/ready` (2026-11-20T22:26:42Z) confirmed:
- `persistence.adapter`: `"postgres"`
- `persistence.connected`: `true` (`latencyMs: 4`)
- `persistence.schema.migrationsTablePresent`: `true`
- `persistence.schema.migrationsAppliedCount`: `8`
- `persistence.schema.essentialTablesPresent`: `true` (`missingEssentialTables: []`)
- `persistence.schema.overlapConstraintPresent`: `true`
- `persistence.schema.canonicalSchemaReady`: `true`

---

## 3. Blocked Live Database Execution Gates

The following gates require direct `STAGING_DATABASE_URL` access and PostgreSQL client tools (`psql`/`pg_dump`/`pg_restore`), which are not provisioned in this sandbox:
1. Live connected `npx tsx scripts/run-migrations.ts --dry-run` against Railway staging PostgreSQL with the updated advisory-lock/checksum code.
2. Live concurrent two-process migration lock test against a real PostgreSQL instance.
3. Live isolated PostgreSQL `pg_dump` backup and `pg_restore` disaster recovery rehearsal.
4. Production database migrations remain **strictly prohibited** without separate explicit production authorization.
