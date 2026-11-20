# Phase 19 — 04 RLS & Concurrency Acceptance

**Audit Timestamp:** `2026-11-20T04:30:31Z`  
**Status:** **HARNESS & LOCAL CONCURRENCY VERIFIED — LIVE POSTGRESQL `NOBYPASSRLS` & `23P01` EXECUTION BLOCKED (NO STAGING `DATABASE_URL` IN SANDBOX)**

---

## 1. Automated Harness Verification (`scripts/verify-staging-postgres.ts --self-check`)

Verified on `2026-11-20T04:29:33Z`:

```json
{
  "ok": true,
  "mode": "self-check",
  "guardRequired": "STAGING_DB_CONFIRM=YES_ISOLATED_STAGING",
  "exclusionConstraint": "excl_consultations_planner_buffered_overlap",
  "requiredCoreForceRlsTables": [
    "consultations",
    "notification_outbox",
    "notification_webhook_events",
    "staff_availability_rules",
    "consultation_slot_holds",
    "crm_follow_up_tasks"
  ],
  "rlsAssertionsCount": 10,
  "concurrencyWaves": [2, 3, 10, 25],
  "optionalFlags": ["--backup-restore-drill"]
}
```

### 10-Point Non-Superuser (`NOBYPASSRLS`) Security Matrix Encoded in Harness
1. Ephemeral `NOSUPERUSER NOBYPASSRLS` role created for staging verification (never relies on superuser bypass).
2. `FORCE ROW LEVEL SECURITY` verified across all 36 domain tables including all 6 Phase 14/15 consultation & notification tables.
3. Unauthenticated context denied reads/writes on `consultations`, `notification_outbox`, `crm_follow_up_tasks`, and `notification_webhook_events`.
4. Client context isolated strictly to own bookings/consultations (cross-client enumeration returns 0 rows; cross-client update denied).
5. Vendor context scoped strictly to `v_vendor_booking_briefs` (zero private client PII or financial quote leakage).
6. Event Planner / Staff context scoped to authorized operational records.
7. `notification_worker` context permitted scoped outbox claim/update without unrestricted admin read/write.
8. Admin context permitted governed administrative operations under `SET LOCAL app.*` session variables.
9. Transaction-scoped `SET LOCAL` session variables reset cleanly across pooled connections (zero cross-request leakage).
10. Scoped `csa_` consultation token hashes stored only as SHA-256 digests (`access_token_hash`), never plaintext.

### Concurrency & Scheduling Integrity Matrix Encoded in Harness
- **PostgreSQL MVCC Race Waves:** 2-way, 3-way, 10-way, and 25-way parallel `INSERT` races targeting the identical planner/slot (`excl_consultations_planner_buffered_overlap` using `btree_gist` + `tstzrange` with 15-minute buffer): exactly **1 succeeds**, remaining **N-1 fail with SQLSTATE `23P01`**, mapped by `server/lib/pgErrorClassifier.ts` to sanitized HTTP `409 SLOT_CONFLICT` with zero PII or constraint-name exposure.
- **Idempotency Replay:** Duplicate `Idempotency-Key` (`23505`) returns original booking without duplicate slot or outbox insertion.
- **Expired Hold Reclaim:** Expired `consultation_slot_holds` do not block subsequent valid bookings.
- **Reschedule Conflict & Cancellation Release:** Verified in `tests/phase17f-staging-harnesses.test.ts` (`PASS` at `2026-11-20T04:30:28Z`) — rescheduling onto an occupied slot returns `409`; cancelling the occupying booking immediately releases the slot (`200`).
- **DST Transition Collision & Notice Cutoff:** Verified in `tests/booking-concurrency.test.ts`, `tests/phase14-consultation-system.test.ts`, and `tests/phase15r-critical-repairs.test.ts` (`94/94` total automated suite `PASS`).

---

## 2. Exact Operator Command to Execute Live Staging RLS & Concurrency Verification

```bash
STAGING_DB_CONFIRM=YES_ISOLATED_STAGING \
DATABASE_URL="postgresql://<staging-user>:<staging-pass>@<staging-host>:5432/<staging-db>" \
PGSSLMODE=verify-full \
npx tsx scripts/verify-staging-postgres.ts
```
