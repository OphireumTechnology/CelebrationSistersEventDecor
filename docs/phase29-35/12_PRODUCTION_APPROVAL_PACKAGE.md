# Phase 35 — Production Approval & Cutover Readiness Package

**Deliverable Mapping:** `docs/phase29-35/12_PRODUCTION_APPROVAL_PACKAGE.md`  
**Project:** Celebration Sisters Event Decor  
**Authoritative Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Verified `main` Commit SHA:** `288d20ea6be1827e849e663458fa446f7f46ce95`  
**Release Integration Branch:** `release/phase29-35-production-readiness` (pending workstation push)  
**Production Website:** `https://celebrationsistersdecor.com/`  
**Railway Backend:** `https://celebrationsisterseventdecor-production.up.railway.app/`  
**Current Classification:** **`CODE_READY` (`33 / 48` — `68.75%`)**  
**Target Pre-Cutover Classification:** **`PRODUCTION_APPROVAL_REQUIRED` (`48 / 48` — `100%`)**

---

## 1. Executive Summary for System Owner

All application source code, database migrations (`001`–`008`), security guards, transactional email outbox, administrative MFA workflows, and automated test suites are complete and verified:
- **Automated Regression Suite:** `102 / 102` passing (`0` failures, `0` warnings/errors in TypeScript + Oxlint).
- **Compiled Chromium Browser Acceptance:** `20 / 20` passing (Desktop `1440×900` & Mobile `390×844`, `0` console/page errors, `0px` overflow).
- **Live Read-Only Website Verification:** `https://celebrationsistersdecor.com/` loads cleanly in real Chromium (`0` broken images, `0` console errors, `0px` overflow) and fetches live consultation slots from Railway.
- **Hosted GitHub Actions (`main` `288d20ea`):** CI + `npm audit --audit-level=high` + Docker image build (`Run 44679267813`) and GitHub Pages deployment (`Run 44679267814`) are **green**.

**Why Production Cutover Cannot Proceed Yet:**
Live read-only diagnostics from `GET https://celebrationsisterseventdecor-production.up.railway.app/ready` (HTTP `503`) and live DNS queries prove four infrastructure activations remain incomplete:
1. Canonical PostgreSQL migrations `001`–`008` are **0 / 8 applied** (missing `schema_migrations`, `consultations`, `consultation_slot_holds`, `notification_outbox`, `notification_webhook_events`, `crm_follow_up_tasks`, and `excl_consultations_planner_buffered_overlap`).
2. Supabase Auth environment variables are **not configured** on Railway or GitHub Pages.
3. Resend credentials (`RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET`) are **not configured** on Railway.
4. DNS records for `celebrationsistersdecor.com` lack Resend SPF, DKIM (`resend._domainkey`), return-path MX (`send`), and DMARC (`_dmarc`).

---

## 2. Ordered Cutover Promotion Path (Do Not Skip Gates)

### Gate A — Promote `CODE_READY` -> `STAGING_READY`
1. Push Phase 29–35 workspace repairs to `release/phase29-35-production-readiness` and open PR against `main`; verify hosted CI + Docker build green (`SRC-06`).
2. Provision isolated staging PostgreSQL 16+, staging Railway service, staging Supabase Auth project, and Resend DNS records (`SPF`/`DKIM`/`DMARC`/`send` MX).

### Gate B — Promote `STAGING_READY` -> `STAGING_VERIFIED`
1. Execute `scripts/run-migrations.ts --dry-run` and `STAGING_DB_CONFIRM=YES_ISOLATED_STAGING npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill` (`DB-05`, `DB-06`, `OPS-03`).
2. Confirm staging Railway `GET /ready` returns **HTTP `200 ready`** with all 6 checks `true`.
3. Execute `scripts/verify-staging-railway-and-resend.ts` with `STAGING_REQUIRE_SUPABASE_AUTH=true` and `STAGING_REQUIRE_RESEND_LIVE=true` against an approved internal QA mailbox (`BE-06`, `MAIL-04`..`06`).
4. Execute full Desktop & Mobile staging booking + MFA admin + cross-account security + Railway rollback + alerting validation (`AUTH-06`, `BOOK-05`, `BOOK-06`, `SEC-06`, `OPS-04`, `OPS-05`).

### Gate C — Promote `STAGING_VERIFIED` -> `PRODUCTION_APPROVAL_REQUIRED` -> Owner Cutover
No production migrations, production credential changes, customer email activation (`EMAIL_LIVE_DELIVERY_ENABLED=true`), or merges to `main` may occur without explicit owner sign-off below:

- [ ] **Owner Authorization — Merge `release/phase29-35-production-readiness` to `main`**
- [ ] **Owner Authorization — Create Pre-Cutover Production PostgreSQL Backup & Apply Migrations `001`–`008`**
- [ ] **Owner Authorization — Configure Production Supabase Auth & Bind Immutable Admin/Staff UUIDs**
- [ ] **Owner Authorization — Activate Verified Resend Sender Domain & Live Customer Email Delivery**
- [ ] **Owner Authorization — Execute Post-Deploy Smoke Check (`GET /health` `200`, `GET /ready` `200 ready`)**
