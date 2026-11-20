# Phase 30 — PostgreSQL Staging Database Activation & Acceptance

**Deliverable Mapping:** `PHASE30_DATABASE_ACCEPTANCE.md` / `docs/phase29-35/02_POSTGRESQL_STAGING_ACCEPTANCE.md`  
**Audit Timestamp:** `2026-11-20T13:51Z`  
**Phase 30 Status:** **PARTIALLY VERIFIED (`4/6` — `DB-05` & `DB-06` BLOCKED on isolated staging PostgreSQL access)**

---

## 1. Live Database Diagnostic Findings

Read-only inspection of live Railway `GET /ready` (`https://celebrationsisterseventdecor-production.up.railway.app/ready`) at `2026-11-20T13:51:44Z` confirmed:

- **PostgreSQL Connectivity (`DB-04` — VERIFIED):** `adapter: "postgres"`, `connected: true`, `latencyMs: 19`, `hostClass: "railway-internal"`.
- **Canonical Migration Gap (CONFIRMED LIVE):**
  - `migrationsTablePresent: false`
  - `migrationsAppliedCount: 0` (required: `8`)
  - `rateLimitTablePresent: true` (auto-bootstrapped via single-flight `42P01` guard)
  - `essentialTablesPresent: false`
  - `missingEssentialTables`: `["schema_migrations", "consultations", "consultation_slot_holds", "notification_outbox", "notification_webhook_events", "crm_follow_up_tasks"]`
  - `overlapConstraintPresent: false` (`excl_consultations_planner_buffered_overlap` not yet created)
  - `canonicalSchemaReady: false`

No write operations were executed against production.

---

## 2. Offline & Automated Verification Completed

1. **Canonical Migration Manifest (`DB-01` — VERIFIED):**
   `npx tsx scripts/verify-migrations.ts` passed (`rlsTablesChecked: 36`, `errors: []`).
2. **Read-Only Migration Dry-Run (`DB-02` — VERIFIED):**
   `npx tsx scripts/run-migrations.ts --dry-run` produced deterministic SHA-256 checksums for all 8 canonical migrations without issuing DDL or writes (also proven by `tests/phase20-migration-readonly.test.ts`):

| Order | Migration File | SHA-256 Checksum |
|---|---|---|
| 1 | `001_initial_schema.sql` | `8144e8e565f3b0008303d3b2ac298efab765b3c565c6a88805e7fff678e94668` |
| 2 | `002_rls_policies.sql` | `ed31e085fc5b3c2cf248a2124dd9e84f5955c5efe0e8e7661fac067957f88a31` |
| 3 | `003_auth_identity.sql` | `dcc1ac70f0bdb6796b1dff795ddebdbd3b5c8c94039a0131a5f337662706abc4` |
| 4 | `004_production_hardening.sql` | `d4f1a8b0ecca437faab52b37c9b804eb1f807171d63dcfc3507e73191ea78419` |
| 5 | `005_rls_event_planner_and_invoices.sql` | `cbd4a32e0464ad3646554191d0413a7fa2ecd089c11fcdf4bef8811a7570f709` |
| 6 | `006_normalized_and_outbox.sql` | `81dc7b70c685dfa5470859aef60402d6104b41f366d055de53110b9817ea1483` |
| 7 | `007_consultation_scheduling_and_railway_rls.sql` | `2b6a773e9f1bd938671f49f41842c92a85b35769ac6aad3c1cf17942b4ad9465` |
| 8 | `008_phase15_token_lifecycle_and_webhook_audit.sql` | `10e2ac1a6694395926c0739d1de4d2bcd68e7406585cb3b6efed34b645bdd0d4` |

3. **Snapshot-to-Normalized Reconciliation (`DB-03` — VERIFIED):**
   `npx tsx scripts/reconcile-snapshot-to-normalized.ts` verified `44` entities across `13` normalized tables (`totalFinancialCents: 6145000`, `paidFinancialCents: 1250000`, `anomalies: []`).

---

## 3. Remaining External Blockers (`DB-05`, `DB-06`)

Execution of migrations `001`–`008`, `NOBYPASSRLS` 10-point RLS verification, real multi-connection `2/3/10/25`-way MVCC `23P01` overlap concurrency races, and `pg_dump`/`pg_restore` drill is **BLOCKED** in this environment because:
- `DATABASE_URL` (for an isolated staging PostgreSQL 16+ instance) is `UNSET`.
- `STAGING_RESTORE_DATABASE_URL` is `UNSET`.
- `psql`, `pg_dump`, and `pg_restore` binaries are not installed in the sandbox container.

### Authorized Staging Execution Procedure

```bash
# 1. Read-only pre-flight check against isolated staging DB
DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/run-migrations.ts --dry-run

# 2. Apply migrations 001-008 + verify idempotency + 10-point NOBYPASSRLS + 2/3/10/25-way races + backup/restore drill
DATABASE_URL="$STAGING_DATABASE_URL" \
STAGING_RESTORE_DATABASE_URL="$STAGING_RESTORE_DB_URL" \
STAGING_DB_CONFIRM=YES_ISOLATED_STAGING \
npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill
```
