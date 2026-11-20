# Phase 19 — 05 Authentication Acceptance

**Audit Timestamp:** `2026-11-20T04:30:31Z`  
**Status:** **CODE & CRYPTOGRAPHIC JWT/MFA SUITE VERIFIED LOCALLY — LIVE STAGING SUPABASE AUTH BLOCKED (`SUPABASE_*` UNSET ON RAILWAY & SANDBOX)**

---

## 1. Live Railway Auth Configuration State (`2026-11-20T04:29:41Z`)

Read-only probes of `GET /ready` and `GET /api/auth/config` on Railway confirmed:

```json
{
  "provider": "supabase",
  "supabaseConfigured": false,
  "adminClientConfigured": false,
  "jwtVerificationConfigured": false,
  "readyForProductionAuth": false,
  "mfaPolicy": "totp_required_for_admin",
  "demoPersonasAvailable": false,
  "viteSupabaseConfigured": false
}
```

- **Production Safety Verified:** `demoPersonasAvailable: false` (demo persona login is strictly disabled in production). Unauthenticated access to `/api/consultations` returns `401`, and `/api/admin/metrics` returns `403`.

---

## 2. Cryptographic Identity & MFA Controls Verified in Automated Tests (`94 / 94 PASS`)

Audited `server/identityProvider.ts` and `server/auth.ts` and added explicit Phase 19 cryptographic JWT tests (`tests/phase19-staging-readiness.test.ts`):

| Control | Implementation | Verification Evidence |
|---|---|---|
| Cryptographic Supabase JWT Verification | `verifyProviderAccessToken()` (`jose` JWKS / HS256, `audience: 'authenticated'`, `issuer: <SUPABASE_URL>/auth/v1`, `exp` required) | `tests/phase19-staging-readiness.test.ts` + `tests/identity-architecture.test.ts` (`PASS`) |
| Immutable `sub` Privilege Binding | Privileged roles (`admin`, `staff`, `event_planner`, `vendor`) bind strictly by `supabaseUserId === claims.sub`; email matching never grants privilege | `emailPrivilegeBindBlocked: true` -> downgraded to `client` even when attacker spoofs `user_metadata.role = 'admin'` (`PASS`) |
| Admin AAL2 / RFC 6238 TOTP MFA | Admin accounts require `aal: 'aal2'` (Supabase MFA) or RFC 6238 TOTP verification; static `ADMIN_MFA_PASSCODE` is forbidden in `NODE_ENV=production` | `tests/phase19-staging-readiness.test.ts` (AAL1 -> `mfaVerified: false`, AAL2 -> `mfaVerified: true`) + `tests/production-hardening.test.ts` (`PASS`) |
| Session Revocation & Logout | `sb:<session_id>` and signed cookie sessions checked against durable revocation ledger (`revokeSessionId`) | `tests/auth-and-rbac.test.ts` + `tests/phase12-security-certification.test.ts` (`PASS`) |
| CSRF & Cookie Hardening | Double-submit HMAC CSRF token (`cs_csrf`) + `HttpOnly`, `SameSite`, `Secure` cookie attributes | `tests/phase12-security-certification.test.ts` (`PASS`) |

---

## 3. Required Operator Setup to Unblock Live Staging Authentication

1. Provision an isolated **Staging Supabase Project** and configure TOTP MFA (`aal2`) for the staging admin account.
2. Bind the staging admin user's immutable Supabase UUID (`auth.users.id`) to `users.supabase_user_id` in staging PostgreSQL.
3. Configure Railway Staging Backend env vars (never commit values):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_JWT_SECRET`
4. Configure GitHub Actions Staging / Production Repository Variables (public anon key only):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Re-run `scripts/verify-staging-railway-and-resend.ts` with `STAGING_REQUIRE_SUPABASE_AUTH=true` to verify `STG-AUTH-01` (`readyForProductionAuth: true`) and perform live admin MFA login + dashboard consultation retrieval + logout/revocation verification.
