# Phase 18.6 — Administrative Consultation & CRM Dashboard Acceptance

**Components:** `src/components/AdminConsultationCommandCenter.tsx`, `server/app.ts` (`/api/consultations`, `/api/consultations/:id/confirm`, `/assign`, `/stage`, `/complete`, `/proposal-handoff`, `/decision`, `/api/admin/overview`, `/api/admin/outbox`, `/api/admin/metrics`, `/api/admin/blackout-dates`)

---

## 1. Live Production Security & Readiness Verification (`https://celebrationsisterseventdecor-production.up.railway.app`)

| Endpoint | Unauthenticated Probe | Observed Result |
|---|---|---|
| `GET /api/consultations` | Guest (no credentials) | **HTTP 401** (`AUTH_REQUIRED`) |
| `GET /api/admin/overview` | Guest (no credentials) | **HTTP 403** (`ADMIN_REQUIRED`) |
| `GET /api/admin/outbox` | Guest (no credentials) | **HTTP 403** (`ADMIN_REQUIRED`) |
| `GET /api/admin/metrics` | Guest (no credentials) | **HTTP 403** (`ADMIN_REQUIRED`) |
| `GET /api/auth/config` | Guest | **HTTP 200** (`demoPersonasAvailable: false`, `supabaseConfigured: false`) |

### Production Authentication Dependency Gap
- Live `/ready` confirmed `auth.provider = "supabase"`, `auth.supabaseConfigured = false`, `auth.readyForProductionAuth = false`.
- Demo personas are strictly disabled in production (`demoPersonasAvailable: false`).
- **Result (`LB-14`):** Admin RBAC/MFA isolation, consultation listing, confirmation, reassignment, CRM stage progression, completion, proposal handoff, blackout management, and outbox inspection are **100% verified locally** across automated integration tests and full-stack Playwright browser acceptance. **Live production/staging admin retrieval remains BLOCKED** until Supabase production Auth environment variables (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_JWT_SECRET`) are provisioned on Railway (and `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` in GitHub Actions Variables) and an authorized admin account enrolls TOTP MFA.

---

## 2. Verified Admin Dashboard Workflows (Local Full-Stack & Automated Tests)

- **Role & MFA Enforcement:** `admin` requires verified RFC 6238 TOTP MFA (`requireAdminWithMfa`); `vendor` receives HTTP `403` on `/api/consultations`; `client` sees only own consultations.
- **Consultation Operations:** Newly submitted public bookings appear immediately in `GET /api/consultations` with linked CRM booking record, client details, event metadata, assigned planner, and audit trail (`CONSULTATION_BOOKED`).
- **Workflow Actions:** Confirm (`Pending -> Confirmed`), Reassign planner (with real conflict checking), CRM stage progression, Complete consultation + auto-create follow-up task, Proposal handoff (versioned itemized quote), Client decision (`Approved` / `Revision Requested`), Blackout creation, and Outbox inspection/requeue.
- **Zero Static API Hardcoding:** 100% of calls in `AdminConsultationCommandCenter.tsx` route through `apiFetch('/api/...')` with `credentials: 'include'`.
