# 11 — Rollback and Recovery Verification Report

**Project:** Celebration Sisters Event Decor  
**Audit Timestamp:** 2026-11-20T22:50Z

---

## 1. Phase 39 Release Verification Gate Implemented & Tested (`VERIFIED`)

To ensure a green GitHub CI run can never be mistaken for a verified Railway deployment:

1. **Upgraded `scripts/verify-staging-deployment.mjs`:**
   - Queries Railway GraphQL API (`https://backboard.railway.app/graphql/v2`) independently via `RAILWAY_API_TOKEN` + `RAILWAY_SERVICE_ID` + `RAILWAY_ENVIRONMENT_ID` to retrieve the latest `SUCCESS` deployment's `meta.commitHash`, deployment ID, and Railway evidence URL.
   - Enforces strict three-way SHA equality: `GITHUB_APPROVED_SHA === RAILWAY_DEPLOYED_SHA === STAGING_TESTED_SHA`.
   - Verifies HTTPS origin, same-origin path safety, `GET /health`, `GET /ready` (database, migrations, overlap constraint, auth, worker, and `email.liveDeliveryEnabled === false`), unauthenticated fail-closed guards (`/api/bookings=401`, `/api/admin/overview=403`), and optional authenticated AAL2 check.
   - Emits a machine-readable JSON certification result (`PASS` exit `0`, `FAILED` exit `1`, `BLOCKED` exit `2`) and writes it to `--output <path>`.
2. **Dedicated Workflow `.github/workflows/staging-deployment-gate.yml`:**
   - Runs strictly separate from `.github/workflows/ci.yml` (`workflow_dispatch` or post-CI `workflow_run` on `ops/**` and `release/**`).
   - Uploads `staging-deployment-certification.json` via `actions/upload-artifact@v4` with 30-day retention.
3. **Automated Gate Tests (`tests/phase31-40-deployment-gate.test.ts` — `5 / 5 PASS`):**
   - Verified missing evidence (`BLOCKED`, exit `2`), independent Railway GraphQL SHA mismatch (`FAILED`, exit `1`), full pass (`PASS`, exit `0`), non-HTTPS/cross-origin rejection, staging live-email rejection, broken auth guard rejection, and workflow separation.

---

## 2. Rollback & Recovery Procedures Ready

- **Railway Backend Rollback:** Redeploy the previously recorded known-good immutable Docker deployment ID in `celebration-sisters-staging` (`5ba79779-aa42-4516-b294-900ef137f23c`) without altering environment secrets or dropping tables, then verify recovery via `scripts/verify-deployment-and-rollback.ts` and `scripts/verify-staging-deployment.mjs`.
- **GitHub Pages Rollback:** Re-run the last green `Deploy Celebration Sisters frontend to GitHub Pages` run (e.g., Run `44829640386`).
- **PostgreSQL Backup & Restore:** `pg_dump --format=custom` snapshot prior to any future approved production schema change + isolated `pg_restore` into a disposable verification DB + `npx tsx scripts/run-migrations.ts --dry-run`.
- **Emergency Email Kill Switch:** Set `EMAIL_LIVE_DELIVERY_ENABLED=false` and confirm `/ready` reports `liveDeliveryEnabled: false`.

---

## 3. Blocked Live Rehearsal Gates

- **Live Railway Staging Rollback Rehearsal (`REQ-46`):** **BLOCKED** (requires Railway deployment/rollback permissions + `RAILWAY_API_TOKEN`).
- **Live PostgreSQL `pg_dump` / `pg_restore` Recovery Rehearsal (`REQ-14`):** **BLOCKED** (requires `STAGING_DATABASE_URL` and PostgreSQL client tools).
- **Branch Protection Required Status Check for `verify-railway-staging`:** Pending repository admin configuration after `.github/workflows/staging-deployment-gate.yml` is pushed to GitHub.
