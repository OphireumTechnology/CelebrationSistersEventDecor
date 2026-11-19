# Phase 15R — Repair 05: CI Parity & Real Headless Chromium Browser Acceptance

**Project:** Celebration Sisters Event Decor  
**Real Browser Acceptance Status:** `VERIFIED` (`18/18` checks passed in real headless Chromium across Desktop `1440x900` and Mobile `390x844`)  
**Hosted GitHub Actions Workflow Run:** `BLOCKED` (No `.git` repository or `gh` CLI in sandbox; all local CI commands executed and passed)  
**Test Harness:** `scripts/phase15r-browser-acceptance.ts` (`playwright-core` + Chromium headless shell)

---

## 1. Local CI Gate Execution Results

Updated `package.json` with `"typecheck": "tsc --noEmit"` and aligned `.github/workflows/ci.yml` to run both `npm run typecheck` and `npm run lint`.

| CI Gate Command | Result | Key Output |
| :--- | :--- | :--- |
| `npm run typecheck` | PASS | `tsc --noEmit` — 0 TypeScript errors |
| `npm run lint` | PASS | `tsc --noEmit && oxlint src server tests scripts server.ts` — 0 warnings, 0 errors |
| `npx tsx scripts/verify-migrations.ts` | PASS | 8 ordered migrations (`001`–`008`), 36/36 RLS tables, 0 unconditional `auth.uid()` calls |
| `npx tsx scripts/reconcile-snapshot-to-normalized.ts` | PASS | Deterministic snapshot-to-normalized dry-run succeeded |
| `npm test` | PASS | **62/62 automated tests passed, 0 failures** (`tests/*.test.ts`) |
| `npm audit --audit-level=high` | PASS | `found 0 vulnerabilities` |
| Static secret regex scan (`src server scripts docs`) | PASS | `SECRET_SCAN_CLEAN: 0 matches` |
| GitHub Pages custom-domain root build (`GITHUB_PAGES=true GITHUB_PAGES_CUSTOM_DOMAIN=true npm run build:client`) | PASS | `dist/index.html`, `dist/assets/celebration-sisters-logo.png`, `dist/CNAME=celebrationsistersdecor.com` verified |
| `npm run build` | PASS | Vite client (`752.71 kB`) + esbuild server (`dist-server/server.mjs`, `313.3 kb`) compiled cleanly |

---

## 2. Real Headless Chromium Browser Acceptance Matrix (`18/18 PASS`)

Executed via `npx tsx scripts/phase15r-browser-acceptance.ts` launching real Chromium (`/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell`) against the compiled `dist/` frontend served by the live Express backend:

| Check ID | Viewport | Scenario Verified | Observed Evidence | Status |
| :--- | :--- | :--- | :--- | :--- |
| `BA-01` | Desktop `1440x900` | Public website loads with official branding | `title="Celebration Sisters Event Decor — Luxury Event Planning & Design"` | PASS |
| `BA-02` | Desktop `1440x900` | Consultation modal opens with accessible focus management | `document.activeElement` trapped inside `[role="dialog"]` | PASS |
| `BA-03` | Desktop `1440x900` | `Escape` closes modal cleanly & re-opening works | Closed on `Escape` and re-opened cleanly | PASS |
| `BA-04` | Desktop `1440x900` | Step 1 validation rejects empty target event date | Inline validation alert `Please choose your target event date.` rendered | PASS |
| `BA-05` | Desktop `1440x900` | Step 2 renders live availability slots & selects time | Live slot button selected (`7:00 PM UTC 45m Lead: Maya Jenkins`) | PASS |
| `BA-06` | Desktop `1440x900` | Step 3 client contact info & privacy consent advance to Step 4 | Reached Step 4 review summary | PASS |
| `BA-07` | Desktop `1440x900` | Simulated HTTP `503 DATABASE_UNAVAILABLE` error handling | Actionable error alert shown; **zero** false confirmation screen rendered | PASS |
| `BA-08` | Desktop `1440x900` | Retry persists booking & renders `referenceCode` + `csa_` token | Persisted `CS-2027-0065` + one-time `csa_...` verification token | PASS |
| `BA-09` | Desktop `1440x900` | Manage portal rejects wrong verification token | HTTP `403` error rendered cleanly without exposing data | PASS |
| `BA-10` | Desktop `1440x900` | Manage portal opens verified appointment & displays `Event Theme` | Opened `CS-2027-0065` showing `Candlelit Royal Amethyst & Champagne Gold` | PASS |
| `BA-11` | Desktop `1440x900` | Client online reschedule updates appointment cleanly | Rescheduled to new slot via online slot picker | PASS |
| `BA-12` | Desktop `1440x900` | Client online cancellation cancels appointment & releases slot | Status updated to `Cancelled` | PASS |
| `BA-13` | Desktop `1440x900` | MFA-verified Admin opens Consultation Command Center & views live booking | Live booking `CS-2027-0066` (`Midlands Symphony Annual Gala`) displayed | PASS |
| `BA-14` | Desktop `1440x900` | Admin confirms consultation inside Command Center | Clicked `Confirm Appointment` -> `Confirmed consultation CS-2027-0066.` | PASS |
| `BA-15` | Desktop `1440x900` | Admin Email Outbox tab renders honest delivery states | Outbox status badges (`Skipped`/`Pending`/etc.) rendered cleanly | PASS |
| `BA-16` | Desktop `1440x900` | Zero unhandled console errors or pageerrors across desktop flows | `0 console errors, 0 pageerrors` | PASS |
| `BA-17` | Mobile `390x844` | Mobile viewport renders with zero horizontal overflow | `overflow=0px` | PASS |
| `BA-18` | Mobile `390x844` | Mobile consultation modal fits viewport with touch-friendly CTA | `modalOverflow=0px`, `ctaHeight=44px`, `0 pageerrors` | PASS |

---

## 3. Hosted GitHub Actions Workflow Note (`BLOCKED`)

Because `/app/applet/.git` and `gh` CLI are absent in this sandbox, pushing branch `repair/phase15r-critical-acceptance` and observing the hosted GitHub Actions workflow run (`ci.yml` + `docker-build`) must be performed from the operator workstation once the workspace diff is synced to GitHub.
