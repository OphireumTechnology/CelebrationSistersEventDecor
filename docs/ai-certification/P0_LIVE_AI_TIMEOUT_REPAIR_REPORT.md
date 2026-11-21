# Celebration Sisters Event Decor — Critical P0 Live AI Concept Studio & Gemini Integration Repair Report

**Directive:** Critical Repair Directive — Live AI Concept Studio and Gemini Integration  
**Public Website:** `https://celebrationsistersdecor.com/`  
**Connected Staging Backend (verified in live bundle `assets/index-Be5xaymG.js`):** `https://celebrationsisterseventdecor-staging-staging.up.railway.app`  
**GitHub Source of Truth:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Railway Project ID:** `786a7d31-23a8-4154-8185-0d5f07914c24`  
**Railway Staging Environment ID:** `0ad6480e-6259-4a1a-81f8-a4bc89869cca`  
**Railway Service ID:** `5ba79779-aa42-4516-b294-900ef137f23c`  
**Final Classification:** **`CODE_REPAIRED`** *(Local source, TypeScript, lint, automated tests, production build, and isolated Desktop/Mobile Playwright verification PASS; GitHub push, Railway staging redeployment, and live external Gemini API execution are **`BLOCKED`** inside this sandbox due to absent `GITHUB_TOKEN`, `RAILWAY_TOKEN`, `GEMINI_API_KEY`, and `STAGING_DATABASE_URL` credentials.)*

---

## A. Executive Summary

Direct live probing of `https://celebrationsistersdecor.com/` and `https://celebrationsisterseventdecor-staging-staging.up.railway.app` reproduced the exact live `AI_TIMEOUT` defect (`fc3a34e4-df7a-4782-8239-0274c9ff9e10`) on **both** AI endpoints and pinpointed the complete root-cause chain:

1. **Primary Live Failure (Deployment Drift to Pre-Repair Commit `30201cf7`):** While `https://celebrationsistersdecor.com/` was deployed from `main` (`4b8344e`), the Railway staging service (`5ba79779-aa42-4516-b294-900ef137f23c`) is **still running stale commit `30201cf7` (`fix/gemini-timeout-model-20261121`)** with `GEMINI_MODEL=gemini-3.8-flash` and `GEMINI_TIMEOUT_MS=60000`. That stale build omits `thinkingConfig` (so `gemini-3.8-flash` runs at its default `medium` thinking level), enforces restrictive `maxOutputTokens` (`1024`/`2048`), lacks `AbortSignal` cancellation, lacks transient retry handling, and lacks structured diagnostics. Both live `POST /api/ai/concierge` (`60.502s`, `HTTP 504`, `X-Request-Id: 4f11fcf4-1211-4717-ba86-3cbfc7f299ce`) and live `POST /api/ai/concept-studio` (`60.488s`, `HTTP 504`, `X-Request-Id: 2963760b-77aa-4e33-b78f-26b97a6126db`) timed out at exactly 60.0s with the legacy `30201cf7` error body.
2. **Codebase Repairs Applied Directly on Latest GitHub Baseline (`repair/reconcile-main-20261121` @ `cfff3e6a`) — Zero Prior Repairs Overwritten:**
   - **Synchronized cleanly to `cfff3e6a`** preserving all Phase 21–46 work (`conceptLeaseRepository.ts`, `railway.json`, `phase46-postgres-certification.ts`, `phase46-http-certification.ts`, auth/MFA/RLS).
   - **Eliminated 28% Timeout Budget Waste on Attempt 1 (`server/gemini.ts`):** Removed the premature `0.72 * remainingBudgetMs` cap on Attempt 1 (which previously aborted Attempt 1 at `32.4s` of a `45s` budget even though `AI_TIMEOUT` is not retried automatically) and added `pending.catch(() => {})` inside `withTimeout()` to prevent unhandled promise rejections on abort.
   - **Model-Aware `ThinkingLevel` Tuning & Live Model Probe (`server/gemini.ts`, `server/app.ts`):** Selects `ThinkingLevel.MINIMAL` for `flash-lite` models (e.g. `gemini-3.5-flash-lite`), `ThinkingLevel.LOW` for `gemini-3.8-flash` and `gemini-4-hydrogen` (never sending unsupported `MINIMAL` to `gemini-4-hydrogen`), supports validated `GEMINI_THINKING_LEVEL` override, exposes `thinkingLevel` and `abortSignalSupported: true` on `/ready` and `/api/health` so stale deployments are immediately detectable, and adds `probeGeminiModelAvailability()`.
   - **Fixed Authenticated `AI_TIMEOUT` Retry Self-Lockout & Certified Lease TTL (`src/components/AIStudioWorkspace.tsx`, `server/repositories/conceptLeaseRepository.ts`):** Certified `CONCEPT_LEASE_TTL_MS` from provisional `600_000ms` (10 min) to `180_000ms` (`2 * MAX_GEMINI_TIMEOUT_MS`), preserved Phase 46 cross-replica lease retention on automatic timeout replay, and updated `AIStudioWorkspace.tsx` to clear `pendingIdempotencyKey` after `AI_TIMEOUT`/`REQUEST_TIMEOUT` so an explicit manual click on **Retry Proposal Generation** issues a fresh `Idempotency-Key` instead of looping on `503 AI_SERVICE_BUSY`. Added request-sequence guards (`conceptRequestSeqRef`, `conciergeRequestSeqRef`) and aligned client timeouts (`75s` Concept Studio / `70s` Concierge) above Railway's `60s` staging timeout.
   - **Completed All 15 Section 8 Concept Studio Elements (`server/gemini.ts`, `src/types/domain.ts`, `server/store.ts`, `src/components/AIStudioWorkspace.tsx`):** Added **Centerpiece Design** (`centerpieceDesign`), **Venue Styling** (`venueStyling`), and **Proposed Guest Experience** (`guestExperience`) to Gemini `responseSchema.required`, Zod validation (backward-compatible for legacy stored revisions), seeded data, and dedicated UI cards.
   - **Added Zero-Mock Live Staging AI Certification Script (`scripts/verify-live-ai-staging.mjs`):** Automates live staging verification of `/api/health` AI diagnostics, CORS, all 4 event categories (Wedding, Corporate Gala, Milestone Birthday, Baby Shower) with all 15 Section 8 fields + anti-wedding contamination checks, Concierge multi-turn, validation `400`, and unauthenticated `/api/concepts` isolation `401`.

