# 02 — Architecture Gap Analysis & Defect Register

**Baseline `main` Commit:** `63fb9a6fb4425a32cd4780c4099b9dd42c6e5d6a`  
**Audit Timestamp:** `2026-11-20T04:59Z`

---

## 1. Confirmed Defects Found & Resolved in Source Code

| Gap ID | Severity | Area | Confirmed Defect | Resolution Applied | Verification Status |
|---|---|---|---|---|---|
| **GAP-01** | High | GitHub CI (`main`) | Hosted CI Run `44675475930` failed on `main` (`63fb9a6fb4`) because `docs/phase19/08_REGRESSION_AND_SECURITY_ACCEPTANCE.md` included a literal key prefix token scanned by `ci.yml`. | Integrated PR #19 fix replacing literal prefix tokens with descriptive prose. | **VERIFIED** (`CI_SECRET_SCAN=PASS`) |
| **GAP-02** | High | PostgreSQL Migrations | `scripts/run-migrations.ts` executed `CREATE TABLE` / `ALTER TABLE` on `schema_migrations` even during connected `--dry-run`. | Integrated PR #20 (`0eab455a`) strictly read-only `SELECT to_regclass` + `SELECT` dry-run + `tests/phase20-migration-readonly.test.ts`. | **VERIFIED** (`99 / 99` tests pass) |
| **GAP-03** | Critical | Backend Readiness (`/ready`) | `GET /ready` returned HTTP `200 ok: true` in production solely because `SELECT 1` succeeded — even when `migrationsAppliedCount: 0`, `auth.readyForProductionAuth: false`, and `email.configured: false`. | Implemented `evaluateApplicationReadiness()` in `server/app.ts`, extended catalog/constraint checks in `postgresRepository.ts`, added worker status in `outbox.ts`, and enforced `503 not_ready` in production when any required dependency is missing. | **VERIFIED** (`tests/phase23-readiness-and-hardening.test.ts`) |
| **GAP-04** | Medium | Staging Verifier | `STG-API-02` did not explicitly verify `essentialTablesPresent` or `overlapConstraintPresent` from `/ready`. | Updated `scripts/verify-staging-railway-and-resend.ts` to inspect Phase 23 schema and constraint fields. | **VERIFIED** (`--self-check` + `npm test`) |

---

## 2. Unresolved Infrastructure & Operational Gaps (External Blockers)

| Gap ID | Severity | Area | Observed Production / Environment Gap | Required Owner / Operator Action |
|---|---|---|---|---|
| **EXT-01** | Critical | Production / Staging DB | Live Railway `/ready` (`2026-11-20T04:56:13Z`) proves `migrationsTablePresent: false`, `migrationsAppliedCount: 0`. Canonical tables, exclusion constraints, and 36-table `FORCE RLS` are not yet applied to Railway PostgreSQL. | Provision isolated staging PostgreSQL, run `scripts/run-migrations.ts` (`001`–`008`), run `scripts/verify-staging-postgres.ts --backup-restore-drill`, then schedule approved production cutover with pre-cutover `pg_dump`. |
| **EXT-02** | Critical | Authentication | Live Railway `/ready` reports `supabaseConfigured: false`, `readyForProductionAuth: false`. Admin MFA login and client accounts cannot authenticate in production. | Provision staging & production Supabase Auth projects, configure `SUPABASE_*` on Railway and `VITE_SUPABASE_*` in GitHub Actions Variables, bind admin `supabase_user_id`, enroll AAL2 TOTP MFA. |
| **EXT-03** | High | Email & Webhooks | Live Railway `/ready` reports `email.configured: false`, `webhookSecretConfigured: false`, `liveDeliveryEnabled: false`. | Authenticate sender domain (SPF/DKIM/DMARC) in Resend, configure staging `RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET`, and verify with `verify-staging-railway-and-resend.ts`. |
| **EXT-04** | High | Source & Container CI | Sandbox lacks `.git` repo metadata, `GITHUB_TOKEN`, `package-lock.json`, and `docker` daemon. | Push unified Phase 21–28 branch from workstation, run `npm ci`, `npm audit --audit-level=high`, `docker build`, and confirm green hosted GitHub Actions on PR. |
| **EXT-05** | Medium | Legacy Open PR Hygiene | Legacy draft/open PRs #6, #7, #9, #11–#16, #18, #19, #20 remain open on GitHub. | Close superseded legacy PRs after unifying Phase 21–28 into a single clean PR against `main`. |
| **EXT-06** | Deferred (Post-Launch) | Payments (Phase 28) | Live payment processing is intentionally unimplemented (`501 PAYMENT_PROVIDER_NOT_INTEGRATED`). | Scoped out of initial production launch unless owner explicitly approves Stripe Checkout + webhook phase. |
