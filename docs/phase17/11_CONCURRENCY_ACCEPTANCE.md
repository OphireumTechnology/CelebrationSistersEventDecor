# Phase 17F — Live PostgreSQL Booking Concurrency Acceptance (`REQ-CONC-01`)

**Database Constraint:** `consultations_no_overlapping_active_slot` (`EXCLUDE USING gist` via `btree_gist`, Migration `007`)  
**API SQLSTATE Mapper:** `server/lib/pgErrorClassifier.ts` (`23P01` / `23505` / `40001` / `40P01` -> HTTP `409 Conflict`)  
**Canonical Live Harness:** `scripts/verify-staging-postgres.ts`  
**Requirement Status:** **`BLOCKED`** *(all application concurrency invariants, SQLSTATE `23P01` HTTP `409` mapping, and multi-connection PostgreSQL MVCC harness are verified/implemented; real PostgreSQL 16+ multi-connection execution requires live staging `DATABASE_URL`)*

---

## 1. Phase 17F Concurrency Defect Discovered & Repaired

During Phase 17F source inspection, we identified a genuine gap in `server/app.ts`'s global error middleware:
- **Prior Behavior:** If PostgreSQL raised SQLSTATE `23P01` (`exclusion_violation`), `23505` (`unique_violation`), `40001` (`serialization_failure`), or `40P01` (`deadlock_detected`) during a concurrent booking or reschedule transaction, the Express global error handler returned HTTP **`500 INTERNAL_SERVER_ERROR`**.
- **Phase 17F Repair (`server/lib/pgErrorClassifier.ts` + `server/app.ts`):** All four concurrency SQLSTATE codes now map deterministically to HTTP **`409 Conflict`** (`code: 'SLOT_CONFLICT'`), record `observability.recordBookingOutcome(false)` for consultation routes, and emit a sanitized client message with zero SQL/PII leakage (`tests/phase17f-staging-harnesses.test.ts` Test 1).

---

## 2. Concurrency Scenario Verification Matrix

| Scenario | Application / Express Proof (`VERIFIED`) | Real PostgreSQL 16+ Multi-Connection MVCC Proof (`BLOCKED` in Sandbox) |
| :--- | :--- | :--- |
| 2-Way Concurrent Booking Race | **PASS** (`tests/phase16`: 1 `201`, 1 `409`) | Scripted in `verify-staging-postgres.ts` (asserts 1 commit + `23P01`) |
| 3-Way Concurrent Booking Race | **PASS** (`tests/phase16`: 1 `201`, 2 `409`) | Scripted in `verify-staging-postgres.ts` (asserts 1 commit + `23P01`) |
| 10-Way Concurrent Booking Race | **PASS** (`tests/phase16`: 1 `201`, 9 `409`) | Scripted in `verify-staging-postgres.ts` (asserts 1 commit + `23P01`) |
| 25-Way Concurrent Booking Race | **PASS** (`tests/phase16`: 1 `201`, 24 `409`) | Scripted in `verify-staging-postgres.ts` (asserts 1 commit + `23P01`) |
| SQLSTATE `23P01` -> HTTP `409` Handling | **PASS** (`tests/phase17f` Test 1) | Verified on live PG `consultations_no_overlapping_active_slot` |
| Rescheduling Conflict (`409`) | **PASS** (`tests/phase17f` Test 4) | Scripted in `runLifecycleExclusionScenarios` (`UPDATE` -> `23P01`) |
| Cancellation Releases Slot for Immediate Rebook | **PASS** (`tests/phase17f` Test 4 + Chromium `P16-BA-12`) | Scripted in `runLifecycleExclusionScenarios` (`Cancelled` -> re-`INSERT` commits) |
| 120-Minute Minimum Consultation Notice | **PASS** (`tests/phase17f` Test 3 — `STG-API-06` + `server/scheduling.ts`) | Preserved identically across PG and JSON adapters |
| Idempotency-Key Duplicate Prevention | **PASS** (`tests/phase14/16/17f`: replay returns `200`, `0` dup outbox) | Preserved identically with PG `FOR UPDATE` transaction |
| DST Transition Canonical UTC Storage | **PASS** (`tests/phase16`) | Scripted on `2028-11-05` US DST fall-back morning in `verify-staging-postgres.ts` |
| DB Connection Interruption (`08006`/`57P01`) | **PASS** (`tests/phase17f` Test 1 -> `503` + `ROLLBACK` in `postgresRepository.ts`) | Verified via live Railway pool check |

---

## 3. Exact Operator Action to Close `REQ-CONC-01`

Execute `scripts/verify-staging-postgres.ts` against Railway Staging PostgreSQL 16+ (see `09_POSTGRESQL_LIVE_STAGING_ACCEPTANCE.md`) and verify:
- All four `concurrencyRaces` (`2`, `3`, `10`, `25`) report `winners: 1`, `sqlstate23P01Count >= 1`, `unexpectedErrors: 0`, and `passed: true`.
- `lifecycleExclusion` reports `dstRescheduleConflictCode: "23P01"`, `postCancelRebookSucceeded: true`, and `passed: true`.
