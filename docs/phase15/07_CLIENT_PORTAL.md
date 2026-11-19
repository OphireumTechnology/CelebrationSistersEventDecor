# Phase 15.8 — Client Self-Service Portal & Token Lifecycle Report

**Project:** Celebration Sisters Event Decor  
**Primary Modules:** `src/components/ConsultationModal.tsx`, `server/scheduling.ts`, `server/app.ts`

---

## 1. Self-Service Capabilities Implemented

| Client Action | Endpoint | Security & Authorization Model |
| :--- | :--- | :--- |
| **View Consultation Status & Planner Assignment** | `GET /api/consultations/status` | Scoped verification token (`referenceCode` + `accessToken`, hashed via SHA-256 and verified with `crypto.timingSafeEqual`) OR authenticated owning client session. Rate-limited fail-closed. |
| **View Authorized Proposal Status** | `GET /api/consultations/status` (`proposalSummary`) | Returns latest linked quotation version, exact total, discount, item count, decision status, and CRM stage ONLY after token or owning-client verification passes. |
| **Update Contact & Event Requirements** | `PATCH /api/consultations/:id/client-details` | Allows clients to update phone number, preferred contact method (`email`/`phone`/`sms`), timezone, event title, event theme, guest count, venue name, and inspiration notes. Automatically syncs linked booking and logs `CONSULTATION_CLIENT_DETAILS_UPDATED`. Rejects cancelled consultations (`409`). |
| **Reschedule Appointment Online** | `POST /api/consultations/:id/reschedule` | Displays live availability in the client's timezone excluding the current appointment, validates server-side against conflicts/holidays/blackouts, releases the prior slot immediately, and queues reschedule notifications. |
| **Cancel Appointment Online** | `POST /api/consultations/:id/cancel` | Transitions appointment to `Cancelled`, frees the consultation slot immediately, and queues cancellation notifications. |
| **Revoke Private Verification Token** | `POST /api/consultations/:id/token/revoke` | Immediately sets `accessTokenRevokedAt` and logs `CONSULTATION_TOKEN_REVOKED`; subsequent token requests fail closed with `403 TOKEN_REVOKED`. |

---

## 2. Scoped Access Token Lifecycle Controls

1. **Creation:** `generateConsultationAccessToken()` creates a high-entropy `csa_` token; only its SHA-256 hash (`accessTokenHash`) is persisted in the database. The raw token is displayed once to the client in the confirmed consultation summary with a one-click copy action.
2. **Expiration:** Every newly created consultation sets `accessTokenExpiresAt` to `max(scheduledConsultationEnd + 90 days, now + 30 days)`. `validateConsultationTokenAccess()` rejects expired tokens with `403 TOKEN_EXPIRED`.
3. **Immediate Revocation:** Clients (via Manage mode -> **Revoke Access Token**) or Admin MFA operators can revoke a token immediately. `validateConsultationTokenAccess()` rejects revoked tokens with `403 TOKEN_REVOKED`.
4. **Cross-Client Isolation:** Attempting to read status, update details, reschedule, cancel, or revoke another client's consultation with an invalid token or a different client's session returns `403`.
