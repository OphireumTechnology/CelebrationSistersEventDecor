# Phase 18.3 — Consultation Booking Wizard Acceptance

**Component:** `src/components/ConsultationModal.tsx`  
**Supporting API Client:** `src/lib/apiClient.ts`

---

## 1. End-to-End 4-Step Wizard Audit

| Step | Functionality | Live Production Audit (Read-Only) | Local Full-Stack Automated + Chromium Audit |
|---|---|---|---|
| **Step 1 — Event Discovery** | Event category, optional celebration title & theme, target event date (`min={todayIso}` in `America/New_York`), guest count (`>=10`), budget range, city/state, venue, service division toggles | Verified on Desktop (`1440x900`) & Mobile (`390x844`): empty event date blocked with `"Please choose your target event date."` | Verified: valid submission advances to Step 2 and preserves all fields |
| **Step 2 — Scheduling** | 3 consultation methods (`video`, `in_person_columbia`, `phone`), timezone selector, 14-day horizontal date strip with blackout/closed states, real-time planner slots, Retry Availability button, 10-minute temporary hold (`POST /api/consultations/holds`) with `Reserving Slot...` busy guard | Verified live slots loaded from Railway across all 3 formats + `America/Los_Angeles` timezone switch + Thanksgiving `Blackout` pill | Verified: slot hold (`201`), slot selection, Step 2 -> Step 3 transition, conflict refresh (`409`) |
| **Step 3 — Contact Details & Consent** | Full name, email format validation, phone (`>=7` chars), preferred contact method (`email`/`phone`/`sms`), notes, explicit privacy consent checkbox | Code & validation verified (stopped before prod mutation) | Verified: invalid email/missing consent blocked; valid input advances to Step 4 |
| **Step 4 — Review & Confirm** | Displays Event Discovery, timezone-accurate Consultation Appointment (`clientTimezone` + studio ET), and Client Information with Edit links for Steps 1–3; idempotent `POST /api/consultations` with `Idempotency-Key` header and `Retry` on transient `503`/network failures | Code & render verified (stopped before prod booking write) | Verified: booking returns `201`, displays confirmation reference (`CS-YYYY-NNNN`), one-time `csa_` verification token with Copy button, and honest outbox status |

---

## 2. Error-Handling & Anti-Fabrication Verification

- **Zero Fabricated Availability:** When the API returns an error or non-JSON 404, `ConsultationModal` clears slots and displays a clear error alert with a `Retry Availability` button — never synthetic/mock slots.
- **Race-Condition Recovery (`409`):** If a slot is booked by another client between Step 2 and Step 4, the modal regenerates `Idempotency-Key`, returns to Step 2, displays a clear conflict alert, and refreshes live availability.
- **Idempotent Retry (`503` / network interruption):** On transient submission errors, the modal retains the same `Idempotency-Key` and renders a `Retry` button so retrying cannot double-book.
