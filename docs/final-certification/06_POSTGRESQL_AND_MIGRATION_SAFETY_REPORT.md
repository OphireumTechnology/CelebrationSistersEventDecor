# 06 — PostgreSQL and Migration Safety Report

**Project:** Celebration Sisters Event Decor  
**Canonical Migrations:** `db/migrations/001_initial_schema.sql` through `008_phase15_token_lifecycle_and_webhook_audit.sql` (8 files)  
**Migration Runner:** `scripts/run-migrations.ts`  
**Audit Timestamp:** 2026-11-20T22:49Z

---

## 1. Verified Schema, RLS & Migration Runner Controls

| Control | Implementation & Evidence | Status |
| --- | --- | --- |
| Canonical migrations `001`–`008` ordering, SQL syntax & `FORCE ROW LEVEL SECURITY` write policies | Validated by `scripts/verify-migrations.ts`, `scripts/verify-deployment-and-rollback.ts`, `tests/phase14-postgres-rls.test.ts`, and `tests/phase29-35-deficiency-remediation.test.ts` | **VERIFIED** |
| Pure `SELECT`-only `--dry-run` on fresh and migrated databases | `scripts/run-migrations.ts` runs only `to_regclass` and `SELECT version, checksum_sha256` with zero DDL/writes/locks (`tests/phase20-migration-readonly.test.ts`) | **VERIFIED** |
| Concurrent migration advisory lock (`MIGRATION_LOCK_CONTENTION`) | Acquires `pg_try_advisory_lock(728491034218)` before any DDL, rejects non-true `acquired`, unlocks in `finally` (`tests/phase21-30-certification.test.ts`) | **VERIFIED** |
| SHA-256 checksum drift & NULL-checksum fail-closed protection | Both dry-run and apply modes reject missing (`NULL`) or mismatched checksums (`MIGRATION_CHECKSUM_MISMATCH`) | **VERIFIED** |
| Transactional rollback & idempotent rerun | Each pending migration executes in `BEGIN ... COMMIT` with explicit `ROLLBACK` on SQL failure; rerun skips all 8 cleanly (`tests/phase21-30-certification.test.ts`) | **VERIFIED** |
| Live Railway staging `/ready` DB telemetry | Confirmed `adapter: "postgres"`, `connected: true` (`4ms`), `migrationsAppliedCount: 8`, `essentialTablesPresent: true`, `overlapConstraintPresent: true`, `worker.pollingActive: true` | **VERIFIED** |

---

## 2. Blocked Live Staging PostgreSQL Operations

Sandbox environment variables confirmed `STAGING_DATABASE_URL: false` and `DATABASE_URL: false`, and `psql`/`pg_dump`/`pg_restore` binaries are unavailable locally. The following live staging PostgreSQL verifications remain **BLOCKED** pending operator execution with `STAGING_DATABASE_URL`:

1. Live connected read-only dry-run: `DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/run-migrations.ts --dry-run`
2. Live two-process advisory lock contention test on an isolated staging/test PostgreSQL database.
3. Live non-superuser RLS isolation probe: `DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/setup-staging-rls-probe.ts`
4. Live read-only `public.users` administrator binding audit for `fd9523dd-eb07-4cca-9040-62feea3f5353`.
5. Live isolated `pg_dump` / `pg_restore` backup and recovery rehearsal.
