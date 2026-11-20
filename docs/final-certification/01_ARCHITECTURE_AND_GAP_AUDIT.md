# 01 — Architecture and Gap Audit

**Project:** Celebration Sisters Event Decor  
**Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Active PR / Baseline Branch:** PR #21 — `ops/staging-migration-job-20261121` (GitHub HEAD `de848c890138ee00db72ce08e093a0f337215226`, 29 commits, 14 changed files)  
**Audit Date:** 2026-11-20  
**Scope:** End-to-end architecture audit covering Phases 21–30, reconciling the remote PR #21 baseline with workspace repairs and verifying every defect found.

---

## 1. Verified System Architecture

| Layer | Technology & Runtime | Staging / External Identifier |
| --- | --- | --- |
| Public Frontend | React 19 + TypeScript + Vite 8 + Tailwind CSS | GitHub Pages (`https://celebrationsistersdecor.com/`) |
| Backend API & Worker | Node.js 22 + Express 4 + Zod + `jose` + `pg` | Railway Staging (`https://celebrationsisterseventdecor-staging-staging.up.railway.app/`, project `786a7d31-23a8-4154-8185-0d5f07914c24`) |
| Relational Persistence | PostgreSQL (8 canonical SQL migrations `001`–`008` + `FORCE ROW LEVEL SECURITY`) | Railway Staging PostgreSQL (`migrationsAppliedCount: 8`, `overlapConstraintPresent: true`) |
| Dedicated Staging Auth Project | Supabase Auth (`ES256` JWKS) | `diasvulceaahmorucoro` (`kid: 7bf015f5-760b-4fff-8ca8-afb536a87c07`) |
| Trusted External Staging Identity Issuer (Read-Only) | Supabase Auth (`ES256` JWKS) | `nswxwwmtcasmkjtmrdqg` (`kid: c61ff1b2-e23a-4649-9f45-3108f1c77b8d`), pinned admin UUID `fd9523dd-eb07-4cca-9040-62feea3f5353` |
| Transactional Email | Resend API + Durable Outbox Worker + Signed Webhooks | Configured on staging; `EMAIL_LIVE_DELIVERY_ENABLED=false` (safely paused) |
| CI / CD | GitHub Actions (`ci.yml` + `deploy-pages.yml`) + Docker | Hosted CI Run `44826562917` (green) + Pages Run `44826562767` (green) on `de848c89` |

---

## 2. Critical Gaps Identified in Baseline `de848c89` and Remediated in Workspace

