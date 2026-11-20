# 04 — Administrator Binding Verification

**Project:** Celebration Sisters Event Decor  
**Trusted Staging Admin Subject UUID:** `fd9523dd-eb07-4cca-9040-62feea3f5353`  
**Trusted Staging External Issuer:** `https://nswxwwmtcasmkjtmrdqg.supabase.co/auth/v1`  
**Audit Date:** 2026-11-20

---

## 1. Fail-Closed Administrator Policy Enforcement (`server/stagingExternalAuthPolicy.ts`, `server/auth.ts`, `server/app.ts`)

1. **Five-Flag Staging Activation Gate (`stagingExternalAuthEnabled`):**
   External Auth staging mode activates ONLY when ALL five environment conditions are simultaneously true:
   - `RAILWAY_ENVIRONMENT_NAME === 'staging'` (never `production`)
   - `STAGING_DB_CONFIRM === 'YES_ISOLATED_STAGING'`
   - `EMAIL_LIVE_DELIVERY_ENABLED === 'false'`
   - `PHASE19_EXTERNAL_AUTH_READ_ONLY === 'YES_EXTERNAL_AUTH_STAGING_ONLY'`
   - `PHASE19_EXTERNAL_AUTH_PROJECT_REF === 'nswxwwmtcasmkjtmrdqg'`
2. **Immutable UUID Subject Pinning (`server/auth.ts`):**
   - External Auth NEVER auto-provisions or promotes an administrator.
   - `claims.sub === STAGING_ADMIN_SUBJECT` must already exist in the staging database `users` table with `role = 'admin'`, `supabase_user_id = 'fd9523dd-eb07-4cca-9040-62feea3f5353'`, and `account_status = 'active'`.
   - Any other subject — even with a matching administrator email, forged `user_metadata.role = 'admin'`, or valid AAL2 token — is strictly denied admin access (`resolveTrustedUserFromClaims` blocks email-to-privilege binding and flags `emailPrivilegeBindBlocked: true`).
3. **Central Request Boundary (`getAuth()` in `server/app.ts`):**
   - On every route except `GET /api/auth/session` and `POST /api/auth/logout`, any admin session that does not carry `authMethod === 'supabase_jwt'`, `supabaseUserId === STAGING_ADMIN_SUBJECT`, and `aal === 'aal2'` is demoted to `guest` (`mfaVerified: false`, `spoofAttemptDetected: true`).
   - Local HMAC admin cookies, static passcodes, and local TOTP recovery codes are all rejected in external staging mode.

---

## 2. Live Staging PostgreSQL Verification Query (To Be Run With `STAGING_DATABASE_URL`)

Because this sandbox does not hold `STAGING_DATABASE_URL` credentials, the live database binding inspection on Railway staging PostgreSQL remains **BLOCKED** and must be executed by an authorized operator using the read-only query below:

```sql
SELECT id, email, role, supabase_user_id, email_verified, account_status, mfa_enrolled
FROM public.users
WHERE role IN ('admin', 'staff', 'event_planner')
   OR supabase_user_id = 'fd9523dd-eb07-4cca-9040-62feea3f5353'
ORDER BY role, id;
```

**Expected Acceptance Criteria:**
- Exactly one active `admin` record bound to `supabase_user_id = 'fd9523dd-eb07-4cca-9040-62feea3f5353'`.
- Zero unintended privileged accounts bound to external test UUIDs or inactive/unverified placeholder admin records.
- Zero database changes applied to production PostgreSQL or production Supabase Auth.

---

## 3. Certification Status

- **Application Policy & Automated Negative/Positive Binding Tests:** **VERIFIED** (`tests/phase19-external-auth-policy.test.ts`, `tests/phase19-jwt-role-isolation.test.ts`, `tests/phase21-30-certification.test.ts`).
- **Live Staging PostgreSQL `public.users` Row Audit:** **BLOCKED** (requires operator execution with `STAGING_DATABASE_URL`).
