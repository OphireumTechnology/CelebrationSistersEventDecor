# Phase 15R — Repair 04: Booking Concurrency, Token Security & Atomic Webhook Replay Protection

**Project:** Celebration Sisters Event Decor  
**Status:**
- Consultation Access Token Security: `VERIFIED`
- Resend Webhook Replay Protection & Atomicity: `VERIFIED`
- Booking Concurrency Protection: `VERIFIED` at App/HTTP/Serialized-Transaction layer; **Real PostgreSQL concurrent exclusion-constraint load test `BLOCKED`** (no PostgreSQL engine in sandbox)

**Primary Modules:** `server/outbox.ts`, `server/app.ts`, `server/scheduling.ts`  
**Regression Test Suite:** `tests/phase15r-critical-repairs.test.ts` (`REPAIR 04A`, `REPAIR 04B`, `REPAIR 04C`)

---

## 1. Repairs Applied

1. **Single-Transaction Atomic Resend Webhook Reconciliation (`server/outbox.ts`, `server/app.ts`):**
   - Previously, `POST /api/webhooks/resend` ran two separate `withTransaction()` calls (one for `svix-id` deduplication, a second for `recordProviderDeliveryConfirmation()`), leaving a split-transaction race window under concurrent retries.
   - Introduced `reconcileResendWebhookAtomic()` in `server/outbox.ts` so `svix-id` deduplication, outbox job reconciliation, delivery ledger sync, and `notificationWebhookEvents` audit insertion execute inside **one atomic serialized transaction**.
   - Hardened `applyProviderDeliveryEventInTx()` against out-of-order and duplicate terminal events: non-terminal late events (e.g., `email.sent`) never downgrade a `Delivered` job, duplicate `Bounced` events never re-mutate `DeadLetter` jobs, and unknown `providerMessageId` values never touch unrelated outbox jobs.
2. **Orphaned Slot Hold Cleanup on Booking Confirmation (`server/app.ts`):**
   - Updated `POST /api/consultations` so confirming a slot purges not only the caller's hold, but also any expired holds and any overlapping holds for the booked planner/window inside the same transaction — ensuring zero orphaned holds remain after concurrent races.
3. **True 256-Bit Token Entropy (`server/scheduling.ts`):**
   - Upgraded `generateConsultationAccessToken()` from `crypto.randomBytes(24)` (192-bit) to `crypto.randomBytes(32)` (256-bit, `csa_` + 43 base64url chars) with SHA-256 hash-only persistence and `crypto.timingSafeEqual` verification.

---

## 2. Verified Security & Concurrency Evidence

Executed via `npm test` (`tests/phase15r-critical-repairs.test.ts`):

### A. Concurrent Booking Race (`REPAIR 04A`)
- Caller A acquired a 10-minute hold on contested slot `S`; 3 concurrent `POST /api/consultations` requests (Callers A, B, C) fired via `Promise.all`.
- **Verified Outcomes:**
  - HTTP responses: strictly `[201, 409, 409]` (1 winner, 2 conflict rejections).
  - Database consultations at slot `S`: strictly `1`.
  - Remaining holds at slot `S`: `0` (zero orphaned holds).
  - Outbox notification jobs: enqueued **only** for the winning booking; `0` jobs for the two rejected `409` callers.

### B. Consultation Access Token Security (`REPAIR 04B`)
| Security Control | Verified Behavior | Result |
| :--- | :--- | :--- |
| Token generation entropy | 256-bit (`32` random bytes, `csa_` + 43 chars), SHA-256 64-char hex digest | PASS |
| Hash-only storage | Persisted JSON DB file inspected: raw Token A & Token B absent | PASS |
| Cross-client isolation | Token A requesting Booking B returns `403 INVALID_CONSULTATION_TOKEN`, zero data returned | PASS |
| Explicit revocation | Admin MFA revocation -> Token A returns `403 TOKEN_REVOKED` | PASS |
| Revocation scoping | Revoking Token A leaves Token B (`200`) and Admin session (`200 /api/auth/session`) unaffected | PASS |
| Token expiration | Expired `accessTokenExpiresAt` -> returns `403 TOKEN_EXPIRED` | PASS |
| Zero log disclosure | Captured all `console.log`/`warn`/`error` output: raw Token A & Token B never logged | PASS |
| Restart persistence | Closed server, booted fresh server on same DB -> Token A still `403 TOKEN_REVOKED` | PASS |
| Rate limiting | Rapid lookups against `GET /api/consultations/status` trigger HTTP `429` | PASS |

### C. Resend Webhook Replay & Out-of-Order Matrix (`REPAIR 04C`)
| Webhook Scenario | Verified Behavior | Result |
| :--- | :--- | :--- |
| Expired `svix-timestamp` (> 300s old) | Rejected with HTTP `401` | PASS |
| Unknown `providerMessageId` | HTTP `200`, `reconciled: false`, zero mutation to unrelated outbox jobs | PASS |
| 5x simultaneous identical signed `svix-id` replay (`Promise.all`) | Strictly `1` `{ deduplicated: false, reconciled: true }` and `4` `{ deduplicated: true, reconciled: false }`; strictly `1` audit row | PASS |
| Out-of-order `email.sent` after `Delivered` | HTTP `200`, `reconciled: false`; outbox job stays `Delivered` (never downgraded) | PASS |
| Unrelated job isolation | Job Beta remains untouched (`ProviderAccepted`) throughout Alpha's webhooks | PASS |

---

## 3. Remaining External PostgreSQL Concurrency Step (`BLOCKED` in Sandbox)

To complete live PostgreSQL exclusion-constraint (`excl_consultations_planner_buffered_overlap`) verification against a real PostgreSQL engine, run `tests/phase15r-critical-repairs.test.ts` and a 10-way `Promise.all` concurrent `createConsultationAtomic()` script against staging/Docker PostgreSQL (`PERSISTENCE_ADAPTER=postgres`, `DATABASE_URL=...`) to confirm SQLSTATE `23P01` / `SLOT_CONFLICT` maps cleanly to HTTP `409` under multi-connection MVCC concurrency.
