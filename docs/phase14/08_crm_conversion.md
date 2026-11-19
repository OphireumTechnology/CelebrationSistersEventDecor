# Phase 14 — Block 14.8: Consultation-to-Client CRM Conversion Pipeline

## 8-Stage Lifecycle Architecture
Every consultation booking automatically creates a linked `BookingRecord` and enters the 8-stage CRM conversion pipeline (`CRM_PIPELINE_STAGES` in `src/types/domain.ts`):

1. `New Inquiry` — Initial pre-scheduling lead intake
2. `Qualified Lead` — Event scope, date, guest count, and budget validated
3. `Consultation Scheduled` — Atomic slot reserved (`POST /api/consultations`)
4. `Consultation Completed` — Planner captures outcome summary (`POST /api/consultations/:id/complete`)
5. `Proposal Prepared` — Draft itemized quotation assembled (`markAsSent: false`)
6. `Proposal Sent` — Exact cent-verified quotation issued to client portal (`POST /api/consultations/:id/proposal-handoff`, `markAsSent: true`)
7. `Client Decision` — Client requests revision or declines (`POST /api/consultations/:id/decision`)
8. `Event Booked` — Client approves proposal; linked booking advances to `Confirmed`

## Exact Integer-Cent Financial Arithmetic
To eliminate IEEE-754 floating-point drift (such as `$19.99 * 3 + $0.03 - $10.00`), `POST /api/consultations/:id/proposal-handoff` computes all line-item subtotals, courtesy discounts, and final totals in **integer cents**:
- Accepts `unitPriceCents` (integer) or converts `unitPrice` via `Math.round(unitPrice * 100)`.
- Enforces `discountCents <= subtotalCents`.
- Returns both `amountsCents: { subtotalCents, discountCents, totalCents }` and exact USD amounts on the appended `QuotationVersion`.
- Verified by automated unit test in `tests/phase14-consultation-system.test.ts`.

## CRM Follow-Up Task Engine
- Follow-up tasks (`CrmFollowUpTask` & `crm_follow_up_tasks` SQL table) can be auto-generated upon completing a consultation or added manually via `POST /api/crm/tasks`.
- Overdue open tasks (`status === 'Open' && dueAt < now`) are surfaced in KPI metrics (`overdueFollowUps`) and highlighted in the Command Center.
- Conversion funnel metrics (`totalLeads`, `consultationCompletionRatePct`, `bookingConversionRatePct`) are served from `GET /api/crm/pipeline`.
