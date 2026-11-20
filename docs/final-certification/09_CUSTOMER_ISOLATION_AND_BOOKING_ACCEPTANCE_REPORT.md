# 09 — Customer Isolation and Booking Acceptance Report

**Project:** Celebration Sisters Event Decor  
**Audit Timestamp:** 2026-11-20T22:50Z

---

## 1. Local Automated Isolation & Booking Verification (`VERIFIED`)

### Cross-Account Isolation (`tests/auth-and-rbac.test.ts` & `tests/phase21-30-certification.test.ts`)
- Customer A (`user-client-camille`) cannot read Customer B (`user-client-elena`) bookings (`bkg-102` excluded).
- Cross-account email matching cannot leak records bound to another `clientId` (repaired in `server/app.ts` `GET /api/consultations`; regression test confirms Customer B's bound consultation sharing Customer A's email is hidden from A and visible to B).
- Customer A receives fail-closed denial across every cross-tenant/privileged endpoint:
  - `GET /api/admin/overview` -> `403`
  - `GET /api/staff/checklists` -> `403`
  - `GET /api/inventory` -> `403`
  - `GET /api/vendors` -> `403`
  - `POST /api/bookings/bkg-102/contract/sign` -> `403`
  - `POST /api/bookings/bkg-102/quotes` -> `403`
  - `PATCH /api/bookings/bkg-102/status` -> `403`
  - `PATCH /api/bookings/bkg-102/assignments` -> `403`
  - `POST /api/bookings/bkg-102/messages` -> `404` (anti-enumeration denial)
  - `PATCH /api/bookings/bkg-102/milestones/ms-1` -> `404` (anti-enumeration denial)

### End-to-End Booking, Concurrency & Real Chromium Acceptance (`VERIFIED`)
- **Automated Booking & Concurrency Tests (`npm test` — `132 / 132 PASS`):** Verified live availability, slot holds + `DELETE /api/consultations/holds` immediate release, Columbia ET today validation, `Idempotency-Key` deduplication, conflict exclusion, rescheduling, cancellation, and transactional rollback.
- **Real Headless Chromium Browser Acceptance (`scripts/phase16-browser-acceptance.ts` — `20 / 20 PASS` at 2026-11-20T22:49:17Z):**
  - Desktop `1440x900` + Mobile `390x844` (`pageOverflow=0px`, `modalOverflow=0px`, `ctaHeight=44px`).
  - Full wizard booking (`CS-2027-0065`), HTTP `503` outage alert without false confirmation, wrong `csa_` token rejection, client online rescheduling & cancellation, admin MFA confirmation (`CS-2027-0066`), planner assignment & CRM persistence across reload, proposal handoff, Admin Email Outbox verification, and **`0` console errors / `0` page errors**.

---

## 2. Blocked Live Staging Customer & Concurrency Gates

- **Live Staging Customer A vs. Customer B Authenticated Write & Isolation Run (`REQ-36`):** **BLOCKED** pending deployment of the reconciled commit and staging test identity tokens.
- **Live Staging PostgreSQL Non-Superuser RLS Probe (`REQ-37`):** **BLOCKED** (`STAGING_DATABASE_URL` unavailable in sandbox).
- **Live Staging Concurrent Double-Booking Race Against Railway PostgreSQL Exclusion Constraint (`REQ-38`):** **BLOCKED** (requires authorized live staging write run).
