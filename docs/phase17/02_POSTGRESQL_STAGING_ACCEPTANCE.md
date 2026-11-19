# Phase 17 — PostgreSQL Staging Acceptance Report

**Target Database Engine:** Railway PostgreSQL 16+ (Isolated Staging Instance)  
**Migration Directory:** `supabase/migrations/` (`001` through `008`)  
**Migration Runner:** `scripts/run-migrations.ts`  
**Live Verification Harness:** `scripts/verify-staging-postgres.ts`  
**Static / Mock-PG Validation Status:** `VERIFIED`  
**Live Railway Staging PostgreSQL 16+ Execution Status:** `BLOCKED` (no staging `DATABASE_URL` or PostgreSQL binary present in sandbox)

---

## 1. Executed Local & Automated Migration Verification (`VERIFIED`)

All eight ordered SQL migrations and the programmatic migration runner were independently validated in Phase 17:

1. **Static Schema & 36-Table RLS Audit (`npx tsx scripts/verify-migrations.ts`):**
   - Result: **`passed: true`**, **`files: 8`**, **`rlsTablesChecked: 36`**, **`errors: []`**.
2. **Deterministic Migration Checksums (`npx tsx scripts/run-migrations.ts --dry-run`):**

| Version | Filename | SHA-256 Checksum |
| :--- | :--- | :--- |
| `001_initial_schema` | `001_initial_schema.sql` | `8144e8e565f3b0008303d3b2ac298efab765b3c565c6a88805e7fff678e94668` |
| `002_rls_policies` | `002_rls_policies.sql` | `ed31e085fc5b3c2cf248a2124dd9e84f5955c5efe0e8e7661fac067957f88a31` |
| `003_auth_identity` | `003_auth_identity.sql` | `dcc1ac70f0bdb6796b1dff795ddebdbd3b5c8c94039a0131a5f337662706abc4` |
| `004_production_hardening` | `004_production_hardening.sql` | `d4f1a8b0ecca437faab52b37c9b804eb1f807171d63dcfc3507e73191ea78419` |
| `005_rls_event_planner_and_invoices` | `005_rls_event_planner_and_invoices.sql` | `cbd4a32e0464ad3646554191d0413a7fa2ecd089c11fcdf4bef8811a7570f709` |
| `006_normalized_and_outbox` | `006_normalized_and_outbox.sql` | `81dc7b70c685dfa5470859aef60402d6104b41f366d055de53110b9817ea1483` |
| `007_consultation_scheduling_and_railway_rls` | `007_consultation_scheduling_and_railway_rls.sql` | `2b6a773e9f1bd938671f49f41842c92a85b35769ac6aad3c1cf17942b4ad9465` |
| `008_phase15_token_lifecycle_and_webhook_audit` | `008_phase15_token_lifecycle_and_webhook_audit.sql` | `10e2ac1a6694395926c0739d1de4d2bcd68e7406585cb3b6efed34b645bdd0d4` |

3. **Transactional Runner Verification (`tests/phase16-platform-acceptance.test.ts`):**
   - Verified sequential transactional execution (`BEGIN` / `COMMIT`), idempotent rerun skipping previously applied migrations without duplicating schema objects, clean `ROLLBACK` on simulated SQL errors, and fail-closed checksum tamper detection.
4. **Snapshot-to-Normalized Parity Audit (`npx tsx scripts/reconcile-snapshot-to-normalized.ts`):**
   - Verified `44` domain entities across `13` normalized target tables, `0` anomalies, exact financial reconciliation (`totalFinancialCents: 6145000`, `paidFinancialCents: 1250000`), and `snapshotPreserved: true`.
5. **Staging Harness Self-Check (`npx tsx scripts/verify-staging-postgres.ts --self-check`):**
   - Verified safety guard prevents accidental execution against any non-confirmed database (`STAGING_DB_CONFIRM=YES_ISOLATED_STAGING` required).

---

## 2. TLS & Production Persistence Fail-Closed Posture

- `server/lib/postgresPool.ts` enforces verified TLS (`rejectUnauthorized: true`) for hosted PostgreSQL connections and rejects insecure TLS downgrades in production.
- `dist-server/server.mjs` was directly executed with `NODE_ENV=production` and unset `DATABASE_URL`; it exited non-zero immediately with:
  `PERSISTENCE_READINESS_FAILURE: PERSISTENCE_ADAPTER=postgres requires DATABASE_URL to be configured.`
- `tests/phase14-consultation-and-hardening.test.ts` verifies `SELECT 1` readiness probing, `BEGIN` / `FOR UPDATE` / `COMMIT`, `ROLLBACK` on failure, and HTTP `503` from `/ready` upon DB failure.

---

## 3. Blocked External Staging Gate & Exact Operator Runbook (`REQ-PG-01`)

**Why `BLOCKED`:** No isolated Railway Staging PostgreSQL 16+ URL or local `postgres` engine is provisioned inside this build sandbox.

**Operator Execution Procedure (Isolated Staging Database Only):**

```bash
export DATABASE_URL="postgresql://<staging-app-user>:<password>@<railway-staging-host>:<port>/<staging-db>?sslmode=require"
export STAGING_DB_CONFIRM="YES_ISOLATED_STAGING"

# 1. Run full automated staging PostgreSQL verification suite
#    (PG >= 16 check, verified TLS, migrations 001-008 + idempotent rerun,
#     36/36 FORCE RLS catalog audit, GiST exclusion constraint check,
#     and real multi-connection 2/3/10/25-way MVCC concurrency tests)
npx tsx scripts/verify-staging-postgres.ts
```

**Acceptance Criteria to Flip `REQ-PG-01` to `VERIFIED`:**
- `serverVersionNum >= 160000` (PostgreSQL 16+).
- First `run-migrations.ts` pass applies `8` migrations cleanly; immediate second pass applies `0` (`skipped: 8`).
- `btree_gist` extension is installed and `consultations_no_overlapping_active_slot` constraint is present in `pg_constraint`.
- Verified TLS connection succeeds without `rejectUnauthorized: false`.
