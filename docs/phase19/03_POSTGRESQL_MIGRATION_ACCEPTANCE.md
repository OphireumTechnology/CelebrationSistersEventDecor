# Phase 19 — 03 PostgreSQL Migration Acceptance

**Audit Timestamp:** `2026-11-20T04:29:33Z`  
**Status:** **LOCAL STATIC & DRY-RUN VERIFIED — LIVE STAGING EXECUTION BLOCKED (`DATABASE_URL` / `psql` / `pg_dump` UNAVAILABLE IN SANDBOX)**

---

## 1. Live Production Schema Finding (Why Canonical Migrations Are Mandatory)

Live `GET /ready` on Railway (`2026-11-20T04:29:41Z`) reported:

```json
"schema": {
  "rateLimitTablePresent": true,
  "migrationsTablePresent": false,
  "migrationsAppliedCount": 0
}
```

**Critical Architectural Rule:** Although Phase 18's idempotent `42P01` bootstrap created `rate_limit_buckets` and cleared the live `503` on `/api/consultations/status`, **`rate_limit_buckets` bootstrap is NOT a substitute for canonical migrations `001`–`008`**. Without running `scripts/run-migrations.ts`, normalized tables (`consultations`, `consultation_slot_holds`, `notification_outbox`, `notification_webhook_events`, `crm_follow_up_tasks`), exclusion constraint `excl_consultations_planner_buffered_overlap`, and 36-table `FORCE ROW LEVEL SECURITY` policies are NOT yet deployed to PostgreSQL.

---

## 2. Verified Migration Manifest (`001` – `008`)

Executed `npx tsx scripts/verify-migrations.ts` and `npx tsx scripts/run-migrations.ts --dry-run` on `2026-11-20T04:29:28Z` (`passed: true`, `errors: []`, `rlsTablesChecked: 36`):

| Order | Version | Filename | SHA-256 Checksum |
|---|---|---|---|
| 1 | `001_initial_schema` | `001_initial_schema.sql` | `8144e8e565f3b0008303d3b2ac298efab765b3c565c6a88805e7fff678e94668` |
| 2 | `002_rls_policies` | `002_rls_policies.sql` | `ed31e085fc5b3c2cf248a2124dd9e84f5955c5efe0e8e7661fac067957f88a31` |
| 3 | `003_auth_identity` | `003_auth_identity.sql` | `dcc1ac70f0bdb6796b1dff795ddebdbd3b5c8c94039a0131a5f337662706abc4` |
| 4 | `004_production_hardening` | `004_production_hardening.sql` | `d4f1a8b0ecca437faab52b37c9b804eb1f807171d63dcfc3507e73191ea78419` |
| 5 | `005_rls_event_planner_and_invoices` | `005_rls_event_planner_and_invoices.sql` | `cbd4a32e0464ad3646554191d0413a7fa2ecd089c11fcdf4bef8811a7570f709` |
| 6 | `006_normalized_and_outbox` | `006_normalized_and_outbox.sql` | `81dc7b70c685dfa5470859aef60402d6104b41f366d055de53110b9817ea1483` |
| 7 | `007_consultation_scheduling_and_railway_rls` | `007_consultation_scheduling_and_railway_rls.sql` | `2b6a773e9f1bd938671f49f41842c92a85b35769ac6aad3c1cf17942b4ad9465` |
| 8 | `008_phase15_token_lifecycle_and_webhook_audit` | `008_phase15_token_lifecycle_and_webhook_audit.sql` | `10e2ac1a6694395926c0739d1de4d2bcd68e7406585cb3b6efed34b645bdd0d4` |

### Snapshot-to-Normalized Reconciliation Dry-Run (`2026-11-20T04:29:28Z`)
- Command: `npx tsx scripts/reconcile-snapshot-to-normalized.ts`
- Result: `snapshotPreserved: true`, `totalEntities: 60` across 13 tables, `totalFinancialCents: 6145000`, `paidFinancialCents: 1250000`, **`anomalies: []`**.

---

## 3. Exact Operator Commands for Isolated Staging PostgreSQL Migration & Recovery Drill

```bash
# 1. Verify runner plan
npx tsx scripts/run-migrations.ts --dry-run

# 2. Apply migrations 001-008 to isolated staging PostgreSQL
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full \
npx tsx scripts/run-migrations.ts

# 3. Verify idempotent re-run (must apply 0 new files with 0 checksum drift)
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full \
npx tsx scripts/run-migrations.ts

# 4. Run full staging PostgreSQL verification + pg_dump / pg_restore recovery drill
STAGING_DB_CONFIRM=YES_ISOLATED_STAGING \
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full \
npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill
```

### Expected Staging Pass Criteria
- `migrationsAppliedCount: 8` on `/ready` and `schema_migrations` row count = 8.
- `rate_limit_buckets` present with `idx_rate_limit_buckets_reset`.
- `pg_dump` -> clean temporary database `pg_restore` -> row-count & schema integrity equality verified with `restoredConnectivityVerified: true`.
