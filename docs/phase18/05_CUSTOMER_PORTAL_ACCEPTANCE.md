# Phase 18.5 — Customer Self-Service Portal Acceptance

**Endpoints:**
- `GET /api/consultations/status`
- `PATCH /api/consultations/:id/client-details`
- `POST /api/consultations/:id/reschedule`
- `POST /api/consultations/:id/cancel`
- `POST /api/consultations/:id/token/revoke`

---

## 1. Live & Code Security Findings Repaired in Phase 18

### Repair 1 — Eliminated Sensitive Verification Token Leakage in URL Query Strings
- **Defect Found:** `src/components/ConsultationModal.tsx` previously called `GET /api/consultations/status?referenceCode=...&accessToken=...`, exposing the private `csa_` verification secret in URL query strings (which are routinely captured by Railway HTTP access logs, CDN logs, and browser history).
- **Repair:** Updated `ConsultationModal.tsx` to transmit the verification secret exclusively via the `X-Consultation-Token` request header across all 5 customer self-service endpoints (`status`, `client-details`, `reschedule`, `cancel`, `token/revoke`). Server CORS allowlist (`server/authz.ts`) already explicitly permits `X-Consultation-Token`.

### Repair 2 — Resolved Live `503 RATE_LIMITER_UNAVAILABLE` Blocking All Customer Self-Service Endpoints
- **Defect Found:** On live Railway, `GET /api/consultations/status` failed with `HTTP 503 RATE_LIMITER_UNAVAILABLE` because `rate_limit_buckets` (migration `004`) had not yet been applied to Railway PostgreSQL.
- **Repair:** `PostgresRateLimitStore` (`server/rateLimit.ts`) now bootstraps `rate_limit_buckets` idempotently on `42P01` without compromising fail-closed protection on outages or non-superuser privilege boundaries.

---

## 2. Verified Self-Service Lifecycle Capabilities

| Check | Local Automated + Browser Verification | Live Production Verification |
|---|---|---|
| Scoped token (`csa_`) SHA-256 hashed at rest & constant-time verified | **PASS** | Code deployed; live probe currently blocked by unmigrated `rate_limit_buckets` (`503`) until Phase 18 deploy / migration `004` |
| Reference-only lookup blocked (`400 SCOPED_TOKEN_REQUIRED`) | **PASS** | Blocked until deploy / migration `004` |
| Wrong/forged token rejected (`403 INVALID_CONSULTATION_TOKEN`) | **PASS** | Blocked until deploy / migration `004` |
| Client contact & event details update (`PATCH /client-details`) via `X-Consultation-Token` | **PASS** | Requires staging write test |
| Reschedule (`POST /reschedule`) frees old slot & locks new slot atomically | **PASS** | Requires staging write test |
| Cancel (`POST /cancel`) transitions status to `Cancelled`, frees slot, enqueues alerts | **PASS** | Requires staging write test |
| Token revocation (`POST /token/revoke`) immediately blocks subsequent lookups (`403 TOKEN_REVOKED`) | **PASS** | Requires staging write test |
| Manage / Track UI renders cleanly on Desktop (`1440x900`) & Mobile (`390x844`) | **PASS** | **VERIFIED LIVE** (read-only) |
