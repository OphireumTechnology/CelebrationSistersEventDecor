# Phase 17 — Row Level Security (RLS) & Concurrency Acceptance Report

**Target Database Controls:** PostgreSQL `ENABLE/FORCE ROW LEVEL SECURITY` (`36` tables), `NOBYPASSRLS` application role, `btree_gist` `EXCLUDE USING gist` (`consultations_no_overlapping_active_slot`)  
**Application & Static Controls Status:** `VERIFIED` (80/80 automated tests passing)  
**Live PostgreSQL 16+ Engine RLS & MVCC Concurrency Status:** `BLOCKED` (awaiting isolated Railway Staging PostgreSQL execution via `scripts/verify-staging-postgres.ts`)

---

## 1. Row Level Security Verification (`VERIFIED` Statically & In App/Mock-PG; `BLOCKED` Live Engine)

### Verified Controls
- **36/36 Table Coverage (`npx tsx scripts/verify-migrations.ts`):** Every tenant/domain table in `supabase/migrations/001`–`008` declares both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, plus fail-closed `app.current_user_id` / `app.current_role` session-context policies in `007_consultation_scheduling_and_railway_rls.sql`.
- **Transaction-Scoped Context Propagation (`tests/phase15-enterprise-acceptance.test.ts` & `phase16-platform-acceptance.test.ts`):** Verified that API requests and background worker sweeps execute `SET LOCAL app.current_user_id` and `SET LOCAL app.current_role` inside explicit PostgreSQL transactions so connection pooling never leaks caller identity across requests.
- **Role-Based API Isolation (`tests/phase16-platform-acceptance.test.ts` & Chromium `P16-BA-17`):**
  - Unauthenticated and non-admin callers receive HTTP `403` on `/api/admin/metrics`, `/api/admin/consultations`, `/api/admin/notifications/outbox`, and proposal conversion endpoints.
  - Client self-service access requires a cryptographically scoped `csa_` consultation token matched against its SHA-256 hash; wrong, expired, and revoked tokens are rejected fail-closed with HTTP `403` (verified in `tests/phase17-staging-and-api-routing.test.ts`).

### Blocked Live Staging Gate (`REQ-RLS-01`)
Live PostgreSQL catalog and multi-role query verification requires connecting as a non-superuser `NOBYPASSRLS` role on Railway Staging PostgreSQL 16+ and proving:
1. All `36` tables have `relrowsecurity = true` AND `relforcerowsecurity = true` in `pg_class`.
2. Setting `SET LOCAL app.current_role = 'client'` and `app.current_user_id = '<clientA>'` returns **0 rows** for Client B's consultations, quotations, contracts, and payments.
3. Setting `SET LOCAL app.current_role = 'admin'` accesses admin consultation & outbox rows while anonymous sessions with unset `app.current_user_id` see **0 private rows**.

---

## 2. Double-Booking Prevention & Concurrency Verification

### Verified Application & Transactional Controls (`VERIFIED`)
- **Multi-Way Concurrent Slot Races (`tests/phase16-platform-acceptance.test.ts`):**
  - **2-way** concurrent booking race on identical planner/slot -> exactly **1** `201 Created`, **1** `409 Conflict`.
  - **3-way** concurrent booking race -> exactly **1** `201 Created`, **2** `409 Conflict`.
  - **10-way** concurrent booking race -> exactly **1** `201 Created`, **9** `409 Conflict`.
  - **25-way** concurrent booking race -> exactly **1** `201 Created`, **24** `409 Conflict`.
- **Buffer & Overlap Math (`tests/phase14` & `phase16`):** Pre/post-consultation buffer windows block adjacent overlapping requests cleanly.
- **Timezone & DST Boundaries (`tests/phase16-platform-acceptance.test.ts`):** Verified UTC canonical slot storage and deterministic conversion across US DST spring-forward and fall-back dates (`America/New_York`, `America/Los_Angeles`).
- **Idempotency-Key Protection (`tests/phase14` & `phase16`):** Replaying an identical `Idempotency-Key` returns the exact original consultation without creating duplicate bookings or duplicate email outbox jobs.
- **Cancellation Slot Release (`Chromium P16-BA-12` & unit tests):** Cancelling an active consultation immediately frees the slot so a subsequent booking succeeds cleanly.

### Blocked Live Staging Gate (`REQ-CONC-01`)
`scripts/verify-staging-postgres.ts` is implemented and self-checked (`--self-check` passed). When executed against Railway Staging PostgreSQL 16+, it opens **parallel real `pg.Pool` connections** and runs simultaneous `INSERT` transactions against the `consultations` table for **2-way, 3-way, 10-way, and 25-way** races, asserting:
- Exactly **1** transaction commits per race wave.
- All **N - 1** losing transactions fail with PostgreSQL SQLSTATE `23P01` (`exclusion_violation`) from `consultations_no_overlapping_active_slot` (`EXCLUDE USING gist`).
- All temporary staging race rows are cleanly rolled back / purged after each wave.
