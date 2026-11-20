# Phase 18.9 — GitHub Synchronization & Release Readiness

**Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Verified `main` Commit:** `3576b513682757192c4ab3548adac882881be42d` (PR #17 merged `2026-11-20T04:03:02Z`)  
**Target Feature Branch:** `repair/phase18-live-booking-end-to-end`

---

## 1. Phase 18 Modified & Created Files Ready for Branch Commit

### Code & Workflow Repairs
1. `.github/workflows/deploy-pages.yml` — Synced with PR #17 (`3576b513682757192c4ab3548adac882881be42d`) so `VITE_API_BASE_URL` defaults to Railway production origin and fails closed if empty.
2. `server/rateLimit.ts` — Added idempotent `42P01` bootstrap for `rate_limit_buckets` (fixing live Railway `503 RATE_LIMITER_UNAVAILABLE` on customer self-service/auth endpoints) while preserving fail-closed `503` on outages, timeouts, and restricted roles.
3. `server/repositories/postgresRepository.ts` — Added PostgreSQL `schema` readiness diagnostics (`rateLimitTablePresent`, `migrationsTablePresent`, `migrationsAppliedCount`) to `checkPersistenceHealth()` (`/ready`).
4. `server/scheduling.ts` — Added `getStudioTodayIso()` (`America/New_York`) eliminating evening US UTC date drift.
5. `server/app.ts` — Applied `getStudioTodayIso()` on availability defaults & booking event-date checks; aligned `if (staffEmail)` guards on reschedule & cancel notifications.
6. `src/components/ConsultationModal.tsx` — Switched customer self-service calls to `X-Consultation-Token` header (eliminating URL query-string token leakage), applied `America/New_York` `todayIso`, added Step 2 `Retry Availability` button & `holdingSlot` double-click guard, and fixed cross-midnight Step 4 client-timezone timestamp formatting.

### Tests & Acceptance Reports
7. `tests/phase18-live-booking-acceptance.test.ts` — 5 new Phase 18 regression tests (91/91 total tests passing).
8. `docs/phase18/01_LIVE_DEPLOYMENT_AUDIT.md` through `docs/phase18/FINAL_LIVE_BOOKING_ACCEPTANCE_REPORT.md` (10 reports).

---

## 2. Sandbox Git Boundary & Operator PR Commands

This AI Studio sandbox has no `.git` repository metadata, `gh` CLI, or GitHub credentials (`GITHUB_TOKEN`/`GH_TOKEN` unset). No direct push to `main` was attempted. From an authenticated workstation synced to `3576b513682757192c4ab3548adac882881be42d`:

```bash
git fetch origin main
git checkout -b repair/phase18-live-booking-end-to-end origin/main
# Copy the Phase 18 workspace changes into the working tree, then verify:
npm run lint && npm test && npm run build
git add .github/workflows/deploy-pages.yml server/ src/components/ConsultationModal.tsx tests/phase18-live-booking-acceptance.test.ts docs/phase18/
git commit -m "Phase 18: fix live 503 rate_limit_buckets bootstrap, X-Consultation-Token header, studio timezone date drift, and Step 2 retry/hold guards"
git push -u origin repair/phase18-live-booking-end-to-end
gh pr create \
  --base main \
  --head repair/phase18-live-booking-end-to-end \
  --title "Phase 18: Live Consultation Booking Reliability, Security & Self-Service Repair" \
  --body "See docs/phase18/FINAL_LIVE_BOOKING_ACCEPTANCE_REPORT.md for live audit evidence, root-cause fixes (503 RATE_LIMITER_UNAVAILABLE on unmigrated Railway DB, X-Consultation-Token header hardening, studio timezone date drift, Step 2 retry/hold guards), 91/91 automated tests, and 20/20 Chromium acceptance checks."
```

## 3. Pre-Merge Staging & Production Cutover Sequence

1. **Merge & Deploy to Staging First:** Validate `repair/phase18-live-booking-end-to-end` on an isolated Railway staging service + staging PostgreSQL database.
2. **Apply Database Migrations (`001`–`008`):** Run `npx tsx scripts/run-migrations.ts` and `npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill` on staging PostgreSQL, then verify `/ready` shows `schema.migrationsAppliedCount: 8` and `rateLimitTablePresent: true`.
3. **Provision Supabase Auth & Resend Staging Secrets:** Set Supabase and Resend env vars on staging Railway, run `npx tsx scripts/verify-staging-railway-and-resend.ts`, and verify full customer booking -> PostgreSQL persistence -> reschedule/cancel -> Admin Command Center -> Resend delivery & Svix webhook reconciliation.
4. **Explicit Executive Approval for Production:** Only after all 20/20 `LB-01`..`LB-20` gates verify on staging, apply migrations `001`–`008` to production Railway PostgreSQL, merge PR into `main`, verify `/ready`, and enable `EMAIL_LIVE_DELIVERY_ENABLED=true`.
