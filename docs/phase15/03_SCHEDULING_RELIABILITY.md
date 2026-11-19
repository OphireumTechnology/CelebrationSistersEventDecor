# Phase 15.4 — Scheduling Engine & Availability Reliability Report

**Project:** Celebration Sisters Event Decor  
**Primary Modules:** `server/scheduling.ts`, `server/app.ts`, `src/components/ConsultationModal.tsx`, `src/components/AdminConsultationCommandCenter.tsx`  
**Studio Timezone:** `America/New_York` (Columbia, South Carolina, USA)

---

## 1. Scheduling Architecture & Guarantees

| Capability | Implementation | Verification |
| :--- | :--- | :--- |
| **Server-Authoritative Slot Generation** | `computeConsultationAvailability()` computes candidate slots dynamically from active `staffAvailabilityRules` in `America/New_York` using `Intl.DateTimeFormat` timezone offsets (DST-safe across EST/EDT transitions). | Verified via unit + HTTP tests |
| **Buffer Enforcement** | Every booked consultation and active temporary hold applies `bufferBeforeMinutes` and `bufferAfterMinutes` (default `15m`/`15m`, configurable per planner per day). | Verified via automated overlap tests |
| **Editable Duration & Buffers** | Admin Command Center -> **Staff Availability** tab now provides editable numeric inputs for `slotDurationMinutes` (`15–180m`), `bufferBeforeMinutes` (`0–60m`), and `bufferAfterMinutes` (`0–60m`), persisted via `PUT /api/staff/availability/:plannerId`. | Verified via `phase15-e2e-and-hardening.test.ts` |
| **US Studio Holiday Calendar** | Added `getStudioHolidayReason(dateIso)` in `server/scheduling.ts` blocking New Year's Day, Memorial Day (last Monday of May), Independence Day, Labor Day (first Monday of September), Thanksgiving Day (4th Thursday of November), and Christmas Day automatically across both availability rendering and booking validation (`409`). | Verified via unit + API availability tests |
| **Custom Blackout Dates** | Studio blackout dates stored in `blackoutDates` override staff schedules cleanly with explicit `blackoutReason` display. | Verified |
| **Temporary 10-Minute Slot Holds** | `POST /api/consultations/holds` reserves a slot for 10 minutes keyed by `holderKey`; expired holds (`expiresAt <= now`) are ignored automatically and purged on transaction writes. | Verified |
| **Concurrent Double-Booking Prevention** | `POST /api/consultations` executes validation and persistence atomically inside `withTransaction()`, backed by `Idempotency-Key` deduplication and PostgreSQL exclusion/unique conflict constraints. Simultaneous `Promise.all` requests for the same slot yield exactly one `201 Created` and one `409 SLOT_CONFLICT`. | Verified via Scenario B race test |
| **Reschedule & Cancel Slot Release** | `POST /api/consultations/:id/reschedule` validates the target slot excluding the current consultation ID (`excludeConsultationId`) and immediately frees the prior window. `POST /api/consultations/:id/cancel` marks status `Cancelled`, releasing the slot immediately because `isActiveConsultationStatus()` excludes `Cancelled`, `Completed`, and `No-show`. | Verified via Scenarios E & F |
| **Timezone Accuracy** | All timestamps are persisted in UTC (`startUtc`, `endUtc`), rendered in the client's selected IANA timezone (`clientWindow`) alongside Columbia studio Eastern Time (`studioWindow`). Invalid timezones are rejected with `400`. | Verified |

---

## 2. State Transition Enforcement

`canTransitionConsultationStatus()` enforces strict lifecycle transitions:
- `Draft` -> `Pending`, `Confirmed`, `Cancelled`
- `Pending` -> `Confirmed`, `Rescheduled`, `Cancelled`, `Completed`, `No-show`
- `Confirmed` -> `Rescheduled`, `Cancelled`, `Completed`, `No-show`
- `Rescheduled` -> `Confirmed`, `Rescheduled`, `Cancelled`, `Completed`, `No-show`
- Terminal states (`Completed`, `Cancelled`, `No-show`) reject subsequent reschedule or cancellation attempts with `409`.
