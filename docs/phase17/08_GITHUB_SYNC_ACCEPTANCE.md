# Phase 17F — GitHub Source Synchronization Acceptance (`REQ-GH-05`)

**Repository:** https://github.com/OphireumTechnology/CelebrationSistersEventDecor  
**Live Verified `main` HEAD SHA:** `5f1982df7a86b9c49da9ce0781b8215b79a97f1e` (`2026-11-19T21:45:09Z`)  
**Parent Commit SHA:** `6b540d458257f5566c2c2fc916fb92154f980142`  
**Target Feature Branch:** `feature/phase17-staging-production-acceptance`  
**Requirement Status:** **`BLOCKED`** *(Commit `5f1982df` is verified live on GitHub `main` with green CI, Docker, and Pages workflows; pushing the new Phase 17F SQL/migration-runner repairs to `feature/phase17-staging-production-acceptance` and opening a PR from this sandbox is blocked by missing `.git` metadata and GitHub write credentials)*

---

## 1. Live GitHub Verification Executed (`2026-11-19`)

Direct queries against `https://api.github.com/repos/OphireumTechnology/CelebrationSistersEventDecor` confirmed that commit `5f1982df7a86b9c49da9ce0781b8215b79a97f1e` (`refactor(db): implement centralized error classification`) is live on `main`, contains `package-lock.json` (`hasPackageLock: true`, `hasBunLock: false`), and passed all hosted CI/CD checks:

| Workflow | Run ID | Commit SHA | Job | Conclusion | URL |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `CI Verification & Production Hardening Checks` | `44621911782` | `5f1982df` | `Typecheck, Lint, Test, Migrations, Audit & Runtime Smoke` | **`success`** | https://github.com/OphireumTechnology/CelebrationSistersEventDecor/actions/runs/44621911782/job/135905508263 |
| `CI Verification & Production Hardening Checks` | `44621911782` | `5f1982df` | `Docker Production Image Build Check` | **`success`** | https://github.com/OphireumTechnology/CelebrationSistersEventDecor/actions/runs/44621911782/job/135905947037 |
| `Deploy Celebration Sisters frontend to GitHub Pages` | `44621911905` | `5f1982df` | `build` | **`success`** | https://github.com/OphireumTechnology/CelebrationSistersEventDecor/actions/runs/44621911905/job/135905508881 |
| `Deploy Celebration Sisters frontend to GitHub Pages` | `44621911905` | `5f1982df` | `deploy` | **`success`** | https://github.com/OphireumTechnology/CelebrationSistersEventDecor/actions/runs/44621911905/job/135905874039 |

---

## 2. Open Pull Requests Audit (13 Historical Open PRs)

Live API inspection found **13 open legacy PRs** whose fixes have already been superseded/reconciled into `main` (`5f1982df7a86b9c49da9ce0781b8215b79a97f1e`):
- `#16` (`repair/ci-playwright-lockfile-20261120`), `#15` (`repair/phase15r-source-audit`), `#14` (`repair/phase15-booking-consistency`), `#13` (`repair/postgresql-source-control`), `#12` (`repair/phase1-readonly-postgres-audit-20261119`), `#11` (`repair/phase1-readonly-postgres-audit`), `#9` (`repair/main-phase12-ci-and-docker-after-pages`), `#7` (`repair/phase12-ci-secret-scan-docker`), `#6` (`repair/docker-rolldown-glibc-binding`), `#5` (`repair/ci-node-setup-lockfile`), `#4` (`fix/consultation-and-cookie-hardening-20261118`), `#3` (`security/disable-demo-auth-in-production`), `#2` (`fix/typescript7-ci-dependency-conflicts`).
- Operator action: close superseded legacy PRs after verifying no unmerged deltas remain.

---

## 3. Exact External Blocker & New Phase 17F Repairs Pending Operator PR

**Sandbox Environment Probe Results (Factual):**
- `.git`: `ABSENT` (`fatal: not a git repository`)
- `gh`: `ABSENT`
- `GITHUB_TOKEN`: `UNSET`, `GH_TOKEN`: `UNSET`

**New Phase 17F Repairs Verified Locally (`86/86` tests, `0` lint/TS errors, `20/20` Chromium, `0` secrets):**
- `scripts/run-migrations.ts` — Fixed fatal `schema_migrations` DDL incompatibility with migrations `005`–`008` (`filename` column + nullable `checksum_sha256` + `ON CONFLICT (version) DO UPDATE`) so fresh and pre-existing PostgreSQL 16+ runs never crash on Migration `005`.
- `scripts/verify-staging-postgres.ts` — Repaired all SQL queries, UUID types, parent table seeding (`users`, `clients`, `bookings`, `consultations`, `notification_outbox`, `audit_logs`), real constraint name (`excl_consultations_planner_buffered_overlap`), real worker RLS role (`notification_worker`), `v_vendor_booking_briefs` `security_invoker` check, `uq_consultations_idempotency_key` (`23505`) + `consultation_slot_holds` expired-hold checks, and post-restore DB connectivity verification in `--backup-restore-drill`.
- `scripts/phase16-browser-acceptance.ts` — Made Chromium executable resolution portable across the AI Studio sandbox and standard Playwright workstations/CI runners.
- `tests/phase17f-staging-harnesses.test.ts` — Expanded to 6 tests (`86/86` total) guarding `schema_migrations` compatibility and staging SQL-to-migration contract parity.
- `docs/phase17/08_*.md` through `docs/phase17/FINAL_100_PERCENT_DEPLOYMENT_ACCEPTANCE.md` — Corrected file paths (`server/notifications.ts`, `server/outbox.ts`, `db/migrations/`), real constraint names, RLS counts, and live `main` SHA (`5f1982df`).

**Exact Operator Commands to Close `REQ-GH-05`:**
```bash
git fetch origin
git checkout -b feature/phase17-staging-production-acceptance origin/main
# Sync updated Phase 17F files into working tree, then verify:
test ! -f bun.lock && test ! -f .env
npm ci --no-audit --no-fund
npm run typecheck && npm run lint && npm test && npm run build && npm audit --audit-level=high
npx tsx scripts/verify-migrations.ts && npx tsx scripts/run-migrations.ts --dry-run
docker build --tag celebration-sisters-prod:verify .
git add .
git commit -m "fix(phase17f): align migration runner and staging PostgreSQL verifier with real 001-008 schema"
git push -u origin feature/phase17-staging-production-acceptance
# Open Pull Request targeting main (do NOT merge without approval) and confirm hosted CI (verify + docker-build) passes on the PR head SHA.
```