---

## B. Exact Root-Cause Analysis of Live `AI_TIMEOUT` Failure

### Live Forensic Probe Measurements (2026-11-21 UTC)

| Stage / Probe | Target | HTTP | Elapsed | `X-Request-Id` | Observed Evidence |
|---|---|---|---|---|---|
| Public Website Bundle | `https://celebrationsistersdecor.com/` | `200` | `<1s` | n/a | Serves `assets/index-Be5xaymG.js` (`main` @ `4b8344e`) pointing `VITE_API_BASE_URL` to `https://celebrationsisterseventdecor-staging-staging.up.railway.app` |
| Staging Liveness | `GET /health` | `200` | `397ms` | `0c1ec853-9bb1-4d69-b2c2-3ac48e538874` | `{"ok":true,"status":"alive"}` |
| Staging Readiness | `GET /ready` | `200` | `362ms` | `05673315-fafb-4627-ab7c-9c27905d193b` | `productionReady: true`, DB `8ms`, 8/8 migrations, `ai: {"model":"gemini-3.8-flash","configured":true}` |
| Staging Health | `GET /api/health` | `200` | `349ms` | `3d2306c0-d5df-4324-a568-b15869d831d5` | `ai: {"model":"gemini-3.8-flash","configured":true,"timeoutMs":60000}` — **proves stale `30201cf7` build** (missing `modelSource`, `conciergeTimeoutMs`, `conceptTimeoutMs`, `maxRetries`, `thinkingLevel`, `abortSignalSupported`) |
| CORS Preflight | `OPTIONS /api/ai/concept-studio` | `204` | `389ms` | `e589488c-1682-4c85-8eed-09ba4e4e366b` | `Access-Control-Allow-Origin: https://celebrationsistersdecor.com`; `Idempotency-Key` allowed |
| Live Concierge Probe | `POST /api/ai/concierge` | **`504`** | **`60,502ms`** | `4f11fcf4-1211-4717-ba86-3cbfc7f299ce` | `{"error":"AI Event Concierge timed out. Please try again.","code":"AI_TIMEOUT"}` |
| Live Concept Studio Probe | `POST /api/ai/concept-studio` | **`504`** | **`60,488ms`** | `2963760b-77aa-4e33-b78f-26b97a6126db` | `{"error":"AI Event Concept Studio timed out. Please try again.","code":"AI_TIMEOUT"}` |
| Live Concept Validation Probe | `POST /api/ai/concept-studio` (invalid) | `400` | `367ms` | `aa9cd857-515b-4d03-bc49-d8743ec17a55` | `{"error":"Please describe your event vision and venue style."}` (fast validation before provider call) |

