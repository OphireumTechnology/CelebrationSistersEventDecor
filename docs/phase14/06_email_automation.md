# Phase 14 — Block 14.6: Resend Transactional Email Automation & Outbox Reliability

## Architecture (`server/notifications.ts` & `server/outbox.ts`)
All 14 consultation-lifecycle notifications (7 customer-facing + 7 internal studio operational alerts) plus existing booking/security alerts (16 total categories) are enqueued atomically inside the same transaction as the state change via `enqueueOutboxNotification()`, then dispatched asynchronously with bounded exponential backoff retries by `NotificationOutboxWorker`.

## Complete 16-Category Notification Coverage

### Customer Notifications (7 Consultation Templates)
1. `consultation_confirmation` — Booking received summary with reference code, target event date, consultation window in client timezone, format, and assigned lead planner.
2. `consultation_confirmed` — Planner confirmation of private consultation slot.
3. `consultation_rescheduled` — Previous slot (strikethrough) vs. newly confirmed slot, method, and planner.
4. `consultation_cancelled` — Cancellation confirmation confirming the released slot and reason.
5. `consultation_reminder` — Upcoming 24–48h courtesy reminder (`POST /api/admin/consultations/reminders/dispatch`).
6. `consultation_followup` — Post-consultation thank-you and recorded outcome summary.
7. `proposal_available` — Itemized proposal version and exact formatted USD total ready for review.

### Internal Operations & Staff Notifications (7 Consultation Templates)
8. `staff_new_booking_alert` — Immediate alert with client details, event date, venue, budget, and scheduled slot (Studio ET).
9. `staff_appointment_assigned` — Alert sent to target planner upon consultation reassignment.
10. `staff_upcoming_consultation` — Upcoming consultation reminder for studio operations.
11. `staff_reschedule_alert` — Alert detailing previous vs. new window and reason.
12. `staff_cancellation_alert` — Alert confirming released slot and cancellation reason.
13. `staff_followup_required` — Post-consultation summary and auto-created follow-up task alert.
14. `staff_proposal_awaiting_action` — Alert when proposal is delivered and awaiting client decision.

### Preserved Existing Categories
15. `booking_status_update`
16. `admin_security_alert`

## Safety, Idempotency & Honest Delivery Semantics
- **XSS Sanitization:** Every dynamic variable rendered into HTML templates passes through `escapeHtml()`.
- **Idempotency Suppression:** Every outbox job carries a deterministic `idempotencyKey` (e.g., `consultation:${id}:confirmation`, `consultation:${id}:rescheduled:${count}`, `consultation:${id}:proposal:v${version}`). Duplicate sends are suppressed automatically.
- **Retry & Dead-Letter Handling:** Transient provider errors (`5xx`, network failures) schedule bounded exponential backoff (`Retrying`) up to `maxAttempts`, moving permanently failing jobs to `DeadLetter` without crashing API requests.
- **Honest Provider States:**
  - When `RESEND_API_KEY` or `EMAIL_FROM` is absent: recorded as `Skipped (Unconfigured)`.
  - When `EMAIL_LIVE_DELIVERY_ENABLED !== 'true'`: safely paused (`Skipped (Unauthorized)`).
  - When Resend returns HTTP `2xx`: recorded honestly as `ProviderAccepted` (never fabricated as inbox `Delivered` without verified Resend webhook confirmation).
- **Live Sending Prohibition:** No live customer emails were dispatched during Phase 14 development or automated testing.
