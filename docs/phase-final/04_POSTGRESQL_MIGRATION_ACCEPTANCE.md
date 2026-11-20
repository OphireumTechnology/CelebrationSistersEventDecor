# 04 — PostgreSQL Migration Acceptance Report (Phase 22)

**Audit Timestamp:** `2026-11-20T04:59:11Z`  
**Status:** **STATIC, CHECKSUM, READ-ONLY DRY-RUN & RECONCILIATION VERIFIED — LIVE STAGING MIGRATION APPLY & RESTORE DRILL BLOCKED (`DATABASE_URL` / `psql` / `pg_dump` UNAVAILABLE IN SANDBOX)**

---

## 1. Live Production Database State (`2026-11-20T04:56:13Z`)

Read-only `GET /ready` on live Railway production confirmed:
- `adapter: "postgres"`, `connected: true`, `latencyMs: 5`, `hostClass: "railway-internal"`, `sslMode: "disable"`.
- `schema.rateLimitTablePresent: true`, **`schema.migrationsTablePresent: false`**, **`schema.migrationsAppliedCount: 0`**.
- **Conclusion:** Live Railway PostgreSQL is reachable, but canonical migrations `001`–`008` have **not yet been applied**. With Phase 23's readiness correction deployed, `GET /ready` will accurately return `503 not_ready` in production until all 8 canonical migrations, essential tables, and `excl_consultations_planner_buffered_overlap` exist.

---

## 2. Canonical Migration Verification (`001` – `008`)

Executed `npx tsx scripts/verify-migrations.ts` (`passed: true`, `errors: []`, `rlsTablesChecked: 36`) and `npx tsx scripts/run-migrations.ts --dry-run` (`2026-11-20T04:59:11Z`):

| # | Version | Filename | SHA-256 Checksum |
|---|---|---|---|
| 1 | `001_initial_schema` | `001_initial_schema.sql` | `8144e8e565f3b0008303d3b2ac298efab765b3c565c6a88805e7fff678e94668` |
| 2 | `002_rls_policies` | `002_rls_policies.sql` | `ed31e085fc5b3c2cf248a2124dd9e84f5955c5efe0e8e7661fac067957f88a31` |
| 3 | `003_auth_identity` | `003_auth_identity.sql` | `dcc1ac70f0bdb6796b1dff795ddebdbd3b5c8c94039a0131a5f337662706abc4` |
| 4 | `004_production_hardening` | `004_production_hardening.sql` | `d4f1a8b0ecca437faab52b37c9b804eb1f807171d63dcfc3507e73191ea78419` |
| 5 | `005_rls_event_planner_and_invoices` | `005_rls_event_planner_and_invoices.sql` | `cbd4a32e0464ad3646554191d0413a7fa2ecd089c11fcdf4bef8811a7570f709` |
| 6 | `006_normalized_and_outbox` | `006_normalized_and_outbox.sql` | `81dc7b70c685dfa5470859aef60402d6104b41f366d055de53110b9817ea1483` |
| 7 | `007_consultation_scheduling_and_railway_rls` | `007_consultation_scheduling_and_railway_rls.sql` | `2b6a773e9f1bd938671f49f41842c92a85b35769ac6aad3c1cf17942b4ad9465` |
| 8 | `008_phase15_token_lifecycle_and_webhook_audit` | `008_phase15_token_lifecycle_and_webhook_audit.sql` | `10e2ac1a6694395926c0739d1de4d2bcd68e7406585cb3b6efed34b645bdd0d4` |

### Read-Only Dry-Run Proof (PR #20 Integrated)
- Verified in `tests/phase20-migration-readonly.test.ts` (`3/3 PASS` at `2026-11-20T04:59:23Z`):
  1. Connected dry-run on fresh DB executes strictly `SELECT to_regclass('public.schema_migrations')` (`0` DDL/DML writes) and reports all 8 migrations pending.
  2. Connected dry-run on partially migrated DB executes only `SELECT` queries and reports exact `skipped` vs `pending`.
  3. Connected dry-run fails closed with `MIGRATION_CHECKSUM_MISMATCH` on any checksum drift.

### Snapshot-to-Normalized Reconciliation Dry-Run (`2026-11-20T04:59:06Z`)
- `snapshotPreserved: true`, `totalEntities: 60` across `13` normalized tables, `totalFinancialCents: 6145000`, `paidFinancialCents: 1250000`, **`anomalies: []`**.

---

## 3. Exact Isolated Staging Execution Commands (Operator Required)

```bash
# 1. Read-only dry-run against isolated staging DB (zero writes)
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full npx tsx scripts/run-migrations.ts --dry-run

# 2. Apply migrations 001-008 transactionally
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full npx tsx scripts/run-migrations.ts

# 3. Verify idempotent rerun (applied: [], skipped: [8 files], pending: [])
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full npx tsx scripts/run-migrations.ts

# 4. Run full staging verification + backup/restore drill
STAGING_DB_CONFIRM=YES_ISOLATED_STAGING \
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill
```
