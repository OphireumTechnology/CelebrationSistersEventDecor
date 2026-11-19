# Phase 17 — GitHub Repository Reconciliation & Release Candidate Report

**Repository:** https://github.com/OphireumTechnology/CelebrationSistersEventDecor  
**Authoritative Production Branch:** `main`  
**Verified `main` HEAD SHA:** `62935546a9a978c50be1194c541d30e668f33121`  
**`main` Commit Timestamp:** `2026-11-19T21:00:57Z`  
**Target Phase 17 PR Branch:** `feature/phase17-staging-production-acceptance`  
**Push / PR Status from Sandbox:** `BLOCKED` (no local `.git` metadata or authenticated GitHub write token in sandbox)

---

## 1. Live GitHub `main` & Workflow Verification

Live inspection of `OphireumTechnology/CelebrationSistersEventDecor` confirmed that the Phase 16 hardening commit `62935546a9a978c50be1194c541d30e668f33121` is active on `main` and passed all hosted CI/CD workflows cleanly:

| Workflow | Run ID | Commit SHA | Jobs | Outcome |
| :--- | :--- | :--- | :--- | :--- |
| `CI Verification & Production Hardening Checks` (`.github/workflows/ci.yml`) | `44614486909` | `62935546a9a978c50be1194c541d30e668f33121` | `Typecheck, Lint, Test, Migrations, Audit & Runtime Smoke`; `Docker Production Image Build Check` | **`completed / success`** |
| `Deploy Celebration Sisters frontend to GitHub Pages` (`.github/workflows/deploy-pages.yml`) | `44614486936` | `62935546a9a978c50be1194c541d30e668f33121` | `build`; `deploy` | **`completed / success`** |

Key repository hygiene facts verified on `main` (`62935546`) and in the local release workspace:
- `bun.lock` is **absent** on `main` and **absent** in the local workspace (`package-lock.json` is the sole authoritative lockfile).
- `.env` is **absent** from tracked files and local workspace; only `.env.example` is tracked.
- `package-lock.json` passes `npm ci --dry-run --no-audit --no-fund` cleanly.
- `npm audit --audit-level=high` reports **0 vulnerabilities**.

---

## 2. Pull Request & Branch Reconciliation

All prior Phase 14–16 stabilization items (including the earlier PR #14 consultation booking fixes, PR #15 lockfile/CORS/email-centralization/observability hardening, and PR #16 migration runner + Chromium acceptance suite) are already reconciled into `main` at `62935546a9a978c50be1194c541d30e668f33121`.

Phase 17 adds strictly targeted staging-readiness repairs and verification harnesses on top of `62935546`:

| File | Change Type | Purpose |
| :--- | :--- | :--- |
| `vite.config.ts` | Modified | Injects `import.meta.env.VITE_GITHUB_PAGES` flag (`'true'` during `GITHUB_PAGES=true` builds) so apex custom-domain Pages builds reliably detect static-hosting mode even when Vite `base` is `'/'`. |
| `src/lib/apiClient.ts` | Modified | Detects static Pages hosting via `VITE_GITHUB_PAGES === 'true'` and `isStaticPagesHostname()` (`celebrationsistersdecor.com`, `www.celebrationsistersdecor.com`, `*.github.io`); returns structured JSON `503 BACKEND_NOT_CONFIGURED` instead of firing guaranteed HTML `404` requests when `VITE_API_BASE_URL` is unset. |
| `server/app.ts` | Modified | Exposes `demoPersonasAvailable: process.env.NODE_ENV !== 'production'` on `GET /api/auth/config` while keeping `GET /api/auth/personas` strictly fail-closed (`404`) in production. |
| `src/App.tsx` | Modified | Skips auth bootstrap fetches when `!isBackendConfigured`; reads `/api/auth/config` before conditionally requesting `/api/auth/personas`, permanently eliminating production browser `404` console noise. |
| `src/components/ConsultationModal.tsx` | Modified | Checks `Content-Type` JSON header and handles `503 BACKEND_NOT_CONFIGURED` and non-JSON HTML `404` responses with clear, honest availability diagnostics and zero fabricated slots. |
| `.env.example` | Modified | Documents production/apex custom domain origins (`https://celebrationsistersdecor.com,https://www.celebrationsistersdecor.com,https://ophireumtechnology.github.io`) in `ALLOWED_ORIGINS`. |
| `.github/workflows/deploy-pages.yml` | Modified | Adds explicit `VITE_API_BASE_URL` validation step: warns clearly when unset, validates `https://` scheme when set, and asserts the configured Railway API origin is embedded in `dist/assets/*.js`. |
| `tests/phase17-staging-and-api-routing.test.ts` | Added | 5 new regression tests covering apex static-host detection, Railway cross-origin routing, `/api/auth/config` `demoPersonasAvailable`, expired/revoked consultation token `403` rejection, and expired Svix webhook `>300s` replay guard. |
| `scripts/verify-staging-postgres.ts` | Added | Safety-guarded (`STAGING_DB_CONFIRM=YES_ISOLATED_STAGING`) real staging PostgreSQL 16+ verification script (PG version >= 16, verified TLS, ordered migrations + idempotency, 36-table `FORCE RLS`, `EXCLUDE USING gist` constraint, and real multi-connection 2/3/10/25-way MVCC concurrency proof). |
| `docs/phase17/*.md` | Added | Complete 9-document Phase 17 evidence package and 72-requirement reconciliation ledger. |

---

## 3. Operator Git Synchronization & PR Commands (External Gate `REQ-GH-05`)

Because this AI Studio sandbox does not contain `.git` credentials or GitHub push authorization, an authorized repository operator should publish the Phase 17 release candidate onto a dedicated feature branch (never pushing directly to `main`):

```bash
git fetch origin
git checkout -b feature/phase17-staging-production-acceptance origin/main
# Apply/sync Phase 17 workspace changes, then verify hygiene:
test ! -f bun.lock && test ! -f .env
npm ci --no-audit --no-fund
npm run typecheck && npm run lint && npm test && npm run build
git status
git add .
git commit -m "chore(phase17): repair apex Pages API routing, zero-404 auth bootstrap, and staging PG harness"
git push -u origin feature/phase17-staging-production-acceptance
# Open Pull Request targeting main and verify ci.yml (verify + docker-build) completes green.
```

**Production Merge Gate:** Do **not** merge into `main` until the 6 staging acceptance gates (`02`–`07`) have executed cleanly against isolated staging infrastructure and explicit release authorization is granted.
