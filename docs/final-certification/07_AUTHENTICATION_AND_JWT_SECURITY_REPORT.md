# 07 — Authentication and JWT Security Report

**Project:** Celebration Sisters Event Decor  
**Trusted External Staging Issuer (Read-Only):** `https://nswxwwmtcasmkjtmrdqg.supabase.co/auth/v1` (`ES256`, `kid: c61ff1b2-e23a-4649-9f45-3108f1c77b8d`)  
**Dedicated Staging Supabase Project:** `https://diasvulceaahmorucoro.supabase.co/auth/v1` (`ES256`, `kid: 7bf015f5-760b-4fff-8ca8-afb536a87c07`)  
**Trusted Staging Admin Subject UUID:** `fd9523dd-eb07-4cca-9040-62feea3f5353`  
**Audit Timestamp:** 2026-11-20T22:49Z

---

## 1. Cryptographic JWT & Issuer Verification Hardening (`server/identityProvider.ts`, `server/auth.ts`)

- **Protected-Header Algorithm Routing & Pinning:** Decodes JWT protected header `alg` before verification; immediately rejects `alg: none` and unknown algorithms. Asymmetric algorithms (`ES256`, `RS256`, `EdDSA`) always verify via issuer-specific JWKS even if `SUPABASE_JWT_SECRET` is configured in Railway environment variables.
- **External Staging `useJwksOnly: true`:** Forces issuer JWKS verification for `nswxwwmtcasmkjtmrdqg`, rejecting `HS256` tokens forged with `SUPABASE_JWT_SECRET`.
- **Key Rotation Support:** Tested with multi-key `kid` rotation (`kid-rot-1` -> `kid-rot-2`) in `tests/phase21-30-certification.test.ts`.
- **Strict Claim Enforcement:** Enforces exact issuer (`iss`), audience (`authenticated`), expiration (`exp`), and signature validity; ignores mutable `user_metadata.role` and prevents email-to-privilege binding (`tests/phase19-jwt-role-isolation.test.ts`).

---

## 2. Consolidated Frontend Session Lifecycle (`src/App.tsx`)

- **Single Sign-In Path:** Eliminated dual `/api/auth/login` + Supabase sign-in conflict in external staging mode; authenticates once via `signInWithPassword` and confirms authorization against `GET /api/auth/session` (failing closed with `signOutExternalStagingSession()` if rejected).
- **Reload Restoration & Multi-Tab Sync:** Restores active Supabase session on boot, subscribes to `onAuthStateChange` (`TOKEN_REFRESHED`, `USER_UPDATED`, `SIGNED_OUT`), and cleans up subscription on unmount.
- **Clean Logout:** Revokes server session via `POST /api/auth/logout`, signs out Supabase client, clears pending TOTP factor state, and resets in-memory tokens and UI state.

---

## 3. Closed Alternate Admin Authorization Paths (`server/app.ts`)

| Vector | Behavior in External Staging Mode | Verified By |
| --- | --- | --- |
| `POST /api/auth/mfa/totp/enroll` | `409 SUPABASE_MFA_REQUIRED` | `tests/phase21-30-certification.test.ts` |
| `POST /api/auth/mfa/verify` | `409 SUPABASE_MFA_REQUIRED` | `tests/phase21-30-certification.test.ts` |
| `POST /api/auth/mfa/recover` | `409 SUPABASE_MFA_REQUIRED` | `tests/phase21-30-certification.test.ts` |
| `POST /api/auth/mfa/totp/revoke` | `409 SUPABASE_MFA_REQUIRED` | `tests/phase21-30-certification.test.ts` |
| `POST /api/auth/password-reset` | `409 EXTERNAL_AUTH_READ_ONLY` | `tests/phase21-30-certification.test.ts` |
| Forged local HMAC admin cookie (`mfaVerified: true`) | Demoted to `guest` (`403`) | `tests/phase21-30-certification.test.ts` |
| Spoofed `x-user-id` / `x-user-role: admin` headers | Rejected (`403`) | Live Railway staging probe + `tests/auth-and-rbac.test.ts` |
| `POST /api/auth/switch` demo switching | Disabled (`demoPersonasAvailable: false`) | Live Railway staging `/api/auth/config` |

---

## 4. Remaining External Auth Blockers

- Live staging browser session verification (login, reload, token refresh, logout) with real external Supabase credentials after deploying the reconciled commit to Railway staging: **BLOCKED**.
- Live staging PostgreSQL `public.users` SQL binding audit for `fd9523dd-eb07-4cca-9040-62feea3f5353`: **BLOCKED** (no `STAGING_DATABASE_URL`).
