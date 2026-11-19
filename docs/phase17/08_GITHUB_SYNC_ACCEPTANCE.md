# Phase 17F — GitHub Source Synchronization Acceptance (`REQ-GH-05`)

**Repository:** https://github.com/OphireumTechnology/CelebrationSistersEventDecor  
**Live Verified `main` HEAD SHA:** `6b540d458257f5566c2c2fc916fb92154f980142` (`2026-11-19T21:28:42Z`)  
**Parent Commit SHA:** `62935546a9a978c50be1194c541d30e668f33121`  
**Target Feature Branch:** `feature/phase17-staging-production-acceptance`  
**Requirement Status:** **`BLOCKED`** *(Phase 17 commit `6b540d45` is verified live on GitHub with green CI/Docker/Pages; pushing Phase 17F additions & creating a PR from this sandbox is blocked by missing `.git` metadata and GitHub write credentials)*

---

## 1. Live GitHub Verification Executed (`2026-11-19`)

Direct queries against `https://api.github.com/repos/OphireumTechnology/CelebrationSistersEventDecor` confirmed that **all 18 Phase 17 repair and documentation files** were synchronized onto `main` at commit `6b540d458257f5566c2c2fc916fb92154f980142` (`refactor: enhance GitHub Pages static deployment support`) and passed all hosted CI/CD checks:

| Workflow | Run ID | Commit SHA | Job | Conclusion | URL |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `CI Verification & Production Hardening Checks` | `44619161583` | `6b540d45` | `Typecheck, Lint, Test, Migrations, Audit & Runtime Smoke` | **`success`** | https://github.com/OphireumTechnology/CelebrationSistersEventDecor/actions/runs/44619161583/job/135895854129 |
| `CI Verification & Production Hardening Checks` | `44619161583` | `6b540d45` | `Docker Production Image Build Check` | **`success`** | https://github.com/OphireumTechnology/CelebrationSistersEventDecor/actions/runs/44619161583/job/135896324527 |
| `Deploy Celebration Sisters frontend to GitHub Pages` | `44619161406` | `6b540d45` | `build` | **`success`** | https://github.com/OphireumTechnology/CelebrationSistersEventDecor/actions/runs/44619161406/job/135895854305 |
| `Deploy Celebration Sisters frontend to GitHub Pages` | `44619161406` | `6b540d45` | `deploy` | **`success`** | https://github.com/OphireumTechnology/CelebrationSistersEventDecor/actions/runs/44619161406/job/135896203580 |

---

## 2. Open Pull Requests Audit (13 Historical Open PRs)

Live API inspection found **13 open legacy PRs** whose fixes have already been superseded/reconciled into `main` (`6b540d458257f5566c2c2fc916fb92154f980142`):
- `#16` (`repair/ci-playwright-lockfile-20261120`), `#15` (`repair/phase15r-source-audit`), `#14` (`repair/phase15-booking-consistency`), `#13` (`repair/postgresql-source-control`), `#12` (`repair/phase1-readonly-postgres-audit-20261119`), `#11` (`repair/phase1-readonly-postgres-audit`), `#9` (`repair/main-phase12-ci-and-docker-after-pages`), `#7` (`repair/phase12-ci-secret-scan-docker`), `#6` (`repair/docker-rolldown-glibc-binding`), `#5` (`repair/ci-node-setup-lockfile`), `#4` (`fix/consultation-and-cookie-hardening-20261118`), `#3` (`security/disable-demo-auth-in-production`), `#2` (`fix/typescript7-ci-dependency-conflicts`).
- Operator action: close superseded legacy PRs after verifying no unmerged deltas remain.

---

## 3. Exact External Blocker & Phase 17F Additions Pending Operator Push

**Sandbox Environment Probe Results (Factual):**
- `.git`: `No such file or directory`
- `gh`: `ABSENT`
- `GITHUB_TOKEN`: `UNSET`, `GH_TOKEN`: `UNSET`

**New Phase 17F Source & Documentation Files Verified Locally (`84/84` tests, `0` lint/TS errors, `0` secrets):**
- `server/lib/pgErrorClassifier.ts` (maps PG SQLSTATE `23P01`/`23505`/`40001`/`40P01` -> `409`, `42501` -> `403`, connection codes -> `503` without PII/schema leakage)
- `server/app.ts` (wired global error middleware to `classifyDatabaseError`)
- `scripts/verify-staging-postgres.ts` (upgraded with full 10-point `NOBYPASSRLS` RLS suite, reschedule/cancel/DST exclusion checks, production-label URL guard, and optional `--backup-restore-drill`)
- `scripts/verify-staging-railway-and-resend.ts` (turnkey 13-check Railway Staging API + signed Svix Resend webhook verifier)
- `scripts/phase16-browser-acceptance.ts` (added `TARGET_FRONTEND_URL` + `TARGET_API_BASE_URL` live staging rerun support)
- `tests/phase17f-staging-harnesses.test.ts` (4 new tests expanding suite to **84/84**)
- `docs/phase17/08_*.md` through `docs/phase17/FINAL_100_PERCENT_DEPLOYMENT_ACCEPTANCE.md`

**Exact Operator Commands to Close `REQ-GH-05`:**
```bash
git fetch origin
git checkout -b feature/phase17-staging-production-acceptance origin/main
# Sync Phase 17F files into working tree, then verify:
test ! -f bun.lock && test ! -f .env
npm ci --no-audit --no-fund
npm run typecheck && npm run lint && npm test && npm run build && npm audit --audit-level=high
git add .
git commit -m "feat(phase17f): map PG SQLSTATE 23P01/42501 safely and complete staging PG/Railway/Resend harnesses"
git push -u origin feature/phase17-staging-production-acceptance
# Open Pull Request targeting main and confirm CI Run (verify + docker-build) completes green on the PR head SHA.
```
