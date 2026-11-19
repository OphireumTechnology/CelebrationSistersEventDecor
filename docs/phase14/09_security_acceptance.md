# Phase 14 — Block 14.9: Security & Privacy Hardening Acceptance

## Controls Verified

| Control Domain | Implementation | Evidence |
| :--- | :--- | :--- |
| **Scoped Public Consultation Access** | `GET /api/consultations/status`, `POST /api/consultations/:id/reschedule`, and `POST /api/consultations/:id/cancel` require a 192-bit cryptographic `csa_...` verification token (stored solely as SHA-256 `accessTokenHash`, compared via `crypto.timingSafeEqual`) OR an authorized authenticated session. Predictable reference-only lookups return `400 SCOPED_TOKEN_REQUIRED`; wrong tokens return `403`. | `server/scheduling.ts`, `server/app.ts`, `tests/phase14-consultation-system.test.ts` |
| **Role-Based Access Control (RBAC) & MFA** | `GET /api/consultations` requires active account (`401` guest); `vendor` denied `403`; `client` strictly isolated to own records; `admin` requires verified MFA (`aal2`) across all consultation, CRM, staff-availability, and reminder endpoints (`403` without MFA). | `server/app.ts`, `server/authz.ts`, `tests/phase14-consultation-system.test.ts` |
| **Database RLS & Railway PG Compatibility** | Migration `007` reconciles `auth.uid()` safely via `to_regprocedure('auth.uid()')` in `app_resolve_provider_uid()` / `app_current_user_id()`, failing closed (`NULL`) when unset. All new tables (`staff_availability_rules`, `consultation_slot_holds`, `crm_follow_up_tasks`) enable and `FORCE ROW LEVEL SECURITY`. | `db/migrations/007_consultation_scheduling_and_railway_rls.sql`, `tests/phase14-postgres-rls.test.ts` |
| **CORS Production Domain Allowlist** | Added `https://celebrationsistersdecor.com` and `https://www.celebrationsistersdecor.com` to default production `ALLOWED_ORIGINS` without wildcards. | `server/authz.ts` |
| **CSRF Protection** | Existing cookie-authenticated mutation middleware enforces Origin/Referer + cryptographic synchronizer token (`X-CSRF-Token`) across all `/api/*` POST/PUT/PATCH/DELETE routes including Phase 14 endpoints. | `server/app.ts`, `tests/phase13-security-and-rate-limit.test.ts` |
| **Rate Limiting & Fail-Closed Protection** | Dedicated rate limits applied to `/api/consultations/availability` (90/min), `/holds` (25/min), `POST /api/consultations` (20/min), `/status` (30/min, fail-closed), `/reschedule` (25/min, fail-closed), and `/cancel` (25/min, fail-closed). | `server/app.ts`, `server/rateLimit.ts` |
| **XSS & Template Injection Prevention** | All user-supplied fields embedded in HTML email templates pass through `escapeHtml()`. React auto-escaping is preserved across all UI components with zero `dangerouslySetInnerHTML`. | `server/notifications.ts`, `src/components/ConsultationModal.tsx` |
| **Privacy Consent & PII Minimization** | Booking creation enforces `privacyConsentAccepted: z.literal(true)` and timestamps consent (`privacyConsentAt`, `privacyConsentVersion`). `sanitizeConsultationForClient()` strips `accessTokenHash`. `redactSensitiveFields()` strips `accessToken`, `email`, `secret`, `password`, and `token` keys from structured logs. | `server/app.ts`, `server/store.ts`, `server/observability.ts` |
| **Secret & Artifact Hygiene** | Obsolete `/bun.lock` removed; CI secret regex scan passes with zero matches across `src`, `server`, `scripts`, and `docs`. No `.env` or live customer exports committed. | `.github/workflows/ci.yml` |

## Production Environment Controls Still Requiring Operator Execution (Blocked Outside Sandbox)
- Live Railway PostgreSQL deployment with dedicated non-superuser app role (`NO BYPASSRLS`) and TLS verification (`PGSSLMODE=verify-full` / provider CA).
- Live Resend domain verification (SPF/DKIM/DMARC) and verified webhook endpoint for upgrading `ProviderAccepted` to `Delivered`.
