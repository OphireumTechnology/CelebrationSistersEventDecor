# Phase 29 — Source Synchronization & Release Branch Acceptance

**Deliverable Mapping:** `PHASE29_GITHUB_RELEASE_ACCEPTANCE.md` / `docs/phase29-35/01_SOURCE_SYNCHRONIZATION.md`  
**Authoritative Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Audit Timestamp:** `2026-11-20T13:51Z`  
**GitHub `main` HEAD SHA:** `288d20ea6be1827e849e663458fa446f7f46ce95` (`2026-11-20T05:10:40Z` — `feat: enhance readiness probes and migration safety`)  
**Target Release Branch:** `release/phase29-35-production-readiness`  
**Phase 29 Status:** **PARTIALLY VERIFIED (`5/6` — `SRC-06` BLOCKED on external Git push credentials & local Docker daemon)**

---

## 1. Authoritative GitHub Repository & PR Reconciliation

Live read-only verification against the GitHub REST API confirmed:

| Ref / PR | Commit SHA | State | Reconciliation Findings |
|---|---|---|---|
| `main` | `288d20ea6be1827e849e663458fa446f7f46ce95` | Default branch (CI green) | Incorporates Phase 19 doc scan fix, Phase 20 read-only migration dry-run, and Phase 23 `/ready` schema/constraint/auth/email/worker separation. |
| PR #20 (`repair/phase20-readonly-migration-dry-run`) | `0eab455a` | Open (superseded by `main`) | `scripts/run-migrations.ts` read-only dry-run and `tests/phase20-migration-readonly.test.ts` are already present and byte-identical in `main` `288d20ea` and the workspace. |
| PR #19 (`repair/phase19-secret-scan-doc-false-positive-20261120`) | `efc5d362` | Open (superseded by `main`) | `docs/phase19/08_REGRESSION_AND_SECURITY_ACCEPTANCE.md` secret-scan remediation is already present in `main` `288d20ea` and the workspace. |
| PR #17 (`repair/connect-pages-to-railway-api-20261120`) | `2338d17b` | Merged (`2026-11-20T04:03:02Z`) | Embedded Railway API origin into GitHub Pages builds cleanly. |

### Blob Parity Audit (Pre-Phase 29 Edits)
Comparing all `200` git blobs in `main` `288d20ea` against `/app/applet`:
- **Identical blobs:** `199 / 200` (`MODIFIED_LOCAL: []`)
- **Missing locally:** `package-lock.json` (excluded from sandbox workspace mount; present and verified on GitHub `main` `288d20ea` in CI Run `44679267813`).

---

## 2. Phase 29–35 Code-Level Repairs Implemented in Workspace

During live compiled smoke testing and workflow inspection, three real code-level defects were identified, reproduced, repaired, and covered by automated regression tests (`tests/phase29-35-readiness-hardening.test.ts`):

1. **Structured Startup Log Over-Redaction (`server/observability.ts`)**
   - **Root Cause:** `SENSITIVE_KEY_PATTERN` matched any key containing `email`, redacting non-PII operational startup diagnostics `emailProvider` and `emailLiveEnabled` to `"[REDACTED]"` in `server_startup_diagnostics`.
   - **Fix:** Added an explicit `SAFE_OPERATIONAL_DIAGNOSTIC_KEYS` allowlist (`emailProvider`, `emailLiveEnabled`, `emailConfigured`, `emailVerified`) while preserving strict redaction of all email PII (`email`, `clientEmail`, `staffNotificationEmail`, `recipientEmail`) and secret patterns.
2. **Production Readiness Blind Spot When Outbox Polling Is Disabled (`server/app.ts`)**
   - **Root Cause:** `evaluateApplicationReadiness()` checked only `worker.healthy` (which defaults to `true` before the first heartbeat), so setting `DISABLE_OUTBOX_POLLING=true` in production would not fail `GET /ready`.
   - **Fix:** Updated `evaluateApplicationReadiness()` so `isProduction && worker.pollingDisabled` sets `checks.worker = false`, returns HTTP `503`, and appends `'Background notification outbox worker polling is disabled in production (DISABLE_OUTBOX_POLLING=true).'`.
3. **Missing `release/**` CI Push Trigger (`.github/workflows/ci.yml`)**
   - **Root Cause:** `on.push.branches` only listed `[main, 'development/**', 'repair/**', 'feature/**']`, omitting `'release/**'`, so pushing `release/phase29-35-production-readiness` would not trigger push CI automatically.
   - **Fix:** Added `'release/**'` to `on.push.branches`.

---

## 3. Command Execution Evidence

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` | **PASS** | `tsc --noEmit` — 0 errors |
| `npm run lint` | **PASS** | `tsc --noEmit && oxlint` — 0 warnings, 0 errors |
| `npx tsx scripts/verify-migrations.ts` | **PASS** | 8 migrations (`001`–`008`), 36 RLS tables checked, 0 errors |
| `npx tsx scripts/reconcile-snapshot-to-normalized.ts` | **PASS** | 44 entities across 13 tables, `anomalies: []` |
| `npm test` | **PASS** | `102 / 102` tests passing (`0` fail, `0` skipped) including 3 new Phase 29–35 regression tests |
| `npm run build` | **PASS** | `dist/index.html` + `dist-server/server.mjs` (`326.x kB`) compiled cleanly |
| Static secret scan (`ci.yml` regex) | **PASS** | `0` matches across `src`, `server`, `scripts`, `docs` |
| `npm ci` / `npm audit --audit-level=high` | **HOSTED CI PASS / LOCAL ENOLOCK** | Passed on identical dependency graph in GitHub Actions Run `44679267813` (`main` `288d20ea`); local sandbox lacks `package-lock.json` |
| `docker build -t celebration-sisters-release .` | **HOSTED CI PASS / LOCAL BLOCKED** | Passed on `main` `288d20ea` in GitHub Actions job `Docker Production Image Build Check` (`44679267813`); local sandbox has no `docker` binary |
| Push `release/phase29-35-production-readiness` & open PR | **BLOCKED** | Sandbox has no `.git` metadata, no `gh` CLI, and `GITHUB_TOKEN`/`GH_TOKEN` are unset |

---

## 4. Operator Commands to Synchronize Release Branch from Authorized Workstation

```bash
git fetch origin
git checkout -B release/phase29-35-production-readiness origin/main
# Apply the verified Phase 29-35 workspace changes (server/observability.ts, server/app.ts,
# .github/workflows/ci.yml, tests/phase29-35-readiness-hardening.test.ts, docs/phase29-35/*)
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
docker build -t celebration-sisters-release .
git add -A
git commit -m "chore(release): phase 29-35 readiness hardening and acceptance package"
git push -u origin release/phase29-35-production-readiness
gh pr create --base main --head release/phase29-35-production-readiness \
  --title "Release: Phase 29-35 production readiness hardening & acceptance evidence"
```

**Note:** After merging `release/phase29-35-production-readiness` (with owner approval), close superseded open PRs `#11`–`#16` and `#18`–`#20` to keep repository hygiene clean.
