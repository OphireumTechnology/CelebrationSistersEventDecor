# Phase 14 — Block 14.4: Real-Time Consultation Availability & Scheduling Engine

## Architecture (`server/scheduling.ts`)
The consultation scheduling engine is strictly **server-authoritative**: the frontend never computes booking eligibility locally or trusts client-supplied end times or buffer intervals.

## Core Capabilities
1. **Studio Timezone & DST Accuracy**
   - Canonical studio timezone: `America/New_York` (Columbia, South Carolina).
   - `localDateTimeToUtc(dateIso, hhmm, timeZone)` uses `Intl.DateTimeFormat().formatToParts()` with double-pass offset refinement to handle US Daylight Saving Time transitions (EST UTC-5 vs. EDT UTC-4) deterministically.
   - Supported client display timezones: `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles`, `America/Phoenix`, `UTC` (validated via `isValidIanaTimezone()`).
2. **Staff Operating Windows & Channel Filtering**
   - Evaluates active `StaffAvailabilityRule` records per day of week (`0=Sun..6=Sat`), generating fixed-duration slots (default 45 minutes) stepped by `slotDurationMinutes + bufferAfterMinutes`.
   - Filters candidate slots by requested consultation method (`video`, `in_person_columbia`, `phone`) and optional `plannerId`.
3. **Blackout Dates & Lead-Time Enforcement**
   - Any studio date present in `blackoutDates` immediately returns `isBlackout: true`, `availableCount: 0`, and rejects direct booking attempts with `BLACKOUT` (`409 Conflict`).
   - Appointments must be scheduled at least **60 minutes** in advance (`INVALID_TIME`).
4. **Buffer-Aware Conflict Detection**
   - `findPlannerSlotConflict()` expands both existing active appointments (`Draft`, `Pending`, `Confirmed`, `Rescheduled`) and requested slots by `bufferBeforeMinutes` and `bufferAfterMinutes` (default 15 min before / 15 min after), preventing back-to-back exhaustion and double-booking.
   - Also respects active non-expired `ConsultationSlotHold` entries while ignoring the caller's own `holderHash` so a client holding a slot can seamlessly complete booking.
   - Cancelled, Completed, and No-show consultations immediately release their windows.
5. **Status State Machine (`VALID_CONSULTATION_TRANSITIONS`)**
   - `Draft -> Pending | Confirmed | Cancelled`
   - `Pending -> Confirmed | Rescheduled | Cancelled`
   - `Confirmed -> Rescheduled | Completed | Cancelled | No-show`
   - `Rescheduled -> Confirmed | Rescheduled | Completed | Cancelled | No-show`
   - Terminal states: `Completed`, `Cancelled`, `No-show` (cannot transition further).
6. **Cryptographic Scoped Access Tokens**
   - `generateConsultationAccessToken()` creates a 192-bit random `csa_...` token and stores only its SHA-256 hex digest (`accessTokenHash`).
   - `verifyConsultationAccessToken()` validates incoming tokens using constant-time `crypto.timingSafeEqual`.
