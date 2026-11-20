# 03 — Supabase MFA (AAL2) Certification

**Project:** Celebration Sisters Event Decor  
**External Staging Auth Project (Read-Only):** `nswxwwmtcasmkjtmrdqg`  
**Intended Staging Admin UUID:** `fd9523dd-eb07-4cca-9040-62feea3f5353`  
**Audit Date:** 2026-11-20

---

## 1. Pending TOTP Factor-ID Handoff & Reload Recovery (`src/lib/externalStagingMfa.ts`)

| Requirement | Implementation | Verified |
| --- | --- | --- |
| Capture `factor.id` on `auth.mfa.enroll({ factorType: 'totp' })` | `enrollExternalStagingTotp()` captures `data.id`, `qr_code`, `secret`, `uri` | **VERIFIED** |
| Non-secret reload-safe storage | Persists ONLY `{ factorId, userId, createdAt }` (15-min TTL) in `window.sessionStorage`; `secret`, `qr`, and `otpauth://` URI are NEVER written to browser storage | **VERIFIED** |
| Reload resolution across pending/verified/unverified factors | `resolveExternalTotpFactorId()` verifies pinned admin UUID, inspects `listFactors()`, prioritizes active pending factor ID, falls back to verified TOTP factor, or recovers most recent unverified factor if `sessionStorage` was cleared | **VERIFIED** |
| Prevent accidental duplicate verified factors | `enrollExternalStagingTotp()` rejects new enrollment if a verified TOTP factor already exists on the account | **VERIFIED** |
| Clean stale unverified factor replacement | Explicit `{ replaceUnverified: true }` unenrolls only `status === 'unverified'` TOTP factors before enrolling fresh QR/secret | **VERIFIED** |
| Strict 6-digit code handling & post-verify refresh | Normalizes whitespace, validates `/^\d{6}$/`, executes `challengeAndVerify`, checks `getAuthenticatorAssuranceLevel().currentLevel === 'aal2'`, calls `refreshSession()`, validates returned user UUID, clears pending factor | **VERIFIED** |
| Backend AAL2 confirmation before UI unlock | `src/App.tsx` sets refreshed token, calls `GET /api/auth/session`, and unlocks admin portal ONLY when backend returns `mfaVerified: true && aal === 'aal2'` | **VERIFIED** |
| Scannable QR code rendering in UI | `src/components/PortalsWorkspace.tsx` renders `<img>` strictly gated on `totpEnrollment.qrCode.startsWith('data:image/')` alongside manual setup secret, provisioning URI, and reload-recovery notice | **VERIFIED** |

---

## 2. Non-Mutating Automated MFA Test Matrix (`tests/phase21-30-certification.test.ts`)

All non-mutating MFA tests executed using an isolated mock `ExternalStagingSupabaseClientLike` without touching any real external Supabase account:
- Enrollment factor-ID capture and storage secrecy assertion (`secret` and `otpauth://` absent from `sessionStorage`): **PASS**
- Simulated full page reload recovery via `resolveExternalTotpFactorId()`: **PASS**
- Malformed / non-6-digit code rejection without dropping pending factor: **PASS**
- Incorrect TOTP code rejection without dropping pending factor: **PASS**
- Valid 6-digit code with whitespace -> `aal2` elevation + `refreshSession()` + pending factor cleared: **PASS**
- Duplicate enrollment blocked when verified TOTP factor already exists: **PASS**
- Stale unverified factor replacement unenrolls only unverified factor: **PASS**
- Logout clears pending factor and calls `auth.signOut()`: **PASS**
- Non-admin UUID rejected before enrollment: **PASS**
- Provider returning `aal1` post-verify rejected fail-closed: **PASS**

---

## 3. Account-Holder Interactive Staging Certification Procedure (Ready to Execute)

Per Non-Negotiable Safety Rules, the real account `fd9523dd-eb07-4cca-9040-62feea3f5353` on `nswxwwmtcasmkjtmrdqg` was **NOT** mutated by automation. Once the repaired branch is deployed to staging with `VITE_PHASE19_EXTERNAL_AUTH_STAGING=true` and `VITE_PHASE19_EXTERNAL_AUTH_ANON_KEY` configured:

1. **Sign In (AAL1):** Account holder signs into the staging Portals workspace with email and password. Verify UI displays the Executive MFA gate and `GET /api/admin/overview` returns `403`.
2. **Enroll Authenticator (if no verified TOTP factor exists):** Click **Enroll Authenticator App (TOTP)**. Scan the displayed QR code in an authenticator app (1Password, Google Authenticator, Authy).
3. **Reload Test (Optional Recovery Check):** Refresh the browser page while enrollment is pending; verify the amber pending-enrollment notice appears and no secret is stored in DevTools `sessionStorage`.
4. **Verify & Elevate to AAL2:** Enter the current 6-digit TOTP code and click **Verify & Unlock Executive Portal**. Confirm `GET /api/auth/session` returns `{ mfaVerified: true, aal: "aal2" }` and Executive Administration loads (`GET /api/admin/overview` returns `200`).
5. **Sign Out & Persistence Check:** Sign out, verify session is cleared, then sign back in and verify AAL2 challenge is required again before admin access is granted.

---

## 4. Certification Status

- **Non-Mutating Code & Automated MFA Lifecycle Tests:** **VERIFIED**
- **Live Account-Holder AAL2 Enrollment & Verification on `nswxwwmtcasmkjtmrdqg`:** **BLOCKED** (requires human account holder execution after staging deployment of this branch).
