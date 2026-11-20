# Phase 18.8 — Browser & Security Test Verification

**Date:** `2026-11-20T04:18Z`  
**Chromium Runtime:** Headless Chromium (`playwright-core`)  
**Automated Test Runner:** Node.js native test runner (`tsx --test tests/*.test.ts`)

---

## 1. Automated Unit, Integration, Concurrency & Security Suite (`npm test`)

- **Result:** **91 / 91 PASSED** (`8` suites, `0` failed, `0` skipped)
- **New Phase 18 Regression Suite (`tests/phase18-live-booking-acceptance.test.ts` — 5 tests):**
  1. `PostgresRateLimitStore` idempotently bootstraps missing `rate_limit_buckets` on PostgreSQL `42P01` while remaining strictly fail-closed (`503 RATE_LIMITER_UNAVAILABLE`) on DB outages (`ECONNREFUSED`) and restricted non-superuser roles (`42501`).
  2. `checkPersistenceHealth()` surfaces `schema: { rateLimitTablePresent, migrationsTablePresent, migrationsAppliedCount }` for `/ready` monitoring.
  3. `getStudioTodayIso()` resolves Columbia, SC (`America/New_York`) calendar dates across EST/EDT evening boundaries without UTC next-day drift.
  4. Full header-based `X-Consultation-Token` self-service lifecycle (`status`, `client-details`, `reschedule`, `cancel`, `token/revoke` -> `403 TOKEN_REVOKED`) with zero token in URL query strings + CORS allowlist preflight (`204` for `celebrationsistersdecor.com`, `403` for untrusted origins).
  5. Static source-contract enforcement for `ConsultationModal.tsx` (no `accessToken=` in URL, `X-Consultation-Token` header, `Retry Availability`, `Reserving Slot...`) and `.github/workflows/deploy-pages.yml` (PR #17 Railway origin default + fail-closed check).

---

## 2. Live Production Read-Only Browser Audit (`https://celebrationsistersdecor.com/`)

Strictly read-only (`0` `POST`/`PATCH`/`DELETE` requests issued to production):

| Viewport | Page Overflow | Modal Overflow | Step 1 Validation | Live Railway Availability (`video`, `in_person`, `phone`, `America/Los_Angeles`) | Thanksgiving Blackout | Manage/Track UI | API Requests -> Railway | Non-200 API | Console / Page Errors |
|---|---|---|---|---|---|---|---|---|---|
| Desktop (`1440x900`) | `0px` | `0px` | PASS (`Please choose your target event date.`) | PASS (`4:00 PM UTC` / `8:00 AM PST`) | PASS (`Blackout`) | PASS | `6 / 6` | `0` | `0 / 0` |
| Mobile (`390x844`) | `0px` | `0px` | PASS (`Please choose your target event date.`) | PASS (`4:00 PM UTC` / `8:00 AM PST`) | PASS (`Blackout`) | PASS | `6 / 6` | `0` | `0 / 0` |

---

## 3. Compiled Full-Stack Chromium Acceptance (`scripts/phase16-browser-acceptance.ts`)

- **Result:** **20 / 20 PASSED** (`P16-BA-01` through `P16-BA-20`)
- Verified end-to-end against compiled `dist/` + `dist-server/server.mjs`:
  - Homepage branding & navigation, accessible modal focus/Escape cycle, Step 1 validation, Step 2 live availability & slot hold, Step 3 consent/contact validation, HTTP `503` outage alert with zero false confirmation, Step 4 idempotent retry & persisted booking (`CS-2027-0065`), one-time `csa_` verification token, header-based self-service lookup/reschedule/cancel, unauthorized admin `403`, MFA admin confirm/reassign/CRM progression/proposal handoff/outbox inspection, and Mobile (`390x844`) `0px` overflow & `44px` touch targets.

---

## 4. Security & Static Hygiene Verification

- **Live Railway CORS Allowlist:** `OPTIONS` from `https://celebrationsistersdecor.com` & `https://www.celebrationsistersdecor.com` -> `204` with `ACAC: true`; `OPTIONS` from `https://evil-attacker.example.com` -> `403 CORS_ORIGIN_DENIED` with no `ACAO` header.
- **Live Railway Unauthorized Isolation:** `GET /api/consultations` -> `401 AUTH_REQUIRED`; `GET /api/admin/overview`, `/outbox`, `/metrics` -> `403 ADMIN_REQUIRED`.
- **Static Secret Scan:** `SECRET_SCAN_CLEAN` (zero hardcoded Resend keys, Svix secrets, Gemini keys, JWTs, or private keys across `src/`, `server/`, `scripts/`, `db/`, `.github/`).
- **SQL Migration & RLS Static Verification:** `verify-migrations.ts` passed (`8` files, `36` RLS tables checked, `0` errors); `run-migrations.ts --dry-run` verified all 8 checksums; `reconcile-snapshot-to-normalized.ts` verified `60` entities with `0` anomalies.
