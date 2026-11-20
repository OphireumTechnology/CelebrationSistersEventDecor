# Phase 35 — Backup, Restore & Rollback Operational Resilience

**Deliverable Mapping:** `docs/phase29-35/08_BACKUP_RESTORE_AND_ROLLBACK.md`  
**Audit Timestamp:** `2026-11-20T13:58Z`  
**Operational Resilience Domain Status:** **PARTIALLY VERIFIED (`2/6` — `OPS-03`..`OPS-06` BLOCKED on external staging/Railway/owner access)**

---

## 1. Verified Resilience Controls (`OPS-01`, `OPS-02`)

- **Fault Injection (`OPS-01` — VERIFIED):**
  - Database `HTTP 503` interception during booking submission (`P16-BA-18`) shows an actionable recovery banner with zero false confirmation, and subsequent retry succeeds cleanly.
  - Resend `429`/`5xx`/network timeout failures trigger exponential backoff + jitter and escalate exhausted/permanent failures to `DeadLetter` with immutable audit trails.
  - Compiled production server fails closed on missing `DATABASE_URL`/`SESSION_SECRET` and executes graceful `SIGTERM` shutdown (`SMOKE_SIGTERM_EXIT=0`, draining HTTP server, stopping outbox polling, closing PostgreSQL pool).
  - Phase 31 readiness guard now also fails `GET /ready` (`503`) if `DISABLE_OUTBOX_POLLING=true` in production.
- **Recovery Runbooks (`OPS-02` — VERIFIED):** RPO/RTO targets, PostgreSQL custom-format backup/restore procedures, Railway deployment rollback steps, and GitHub Pages revert workflows are codified in `docs/phase-final/11_BACKUP_RESTORE_ROLLBACK_REPORT.md` and `scripts/verify-staging-postgres.ts`.

---

## 2. Blocked External Resilience Drills (`OPS-03`..`OPS-06`)

| ID | Drill / Control | Blocker | Required Operator Execution |
|---|---|---|---|
| `OPS-03` | Real `pg_dump` & isolated `pg_restore` drill | No `pg_dump`/`pg_restore` binaries or staging `DATABASE_URL` / `STAGING_RESTORE_DATABASE_URL` in sandbox | Run `STAGING_DB_CONFIRM=YES_ISOLATED_STAGING npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill` and confirm `restoredMigrationsCount >= 8`, `restoredConstraintPresent: true`, `restoredRlsCount >= 36`. |
| `OPS-04` | Railway restart & deployment rollback rehearsal | No `RAILWAY_TOKEN` or isolated staging Railway service access | Trigger controlled staging restart + rollback to prior deployment image in Railway; confirm `/health` (`200`), `/ready` (`200`), and persisted booking durability. |
| `OPS-05` | Production monitoring & incident alerting validation | No Railway/log-sink alerting credentials | Configure alerts on `/ready != 200`, `5xx` rate spikes, outbox `DeadLetter` growth, and PostgreSQL connection failures; trigger and record a synthetic staging alert. |
| `OPS-06` | Owner approval & post-cutover production smoke | Blocked behind `STAGING_VERIFIED` and explicit owner sign-off | Present completed staging evidence package for owner approval before production cutover. |
