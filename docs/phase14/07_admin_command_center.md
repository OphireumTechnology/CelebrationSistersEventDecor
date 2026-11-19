# Phase 14 — Block 14.7: Administrative Consultation Command Center

## Overview (`src/components/AdminConsultationCommandCenter.tsx`)
Integrated directly into `src/components/PortalsWorkspace.tsx` for both **Executive Admin** (requires active MFA clearance) and **Staff / Event Planner** roles, without disrupting existing Client, Vendor, Inventory, AI Concierge, Automation, or Audit views.

## Seven Operational Modules Implemented
1. **Consultation Overview KPIs**
   - Live counters for `Total Requests`, `Pending Review`, `Confirmed`, `Upcoming`, `Completed`, `Cancelled`, and `Overdue Tasks` (highlighted in amber when `> 0`), all formatted with `tabular-nums`.
2. **Consultation Calendar & Queue (Day / Week / Month)**
   - Mode switcher (`Day`, `Week`, `Month`), anchor date selector, live search across client name/reference/event/venue, status filter, and planner filter.
   - Right-hand Operations Drawer providing single-click **Confirm Appointment**, **Cancel & Release Slot**, **Lead Planner Reassignment** (conflict-checked server-side), and **Record Outcome & Next Step** (`Completed` / `No-show` + auto follow-up task).
3. **CRM Conversion Pipeline & Client Management**
   - 8-stage horizontal funnel displaying live counts from `01 New Inquiry` through `08 Event Booked`.
   - Client decision triggers (`Mark Event Booked`, `Revision`) and Follow-Up Task manager with overdue indicators and one-click completion.
4. **Proposal Handoff**
   - Multi-line itemized quotation creator with live client-side preview and authoritative server-side integer-cent arithmetic (`POST /api/consultations/:id/proposal-handoff`).
5. **Staff Weekly Availability Management**
   - Planner selector and Sunday–Saturday schedule editor (active toggle, start/end times in `America/New_York`, slot duration & buffers) backed by `PUT /api/staff/availability/:plannerId`.
6. **Transactional Email Outbox Monitor**
   - Tabular visibility into queued, accepted, retrying, skipped, and dead-letter jobs.
   - Executive Admin MFA-protected controls for **Process Outbox Now** (`POST /api/admin/outbox/process`) and **Dispatch 48h Reminders** (`POST /api/admin/consultations/reminders/dispatch`).
7. **Consultation & CRM Audit History**
   - Immutable chronological log filtered to `Consultation`, `CrmTask`, and `StaffAvailability` events with actor identity and role.
