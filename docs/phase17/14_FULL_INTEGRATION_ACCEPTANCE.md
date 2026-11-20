# Phase 17F — Full Integration & Regression Acceptance Report

**Execution Date:** `2026-11-19`  
**Verified Live `main` Commit SHA:** `5f1982df7a86b9c49da9ce0781b8215b79a97f1e`  
**Local Workspace State:** `5f1982df` + Phase 17F `schema_migrations` coexistence repair (`scripts/run-migrations.ts`), real-schema PostgreSQL staging verifier repair (`scripts/verify-staging-postgres.ts`), portable Chromium resolution (`scripts/phase16-browser-acceptance.ts`), and 2 new contract regression tests (`tests/phase17f-staging-harnesses.test.ts` -> **`86/86`** passing)

---

## 1. Complete Executed Verification Matrix (`2026-11-19`)

| Verification Gate | Command / Source | Environment | Result | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| Repository Lockfile & Secret Hygiene | `test ! -f bun.lock && test ! -f .env` + GitHub Tree API | Local + GitHub `5f1982df` | **PASS** | `package-lock.json` on `main`, `bun.lock` absent, `.env` absent |
| Static Migration & 36-Table RLS Audit | `npx tsx scripts/verify-migrations.ts` | Local Sandbox | **PASS** | `8` files, `36` RLS tables, `0` errors |
| Ordered Migration Checksums | `npx tsx scripts/run-migrations.ts --dry-run` | Local Sandbox | **PASS** | `8/8` SHA-256 checksums deterministic |
| Staging PG Harness Safety Guard | `npx tsx scripts/verify-staging-postgres.ts --self-check` | Local Sandbox | **PASS** | `excl_consultations_planner_buffered_overlap`, `6` core FORCE RLS tables, `10` RLS checks, waves `[2,3,10,25]` |
| Staging Railway/Resend Harness Guard | `npx tsx scripts/verify-staging-railway-and-resend.ts --self-check` | Local Sandbox | **PASS** | Guard & env contract verified |
| Snapshot-to-Normalized Reconciliation | `npx tsx scripts/reconcile-snapshot-to-normalized.ts` | Local Sandbox | **PASS** | `44` entities, `0` anomalies, exact cent parity |
| Strict TypeScript Typecheck | `npm run typecheck` | Local Sandbox | **PASS** | `0` errors |
| Oxlint & Typecheck Lint Gate | `npm run lint` | Local Sandbox | **PASS** | `0` warnings, `0` errors |
| Full Automated Test Suite | `npm test` | Local Sandbox | **PASS** | **`86 / 86` passed**, `0` failed, `0` skipped |
| High-Severity Vulnerability Audit | Hosted CI Run `44621911782` (`npm audit --audit-level=high`) | Hosted GitHub Actions (`5f1982df`) | **PASS** | `completed / success` (`0` high/critical vulnerabilities) |
| Production Client & Server Build | `npm run build` | Local Sandbox | **PASS** | `dist/` + `dist-server/server.mjs` (`316.9 kB`) |
| Desktop & Mobile Playwright Acceptance | `npx tsx scripts/phase16-browser-acceptance.ts` | Local Compiled Chromium | **PASS** | **`20 / 20` passed**, `0` console/page errors |
| Live Public Website Zero-404 Probe | Headless Chromium -> `https://celebrationsistersdecor.com/` | Live GitHub Pages Edge (`5f1982df`) | **PASS** | `httpStatus: 200`, `api404Count: 0`, `consoleErrors: []`, `dialogVisible: true` |
| Hosted GitHub Actions CI (`verify`) | Run `44621911782` (`5f1982df`) | Hosted GitHub Actions | **PASS** | `completed / success` |
| Hosted Docker Production Image Build | Run `44621911782` (`5f1982df`) | Hosted GitHub Actions | **PASS** | `completed / success` |
| Hosted GitHub Pages Deployment | Run `44621911905` (`5f1982df`) | Hosted GitHub Actions | **PASS** | `build` + `deploy` `completed / success` |
| Static CI Secret Scan (`src/server/scripts/docs`) | CI regex scan | Local Sandbox + Hosted CI | **PASS** | `0` matches |
| Live Railway Staging PG16 / RLS / Concurrency | `scripts/verify-staging-postgres.ts` | Railway Staging PG | **`BLOCKED`** | No staging `DATABASE_URL` or PG binary in sandbox |
| Live Railway Staging Deploy & Staging Browser Rerun | `scripts/verify-staging-railway-and-resend.ts` + Playwright | Railway Staging + Pages | **`BLOCKED`** | No Railway credentials / `VITE_API_BASE_URL` write access in sandbox |
| Live Resend Staging Delivery & Svix Callback | `scripts/verify-staging-railway-and-resend.ts` | Resend + Railway Staging | **`BLOCKED`** | No staging Resend API key or webhook secret in sandbox |
| Phase 17F Branch Push & PR Creation | `git push` -> `feature/phase17-staging-production-acceptance` | GitHub Remote | **`BLOCKED`** | Sandbox lacks `.git` & GitHub write credentials |

---

## 2. Mandatory Regression Protection Verified (`11 / 11` Preserved)

- **120-minute consultation notice:** Preserved & re-verified (`STG-API-06`, `server/scheduling.ts`).
- **Secure `csa_` consultation tokens:** Preserved & re-verified (SHA-256 hashed, wrong/expired/revoked -> `403`).
- **Atomic Svix webhook processing:** Preserved & re-verified (HMAC + `300s` replay guard + `svix-id` dedup + terminal status lock in `server/outbox.ts`).
- **Centralized notification recipient config:** Preserved (canonical 5-var contract in `server/notifications.ts`).
- **Booking idempotency:** Preserved & re-verified (`Idempotency-Key` replay returns `200`, `deduplicated: true`).
- **Client data isolation:** Preserved & hardened with PG SQLSTATE `42501` -> sanitized `403`.
- **MFA TOTP administration:** Preserved & re-verified (`P16-BA-13`, static passcode forbidden in prod).
- **CRM conversion & outcome persistence:** Preserved & re-verified (`P16-BA-14`, `P16-BA-15`).
- **Proposal handoff:** Preserved & re-verified (`P16-BA-16`).
- **Operational metrics & log redaction:** Preserved & re-verified (`/api/admin/metrics`, `X-Request-Id`, PG `409` counter integration).
- **Zero false booking confirmations:** Preserved & re-verified (`P16-BA-18` `503` outage alert + live zero-404 probe).