| ID | Defect Discovered in Baseline `de848c89` | Root Cause | Remediation Applied | Status |
| --- | --- | --- | --- | --- |
| **GAP-01** | `ES256` JWKS tokens rejected whenever `SUPABASE_JWT_SECRET` was set in environment | `server/identityProvider.ts` prioritized `else if (rawSecret)` before issuer JWKS verification regardless of JWT `alg` header | Added protected-header `alg` inspection, strict allowlists (`ES256`/`RS256`/`EdDSA` for JWKS; `HS256` only for legacy symmetric when `!useJwksOnly`), rejection of `alg: none`, and `useJwksOnly: true` for external staging Auth (`server/identityProvider.ts`, `server/auth.ts`, `server/app.ts`) | **REPAIRED & UNIT-VERIFIED** |
| **GAP-02** | Pending TOTP factor ID lost on browser reload; QR code not rendered; stale unverified factors could accumulate | `src/lib/externalStagingMfa.ts` kept `pendingTotpFactorId` only in module memory; `PortalsWorkspace.tsx` omitted QR `<img>` rendering | Added non-secret `sessionStorage` handoff (`{ factorId, userId, createdAt }`, 15-min TTL; TOTP `secret`/`qr`/`uri` strictly excluded), reload recovery via `resolveExternalTotpFactorId()`, duplicate-verified guard, explicit `replaceUnverified` cleanup, and scannable `data:image/` QR rendering (`src/lib/externalStagingMfa.ts`, `src/components/PortalsWorkspace.tsx`) | **REPAIRED & UNIT-VERIFIED** |
| **GAP-03** | Dual conflicting login path and missing session restore/refresh/logout sync | `src/App.tsx` called `POST /api/auth/login` and then `externalClient.auth.signInWithPassword` sequentially; never restored external Supabase session on boot, never subscribed to `onAuthStateChange`, and never called `externalClient.auth.signOut()` on logout | Consolidated external staging login to a single authoritative `signInWithPassword` + backend `GET /api/auth/session` check (fail-closed sign-out on rejection), added boot session restoration + `onAuthStateChange` subscription, backend AAL2 confirmation after MFA verify, and clean sign-out (`src/App.tsx`) | **REPAIRED & UNIT-VERIFIED** |
| **GAP-04** | Reload during AAL1 MFA gate broke while alternate local MFA routes stayed reachable | `getAuth()` in `server/app.ts` demoted `aal1` admin on `GET /api/auth/session`, while `/api/auth/mfa/recover`, `/api/auth/mfa/totp/revoke`, and `/api/auth/password-reset` were not blocked in external staging mode | Permitted pinned `supabase_jwt` AAL1 strictly on `GET /api/auth/session` (with `csrfToken` omitted) and `POST /api/auth/logout` while demoting AAL1 on all protected routes; blocked `/api/auth/mfa/recover`, `/api/auth/mfa/totp/revoke`, and `/api/auth/password-reset` with HTTP `409` in external staging mode (`server/app.ts`) | **REPAIRED & UNIT-VERIFIED** |
| **GAP-05** | Cross-account email match on bound `clientId` consultations | `GET /api/consultations` matched `clientEmail === ctx.session.email` even when `c.clientId` belonged to another user | Restricted email fallback strictly to unbound `lead:` records with `ctx.emailVerified === true`; bound `clientId` records require exact `clientId === ctx.session.id` (`server/app.ts`) | **REPAIRED & UNIT-VERIFIED** |
| **GAP-06** | Migration runner lacked concurrent advisory locking and failed open on NULL checksums in apply mode | `scripts/run-migrations.ts` did not acquire a PostgreSQL session advisory lock before DDL and only checked `if (existingChecksum && existingChecksum !== ...)` | Added `pg_try_advisory_lock(728491034218)` + `pg_advisory_unlock` in `finally` (throwing `MIGRATION_LOCK_CONTENTION` on contention) and fail-closed NULL checksum enforcement while preserving 100% pure `SELECT`-only dry-run mode (`scripts/run-migrations.ts`) | **REPAIRED & UNIT-VERIFIED** |
| **GAP-07** | Premature protected API fetches while admin was gated on MFA | `PortalsWorkspace.tsx` called `/api/bookings` and `/api/concepts` when `currentUser.role === 'admin' && mfaRequired` | Added early guard in `loadWorkspaceData()` so protected fetches execute only after AAL2 unlocks (`src/components/PortalsWorkspace.tsx`) | **REPAIRED & UNIT-VERIFIED** |

---

## 3. Remaining External Infrastructure Blockers (Not Automatable in Sandbox)

1. **GitHub Push & Hosted CI Re-run on Repair Delta:** Sandbox has no `GITHUB_TOKEN` or write remote access; the 7 repaired files + new certification test + 12 reports must be pushed from an authorized workstation to `ops/staging-migration-job-20261121` to trigger hosted CI on the updated commit.
2. **Account-Holder Live Interactive MFA Enrollment & AAL2 Certification:** Per safety rules, real account `fd9523dd-eb07-4cca-9040-62feea3f5353` on external Supabase Auth project `nswxwwmtcasmkjtmrdqg` must never be mutated automatically; live QR scan and AAL2 verification must be executed interactively by the account holder against staging after deploying the updated branch.
3. **Live Staging PostgreSQL Admin-Binding & RLS SQL Verification:** Sandbox has no `STAGING_DATABASE_URL` or `psql` credentials to run direct SQL role-binding audits, live `pg_dump`/`pg_restore` drill, or live connected migration dry-run against Railway staging PostgreSQL.
4. **Live Authenticated Customer A / Customer B Staging Write Journey:** Requires live staging Supabase customer JWTs and Railway staging write execution after deploying the repaired branch.
5. **Production Promotion Authorization:** Requires explicit human approval after every staging gate reaches `VERIFIED`.
