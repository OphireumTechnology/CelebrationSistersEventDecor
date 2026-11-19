# Phase 15R — Repair 02: Resend Configuration & Documentation Consistency

**Project:** Celebration Sisters Event Decor  
**Status:** `VERIFIED` (Code, Fail-Closed Tests, Zero-Frontend-Leak Scan & Documentation Alignment)  
**Primary Modules:** `server/notifications.ts`, `server/outbox.ts`, `server/app.ts`, `.env.example`, `docs/phase15/04_EMAIL_DELIVERY_READINESS.md`, `docs/phase15/11_PRODUCTION_READINESS.md`  
**Regression Test Suite:** `tests/phase15r-critical-repairs.test.ts` (`REPAIR 02`)

---

## 1. Canonical Environment Variable Contract

All API routes, background outbox workers, health diagnostics, `.env.example`, and documentation now share one canonical environment contract resolved exclusively through `getEmailRuntimeConfig(env)` in `server/notifications.ts`:

| Canonical Variable | Scope | Fail-Closed Behavior |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | Server-only secret | If missing/empty -> outbox records `Skipped (Unconfigured)` and never claims delivery. |
| `EMAIL_FROM` | Server-only sender identity | If missing/empty -> outbox records `Skipped (Unconfigured)` and never claims delivery. |
| `EMAIL_LIVE_DELIVERY_ENABLED` | Server-only boolean kill-switch (`'true'`) | Defaults to `false`; if not `'true'` -> outbox records `Skipped (Unauthorized)` and executes zero outbound HTTP calls. |
| `RESEND_WEBHOOK_SECRET` | Server-only Svix signing secret | If missing/empty -> `POST /api/webhooks/resend` fails closed with HTTP `503 WEBHOOK_NOT_CONFIGURED`. |
| `STAFF_NOTIFICATION_EMAIL` | Server-only studio ops address | Controls internal Columbia, SC studio alert recipient; status exposed as boolean `staffRecipientConfigured` only. |

---

## 2. Inconsistencies Repaired

1. **Centralized Runtime Resolution:** Added `getEmailRuntimeConfig()` in `server/notifications.ts` and routed `getEmailProviderStatus()`, `dispatchEmailNotification()`, `NotificationOutboxWorker.processOnce()` (`server/outbox.ts`), and `POST /api/webhooks/resend` (`server/app.ts`) through it.
2. **Documentation Drift Fixed:**
   - Replaced stale `ENABLE_LIVE_EMAIL_DELIVERY` and `EMAIL_FROM_ADDRESS` references in `docs/phase15/04_EMAIL_DELIVERY_READINESS.md` with `EMAIL_LIVE_DELIVERY_ENABLED`, `EMAIL_FROM`, and `STAFF_NOTIFICATION_EMAIL`.
   - Added `STAFF_NOTIFICATION_EMAIL` to the production variable table in `docs/phase15/11_PRODUCTION_READINESS.md`.
3. **Frontend Credential Isolation Audited:** Verified zero references to `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_LIVE_DELIVERY_ENABLED`, or `VITE_RESEND*` exist anywhere in `src/`.

---

## 3. Verified Fail-Closed & Delivery-Honesty Matrix

All 6 required configuration scenarios passed automated testing in `tests/phase15r-critical-repairs.test.ts`:

| Scenario | Verified Behavior | Result |
| :--- | :--- | :--- |
| 1. Missing `RESEND_API_KEY` | `configured: false`, status `Skipped (Unconfigured)`, zero false delivery | PASS |
| 2. Missing `EMAIL_FROM` | `configured: false`, status `Skipped (Unconfigured)`, zero false delivery | PASS |
| 3. `EMAIL_LIVE_DELIVERY_ENABLED=false` | `configured: true`, `liveDeliveryEnabled: false`, status `Skipped (Unauthorized)`, zero network calls | PASS |
| 4. Missing `RESEND_WEBHOOK_SECRET` | `POST /api/webhooks/resend` returns HTTP `503 WEBHOOK_NOT_CONFIGURED` | PASS |
| 5. Invalid Svix webhook signature | `POST /api/webhooks/resend` returns HTTP `401 INVALID_WEBHOOK_SIGNATURE` | PASS |
| 6. Valid test config + mocked Resend `200` | Records `ProviderAccepted` (NOT `Delivered`); transitions to `Delivered` ONLY after verified signed `email.delivered` webhook | PASS |
| 7. Frontend `/src` static secret scan | 0 occurrences of Resend secrets or server email flags in client code | PASS |
| 8. Phase 15 doc variable scan | 0 occurrences of `EMAIL_FROM_ADDRESS` or `ENABLE_LIVE_EMAIL_DELIVERY` | PASS |

**Note:** Zero live emails were sent to external addresses during Phase 15R verification.
