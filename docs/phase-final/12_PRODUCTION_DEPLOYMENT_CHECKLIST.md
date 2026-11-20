# 12 — Production Deployment Checklist (Phase 27)

**Current Release State:** **`CODE_READY`**  
**Deployment Authorization Status:** **NOT AUTHORIZED — DO NOT DEPLOY UNTIL `STAGING_VERIFIED` AND EXPLICIT OWNER APPROVAL**

---

## Stage 1 — Source Control & CI Gate (Workstation + GitHub Actions)
- [ ] Copy reconciled Phase 21–28 changes into local Git clone on branch `repair/phase21-28-production-readiness`.
- [ ] Run `npm ci --no-audit --no-fund`, `npm audit --audit-level=high`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `docker build --tag celebration-sisters-prod:phase28 .`.
- [ ] Push branch and open unified PR against `main`; confirm both `CI Verification & Production Hardening Checks` (including `docker-build`) and `Deploy Celebration Sisters frontend to GitHub Pages` preview pass 100% green.
- [ ] Close superseded legacy draft PRs (`#6`, `#7`, `#9`, `#11`–`#16`, `#18`–`#20`).

## Stage 2 — Isolated Staging Provisioning & Verification (`STAGING_READY` -> `STAGING_VERIFIED`)
- [ ] Provision isolated Staging PostgreSQL + Staging Railway Service + Staging Supabase Project + Staging Resend QA configuration.
- [ ] Configure Staging Railway environment variables (names only — never commit values): `NODE_ENV=production`, `PORT=3000`, `TRUST_PROXY=1`, `PERSISTENCE_ADAPTER=postgres`, `ALLOW_DEMO_AUTH=false`, `ALLOWED_ORIGINS`, `SESSION_SECRET`, `DATABASE_URL`, `PGSSLMODE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL` (QA inbox), `RESEND_WEBHOOK_SECRET`, `EMAIL_LIVE_DELIVERY_ENABLED=true`.
- [ ] Run `npx tsx scripts/run-migrations.ts --dry-run` -> `npx tsx scripts/run-migrations.ts` -> rerun to verify 0 pending / 0 checksum drift.
- [ ] Run `STAGING_DB_CONFIRM=YES_ISOLATED_STAGING npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill` (10/10 `NOBYPASSRLS` RLS, 2/3/10/25 `23P01` concurrency waves, `pg_dump`/`pg_restore`).
- [ ] Run `STAGING_API_CONFIRM=YES_ISOLATED_STAGING STAGING_REQUIRE_SUPABASE_AUTH=true STAGING_REQUIRE_RESEND_LIVE=true npx tsx scripts/verify-staging-railway-and-resend.ts` and confirm `GET /ready` returns **HTTP `200` (`status: "ready"`, `productionReady: true`, `blockingReasons: []`)**.
- [ ] Complete Desktop & Mobile staging browser booking, Railway restart durability check, AAL2 MFA admin dashboard verification, QA inbox email receipt, and Railway rollback rehearsal.

## Stage 3 — Production Cutover (Strictly After Explicit Owner Sign-Off)
- [ ] Obtain explicit written owner approval (`PRODUCTION_APPROVAL_REQUIRED` -> approved).
- [ ] Execute pre-cutover production `pg_dump` custom archive and verify archive readability.
- [ ] Configure production Supabase Auth and Resend variables on Railway (`EMAIL_LIVE_DELIVERY_ENABLED=false` initially until smoke tests pass) and public `VITE_SUPABASE_*` variables in GitHub Actions.
- [ ] Apply canonical migrations `001`–`008` to production PostgreSQL (`npx tsx scripts/run-migrations.ts`) and verify idempotent rerun.
- [ ] Merge approved PR to `main`; verify GitHub Pages deploy and Railway deploy succeed.
- [ ] Verify production `GET /health` (`200 alive`) and `GET /ready` (`200 ready`, `migrationsAppliedCount: 8`, `overlapConstraintPresent: true`, `auth.readyForProductionAuth: true`, `email.configured: true`, `worker.healthy: true`).
- [ ] Enable `EMAIL_LIVE_DELIVERY_ENABLED=true` upon final sign-off and monitor error rates, latency, rate limiter, and webhook logs for 30 minutes.
