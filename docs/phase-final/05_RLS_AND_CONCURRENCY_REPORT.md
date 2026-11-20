# 05 — Row-Level Security & Concurrency Report (Phase 22)

**Audit Timestamp:** `2026-11-20T04:59:23Z`  
**Status:** **STATIC 36-TABLE RLS AUDIT, SQLSTATE CLASSIFIER, HARNESS SELF-CHECK & LOCAL CONCURRENCY VERIFIED — REAL POSTGRESQL `NOBYPASSRLS` & `23P01` EXECUTION BLOCKED (NO STAGING `DATABASE_URL` IN SANDBOX)**

---

## 1. Automated Verification Summary

- **`scripts/verify-migrations.ts` (`2026-11-20T04:59:11Z`):** `passed: true`, **`36` RLS-protected tables verified**, `0` errors.
- **`scripts/verify-staging-postgres.ts --self-check` (`2026-11-20T04:59:11Z`):**
  - `guardRequired`: `STAGING_DB_CONFIRM=YES_ISOLATED_STAGING` (rejects production-labeled URLs).
  - `exclusionConstraint`: `excl_consultations_planner_buffered_overlap` (`btree_gist` + `tstzrange` + 15-minute studio buffer).
  - `requiredCoreForceRlsTables`: `consultations`, `notification_outbox`, `notification_webhook_events`, `staff_availability_rules`, `consultation_slot_holds`, `crm_follow_up_tasks`.
  - `rlsAssertionsCount`: `10` non-superuser (`NOSUPERUSER NOBYPASSRLS`) role assertions covering unauthenticated, `client` (cross-client isolation), `vendor` (`v_vendor_booking_briefs` only), `event_planner`, `staff`, `notification_worker`, `admin`, `SET LOCAL` pool reset, and SHA-256 `access_token_hash` storage.
  - `concurrencyWaves`: `[2, 3, 10, 25]` simultaneous `INSERT` races verifying exactly 1 winner and `N-1` SQLSTATE `23P01` rejections.
- **SQLSTATE Error Mapping (`tests/phase17f-staging-harnesses.test.ts`, `PASS`):**
  - `23P01` / `23505` / `40001` -> HTTP `409 SLOT_CONFLICT` (zero PII or constraint names exposed).
  - `42501` -> HTTP `403 FORBIDDEN` (zero table names exposed).
  - `08006` / `57P01` -> HTTP `503 DATABASE_UNAVAILABLE`.
- **Transaction Rollback & Locking (`tests/production-hardening.test.ts` + `tests/booking-concurrency.test.ts`, `PASS`):** Verified `BEGIN` -> `SELECT ... FOR UPDATE` -> `COMMIT`, automatic `ROLLBACK` on thrown invariant/DB error, idempotent `Idempotency-Key` replay, reschedule conflict (`409`), cancellation slot release (`200`), and DST transition slot collision handling.

---

## 2. Operator Execution Command for Real Staging PostgreSQL Evidence

```bash
STAGING_DB_CONFIRM=YES_ISOLATED_STAGING \
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full \
npx tsx scripts/verify-staging-postgres.ts
```

Must record real PostgreSQL output showing `10/10` non-superuser RLS passes and `2/3/10/25` concurrency wave `23P01` enforcement before advancing from `CODE_READY` to `STAGING_VERIFIED`.
