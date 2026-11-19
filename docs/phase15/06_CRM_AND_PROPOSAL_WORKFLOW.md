# Phase 15.7 — Consultation-to-Revenue CRM & Proposal Workflow Report

**Project:** Celebration Sisters Event Decor  
**Pipeline Definition:** `CRM_PIPELINE_STAGES` in `src/types/domain.ts`  
**Primary Modules:** `server/app.ts`, `src/components/AdminConsultationCommandCenter.tsx`, `src/components/ConsultationModal.tsx`

---

## 1. End-to-End 8-Stage Revenue Pipeline

| Stage # | CRM Pipeline Stage | Trigger / Transition Mechanism | Audit Action |
| :--- | :--- | :--- | :--- |
| `01` | **New Inquiry** | Initial lead creation or draft booking | `CONSULTATION_CREATED` |
| `02` | **Qualified Lead** | Planner/Admin qualification via `PATCH /api/consultations/:id/stage` | `CRM_STAGE_UPDATED` |
| `03` | **Consultation Scheduled** | Automated upon confirmed slot reservation via `POST /api/consultations` | `CONSULTATION_CREATED` |
| `04` | **Consultation Completed** | Planner records session outcome + next-step task via `POST /api/consultations/:id/complete` | `CONSULTATION_COMPLETED` |
| `05` | **Proposal Prepared** | Proposal drafted or updated prior to sending (`markAsSent: false`) | `PROPOSAL_HANDOFF_CREATED` |
| `06` | **Proposal Sent** | Itemized cent-verified proposal issued via `POST /api/consultations/:id/proposal-handoff` (`markAsSent: true`), queuing client proposal email | `PROPOSAL_HANDOFF_CREATED` |
| `07` | **Client Decision** | Client requests revision or evaluates proposal via `POST /api/consultations/:id/decision` (`Revision Requested` / `Declined`) | `CONSULTATION_DECISION_RECORDED` |
| `08` | **Event Booked** | Client approves proposal via `POST /api/consultations/:id/decision` (`Approved`), advancing linked event booking to `Deposit Pending` / `Booked` | `CONSULTATION_DECISION_RECORDED` |

---

## 2. Financial & Data Integrity Guarantees

- **Integer-Cent Proposal Calculations:** All proposal line items (`unitPriceCents`), courtesy discounts (`discountCents`), subtotals, and totals are computed in integer cents on the server before storing versioned quotations on the linked client booking, preventing floating-point rounding drift.
- **No Unverified Payment Fabrication:** Converting a consultation to `Event Booked` tracks genuine contractual/deposit readiness without fabricating payment receipts or bypassing payment verification.
- **Linked Booking Synchronization:** Client self-service updates (`PATCH /api/consultations/:id/client-details`) and proposal handoffs automatically synchronize with the linked `EventBooking` record inside the same atomic transaction (`withTransaction`).
- **Conversion & Workload Metrics:** `GET /api/consultations` computes live `conversionAnalytics` (`totalLeads`, `qualifiedRatePct`, `completionRatePct`, `proposalRatePct`, `bookingConversionRatePct`) and per-planner `plannerWorkload` metrics rendered in the Admin CRM dashboard.
