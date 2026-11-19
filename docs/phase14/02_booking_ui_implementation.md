# Phase 14 — Block 14.2: Consultation Booking Wizard & Client UI Implementation

## Summary
The **Book a Private Consultation** experience (`src/components/ConsultationModal.tsx`) has been upgraded from a single-step inquiry form into a luxury, WCAG-AA accessible, responsive 4-step consultation booking wizard integrated with real-time server-authoritative availability and self-service appointment management.

## Brand Identity Preservation
- **Palette:** Royal Purple (`#4B2087`), Champagne Gold (`#B99045`), Ivory (`#FAF8F4`), Charcoal (`#292929`)
- **Typography:** Playfair Display headings + Montserrat body with `tabular-nums` for dates, times, guest counts, and confirmation references
- **Official Logo:** Preserved `BrandLogo` (`public/assets/celebration-sisters-logo.png`) in the sticky modal header
- **Accessibility:** `role="dialog"`, `aria-modal="true"`, Escape-key dismissal, `aria-live="polite"` feedback regions, explicit `<label htmlFor>` bindings, and `>= 44px` mobile touch targets across all primary inputs and buttons

## 4-Step Booking Flow
1. **Step 01 — Event Discovery**
   - Captures primary event category, optional celebration title, **target event date** (strictly separated from the consultation appointment date), estimated guest count (`10–5000`), investment range, event city/state, venue name, and multi-select service divisions.
2. **Step 02 — Consultation Scheduling**
   - Fetches live server-verified studio windows from `GET /api/consultations/availability`.
   - Allows clients to choose appointment format (`video`, `in_person_columbia`, `phone`) and display timezone (`America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles`, `America/Phoenix`, `UTC`).
   - Renders a 14-day horizontal calendar strip clearly indicating open slot counts, studio closures, and blackout dates.
   - Creates a temporary 10-minute soft slot hold via `POST /api/consultations/holds` upon advancing to Step 3 to reduce checkout contention.
3. **Step 03 — Client Details & Consent**
   - Validates full name, email address, phone number, preferred contact method (`email`, `phone`, `sms`), design/palette notes, and mandatory privacy consent acceptance.
4. **Step 04 — Review & Confirm**
   - Presents an editable side-by-side summary of Event Discovery, Consultation Appointment (in both client timezone and Columbia, SC Eastern Time), and Client Contact Details.
   - Submits atomically to `POST /api/consultations` with an `Idempotency-Key` header and disabled-in-flight protection to prevent duplicate bookings.
   - Handles `409 SLOT_CONFLICT` gracefully by refreshing live availability and returning the user directly to Step 2 with clear guidance.
   - Renders the Confirmation Screen **only after backend persistence succeeds**, displaying the reference code, one-time scoped Verification Access Token (with copy control), scheduled times, and honest email notification outbox status.

## Self-Service Manage / Track Mode
- **Consultation Appointment (Token):** Calls `GET /api/consultations/status?referenceCode=...&accessToken=...` to display status, planner assignment, and inline **Reschedule** (`POST /api/consultations/:id/reschedule`) and **Cancel** (`POST /api/consultations/:id/cancel`) workflows.
- **Event Booking Lookup (Email):** Retains backward-compatible lookup via `GET /api/bookings/track` for legacy event bookings.
