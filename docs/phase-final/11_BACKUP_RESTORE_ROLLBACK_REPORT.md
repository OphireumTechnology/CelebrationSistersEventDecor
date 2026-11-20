# 11 — Backup, Restore & Rollback Operational Resilience Report (Phase 27)

**Audit Timestamp:** `2026-11-20T05:02Z`  
**Status:** **RESILIENCE PROCEDURES, FAULT-INJECTION TESTS & GRACEFUL SHUTDOWN VERIFIED — REAL `pg_dump`/`pg_restore` DRILL, RAILWAY ROLLBACK REHEARSAL & LIVE MONITORING VALIDATION BLOCKED ON EXTERNAL INFRASTRUCTURE**

---

## 1. Operational Recovery Objectives & Policies

| Parameter | Target / Policy | Owner |
|---|---|---|
| **Recovery Point Objective (RPO)** | `<= 15 minutes` (managed Railway PostgreSQL continuous WAL / automated daily snapshots + mandatory pre-migration `pg_dump`) | Database / DevOps Lead |
| **Recovery Time Objective (RTO)** | `<= 30 minutes` (Railway instant deployment rollback + `pg_restore` into fresh target DB) | Release Manager |
| **Backup Retention Policy** | 30 daily automated snapshots + 90-day encrypted pre-release archive retention outside the database cluster | DevOps Lead |
| **Monitoring Ownership & Escalation** | P1 (API 5xx > 1% or `/ready` 503 > 2m): Immediate page to On-Call Engineer & Studio Operations Director; P2 (Outbox DeadLetter or Resend webhook reject spike): Triage within 30 minutes | On-Call Engineer -> Engineering Lead -> Studio Owner |

---

## 2. Fault-Injection & Shutdown Tests Executed Locally (`2026-11-20T05:02Z`)

- **Compiled Production Fail-Closed Startup:** `NODE_ENV=production node dist-server/server.mjs` without `DATABASE_URL` / `SESSION_SECRET` exited non-zero (`FAIL_CLOSED_PROD_NO_SECRETS=PASS`).
- **Graceful `SIGTERM` Shutdown:** Compiled server stopped `outboxWorker`, closed HTTP server, drained pool, and exited cleanly (`GRACEFUL_SIGTERM=PASS`).
- **Database Outage Simulation:** Both automated (`tests/production-hardening.test.ts`, `tests/phase18-live-booking-acceptance.test.ts`, `tests/phase19-staging-readiness.test.ts`) and Chromium (`P16-BA-18`) confirmed HTTP `503` fail-closed handling with actionable UI alert and zero false confirmation.
- **Email Provider Outage Simulation:** `tests/phase13-outbox-and-persistence.test.ts` and `tests/production-hardening.test.ts` verified 429/5xx exponential backoff with jitter, timeout handling, and DeadLetter routing.

---

## 3. Verified Runbooks (Required Staging Execution Before Production Approval)

### A. Pre-Migration Backup & Independent Restore Drill (Staging First)
```bash
# Create compressed custom-format archive
pg_dump --format=custom --no-owner --no-privileges \
  --file="cs_backup_$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$TARGET_DATABASE_URL"

# Automated end-to-end staging backup + clean-database restore drill:
STAGING_DB_CONFIRM=YES_ISOLATED_STAGING \
DATABASE_URL="$STAGING_DATABASE_URL" \
PGSSLMODE=verify-full \
npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill
```

### B. Migration Failure Recovery
- Every migration file (`001`–`008`) executes inside an explicit `BEGIN` / `COMMIT` transaction (`ROLLBACK` on error), preventing half-applied DDL.
- If post-migration rollback is required, restore the pre-cutover `pg_dump` custom archive into a fresh database or `--clean --if-exists` target and verify row counts and `schema_migrations` checksums.

### C. Application Rollback (Railway & GitHub Pages)
- **Railway Backend Rollback:** Re-activate the previous known-good Railway deployment image/commit (`63fb9a6fb4425a32cd4780c4099b9dd42c6e5d6a`) via Railway Deployments UI or CLI and verify `GET /health` -> `200`.
- **GitHub Pages Frontend Rollback:** Revert the merge commit on `main` (`git revert -m 1 <merge-sha> && git push`) to trigger `.github/workflows/deploy-pages.yml` and restore the previous verified bundle.
- **Emergency Email Kill-Switch:** Set `EMAIL_LIVE_DELIVERY_ENABLED=false` on Railway to pause all outbound Resend calls immediately without losing durable outbox records.