### Confirmed Contributing Causes
1. **Railway Staging Deployment Drift (Primary):** Railway staging is still serving `fix/gemini-timeout-model-20261121` (`30201cf7`) rather than `repair/reconcile-main-20261121` (`cfff3e6a+`). None of the `ThinkingLevel.LOW`, `abortSignal`, `maxOutputTokens` (`4096`/`8192`), structured error classification, or retry repairs have been deployed to Railway yet.
2. **Default Unconstrained Reasoning Latency + Small Output Token Ceiling in `30201cf7`:** On `30201cf7`, `gemini-3.8-flash` runs with default `medium` thinking and no `thinkingConfig` while capped to `1024`/`2048` output tokens, causing every live call on staging to hang until the 60s `withTimeout` fires. *(Operator action also recommended: verify `GEMINI_MODEL` and outbound connectivity to `generativelanguage.googleapis.com` in Railway staging logs once the repaired branch is deployed — if `gemini-3.8-flash` with `ThinkingLevel.LOW` remains slow in Railway's region, switch `GEMINI_MODEL=gemini-3.5-flash-lite` which uses `ThinkingLevel.MINIMAL` for lowest latency.)*
3. **Attempt-1 72% Timeout Cap in `cfff3e6a`:** `server/gemini.ts` previously cut Attempt 1 to `0.72 * remainingBudgetMs` even though `AI_TIMEOUT` is non-retried, wasting 28% of the configured budget. **Repaired.**
4. **Authenticated Retry Self-Lockout After `AI_TIMEOUT` in `cfff3e6a`:** `server/app.ts` retains the durable lease for timed-out `Idempotency-Key`s (Phase 46 invariant), while `AIStudioWorkspace.tsx` previously reused the same `Idempotency-Key` on manual Retry — causing authenticated retries after timeout to fail with `503 AI_SERVICE_BUSY` for the entire provisional 10-minute (`600_000ms`) TTL. **Repaired** (lease TTL certified to `180_000ms`; frontend clears `pendingIdempotencyKey` on `AI_TIMEOUT`/`REQUEST_TIMEOUT` for explicit manual Retry).
5. **Incomplete Section 8 Concept Studio Schema:** Missing `centerpieceDesign`, `venueStyling`, and `guestExperience`. **Repaired** across Gemini `responseSchema`, types, persistence, and UI.

---

## C. Repository Synchronization & Deployment Drift Report

| Target | Branch | Verified Commit SHA | Status |
|---|---|---|---|
| GitHub `main` | `main` | `4b8344e3fe...` | Verified via GitHub API; deployed to GitHub Pages (`44846831621`) |
| GitHub Reconciled Repair Baseline | `repair/reconcile-main-20261121` | `cfff3e6aabebc72948160ade62762aadcf6a3c9a` | Verified via GitHub API; CI run `44942159473` PASSED |
| GitHub PR #23 (Stale) | `fix/gemini-timeout-model-20261121` | `30201cf7169683fcfd73a184c89fbe098c110117` | **Currently deployed on live Railway staging (STALE DRIFT)** |
| Local Repaired Workspace | Rooted cleanly on `cfff3e6a` | Packaged in `release-artifacts/p0-live-ai-repair/` | **All local checks PASS; awaiting maintainer push + Railway deploy** |

---

## D. Gemini SDK & Model Verification

- **Installed SDK:** `@google/genai` `v3.6.1` (`package.json` `^3.4.0`).
- **Verified SDK Capabilities (`node_modules/@google/genai/dist/genai.d.ts`):**
  - `GenerateContentConfig.abortSignal?: AbortSignal` — **SUPPORTED & WIRED**.
  - `ThinkingLevel` enum (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) — **SUPPORTED & WIRED**.
- **Official Google Gemini Model Verification (`ai.google.dev` documentation):**
  - `gemini-3.8-flash`: Active official Flash model (1M context, 64k output, supports `low`/`medium`/`high` thinking; default `medium`).
  - `gemini-4-hydrogen`: Active official Gemini 4 model (unified 1M window, supports `low`/`medium`/`high`/`xhigh` thinking; default `high`; **rejects `minimal`**).
  - `gemini-3.5-flash-lite`: Active official ultra-low-latency Flash-Lite model (1M context, 64k output, supports `minimal`/`low`/`medium`/`high` thinking).
  - `gemini-2.5-flash`: Legacy/phased out — remains flagged by `DEPRECATED_MODEL_PATTERN`.
- **Safe Model Policy Implemented:** `resolveThinkingLevelForModel()` defaults `flash-lite` models to `MINIMAL`, defaults `gemini-3.8-flash` & `gemini-4-hydrogen` to `LOW`, respects valid `GEMINI_THINKING_LEVEL`, and prevents sending invalid `MINIMAL` to `gemini-4-hydrogen`.

---

## E. Files Modified & Created (Strictly On Top of `cfff3e6a`)

| File | Purpose |
|---|---|
| `server/gemini.ts` | Full Attempt-1 timeout budget utilization, unhandled-abort-rejection guard in `withTimeout`, model-aware `resolveThinkingLevelForModel` + `GEMINI_THINKING_LEVEL` override, `probeGeminiModelAvailability()`, `thinkingLevel` & `abortSignalSupported` diagnostics, and Section 8 `centerpieceDesign`/`venueStyling`/`guestExperience` schema & prompt enforcement |
| `server/app.ts` | Expose `thinkingLevel` and `abortSignalSupported` under `ai` on `/ready` and `/api/health` |
| `server/repositories/conceptLeaseRepository.ts` | Certify `CONCEPT_LEASE_TTL_MS` from provisional `600_000ms` to `180_000ms` (`2 * MAX_GEMINI_TIMEOUT_MS`) |
| `server/store.ts` | Populate `centerpieceDesign`, `venueStyling`, and `guestExperience` on seeded `cnc-101` concept |
| `src/types/domain.ts` | Add backward-compatible optional `centerpieceDesign`, `venueStyling`, and `guestExperience` fields to `ConceptRevision` |
| `src/components/AIStudioWorkspace.tsx` | Clear `pendingIdempotencyKey` after `AI_TIMEOUT`/`REQUEST_TIMEOUT` (fixing authenticated retry self-lockout), add stale-response sequence guards, align client timeouts (`75s`/`70s`) above backend `60s` staging ceiling, and render Centerpiece Design, Venue Styling, and Proposed Guest Experience cards |
| `.env.example` | Document `GEMINI_THINKING_LEVEL=` |
| `scripts/verify-live-ai-staging.mjs` | New zero-mock live staging AI acceptance runner covering `/api/health` AI diagnostics, CORS, all 4 event categories (15 elements + anti-wedding checks), Concierge multi-turn, `400` validation, and `401` isolation |
| `tests/ai-system-certification.test.ts` | Added regression tests `AI-REPAIR-01` through `AI-REPAIR-05` |
| `scripts/phase-ai-browser-acceptance.ts` | Upgraded fixtures to all 15 Section 8 elements + added `AI-BA-05B` verifying authenticated `AI_TIMEOUT` manual retry recovers with HTTP `200` |
| `docs/ai-certification/P0_LIVE_AI_TIMEOUT_REPAIR_REPORT.md` | This mandatory Section 17 repair report |

---

## F. Timeout Coordination Architecture

| Layer | Value | Rationale |
|---|---|---|
| Browser `apiFetch` Concept Studio (`AIStudioWorkspace.tsx`) | `75,000ms` | Strictly exceeds Railway staging `GEMINI_TIMEOUT_MS=60,000ms` and default `45,000ms`, ensuring structured backend JSON errors + `X-Request-Id` arrive before browser abort |
| Browser `apiFetch` Concierge (`AIStudioWorkspace.tsx`) | `70,000ms` | Strictly exceeds staging `60,000ms` and default `45,000ms` |
| Node HTTP `server.requestTimeout` (`server.ts`) | `max(70,000ms, aiTimeoutMs + 10,000ms)` | Never terminates active AI calls prematurely at the socket layer (`70s` for `45s`/`60s` AI timeout) |
| Gemini Overall & Attempt Deadline (`server/gemini.ts`) | `GEMINI_TIMEOUT_MS` (default `45,000ms`, max `90,000ms`) | Full remaining budget per attempt with live `AbortController` signal canceling underlying fetch on timeout; fast transient errors (`429`/`503`/`5xx`/network) retry within overall deadline |
| Durable Concept Lease TTL (`conceptLeaseRepository.ts`) | `180,000ms` (`2 * MAX_GEMINI_TIMEOUT_MS`) | Covers worst-case cross-replica provider execution without 10-minute key lockouts |
| Database Transaction Hold During Gemini I/O | **`0ms` (ZERO)** | Lease acquisition and final concept persistence use short atomic transactions; Gemini network I/O NEVER holds a database lock |

---

## G. Concept Studio End-to-End Verification Results (All 15 Section 8 Elements)

All 15 required Concept Studio elements are validated across schema, persistence, and rendered DOM (`Desktop 1440x900` + `Mobile 390x844` in isolated Chromium acceptance):
1. Proposal ID (`cnc-...`) ✅
2. Event category ✅
3. Theme / design identity (`themeName`) ✅
4. Vision / narrative summary (`visionSummary`) ✅
5. Color palette with valid `#RRGGBB` swatches (`colorPalette`) ✅
6. Floral arrangements (`floralConcept`) ✅
7. Centerpiece design (`centerpieceDesign`) ✅
8. Table styling and arrangements (`tableArrangement`) ✅
9. Stage and backdrop concept (`stageBackdrop`) ✅
10. Lighting recommendations (`lightingPlan`) ✅
11. Venue styling (`venueStyling`) ✅
12. Recommended service divisions (`recommendedDivisions`) ✅
13. Proposed guest experience (`guestExperience`) ✅
14. Revision number and timestamp ✅
15. Conceptual design disclaimer & human planner review requirement ✅

---

## H. AI Event Concierge End-to-End Verification Results

- Verified multi-turn history persistence, structured `extractedLead` JSON extraction, consultation prefill transfer, human escalation flagging, user draft preservation on failure/retry, and strict cross-customer session isolation in automated & Chromium browser suites.
- Live staging `POST /api/ai/concierge` currently fails with `HTTP 504 AI_TIMEOUT` at `60.502s` due to stale `30201cf7` deployment on Railway staging; will be re-verified live immediately via `scripts/verify-live-ai-staging.mjs` once Railway deploys the repaired branch.

---

## I. Automated Test, Build, Lint & Browser Verification Summary

| Verification Gate | Result | Exact Evidence |
|---|---|---|
| TypeScript Typecheck (`npm run typecheck`) | **PASS** | `tsc --noEmit` — 0 errors |
| Linter (`npm run lint`) | **PASS** | `tsc --noEmit && oxlint src server tests scripts server.ts` — 0 errors, 0 warnings |
| Automated Unit, Integration & Security Suite (`npm test`) | **PASS** | **178 / 178 passed (0 failed, 0 skipped)** across 9 suites (including 5 new `AI-REPAIR-01`..`AI-REPAIR-05` regression tests) |
| Production Client + Server Build (`npm run build`) | **PASS** | Clean `dist/` + `dist-server/server.mjs` compiled artifacts |
| SQL Migrations 001–008 & RLS Verification (`verify-migrations.ts`) | **PASS** | All 8 migrations ordered and RLS policies intact |
| Static Secret Scan | **CLEAN** | Zero API keys, tokens, or private keys in `src/`, `server/`, `scripts/`, `docs/` |
| Isolated AI Browser Acceptance (`phase-ai-browser-acceptance.ts`) | **PASS** | **10 / 10 passed** across Desktop (`1440x900`) & Mobile (`390x844`), including all 15 Concept Studio fields, `AI-BA-05B` authenticated `504 AI_TIMEOUT` manual Retry recovery, 0px mobile overflow, 0 console/page errors |
| Phase 16 Platform Browser Acceptance (`phase16-browser-acceptance.ts`) | **PASS** | **20 / 20 passed** across Desktop (`1440x900`) & Mobile (`390x844`), 0 console/page errors |
| Live Staging AI Verification (`scripts/verify-live-ai-staging.mjs`) | **BLOCKED (external deploy needed)** | Script syntax verified; live staging currently serves stale `30201cf7` until Railway deploys `repair/reconcile-main-20261121` |

---

## J. Live Environment Verification Results (12 Mandatory Tests)

| Test Case | Live Staging Result | Local Automated / Isolated Chromium Result | Notes / Blocker |
|---|---|---|---|
| Test 01 — Wedding Concept Studio | **FAILED on stale `30201cf7`** (`504 AI_TIMEOUT`, `60.488s`, `2963760b-77aa-4e33-b78f-26b97a6126db`) | **PASS** (`AI-BA-01`, `AI-REPAIR-04`) | Blocked from live re-test until repaired branch is deployed to Railway staging |
| Test 02 — Corporate Gala Concept Studio | **BLOCKED** (stale Railway deploy) | **PASS** (`AI-BA-03`, `ai-system-certification.test.ts`) | Automated in `scripts/verify-live-ai-staging.mjs` |
| Test 03 — Milestone Birthday Concept Studio | **BLOCKED** (stale Railway deploy) | **PASS** (`ai-system-certification.test.ts`) | Automated in `scripts/verify-live-ai-staging.mjs` |
| Test 04 — Baby Shower Concept Studio | **BLOCKED** (stale Railway deploy) | **PASS** (`AI-BA-02`, `ai-system-certification.test.ts`) | Automated in `scripts/verify-live-ai-staging.mjs` |
| Test 05 — AI Event Concierge Multi-Turn | **FAILED on stale `30201cf7`** (`504 AI_TIMEOUT`, `60.502s`, `4f11fcf4-1211-4717-ba86-3cbfc7f299ce`) | **PASS** (`AI-BA-07`, `ai-system-certification.test.ts`) | Automated in `scripts/verify-live-ai-staging.mjs` |
| Test 06 — Invalid Input Validation | **PASS LIVE** (`HTTP 400`, `367ms`, `aa9cd857-515b-4d03-bc49-d8743ec17a55`) | **PASS** | Fast validation before provider call confirmed live |
| Test 07 — Error Recovery & Retry (`503` + `504 AI_TIMEOUT`) | **BLOCKED** (stale Railway deploy) | **PASS** (`AI-BA-05`, `AI-BA-05B`) | Verified both 503 and authenticated 504 retry recover with HTTP 200 |
| Test 08 — Persistence & Page Reload | **BLOCKED** (stale Railway deploy) | **PASS** (`AI-BA-03`) | Reload preserves Proposal ID and all 15 elements |
| Test 09 — Revision Creation (`v1` -> `v2`) | **BLOCKED** (stale Railway deploy) | **PASS** (`AI-BA-04`) | Switching `v2` <-> `v1` verified |
| Test 10 — Customer Isolation (`A` vs `B`) | **BLOCKED** (no live staging creds) | **PASS** (`AI-BA-06`, `phase19-jwt-role-isolation.test.ts`) | Unauthenticated `/api/concepts` returns 401 |
| Test 11 — Concurrent Generation & Duplicate Guard | **BLOCKED** (stale Railway deploy) | **PASS** (`DC-01`..`DC-09`, `phase46-*`) | Durable lease + singleflight verified |
| Test 12 — Responsive Desktop (`1440x900`) & Mobile (`390x844`) | **BLOCKED** (stale Railway deploy) | **PASS** (`AI-BA-01`..`AI-BA-09`) | Zero horizontal overflow; mood board auto-scrolled cleanly |

---

## K. Security & Privacy Verification

- `GEMINI_API_KEY` remains strictly server-side; zero API keys or secrets exposed in client bundles, logs, or responses.
- Static secret scan across `src/`, `server/`, `scripts/`, and `docs/` returned **CLEAN**.
- Untrusted prompt inputs remain wrapped in `<client_input>` framing with secret non-disclosure output validation.
- Cross-customer isolation, dual-approval lock enforcement, auth revalidation inside atomic finalization transactions, and fail-closed unauthenticated access checks preserved 100%.

---

## L. Remaining Blockers & Exact Minimum Administrator Actions Required

Inside this AI Studio sandbox: `GITHUB_TOKEN=UNSET`, `RAILWAY_TOKEN=UNSET`, `GEMINI_API_KEY=UNSET`, `STAGING_DATABASE_URL=UNSET`, and `gh`/`railway`/`docker`/`psql` CLIs are not installed. Therefore external push, CI execution, Railway deployment, and live Gemini verification require these **4 exact administrator actions**:

1. **Apply & Push the Packaged Patch onto `repair/reconcile-main-20261121` (from Codespaces / local clone):**
   ```bash
   git fetch origin repair/reconcile-main-20261121
   git checkout repair/reconcile-main-20261121
   git reset --hard origin/repair/reconcile-main-20261121
   # Copy release-artifacts/p0-live-ai-repair/p0-live-ai-repair.patch into repo root, then:
   git am p0-live-ai-repair.patch
   git push origin repair/reconcile-main-20261121
   ```
2. **Deploy `repair/reconcile-main-20261121` to Railway Staging Service (`5ba79779-aa42-4516-b294-900ef137f23c`):**
   - In Railway Dashboard -> Project `celebration-sisters-staging` (`786a7d31-23a8-4154-8185-0d5f07914c24`) -> Environment `staging` -> Service `5ba79779-aa42-4516-b294-900ef137f23c` -> **Settings -> Source Branch**: switch from stale `fix/gemini-timeout-model-20261121` to `repair/reconcile-main-20261121` and trigger deploy.
   - Verify Railway Variables: `GEMINI_API_KEY` is valid and non-empty, `GEMINI_MODEL=gemini-3.8-flash` (or `gemini-3.5-flash-lite` for lowest latency), `GEMINI_THINKING_LEVEL=low` (or `minimal` if using `gemini-3.5-flash-lite`), `GEMINI_TIMEOUT_MS=45000` (or `60000`).
3. **Run the Zero-Mock Live Staging AI Verification Gate:**
   ```bash
   node scripts/verify-live-ai-staging.mjs \
     --url https://celebrationsisterseventdecor-staging-staging.up.railway.app \
     --output live-ai-staging-report.json
   ```
   - Confirm `LIVE-AI-00` reports `thinkingLevel` & `abortSignalSupported: true`, and `LIVE-AI-01` through `LIVE-AI-07` all pass (`HTTP 200`, all 15 Section 8 elements, zero `AI_TIMEOUT`).
   - If `LIVE-AI-01` still times out on `gemini-3.8-flash` even with `thinkingLevel: LOW`, inspect Railway logs for `ai_request_started` / `ai_provider_failed` (which now log exact `providerCategory`, `model`, `thinkingLevel`, and `durationMs`), run `probeGeminiModelAvailability()`, and test `GEMINI_MODEL=gemini-3.5-flash-lite` (`ThinkingLevel.MINIMAL`).
4. **After `LIVE_AI_VERIFIED` Passes on Staging -> Open/Merge PR to `main`:**
   - Merging to `main` automatically deploys the updated frontend (with Centerpiece Design, Venue Styling, Proposed Guest Experience, and timeout-retry fix) to `https://celebrationsistersdecor.com/` via `.github/workflows/deploy-pages.yml`.

---

## M. Final Verification Classification

**Classification:** **`CODE_REPAIRED`**  
*(Honest classification per Section 16 & 18 rules: NOT classified as `LIVE_AI_VERIFIED` or `PRODUCTION_VERIFIED` because external Railway deployment and live Gemini API execution remain blocked by absent sandbox credentials.)*
