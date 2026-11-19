# Phase 14 — Block 14.5: Backend Consultation & CRM API Contracts

All consultation endpoints are mounted on the existing Express application (`server/app.ts`) alongside all preserved Phase 1–13 routes.

## Public & Scoped-Token Endpoints

| Method | Path | Rate Limit | Auth / Validation | Behavior |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/consultations/availability` | 90/min | Public; validates IANA `timezone`, `method`, `startDate`, `days` (1–31) | Returns real-time server-computed availability slots, blackout flags, and planner options |
| `POST` | `/api/consultations/holds` | 25/min | Public; validates `plannerId`, `startUtc`, `method`, `holderKey` | Reserves a 10-minute soft slot lock; returns `201` or `409 SLOT_CONFLICT` |
| `POST` | `/api/consultations` | 20/min | Public or Client session; Zod validation + `privacyConsentAccepted: true` + `Idempotency-Key` | Atomically validates slot, creates linked `BookingRecord` + `ConsultationAppointment`, enqueues customer & staff outbox alerts, returns `201` with one-time `accessToken` (or `409` with fresh `suggestedSlots`) |
| `GET` | `/api/consultations/status` | 30/min | Requires BOTH `referenceCode` AND `accessToken` (query or `X-Consultation-Token`) | Constant-time token verification; returns `400` if token missing, `403` if invalid; returns sanitized appointment details & reschedule/cancel flags |
| `POST` | `/api/consultations/:id/reschedule` | 25/min | Scoped `accessToken` OR owning client session OR Staff/Admin (MFA) | Enforces state machine, validates new slot atomically, releases prior slot, enqueues customer & staff alerts |
| `POST` | `/api/consultations/:id/cancel` | 25/min | Scoped `accessToken` OR owning client session OR Staff/Admin (MFA) | Enforces state machine, marks `Cancelled`, releases slot immediately, enqueues customer & staff alerts |

## Authenticated Operations, CRM & Admin Endpoints

| Method | Path | Required Role / Clearance | Behavior |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/consultations` | Active account (`vendor` -> `403`, `admin` requires MFA) | `client` receives only own consultations; `event_planner`/`staff`/`admin` receive filtered list, KPI metrics, planners, staff rules, follow-up tasks, outbox & audit logs |
| `PATCH` | `/api/consultations/:id/confirm` | `event_planner`, `staff`, or `admin` (MFA) | Transitions consultation to `Confirmed`, queues `consultation_confirmed` |
| `PATCH` | `/api/consultations/:id/assign` | `event_planner`, `staff`, or `admin` (MFA) | Checks target planner slot conflict (`409`), updates planner + linked booking, queues `staff_appointment_assigned` |
| `POST` | `/api/consultations/:id/complete` | `event_planner`, `staff`, or `admin` (MFA) | Marks `Completed` or `No-show`, captures `outcomeSummary`, advances CRM stage, optionally creates `CrmFollowUpTask`, queues follow-up alerts |
| `POST` | `/api/consultations/:id/proposal-handoff` | `event_planner`, `staff`, or `admin` (MFA) | Computes exact integer-cent itemized quotation, appends to linked `BookingRecord.quotations`, advances CRM to `Proposal Sent`, queues `proposal_available` + staff alert |
| `POST` | `/api/consultations/:id/decision` | `event_planner`, `staff`, or `admin` (MFA) | Records `Approved` / `Revision Requested` / `Declined`, transitions CRM to `Event Booked` or `Client Decision` |
| `GET` | `/api/staff/availability` | `event_planner`, `staff`, or `admin` (MFA) | Lists weekly staff consultation rules and studio blackout dates |
| `PUT` | `/api/staff/availability/:plannerId` | `event_planner`, `staff`, or `admin` (MFA) | Replaces active weekly rules for planner with HH:MM ordering validation |
| `GET` | `/api/crm/pipeline` | `event_planner`, `staff`, or `admin` (MFA) | Returns 8-stage funnel counts, conversion percentages, and follow-up tasks |
| `POST` | `/api/crm/tasks` | `event_planner`, `staff`, or `admin` (MFA) | Creates a new CRM follow-up task linked to a consultation |
| `PATCH` | `/api/crm/tasks/:taskId` | `event_planner`, `staff`, or `admin` (MFA) | Updates task status (`Open`, `Completed`, `Dismissed`) and notes |
| `POST` | `/api/admin/consultations/reminders/dispatch` | `admin` (MFA) | Idempotently evaluates upcoming active consultations within `horizonHours` (default 48h) and enqueues customer & staff reminder jobs |

## Error Contract Guarantees
- All validation errors return `400` with structured messages (no stack traces or raw SQL errors).
- All double-booking or blackout collisions return `409` with machine-readable `code` and refreshed `suggestedSlots` where applicable.
- All unauthenticated requests return `401`; unauthorized roles or missing Admin MFA return `403`.
