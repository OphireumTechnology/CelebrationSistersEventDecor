# 13 — Outstanding Blockers and Ownership Register

**Project:** Celebration Sisters Event Decor  
**Total Active Blockers:** **15** (all external credentials, deployment permissions, interactive account-holder MFA, or human governance gates; **0** code defects or test failures)  
**Audit Date:** 2026-11-20T22:50Z

---

| Blocker ID | Linked Reqs | Exact Cause | Required Permission / Credential | Responsible Party | Exact Next Action |
| --- | --- | --- | --- | --- | --- |
| **BLK-01** | `REQ-06` | Sandbox lacks `GITHUB_TOKEN`/`GH_TOKEN` write credentials; reconciled Phase 21–40 commit is unpushed | GitHub write push permission to `ops/staging-migration-job-20261121` | Developer | Apply `release-artifacts/phase32-reconciled/phase31-40-reconciled.bundle` (or `.patch`) on workstation, verify `npm ci && npm run lint && npm test && npm run build`, push without `--force`, verify hosted CI + Docker build pass |
| **BLK-02** | `REQ-45` | Sandbox lacks `RAILWAY_API_TOKEN` and Railway deploy access; cannot deploy new SHA or independently prove `GITHUB_APPROVED_SHA === RAILWAY_DEPLOYED_SHA === STAGING_TESTED_SHA` | Railway staging deploy access + `RAILWAY_API_TOKEN` repository secret | Infrastructure owner | Deploy CI-approved SHA to Railway staging (`5ba79779-aa42-4516-b294-900ef137f23c`) and run `.github/workflows/staging-deployment-gate.yml` until exit `0` |
| **BLK-03** | `REQ-13`, `REQ-14`, `REQ-23`, `REQ-37` | Sandbox lacks `STAGING_DATABASE_URL`, `psql`, `pg_dump`, and `pg_restore` | Staging PostgreSQL connection string (`STAGING_DATABASE_URL`) | Infrastructure owner | Run read-only `public.users` admin binding query, connected `run-migrations.ts --dry-run`, 2-process lock check, `setup-staging-rls-probe.ts`, and isolated `pg_dump`/`pg_restore` drill |
| **BLK-04** | `REQ-24`, `REQ-29`, `REQ-30` | Real external Supabase Auth account `fd9523dd-eb07-4cca-9040-62feea3f5353` (`nswxwwmtcasmkjtmrdqg`) must never be mutated by automation | Account holder login + authenticator app | Administrator | Complete interactive staging login, QR enrollment (if needed), reload test, AAL2 unlock, logout, and re-challenge |
| **BLK-05** | `REQ-36`, `REQ-38` | Live staging authenticated Customer A/B write isolation and concurrent double-booking race require deployed repair commit + staging test customer tokens | Isolated staging test customer identities | Developer / Administrator | Execute staging Customer A/B cross-tenant read/write suite and concurrent booking race against staging PostgreSQL |
| **BLK-06** | `REQ-44` | `EMAIL_LIVE_DELIVERY_ENABLED` is safely `false` on staging; sandbox lacks Resend credentials | Authorized isolated test inbox + temporary staging test send approval | Administrator / Infrastructure owner | Verify one controlled test-inbox delivery + signed Resend webhook callback without contacting real customers, then leave live delivery paused |
| **BLK-07** | `REQ-46` | Live staging rollback rehearsal requires Railway rollback permissions | Railway staging deployment rollback access | Infrastructure owner | Redeploy prior known-good image in staging, confirm `/ready` `200`, record recovery time, then restore approved candidate |
| **BLK-08** | `REQ-47` | No read-only access to production Railway or production Supabase environment variables in sandbox | Read-only production platform visibility | Infrastructure owner | Audit production environment variable names, secret hygiene, and TLS configuration |
| **BLK-09** | `REQ-48` | Production merge, production database migration, and live customer email activation require explicit human release approval | Executive / release owner authorization | Administrator / Infrastructure owner | Grant written production release sign-off ONLY after `BLK-01` through `BLK-08` reach `VERIFIED` |
