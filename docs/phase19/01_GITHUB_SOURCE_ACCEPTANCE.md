# Phase 19 — 01 GitHub Source & CI Acceptance

**Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Verified Live `main` Commit:** `b9316bc9618f9dce666ddbe5dbe465db531a93b7` (`2026-11-20T04:21:52Z`, `"docs: document phase 18 deployment and audit"`)  
**Previous Merge Commit:** `3576b513682757192c4ab3548adac882881be42d` (PR #17, merged `2026-11-20T04:03:02Z`)  
**Target Phase 19 Development Branch:** `repair/phase19-final-production-readiness`  
**Audit Timestamp:** `2026-11-20T04:30Z`  
**Status:** **REPAIRED IN WORKSPACE — GITHUB PUSH / PR BLOCKED (NO `.git` / NO `GITHUB_TOKEN` IN SANDBOX)**

---

## 1. Live GitHub Baseline & Critical CI/Pages Defect Discovered

Inspection of GitHub `main` (`b9316bc9618f9dce666ddbe5dbe465db531a93b7`) and hosted GitHub Actions workflow runs revealed **two active CI/deployment failures on `main`**:

| Workflow | Run ID | Conclusion | Failing Step | Downstream Impact |
|---|---|---|---|---|
| `CI Verification & Production Hardening Checks` | `44673902149` | `failure` | `Automated unit, integration & security regression tests` | `Docker Production Image Build Check` was skipped. |
| `Deploy Celebration Sisters frontend to GitHub Pages` | `44673902178` | `failure` | `Run automated regression tests` | `deploy` job was skipped — `https://celebrationsistersdecor.com/` is still serving PR #17's older bundle (`3576b513682757192c4ab3548adac882881be42d`). |

### Root Causes Identified & Fixed in Phase 19

1. **Workflow Regex Mismatch (`tests/phase18-live-booking-acceptance.test.ts` line 334):**
   - `.github/workflows/deploy-pages.yml` line 57 enforces empty `VITE_API_BASE_URL` fail-closed via GitHub Actions annotation `echo "::error::VITE_API_BASE_URL must be configured for production booking."` followed by `exit 1`.
   - `tests/phase18-live-booking-acceptance.test.ts` asserted the older string `/ERROR: VITE_API_BASE_URL is empty/`, failing both CI and GitHub Pages builds on `main`.
   - **Repair:** Updated assertion to verify fail-closed empty `VITE_API_BASE_URL` guard matching either `::error::` or `ERROR:` plus `exit 1`.
2. **Test Database Isolation Defect (`tests/phase18-live-booking-acceptance.test.ts` lines 173–178 & 221):**
   - Test 63 set `process.env.DATA_FILE_PATH` instead of the real `CS_DB_PATH` + `PERSISTENCE_ADAPTER='json-local'` environment variables, causing repeat local runs to collide on the hardcoded `Idempotency-Key` (`200` instead of `201`).
   - **Repair:** Switched to `CS_DB_PATH` inside `os.tmpdir()` with `PERSISTENCE_ADAPTER='json-local'` and a unique per-run `Idempotency-Key`.

---

## 2. Open Pull Request Inventory on GitHub

| PR | Status | Notes |
|---|---|---|
| `#17` | Merged (`3576b513682757192c4ab3548adac882881be42d`) | Phase 17F live booking & Pages configuration. |
| `#13`, `#14`, `#15`, `#16` | Open (Legacy) | Pre-Phase 17 branches; do not merge without rebase/supersede review. |

---

## 3. Sandbox Environment Boundaries

- **Git Metadata:** `.git` directory is absent (`NO_GIT_REPO`); `GITHUB_TOKEN` / `GH_TOKEN` are unset; `gh` CLI is not installed.
- **Lockfile & Container Tooling:** `package-lock.json` is absent in the AI Studio workspace (`LOCKFILE_MISSING`; present on GitHub `main`) and `docker` daemon is absent (`docker: MISSING`). Therefore, `npm ci`, `npm audit`, and `docker build` must execute on the operator workstation and GitHub Actions runner once pushed.

---

## 4. Exact Operator Commands to Push Branch & Open Phase 19 PR

```bash
git checkout main
git pull --ff-only origin main
git checkout -b repair/phase19-final-production-readiness

# Copy Phase 19 workspace changes into the local clone, then verify:
npm ci --no-audit --no-fund
npm run typecheck
npm run lint
npm test
npm run build
docker build --tag celebration-sisters-prod:phase19 .

git add -A
git commit -m "fix(phase19): unblock CI/Pages test guard, harden concurrent rate-limit bootstrap, and add staging readiness verification"
git push -u origin repair/phase19-final-production-readiness

gh pr create \
  --base main \
  --head repair/phase19-final-production-readiness \
  --title "Phase 19: Unblock CI/Pages, Harden Concurrent Rate-Limit Bootstrap & Staging Readiness Suite" \
  --body "Fixes failing CI/Pages workflow assertion on main (runs 44673902149 & 44673902178), replaces non-atomic 42P01 rate-limit bootstrap with single-flight coordination, expands staging verification gates (STG-SEC-01/STG-AUTH-01/STG-RES-00), and adds Phase 19 acceptance reports under docs/phase19/."
```
