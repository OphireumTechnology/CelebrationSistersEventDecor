# Payment Integration Architecture & Implementation Plan
## Celebration Sisters Event Decor — Block 12.10 Readiness Blueprint

**Status:** Design & Architecture Complete — **Live Payment Processing: `NOT IMPLEMENTED` (Awaiting Explicit Owner & Provider Approval)**  
**Current Production Safeguard:** `POST /api/bookings/:id/payments/:paymentId/pay` blocks client self-marking in `NODE_ENV=production` with HTTP `501 PAYMENT_PROVIDER_NOT_INTEGRATED` (`liveProcessorVerified: false`). Manual/staging ledger updates are explicitly labeled `paymentProcessingMode: "manual_staging_ledger"`.

---

## 1. Existing Data Models & Constraints

The relational schema in `db/migrations/001_initial_schema.sql` and RLS policies in `002_rls_policies.sql` + `005_rls_event_planner_and_invoices.sql` already provision payment-ready structures:

- **`invoices` table:** `id (UUID)`, `booking_id (FK -> bookings)`, `invoice_number (UNIQUE)`, `currency ('USD')`, `total_cents (>= 0)`, `due_date`, `status ('draft' | 'open' | 'partially_paid' | 'paid' | 'void')`.
- **`payments` table:** `id (UUID)`, `booking_id (FK -> bookings)`, `invoice_id (FK -> invoices)`, `milestone_label`, `amount_cents (> 0)`, `currency ('USD')`, `provider`, `idempotency_key (UNIQUE)`, `provider_event_id (UNIQUE)`, `status ('Pending' | 'Paid' | 'Overdue' | 'Refunded')`, `due_date`, `paid_at`.
- **RLS Isolation:** Clients can only `SELECT` invoices/payments tied to their own bookings; Vendors have **zero** access to `quotations`, `quote_items`, `contracts`, `invoices`, or `payments`; only backend service-role/admin/staff workflows mutate payment records.

---

## 2. Luxury Event Provider Requirements (Columbia, SC)

Celebration Sisters Event Decor invoices high-value luxury weddings, corporate galas, and full-production events (commonly $5,000–$75,000+ split across Deposit, Design Milestone, and Final Balance installments):

1. **Multi-milestone installment billing** (e.g., 35% Retainer Deposit, 35% Production Milestone, 30% Final Balance 14 days pre-event).
2. **Low-fee US ACH Bank Transfers (`us_bank_account`)** alongside Credit/Debit Cards so high-ticket deposits avoid prohibitive 2.9% card surcharges (ACH capped near $5 per transaction on Stripe).
3. **PCI-DSS SAQ-A compliance:** Card/bank credentials must NEVER touch Celebration Sisters Express servers or browser JavaScript memory; hosted checkout or tokenized Elements only.
4. **Cryptographically signed asynchronous webhooks** with replay protection and idempotent reconciliation.
5. **Structured refunds, partial refunds, and chargeback/dispute evidence tracking.**

---

## 3. Payment Provider Comparison Matrix

| Criterion | **Stripe (Recommended)** | PayPal Commerce / Braintree | Square Online Payments |
| --- | --- | --- | --- |
| **Card Pricing (US)** | 2.9% + $0.30 | 2.99%–3.49% + $0.49 | 2.9% + $0.30 |
| **US ACH Direct Debit** | 0.8% capped at **$5.00** (ideal for $15k+ event retainers) | Limited / higher friction | 1.0% (no $5 cap on standard online) |
| **PCI Scope** | SAQ-A via Stripe Checkout / Elements | SAQ-A via PayPal Smart Buttons | SAQ-A via Web Payments SDK |
| **Webhook Security** | `Stripe-Signature` HMAC-SHA256 + timestamp tolerance + event IDs | Cert-based signature verification (heavier runtime overhead) | HMAC-SHA256 webhook signature |
| **Idempotency Support** | First-class `Idempotency-Key` header on all write APIs | Request-ID header | `idempotency_key` in body |
| **Dispute & Refund API** | Full lifecycle webhooks (`charge.refunded`, `charge.dispute.*`) | Supported | Supported |
| **Node/TypeScript SDK** | Official strongly-typed `stripe` SDK | Official SDK | Official SDK |

**Architectural Recommendation:** Adopt **Stripe Checkout Sessions + PaymentIntents (Cards + US ACH Direct Debit)** as the primary processor, preserving optional offline check/wire manual ledger reconciliation strictly for MFA-authenticated Executive Administrators (`admin` role only).

---

## 4. Checkout & PaymentIntent Architecture

