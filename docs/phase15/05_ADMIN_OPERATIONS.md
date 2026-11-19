# Phase 15.6 — Admin Consultation Command Center Operations Report

**Project:** Celebration Sisters Event Decor  
**Primary Component:** `src/components/AdminConsultationCommandCenter.tsx`  
**Backend API Surface:** `/api/consultations`, `/api/consultations/:id/{confirm,assign,reschedule,cancel,stage,complete,proposal-handoff,decision}`, `/api/staff/availability/:plannerId`, `/api/admin/outbox/:jobId/retry`, `/api/admin/outbox/process`, `/api/admin/consultations/reminders/dispatch`

---

## 1. Completed Operational Capabilities

| Operational View | Capabilities Implemented | Authorization Enforcement |
| :--- | :--- | :--- |
| **KPI Overview Strip** | Total Requests, Pending Review, Confirmed, Upcoming, Completed, Cancelled, Overdue Follow-Up Tasks (highlighted cleanly in amber when > 0). | Authenticated Staff / Event Planner / Admin MFA |
| **Schedule & Calendar Queue** | Day / Week / Month schedule windows, live search (client, reference, event, venue), status filter, planner filter, anchor date selector. | Staff / Planner / Admin MFA |
| **Operations Drawer (Customer Profile & Controls)** | Displays scheduled ET time, target event date, guest count, budget range, venue, **Event Theme / Palette**, preferred contact method, and full client vision/requirements notes. Actions: **Confirm Appointment**, **Admin Reschedule** (live slot picker against studio ET availability), **Cancel & Release Slot**, **Assigned Lead Planner** dropdown, **Lead Qualification / CRM Stage** selector (`PATCH /api/consultations/:id/stage`), and **Record Outcome & Auto-Follow-Up** form (`Completed` / `No-show`). | Staff / Planner / Admin MFA |
| **CRM Conversion Pipeline & Workload** | 8-stage horizontal pipeline counters, **Conversion Funnel Analytics** (`Total Pipeline Leads`, `Qualified Rate %`, `Completion Rate %`, `Proposal Sent Rate %`, `Event Booked Conversion %`), **Planner Workload Distribution** table (`Upcoming`, `Pending`, `Completed`, `Event Booked`, `Open Tasks`), Client Conversion Decision buttons, and Follow-Up Task manager. | Staff / Planner / Admin MFA |
| **Proposal Handoff Builder** | Dynamic multi-line itemized quotation builder using integer-cent arithmetic (`unitPriceCents`, `discountCents`), instant subtotal/discount/total calculation, and atomic persistence + client email queueing. | Staff / Planner / Admin MFA |
| **Staff Availability Editor** | Per-planner weekly schedule editor in `America/New_York` with day toggle, start/end times, and **editable slot duration (`15–180m`), before-buffer (`0–60m`), and after-buffer (`0–60m`)** persisted via `PUT /api/staff/availability/:plannerId`. | Staff / Planner / Admin MFA |
| **Email Outbox & Webhook Monitor** | Outbox status filter bar (`All`, `Pending/Retrying`, `ProviderAccepted`, `Delivered`, `DeadLetter`, `Skipped`), verified signed Resend webhook reconciliation counter, error tooltips, **Dispatch 48h Reminders**, **Process Outbox Now**, and per-row **Retry** button on `DeadLetter`/`Skipped` jobs (`POST /api/admin/outbox/:jobId/retry`). | Admin MFA required for Retry / Dispatch / Process |
| **Immutable Audit History** | Displays chronological audit trail of consultation creation, confirmation, planner assignment, rescheduling, cancellation, CRM stage updates, client self-service updates, token revocations, proposals, and outbox requeues. | Staff / Planner / Admin MFA |

---

## 2. Role & Security Boundary Verification

- Client and guest accounts receive `403` on all administrative endpoints.
- Admin accounts without completed TOTP MFA receive `403` on privileged operations (`requireAdminMfa` / `requireStaffOrAdminMfa`).
- Every state mutation appends an immutable audit log entry with `actorName`, `actorRole`, `action`, `targetId`, `details`, and UTC timestamp.
