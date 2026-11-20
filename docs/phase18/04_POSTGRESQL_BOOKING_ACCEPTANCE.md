# Phase 18.4 — PostgreSQL Booking Persistence & Concurrency Acceptance

**Database Engine:** PostgreSQL 16+ (Railway Internal PostgreSQL in production)  
**Migrations:** `db/migrations/001_initial_schema.sql` through `008_phase15_token_lifecycle_and_webhook_audit.sql`

---

## 1. Live Railway PostgreSQL Findings

1. **Connectivity (`LB-03` — VERIFIED LIVE):**
   - Live `GET /ready` returned `200 OK`: `persistence.adapter = "postgres"`, `ready = true`, `connected = true`, `latencyMs = 2`, `tls = { enabled: false, hostClass: "railway-internal", sslMode: "disable" }` (permitted over Railway private WireGuard network; public-network `sslmode=disable` remains prohibited in `buildPostgresSslConfig()`).
2. **Schema Migration Gap Identified on Live Railway:**
   - Live probe of `GET /api/consultations/status` returned `HTTP 503 RATE_LIMITER_UNAVAILABLE`, proving `rate_limit_buckets` (from `db/migrations/004_production_hardening.sql`) has **not** yet been created on live Railway PostgreSQL — only `app_state_snapshots` (auto-bootstrapped on startup) exists today.
   - **Code Repairs Implemented:**
     - `server/rateLimit.ts`: `PostgresRateLimitStore` now idempotently bootstraps `rate_limit_buckets` once on PostgreSQL `42P01` (`undefined_table`) while preserving strict fail-closed `503` for DB outages, timeouts, and restricted roles (`42501`).
     - `server/repositories/postgresRepository.ts`: `checkPersistenceHealth()` now surfaces `schema: { rateLimitTablePresent, migrationsTablePresent, migrationsAppliedCount }` in `/ready` so operators can verify migrations `001`–`008` immediately after deployment.

---

## 2. Persistence Architecture & Concurrency Honesty Note

- **Runtime Transaction Model (`server/repositories/postgresRepository.ts`):**
  - `runPostgresTransaction()` acquires a PostgreSQL row-level `SELECT ... FOR UPDATE` lock on `app_state_snapshots (state_key = 'primary_v1')`, executes booking + hold + outbox + audit mutations atomically inside `BEGIN ... COMMIT` (rolling back on any exception), and persists the updated state to PostgreSQL.
  - This guarantees strict serialization of concurrent booking attempts, idempotency deduplication, hold expiration, and outbox enqueueing across restarts when `PERSISTENCE_ADAPTER=postgres`.
- **Normalized Schema (`db/migrations/001`–`008`) & Reconciliation:**
  - `db/migrations/007_consultation_scheduling_and_railway_rls.sql` defines normalized `consultations`, `consultation_slot_holds`, `staff_availability_rules`, `crm_follow_up_tasks`, `excl_consultations_planner_buffered_overlap` (`btree_gist` exclusion constraint), `uq_consultations_idempotency_key`, and non-superuser RLS policies.
  - `scripts/reconcile-snapshot-to-normalized.ts` maps snapshot state into normalized tables cleanly.
  - **Honest Status for `LB-10`, `LB-11`, `LB-12`:** Local transactional concurrency, double-booking rejection (`409`), idempotency (`200` deduplication), and SQL migration/constraint static validations all pass. However, because the sandbox has no direct PostgreSQL network access (`DATABASE_URL` unavailable) and production write testing is prohibited without approval, **live Railway PostgreSQL write/restart/concurrent-booking verification remains BLOCKED pending operator execution against an isolated staging PostgreSQL instance.**

---

## 3. Exact Operator Verification Commands (Staging / Pre-Prod PostgreSQL)

```bash
# 1. Apply migrations 001–008 idempotently to staging PostgreSQL
DATABASE_URL="postgresql://..." npx tsx scripts/run-migrations.ts

# 2. Verify real PostgreSQL migrations, RLS non-superuser enforcement,
#    concurrent exclusion-constraint conflict (23P01), idempotency (23505),
#    and backup/restore drill
DATABASE_URL="postgresql://..." npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill

# 3. Verify /ready reports schema.migrationsAppliedCount >= 8 and rateLimitTablePresent: true
curl -sS https://<staging-railway-host>/ready | jq '.dependencies.persistence'
```
