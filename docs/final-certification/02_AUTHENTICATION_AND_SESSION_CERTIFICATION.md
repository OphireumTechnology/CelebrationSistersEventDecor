# 02 — Authentication and Session Certification

**Project:** Celebration Sisters Event Decor  
**Active Branch:** `ops/staging-migration-job-20261121`  
**Audit Date:** 2026-11-20

---

## 1. Consolidated External Staging Authentication Flow

In external staging mode (`RAILWAY_ENVIRONMENT_NAME=staging`, `STAGING_DB_CONFIRM=YES_ISOLATED_STAGING`, `EMAIL_LIVE_DELIVERY_ENABLED=false`, `PHASE19_EXTERNAL_AUTH_READ_ONLY=YES_EXTERNAL_AUTH_STAGING_ONLY`, `PHASE19_EXTERNAL_AUTH_PROJECT_REF=nswxwwmtcasmkjtmrdqg`):

1. **Single Authoritative Sign-In (`src/App.tsx`):**
   - When `getExternalStagingMfaClient()` is active, `handleEmailLogin()` signs in once via `externalClient.auth.signInWithPassword({ email, password })` without triggering a conflicting duplicate `POST /api/auth/login`.
   - The returned Supabase access token is set via `setApiAccessToken()` and immediately validated against backend `GET /api/auth/session`.
   - If the backend responds non-OK or returns `role: 'guest'`, the frontend fails closed (`signOutExternalStagingSession()`, clears in-memory access token and pending factor state, resets UI to `DEFAULT_GUEST`).
2. **Page Reload & Session Restoration (`src/App.tsx`):**
   - On mount, `initAuth()` reads `externalClient.auth.getSession()`, restores `setApiAccessToken(session.access_token)` if active, restores any non-secret pending TOTP factor indicator, and synchronizes authoritative role/MFA state from `GET /api/auth/session`.
   - An authenticated pinned staging administrator at `aal1` receives `200 { user: { role: 'admin' }, mfaRequired: true, mfaVerified: false, aal: 'aal1', externalStagingAuth: true }` (with `csrfToken` omitted) so the browser reloads directly onto the MFA verification gate rather than erroneously dropping to guest or unlocking admin routes.
3. **Token Refresh & Multi-Tab Sync (`src/App.tsx`):**
   - Registered `externalClient.auth.onAuthStateChange((event, session) => ...)` with clean unmount unsubscribe.
   - `TOKEN_REFRESHED` and `USER_UPDATED` refresh the in-memory Bearer token and re-sync backend session truth.
   - `SIGNED_OUT` or empty session clears the Bearer token, CSRF token, pending factor handoff, and UI state across tabs.
4. **Clean Logout (`src/App.tsx` + `server/app.ts`):**
   - `handleLogout()` calls `signOutExternalStagingSession()` (clearing pending TOTP factor ID and calling `supabase.auth.signOut()`), invokes `POST /api/auth/logout` (allowed for AAL1 and AAL2 sessions so server-side JTI revocation succeeds), and resets local client state in a `finally` block.

---

## 2. Cryptographic JWT Verification Hardening (`server/identityProvider.ts`, `server/auth.ts`)

Live read-only JWKS inspection confirmed both Supabase projects issue asymmetric **`ES256` (ECDSA P-256)** tokens:
- `https://nswxwwmtcasmkjtmrdqg.supabase.co/auth/v1/.well-known/jwks.json` -> `ES256`, `kid: c61ff1b2-e23a-4649-9f45-3108f1c77b8d`
- `https://diasvulceaahmorucoro.supabase.co/auth/v1/.well-known/jwks.json` -> `ES256`, `kid: 7bf015f5-760b-4fff-8ca8-afb536a87c07`

Key verification guarantees implemented and tested:
- Protected header `alg` is decoded before verification; `alg: none` and unknown algorithms are rejected immediately.
- When `useJwksOnly: true` (enforced on external staging requests in `server/auth.ts` and `server/app.ts`), only asymmetric algorithms (`ES256`, `RS256`, `EdDSA`) verified via issuer JWKS are accepted; `HS256` tokens signed with `SUPABASE_JWT_SECRET` are strictly rejected.
- Even in standard mode when `SUPABASE_JWT_SECRET` is present in environment variables, incoming asymmetric `ES256`/`RS256`/`EdDSA` JWTs route directly to issuer JWKS instead of failing against the legacy symmetric secret.
- Strict issuer (`https://<project_ref>.supabase.co/auth/v1`), audience (`authenticated`), expiration, and signature verification are enforced via `jose`.

---

## 3. Closed Alternate Authorization & Mutation Paths

| Endpoint / Vector | External Staging Behavior | Verification Evidence |
| --- | --- | --- |
| `POST /api/auth/mfa/totp/enroll` | Rejected with `409 SUPABASE_MFA_REQUIRED` | Verified in `tests/phase21-30-certification.test.ts` |
| `POST /api/auth/mfa/verify` | Rejected with `409 SUPABASE_MFA_REQUIRED` | Verified in `tests/phase21-30-certification.test.ts` |
| `POST /api/auth/mfa/recover` | Rejected with `409 SUPABASE_MFA_REQUIRED` | Verified in `tests/phase21-30-certification.test.ts` |
| `POST /api/auth/mfa/totp/revoke` | Rejected with `409 SUPABASE_MFA_REQUIRED` | Verified in `tests/phase21-30-certification.test.ts` |
| `POST /api/auth/password-reset` | Rejected with `409 EXTERNAL_AUTH_READ_ONLY` | Verified in `tests/phase21-30-certification.test.ts` |
| Forged local HMAC admin cookie (`mfaVerified: true`) | Demoted to `guest` (`403` on `/api/admin/overview`) | Verified in `tests/phase21-30-certification.test.ts` |
| `x-user-id` / `x-user-role` spoof headers | Ignored & logged; `401`/`403` fail-closed | Verified in `tests/auth-and-rbac.test.ts` |
| Mutable `user_metadata.role = "admin"` | Ignored; non-bound user stays `client` | Verified in `tests/phase19-jwt-role-isolation.test.ts` |
| `POST /api/auth/switch` in production/staging | Disabled (`demoPersonasAvailable: false` confirmed live on staging) | Verified live on Railway staging `/api/auth/config` |

---

## 4. Certification Status

- **Code & Automated Cryptographic/HTTP Verification:** **VERIFIED** (ES256 rotation, HS256/none rejection, AAL1/AAL2 boundaries, closed alternate endpoints).
- **Live Staging Browser Session Lifecycle with Real External Credentials:** **BLOCKED** pending deployment of this repair delta to Railway staging and interactive login by the authorized account holder.
