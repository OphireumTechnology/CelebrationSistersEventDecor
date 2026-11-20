# 05 — Customer Isolation Test Report

**Project:** Celebration Sisters Event Decor  
**Audit Date:** 2026-11-20

---

## 1. Defect Discovered & Repaired in Customer Consultation Isolation

During the Phase 25 code audit of `GET /api/consultations` in `server/app.ts`, a subtle cross-account email matching bug was discovered:
- **Previous Logic:** Returned consultations where `c.clientId === ctx.session.id || c.clientEmail === ctx.session.email`. If Customer B owned a consultation bound to `clientId = customerB.id` whose `clientEmail` matched Customer A's email, Customer A could see Customer B's consultation record.
- **Repaired Logic (`server/app.ts`):**
  - If a consultation has a bound `clientId` (not starting with `lead:`), it is visible ONLY when `c.clientId === ctx.session.id`.
  - Email matching is permitted ONLY for unbound public lead records (`!c.clientId || c.clientId.startsWith('lead:')`) AND ONLY when `ctx.emailVerified === true`.
- **Regression Test Added:** `tests/phase21-30-certification.test.ts` seeds a consultation bound to `user-client-elena` sharing `user-client-camille`'s email and verifies Camille receives zero access while Elena retains full access.

---

## 2. Automated Horizontal & Vertical Isolation Test Matrix

| Resource / Action | Actor | Expected | Verified Result | Test Suite |
| --- | --- | --- | --- | --- |
| `GET /api/bookings` | Unauthenticated guest | `401` | `401` | `tests/auth-and-rbac.test.ts` + live Railway staging |
| `GET /api/bookings` | Customer A (`user-client-camille`) | Only Customer A bookings (`bkg-102` excluded) | `200`, 0 Customer B records | `tests/auth-and-rbac.test.ts` |
| `POST /api/bookings/bkg-102/contract/sign` | Customer A targeting Customer B | `403` | `403` | `tests/phase21-30-certification.test.ts` |
| `POST /api/bookings/bkg-102/messages` | Customer A targeting Customer B | `403` or `404` (anti-enumeration) | `404` | `tests/phase21-30-certification.test.ts` |
| `POST /api/bookings/bkg-102/quotes` | Customer A targeting Customer B | `403` | `403` | `tests/phase21-30-certification.test.ts` |
| `PATCH /api/bookings/bkg-102/status` | Customer A targeting Customer B | `403` | `403` | `tests/phase21-30-certification.test.ts` |
| `PATCH /api/bookings/bkg-102/assignments` | Customer A targeting Customer B | `403` | `403` | `tests/phase21-30-certification.test.ts` |
| `PATCH /api/bookings/bkg-102/milestones/ms-1` | Customer A targeting Customer B | `403` or `404` (anti-enumeration) | `404` | `tests/phase21-30-certification.test.ts` |
| `GET /api/consultations` (shared email, bound `clientId`) | Customer A targeting Customer B | Customer B bound record excluded | `200`, excluded for A, visible for B | `tests/phase21-30-certification.test.ts` |
| `GET /api/admin/overview` | Customer A / Unauthenticated | `403` | `403` | `tests/phase21-30-certification.test.ts` + live Railway staging |
| `GET /api/staff/checklists` | Customer A | `403` | `403` | `tests/phase21-30-certification.test.ts` |
| `GET /api/inventory` | Customer A | `403` | `403` | `tests/phase21-30-certification.test.ts` |
| `GET /api/vendors` | Customer A | `403` | `403` | `tests/phase21-30-certification.test.ts` |
| Public consultation lookup with wrong `csa_` token | Public caller | `403` | `403` | `scripts/phase16-browser-acceptance.ts` (`P16-BA-10`) |
| `FORCE ROW LEVEL SECURITY` SQL policies (`002`, `005`, `007`) | Non-privileged DB role | Per-table `ENABLE` + `FORCE` + write policies | Verified statically across all 8 migrations | `tests/phase14-postgres-rls.test.ts` + `tests/phase29-35-deficiency-remediation.test.ts` |

---

## 3. Certification Status

- **Local Express API & Static PostgreSQL RLS Isolation Verification:** **VERIFIED**
- **Live Railway Staging Customer A / Customer B Authenticated End-to-End Write & PostgreSQL RLS Probe (`scripts/setup-staging-rls-probe.ts`):** **BLOCKED** (requires `STAGING_DATABASE_URL` and live staging customer credentials).
