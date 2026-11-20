# 11 — Rollback and Recovery Plan

**Project:** Celebration Sisters Event Decor  
**Audit Date:** 2026-11-20

---

## 1. Recovery Tooling Verified in Repository

All 5 disaster-recovery and deployment verification scripts are present and validated (`scripts/verify-deployment-and-rollback.ts` check `rollback_and_dr_scripts`: **PASS**):
1. `scripts/run-migrations.ts` — Pure `SELECT`-only `--dry-run`, transactional apply, SHA-256 checksum drift guard, and PostgreSQL session advisory locking (`pg_try_advisory_lock(728491034218)`).
2. `scripts/verify-deployment-and-rollback.ts` — Automated post-deploy and post-rollback health, readiness, CORS, auth fail-closed, availability, and migration integrity verifier.
3. `scripts/backup-and-restore-drill.ts` — Isolated PostgreSQL `pg_dump` / `pg_restore` verification harness.
4. `scripts/staging-verification-runner.ts` — Staging acceptance runner.
5. `scripts/phase19-live-auth-certification.ts` — Read-only staging external Auth JWT verification harness.

---

## 2. Controlled Rollback Procedures

### A. Railway Backend Rollback (Staging or Future Production)
1. Identify the last known-good Railway deployment ID in the Railway dashboard (`celebration-sisters-staging` service `5ba79779-aa42-4516-b294-900ef137f23c`).
2. Trigger **Rollback / Redeploy** to the previous immutable Docker build image (never delete active environment secrets).
3. Immediately verify recovery via:
   ```bash
   npx tsx scripts/verify-deployment-and-rollback.ts \
     --url https://celebrationsisterseventdecor-staging-staging.up.railway.app \
     --origin https://celebrationsistersdecor.com --strict
   ```
4. Confirm `GET /ready` returns `HTTP 200` with `migrationsAppliedCount: 8`, `overlapConstraintPresent: true`, and `email.liveDeliveryEnabled: false` (on staging).

### B. GitHub Pages Frontend Rollback
1. Revert the offending commit on the release branch or re-run the prior green `Deploy Celebration Sisters frontend to GitHub Pages` workflow run (e.g., baseline Run `44826562767`).
2. Verify `https://celebrationsistersdecor.com/` returns `HTTP 200` and public consultation availability loads without console errors.

### C. PostgreSQL Backup & Restore Recovery Procedure
1. **Pre-Release Snapshot:** Take a full logical snapshot before any future approved production schema change:
   ```bash
   pg_dump --format=custom --no-owner --no-privileges "$TARGET_DATABASE_URL" -f pre_release_snapshot.dump
   ```
2. **Isolated Restore Rehearsal:** Restore ONLY into a disposable verification database (`RESTORE_TEST_DATABASE_URL`), never over a live database without maintenance mode:
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$RESTORE_TEST_DATABASE_URL" pre_release_snapshot.dump
   npx tsx scripts/run-migrations.ts --dry-run
   ```
3. **Post-Restore Checks:** Verify `COUNT(*) = 8` in `public.schema_migrations`, verify `consultations_no_overlapping_active_slots` exclusion constraint exists, and confirm row counts for `users`, `bookings`, `consultations`, and `notification_outbox`.

### D. Emergency Email Pause Switch
If outbound email anomalies occur after future production email activation:
1. Set `EMAIL_LIVE_DELIVERY_ENABLED=false` on the Railway backend service and restart.
2. Confirm `/ready` reports `email.liveDeliveryEnabled: false`; new bookings continue persisting safely while outbox jobs pause without data loss.

---

## 3. Rehearsal Status

- **Rollback Verification Tooling & Local Automated Readiness Fail-Closed Checks:** **VERIFIED**
- **Live PostgreSQL `pg_dump` / `pg_restore` Drill & Live Railway Deployment Rollback Rehearsal:** **BLOCKED** (requires operator execution with `STAGING_DATABASE_URL`, `pg_dump`/`pg_restore`, and Railway deploy permissions).
