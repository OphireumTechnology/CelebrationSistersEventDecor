# Phase 17 — Full Browser Acceptance Report (Headless Chromium)

**Browser Engine:** Real Headless Chromium (`playwright-core@1.65.1`, `/ms-playwright/chromium_headless_shell-1247/...`)  
**Target Build Tested:** Freshly compiled Phase 17 production bundles (`dist/` + `dist-server/server.mjs`)  
**Local Full-Stack Browser Acceptance:** **`VERIFIED` — 20 / 20 PASSED** (`0` console errors, `0` uncaught pageerrors)  
**Static GitHub Pages Zero-404 Proof:** **`VERIFIED` — `api404Count: 0`, `consoleErrorCount: 0`, `pageErrorCount: 0`**  
**Live Staging HTTPS URL Rerun:** `BLOCKED` (awaiting deployed Railway Staging HTTPS URL + `VITE_API_BASE_URL` cutover)

---

## 1. Executed 20-Scenario Full-Stack Headless Chromium Matrix (`VERIFIED`)

Executed via `npx tsx scripts/phase16-browser-acceptance.ts` against the compiled Phase 17 `dist/` + `dist-server/server.mjs` runtime:

| Scenario ID | Viewport | Description | Result | Executed Evidence |
| :--- | :--- | :--- | :--- | :--- |
| `P16-BA-01` | Desktop `1440x900` | Website loads with official Celebration Sisters branding | **PASS** | `title="Celebration Sisters Event Decor — Luxury Event Planning & Design"` |
| `P16-BA-02` | Desktop `1440x900` | Public navigation works across primary routes | **PASS** | `Services -> Portfolio -> AI Studio -> Home` |
| `P16-BA-03` | Desktop `1440x900` | Consultation wizard opens with accessible focus & Escape cycle | **PASS** | Focus trapped + Escape close/reopen verified |
| `P16-BA-04` | Desktop `1440x900` | Event discovery Step 1 validates and captures Event Theme | **PASS** | Date guard + Event Theme captured |
| `P16-BA-05` | Desktop `1440x900` | Live server-authoritative availability loads & selects slot | **PASS** | `slot="2:00 PM UTC 45m Lead: Maya Jenkins"` |
| `P16-BA-06` | Desktop `1440x900` | Invalid appointments rejected by consent guard & server validation | **PASS** | Missing consent blocked + past slot HTTP `400` |
| `P16-BA-07` | Desktop `1440x900` | Valid consultation booking persists cleanly on retry | **PASS** | Persisted `CS-2027-0065` |
| `P16-BA-08` | Desktop `1440x900` | Confirmation displays persisted reference code & scoped `csa_` token | **PASS** | `ref=CS-2027-0065`, `tokenLen=47` |
| `P16-BA-09` | Desktop `1440x900` | Email notifications durably recorded in Admin Email Outbox | **PASS** | `ref=CS-2027-0066` visible with honest status |
| `P16-BA-10` | Desktop `1440x900` | Client self-service portal rejects wrong token & opens verified booking | **PASS** | Wrong token blocked; verified `CS-2027-0065` opened |
| `P16-BA-11` | Desktop `1440x900` | Client online rescheduling updates slot cleanly | **PASS** | Moved to `"2:00 PM UTC Maya Jenkins"` |
| `P16-BA-12` | Desktop `1440x900` | Client online cancellation cancels appointment & releases slot | **PASS** | Status transitioned to `Cancelled` |
| `P16-BA-13` | Desktop `1440x900` | MFA Admin manages & confirms appointment in Command Center | **PASS** | Confirmed `CS-2027-0066` |
| `P16-BA-14` | Desktop `1440x900` | Planner assignment update persists across full page reload | **PASS** | `planner=user-admin-director` persisted |
| `P16-BA-15` | Desktop `1440x900` | CRM stage & outcome recording persist across full page reload | **PASS** | `crmStage=Consultation Completed` persisted |
| `P16-BA-16` | Desktop `1440x900` | Proposal handoff issues itemized quotation & updates CRM | **PASS** | Advanced to `Proposal Sent` |
| `P16-BA-17` | Desktop `1440x900` | Unauthorized access to admin APIs is rejected | **PASS** | `metrics=403`, `outbox=403` |
| `P16-BA-18` | Desktop `1440x900` | Database outage (HTTP `503`) shows actionable alert & zero false confirmation | **PASS** | `503` intercepted cleanly |
| `P16-BA-19` | Mobile `390x844` | Mobile homepage & consultation modal fit viewport with touch-friendly CTAs | **PASS** | `pageOverflow=0px`, `modalOverflow=0px`, `ctaHeight=44px` |
| `P16-BA-20` | Desktop & Mobile | Zero critical console errors & zero uncaught pageerrors | **PASS** | `0` console errors, `0` pageerrors |

---

## 2. Phase 17 Static GitHub Pages Zero-404 Chromium Proof (`VERIFIED`)

To prove that the Phase 17.4 repair permanently eliminates the live website's `/api/auth/personas` and `/api/auth/session` HTTP `404` responses even when `VITE_API_BASE_URL` is unset on a static-only host, the bundle built with `GITHUB_PAGES=true GITHUB_PAGES_CUSTOM_DOMAIN=true npm run build:client` was served by a static-only HTTP server returning HTML `404` for all `/api/*` paths and inspected in headless Chromium:

- `title`: `"Celebration Sisters Event Decor — Luxury Event Planning & Design"`
- `api404Count`: **`0`** (zero `/api/auth/personas` or `/api/auth/session` 404 requests emitted)
- `consoleErrorCount`: **`0`**
- `pageErrorCount`: **`0`**
- `dialogVisible`: **`true`** (Consultation modal opens cleanly on click without crashing or fabricating slots)

---

## 3. Staging Browser Rerun Gate (Post-Railway Cutover)

Once Railway Staging is deployed and `VITE_API_BASE_URL` points a staging frontend build at the Railway Staging HTTPS API, execute the same 20-scenario browser verification against the live staging HTTPS origin to confirm cross-origin CORS cookies, TLS certificates, live PostgreSQL persistence, and live Resend outbox entries end-to-end.
