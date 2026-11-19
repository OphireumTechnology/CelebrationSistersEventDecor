# Phase 15R — Repair 01: Scheduling Two-Hour Booking Cutoff & PR #14 Reconciliation

**Project:** Celebration Sisters Event Decor  
**Status:** `VERIFIED` (Code & Automated Boundary Regression Suite) / GitHub PR #14 remote branch reconciliation `BLOCKED` (no `.git` / `gh` CLI in sandbox)  
**Primary Module:** `server/scheduling.ts`  
**Regression Test Suite:** `tests/phase15r-critical-repairs.test.ts` (`REPAIR 01`, `REPAIR 01 (HTTP)`)

---

## 1. Root Cause Identified

During Phase 15 audit of `server/scheduling.ts`, availability generation and slot submission enforced two contradictory minimum notice rules:

- `computeConsultationAvailability()` enforced a **2-hour (120-minute)** studio preparation notice (`nowMs + 2 * 60 * 60_000`), hiding slots less than 120 minutes away.
- `validateRequestedConsultationSlot()` enforced only a **1-hour (60-minute)** cutoff (`nowMs + 60 * 60_000`), allowing direct API callers to hold or book slots between 60 and 119 minutes in advance even though availability declared them closed.

---

## 2. Implemented Repair (`server/scheduling.ts`)

1. Exported a single authoritative constant and helper shared by every scheduling path:
   - `export const MIN_CONSULTATION_NOTICE_MINUTES = 120;`
   - `export function meetsConsultationNotice(startUtc: string | Date, nowMs?: number, minNoticeMinutes = MIN_CONSULTATION_NOTICE_MINUTES): boolean`
2. Refactored `computeConsultationAvailability()` to evaluate `!meetsConsultationNotice(startDateUtc, nowMs)` with reason `'Past 2-hour booking notice cutoff'`.
3. Refactored `validateRequestedConsultationSlot()` to evaluate `!meetsConsultationNotice(startDt, nowMs)` and return `{ valid: false, errorCode: 'INVALID_TIME', error: 'Consultation appointments must be scheduled at least 2 hours in advance.' }`.
4. Because `POST /api/consultations/holds`, `POST /api/consultations`, and `POST /api/consultations/:id/reschedule` all delegate to `validateRequestedConsultationSlot()`, all endpoints now agree strictly on the exact 120-minute boundary.

---

## 3. Verification Evidence (Controlled Clock & HTTP Integration)

Executed via `npm test` (`tests/phase15r-critical-repairs.test.ts`):

| Scenario (Controlled Clock anchored on Tuesday `2027-03-16` 12:00 PM `America/New_York`) | Availability (`computeConsultationAvailability`) | Validation (`validateRequestedConsultationSlot`) | Result |
| :--- | :--- | :--- | :--- |
| 30 minutes ahead | `available: false` (`Past 2-hour booking notice cutoff`) | `valid: false` (`INVALID_TIME`, 2 hours) | PASS |
| 60 minutes ahead | `available: false` (`Past 2-hour booking notice cutoff`) | `valid: false` (`INVALID_TIME`, 2 hours) | PASS |
| 90 minutes ahead | `available: false` (`Past 2-hour booking notice cutoff`) | `valid: false` (`INVALID_TIME`, 2 hours) | PASS |
| 119 minutes ahead | `available: false` (`Past 2-hour booking notice cutoff`) | `valid: false` (`INVALID_TIME`, 2 hours) | PASS |
| 120 minutes ahead (exact boundary) | `available: true` | `valid: true` | PASS |
| 121 minutes ahead | `available: true` | `valid: true` | PASS |
| Studio Holiday (`2027-12-25` Christmas) | `isBlackout: true` | `valid: false` (`BLACKOUT`) | PASS |
| Custom Studio Blackout Date | `isBlackout: true` | `valid: false` (`BLACKOUT`) | PASS |
| Overlapping Active Appointment | `available: false` | `valid: false` (`SLOT_CONFLICT`) | PASS |
| Planner 15-Minute Post-Appointment Prep Buffer | `available: false` | `valid: false` (`SLOT_CONFLICT`) | PASS |
| Live HTTP `POST /api/consultations/holds` (90m ahead) | HTTP `400 INVALID_TIME` (`2 hours`) | Matches availability | PASS |
| Live HTTP `POST /api/consultations` (90m ahead) | HTTP `400 INVALID_TIME` (`2 hours`) | Matches availability | PASS |

---

## 4. PR #14 Reconciliation Note

Because this execution sandbox has no `.git` metadata directory and no `gh` CLI credentials, remote inspection/cherry-picking of `https://github.com/OphireumTechnology/CelebrationSistersEventDecor/pull/14` cannot run directly inside the container. When syncing this workspace onto `repair/phase15r-critical-acceptance` from `main` (`82d98be897a15528741bd8a15423dd7354e5e3cb`), retain this unified `MIN_CONSULTATION_NOTICE_MINUTES = 120` implementation and close/supersede PR #14 once merged.
