# 14 — Blockers & External Dependencies Register

**Audit Timestamp:** `2026-11-20T05:02Z`  
**Total Open Code Defects:** **`0`**  
**Total External Environment / Access Blockers:** **`6`** (accounting for all `16` `BLOCKED` matrix items)

---

| Blocker ID | Affected Matrix Items | Exact Missing Access / Credential / Tool (No Secret Values Requested) | Exact Resolution Path |
|---|---|---|---|
| **BLK-01** | `SRC-06`, `SEC-05` | Local Git clone with `.git` + `package-lock.json` + GitHub push token (`GITHUB_TOKEN`) + `docker` daemon | Copy Phase 21–28 workspace changes into local clone on branch `repair/phase21-28-production-readiness`, run `npm ci`, `npm audit --audit-level=high`, `docker build`, push & open PR against `main`. |
| **BLK-02** | `DB-05`, `DB-06`, `OPS-03` | Isolated Staging PostgreSQL 16+ connection (`DATABASE_URL` + `STAGING_DB_CONFIRM=YES_ISOLATED_STAGING`) + `psql`/`pg_dump`/`pg_restore` binaries | Run `scripts/run-migrations.ts` (twice) and `scripts/verify-staging-postgres.ts --backup-restore-drill` against isolated staging PostgreSQL. |
| **BLK-03** | `BE-06`, `BOOK-05`, `OPS-04`, `OPS-05` | Isolated Staging Railway service (`RAILWAY_TOKEN`, `STAGING_API_BASE_URL`, `STAGING_API_CONFIRM=YES_ISOLATED_STAGING`) + Railway alerting access | Deploy unified PR branch to isolated staging Railway, execute `scripts/verify-staging-railway-and-resend.ts`, rehearse Railway restart/rollback, and verify alerting. |
| **BLK-04** | `AUTH-06`, `BOOK-06`, `SEC-06` | Isolated Staging Supabase Auth project (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) + bound staging test accounts (including AAL2 MFA admin) | Provision staging Supabase project, bind privileged UUIDs in staging PostgreSQL, verify `GET /ready` `checks.auth: true` (`STG-AUTH-01`), and complete live role + AAL2 MFA tests. |
| **BLK-05** | `MAIL-04`, `MAIL-05`, `MAIL-06` | Resend domain DNS verification (SPF/DKIM/DMARC), staging Resend credentials (`RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET`, `EMAIL_LIVE_DELIVERY_ENABLED=true`), and approved internal QA mailbox | Authenticate sender domain, register staging webhook, run `verify-staging-railway-and-resend.ts` with `STAGING_REQUIRE_RESEND_LIVE=true`, and confirm QA inbox receipt + webhook `Delivered` update. |
| **BLK-06** | `OPS-06` | Explicit owner authorization for production cutover (`PRODUCTION_APPROVAL_REQUIRED` -> approved) | Present completed `STAGING_VERIFIED` evidence package to owner for production migration & merge approval. |
