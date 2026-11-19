# Phase 14 — Block 14.11: CI Pipeline & Production Release Readiness

## CI Workflow Updates (`.github/workflows/ci.yml`)
- Added `'feature/**'` to push triggers alongside `main`, `'development/**'`, and `'repair/**'` so Phase 14 feature branches run full automated verification automatically.
- Updated migration validation step label and script coverage to verify SQL migrations `001`–`007` and all 35 RLS-protected tables.

## Local CI Gate Verification Results

| CI Gate | Command / Check | Status | Observed Output |
| :--- | :--- | :--- | :--- |
| **Artifact & Secret Hygiene** | Check absent `.env`, `bun.lock`, `data/backups/*.json` + regex scan over `src`, `server`, `scripts`, `docs` | **PASS** | `HYGIENE_AND_SECRET_SCAN=PASS` (0 matches) |
| **Dependency Audit** | `npm audit --audit-level=high` | **PASS** | `found 0 vulnerabilities` |
| **SQL Migrations & RLS Audit** | `npx tsx scripts/verify-migrations.ts` | **PASS** | Migrations `001`–`007` valid; 35 RLS tables verified |
| **Normalized Reconciliation Dry-Run** | `npx tsx scripts/reconcile-snapshot-to-normalized.ts` | **PASS** | Clean dry-run pass |
| **Typecheck & Linter** | `npm run lint` | **PASS** | 0 TypeScript errors, 0 Oxlint warnings |
| **Automated Test Suite** | `npm test` | **PASS** | 50 / 50 tests passed |
| **GitHub Pages Custom Domain Build** | `GITHUB_PAGES=true GITHUB_PAGES_CUSTOM_DOMAIN=true npm run build:client` | **PASS** | `dist/CNAME` = `celebrationsistersdecor.com`, root-relative `/assets/`, `dist/assets/celebration-sisters-logo.png` verified |
| **Full Client & Server Build** | `npm run build` | **PASS** | `dist/index.html` + `dist-server/server.mjs` (284.8 kB) compiled cleanly |
| **Production Fail-Closed Boot** | `NODE_ENV=production PORT=3198 node dist-server/server.mjs` | **PASS** | Exits non-zero without `DATABASE_URL` and `SESSION_SECRET` |
| **Compiled Runtime Smoke Test** | Boot `dist-server/server.mjs` on port `3199` | **PASS** | `/health` (`alive`), `/ready` (`persistence.ready: true`), `/api/auth/config`, and `/api/consultations/availability?days=3` all returned valid JSON; clean `SIGTERM` shutdown |

## Production Operator Deployment Checklist (External Infrastructure Required)
The following production deployment steps require live infrastructure credentials and cannot be executed inside the sandbox environment:

1. **Railway Backend Service (`CelebrationSistersEventDecor` in project `zesty-curiosity`):**
   - Confirm `NODE_ENV=production`, `PERSISTENCE_ADAPTER=postgres`, `DATABASE_URL` (using non-superuser role without `BYPASSRLS`), `SESSION_SECRET`, `ALLOWED_ORIGINS=https://celebrationsistersdecor.com,https://www.celebrationsistersdecor.com`, and `STUDIO_NOTIFICATION_EMAIL`.
   - Apply `db/migrations/007_consultation_scheduling_and_railway_rls.sql` against the production PostgreSQL instance during a verified maintenance window (following the Railway PG RLS bootstrap notes in `docs/phase14/03_postgresql_architecture.md`).
   - Verify `/health`, `/ready`, and `GET /api/consultations/availability` over HTTPS after deployment.
2. **Resend Transactional Email Configuration:**
   - Verify SPF, DKIM, and DMARC records for `celebrationsistersdecor.com`.
   - Configure `RESEND_API_KEY`, `EMAIL_FROM`, and `EMAIL_LIVE_DELIVERY_ENABLED=true` on Railway.
   - Register Resend delivery webhook endpoint to upgrade `ProviderAccepted` records to confirmed `Delivered` / `Bounced` status.
3. **GitHub Pages Frontend (`celebrationsistersdecor.com`):**
   - Merge verified branch into `main` via reviewed PR after CI green check.
   - Confirm `VITE_API_BASE_URL` points to the production Railway HTTPS origin and verify live booking wizard, availability fetch, and Admin Consultation Command Center end-to-end.
4. **Live Scheduled Reminders:**
   - Configure an external cron trigger (Railway Cron or GitHub Actions schedule) to call `POST /api/consultations/reminders/dispatch` hourly using a dedicated authenticated studio operations token, or run the in-process worker on a single primary replica.
