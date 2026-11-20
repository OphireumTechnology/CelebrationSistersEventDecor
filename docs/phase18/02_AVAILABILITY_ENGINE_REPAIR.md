# Phase 18.2 — Availability Engine & Scheduling Repair

**Scope:** `server/scheduling.ts`, `server/app.ts` (`GET /api/consultations/availability`, `POST /api/consultations/holds`), `src/components/ConsultationModal.tsx`

---

## 1. Live Availability Audit Results (`https://celebrationsisterseventdecor-production.up.railway.app`)

Live read-only queries against `/api/consultations/availability` confirmed:
- **Studio Timezone:** `America/New_York` (Columbia, SC).
- **14-Day Schedule:** Returns 88 open slots across active studio days (Mon–Sat); Sundays cleanly returned `isStudioOpen: false`.
- **Holiday & Blackout Enforcement:** Thanksgiving (`2026-11-26`) dynamically evaluated and returned `isBlackout: true`, `blackoutReason: "Thanksgiving Day — Studio Closed"`, `availableCount: 0`.
- **Duration & Buffers:** 45-minute consultation windows with 15-minute preparation (`bufferBeforeMinutes: 15`) and 15-minute transition (`bufferAfterMinutes: 15`) buffers enforced server-side.
- **Notice Cutoff:** `MIN_CONSULTATION_NOTICE_MINUTES = 120` enforced identically in availability computation, temporary holds, booking creation, and rescheduling.
- **Timezone Conversion:** Verified live conversion between `UTC` (`4:00 PM UTC`) and `America/Los_Angeles` (`8:00 AM PST`) with zero DST/offset drift.
- **Input Validation:** Invalid IANA timezone (`Mars/Olympus`) and invalid method (`teleport`) both rejected with HTTP `400`.

---

## 2. Defects Identified & Repaired in Phase 18

### Defect A — Evening US UTC Date Drift (`todayIso`)
- **Issue:** Both `src/components/ConsultationModal.tsx` (`const todayIso = new Date().toISOString().slice(0, 10)`) and `server/app.ts` (`/api/consultations/availability` default `startDate` & `POST /api/consultations` `eventDate < todayIso` check) derived "today" in UTC instead of Columbia, SC studio time (`America/New_York`). After 7:00 PM EST / 8:00 PM EDT, South Carolina customers were shifted to tomorrow's calendar date.
- **Repair:**
  - Added `getStudioTodayIso(nowMs?: number)` in `server/scheduling.ts` using `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', ... })`.
  - Updated `server/app.ts` to use `getStudioTodayIso()` for availability defaults and event-date validation.
  - Added matching `getStudioTodayIso()` in `src/components/ConsultationModal.tsx`.
  - Verified via automated unit tests at both winter EST (`2026-11-20T02:30:00Z` -> `2026-11-19`) and summer EDT (`2026-07-05T03:45:00Z` -> `2026-07-04`).

### Defect B — Cross-Midnight Client Timezone Date Display on Step 4 Review
- **Issue:** Step 4 Review rendered `{selectedSlot.dateLocal} · {selectedSlot.displayLabel} ({clientTimezone})`, pairing the studio ET calendar date (`dateLocal`) with the client-timezone clock string. For UTC or late-evening clients crossing midnight, the displayed date could lag the displayed time by 1 day.
- **Repair:** Added `formatSlotInClientTimezone(startUtc, clientTimezone, fallback)` in `src/components/ConsultationModal.tsx` so Step 4 formats the complete date + time directly from authoritative `startUtc` in `clientTimezone`, while displaying the studio ET date and time explicitly underneath.

### Defect C — Step 2 Transient Error Recovery & Hold Double-Click Guard
- **Issue:** If availability loading failed transiently on Step 2, the error alert showed no Retry button; and clicking "Continue" on Step 2 fired `POST /api/consultations/holds` without disabling the button during flight.
- **Repair:** Added `Retry Availability` button directly inside the Step 2 `role="alert"` banner and `holdingSlot` busy state (`Reserving Slot...`) disabling the Continue button while the temporary hold request is in flight.