```text
[Client Portal]
   | 1. POST /api/bookings/:id/payments/:paymentId/checkout-session
   |    (Authenticated Client; server verifies booking ownership & milestone is Pending)
   v
[Express Backend (Railway)]
   | 2. Computes authoritative amount_cents from DB (NEVER trusts client-supplied amount)
   | 3. Generates deterministic Idempotency-Key: `cs-pay:${bookingId}:${paymentId}:v${attempt}`
   | 4. Calls Stripe API: checkout.sessions.create({
   |      mode: 'payment',
   |      payment_method_types: ['card', 'us_bank_account'],
   |      client_reference_id: booking.referenceCode,
   |      metadata: { bookingId, paymentId, invoiceId },
   |      success_url, cancel_url
   |    })
   v
[Client Browser] -> Redirects to Stripe-hosted Checkout URL (PCI SAQ-A)
   | 5. Client completes payment on Stripe
   v
[Stripe Webhook Engine]
   | 6. POST /api/webhooks/stripe  (Raw UTF-8 body + Stripe-Signature header)
   v
[Express Backend]
   | 7. Verifies HMAC-SHA256 signature & timestamp tolerance (<= 300s)
   | 8. Inside PostgreSQL Transaction (BEGIN ... SELECT FOR UPDATE ... COMMIT):
   |      - Checks UNIQUE(provider_event_id) for idempotency
   |      - Validates paid amount_cents === milestone.amount_cents && currency === 'USD'
   |      - Marks milestone Paid with provider reference & paid_at
   |      - If contract dual-signed & deposit settled -> transitions booking to Confirmed
   |      - Inserts immutable audit_logs entry & queues Resend payment receipt
```

---

## 5. Webhook Signature Verification & Replay Defense

1. Mount `express.raw({ type: 'application/json' })` specifically on `/api/webhooks/stripe` **before** global `express.json()`.
2. Verify signature using `stripe.webhooks.constructEvent(rawBody, sigHeader, process.env.STRIPE_WEBHOOK_SECRET)` with the default 300-second replay window.
3. Reject missing/invalid signatures with HTTP `400` and log a `PAYMENT_WEBHOOK_REJECTED` security event without leaking secret material.
4. Return HTTP `200` immediately after durable commit; return HTTP `500` on transient DB failures so Stripe's exponential retry queue redelivers safely.

---

## 6. Idempotent Reconciliation & Concurrency Controls

- **Database Uniqueness:** Enforce `UNIQUE(idempotency_key)` and `UNIQUE(provider_event_id)` on `payments` (already defined in `001_initial_schema.sql`).
- **Row-Level Locking:** Lock the booking/payment row via `SELECT ... FOR UPDATE` before evaluating status transitions so simultaneous webhook retries or concurrent ACH settlement callbacks never double-credit or emit duplicate receipts.
- **Amount & Currency Verification:** Reject and alert (`PAYMENT_AMOUNT_MISMATCH`) if `event.data.object.amount_received !== milestone.amount_cents` or `currency.toUpperCase() !== 'USD'`.

---

## 7. Refunds, Partial Refunds, Disputes & Cancellations

- **Executive Admin Only:** Only MFA-verified `admin` users may initiate refunds via `POST /api/admin/bookings/:id/payments/:paymentId/refund` (with mandatory `reason` and optional `amountCents <= paidAmountCents`).
- **Webhook-Driven Finality:** Issuing a refund marks the milestone `Refund Pending`; only the signed `charge.refunded` webhook transitions it to `Refunded` (or records partial refund ledger entry).
- **Disputes/Chargebacks:** Listen for `charge.dispute.created` -> immediately freeze automated booking completion, log `PAYMENT_DISPUTE_OPENED` in `audit_logs`, and dispatch an urgent Resend alert to `STAFF_NOTIFICATION_EMAIL`.
- **Booking Cancellation:** Cancelling a booking voids unpaid `Pending` milestones and expires open Checkout Sessions (`checkout.sessions.expire`) so a client cannot pay a cancelled event.

---

## 8. Security, RBAC & Audit Requirements

- **Strict Client Prohibition:** Clients can **never** directly call an endpoint to mark an invoice or milestone `Paid`. Only cryptographically verified provider webhooks (or MFA-verified `admin` manual check/wire recording with required wire/check reference + audit justification) may transition payment state to `Paid`.
- **Immutable Audit Trail:** Every checkout session creation, webhook verification, settlement, refund, manual offline wire entry, and failure appends an entry to `audit_logs` containing `actor`, `bookingReference`, `amountCents`, `providerEventId`, and `timestamp`.
- **Required Future Environment Variables (Names Only — Never Commit Values):**
  - `PAYMENT_PROVIDER` (`none` | `stripe`)
  - `STRIPE_SECRET_KEY` (server-side only; `sk_test_...` in staging, `sk_live_...` only after approval)
  - `STRIPE_WEBHOOK_SECRET` (`whsec_...`)
  - `PAYMENT_LIVE_ENABLED` (`false` by default; kill-switch mirroring `EMAIL_LIVE_DELIVERY_ENABLED`)

---

## 9. Phased Implementation Plan (Post-Approval)

1. **Phase A (Approval Gate):** Owner approves Stripe as provider, completes Stripe US business verification, and provisions Staging Test-Mode keys (`sk_test_*`, `whsec_*`).
2. **Phase B (Additive Migration `006`):** Expand `payments.provider` check constraint to include `'stripe'` and add `refunded_cents`, `checkout_session_id`, and `payment_dispute_status`.
3. **Phase C (Backend & Webhook Implementation):** Add `server/payments.ts`, `POST /api/bookings/:id/payments/:paymentId/checkout-session`, `POST /api/webhooks/stripe`, and `POST /api/admin/bookings/:id/payments/:paymentId/refund`.
4. **Phase D (Staging Sandbox Testing):** Execute Stripe test cards (success, 3DS authentication, decline, duplicate webhook replay, partial refund, dispute simulation) and verify end-to-end DB + Resend receipt reconciliation before requesting production go-live approval.
