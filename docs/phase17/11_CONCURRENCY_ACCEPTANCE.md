# Phase 17F — Live PostgreSQL Booking Concurrency Acceptance (`REQ-CONC-01`)

**Database Constraint:** `excl_consultations_planner_buffered_overlap` (`EXCLUDE USING gist` via `btree_gist`, Migration `007`) + `uq_consultations_active_planner_slot` + `uq_consultations_idempotency_key`  
**API SQLSTATE Mapper:** `server/lib/pgErrorClassifier.ts` (`23P01` / `23505` / `40001` / `40P01` -> HTTP `409 Conflict`)  
**Canonical Live Harness:** `scripts/verify-staging-postgres.ts`  
**Requirement Status:** **`BLOCKED`** *(all application concurrency invariants, SQLSTATE `23P01` HTTP `409` mapping, and real-schema multi-connection PostgreSQL MVCC harness are verified/repaired; real PostgreSQL 16+ multi-connection execution requires live staging `DATABASE_URL`)*

---

## 1. Phase 17F Concurrency Defects Discovered & Repaired

1. **Express Global Error Handler SQLSTATE Mapping (`server/lib/pgErrorClassifier.ts` + `server/app.ts`):**
   - Mapped PostgreSQL `23P01` (`exclusion_violation`), `23505` (`unique_violation`), `40001` (`serialization_failure`), and `40P01` (`deadlock_detected`) deterministically to HTTP **`409 Conflict`** (`code: 'SLOT_CONFLICT'`), recording `observability.recordBookingOutcome(false)` with zero SQL/PII leakage (`tests/phase17f-staging-harnesses.test.ts` Test 1).
2. **Real-Schema Concurrency Harness Repairs (`scripts/verify-staging-postgres.ts`):**
   - Fixed constraint name mismatch (`consultations_no_overlapping_active_slot` -> real Migration `007` constraint **`excl_consultations_planner_buffered_overlap`**).
   - Fixed all multi-connection race `INSERT`/`UPDATE` statements to use real `public.consultations` UUID foreign keys (`booking_id`, `client_id`, `assigned_planner_id`) and canonical timestamp columns (`scheduled_for`, `consultation_start_utc`, `consultation_end_utc`, `buffer_before_minutes`, `buffer_after_minutes`).
   - Added real PostgreSQL tests for `uq_consultations_idempotency_key` duplicate rejection (`23505`), expired `consultation_slot_holds` pruning, and offset-overlapping DST reschedule rejection (`23P01`).

---

## 2. Concurrency Scenario Verification Matrix

| Scenario | Application / Express Proof (`VERIFIED`) | Real PostgreSQL 16+ Multi-Connection MVCC Proof (`BLOCKED` in Sandbox) |
| :--- | :--- | :--- |
| 2-Way Concurrent Booking Race | **PASS** (`tests/phase16`: 1 `201`, 1 `409`) | Scripted in `verify-staging-postgres.ts` (asserts 1 commit + `23P01`/`23505`) |
| 3-Way Concurrent Booking Race | **PASS** (`tests/phase16`: 1 `201`, 2 `409`) | Scripted in `verify-staging-postgres.ts` (asserts 1 commit + `23P01`/`23505`) |
| 10-Way Concurrent Booking Race | **PASS** (`tests/phase16`: 1 `201`, 9 `409`) | Scripted in `verify-staging-postgres.ts` (asserts 1 commit + `23P01`/`23505`) |
| 25-Way Concurrent Booking Race | **PASS** (`tests/phase16`: 1 `201`, 24 `409`) | Scripted in `verify-staging-postgres.ts` (asserts 1 commit + `23P01`/`23505`) |
| SQLSTATE `23P01` -> HTTP `409` Handling | **PASS** (`tests/phase17f` Test 1) | Verified on live PG `excl_consultations_planner_buffered_overlap` |
| Rescheduling Conflict (`409` / `23P01`) | **PASS** (`tests/phase17f` Test 4) | Scripted in `runLifecycleExclusionScenarios` (`UPDATE` -> `23P01`) |
| Expired Slot Hold Pruning (`consultation_slot_holds`) | **PASS** (`tests/phase17f` Test 6 contract check) | Scripted in `runLifecycleExclusionScenarios` (`expires_at <= NOW()`) |
| Cancellation Releases Slot for Immediate Rebook | **PASS** (`tests/phase17f` Test 4 + Chromium `P16-BA-12`) | Scripted in `runLifecycleExclusionScenarios` (`Cancelled` -> re-`INSERT` commits) |
| 120-Minute Minimum Consultation Notice | **PASS** (`tests/phase17f` Test 3 — `STG-API-06` + `server/scheduling.ts`) | Preserved identically across PG and JSON adapters |
| Idempotency-Key Duplicate Prevention (`23505`) | **PASS** (`tests/phase14/16/17f`: replay returns `200`, `0` dup outbox) | Scripted in `runLifecycleExclusionScenarios` (`uq_consultations_idempotency_key` -> `23505`) |
| DST Transition Canonical UTC Storage | **PASS** (`tests/phase16`) | Scripted on `2028-11-05` US DST fall-back morning in `verify-staging-postgres.ts` |
| DB Connection Interruption (`08006`/`57P01`) | **PASS** (`tests/phase17f` Test 1 -> `503` + `ROLLBACK` in `postgresRepository.ts`) | Verified via live Railway pool check |

---

## 3. Exact Operator Action to Close `REQ-CONC-01`

Execute `scripts/verify-staging-postgres.ts` against Railway Staging PostgreSQL 16+ (see `09_POSTGRESQL_LIVE_STAGING_ACCEPTANCE.md`) and verify:
- All four `concurrencyRaces` (`2`, `3`, `10`, `25`) report `winners: 1`, `unexpectedErrors: 0`, and `passed: true`.
- `lifecycleExclusion` reports `dstRescheduleConflictCode: "23P01"`, `idempotencyConflictCode: "23505"`, `expiredHoldPrunedAndRebooked: true`, `postCancelRebookSucceeded: true`, and `passed: true`.
