# Phase 15.11 — Production Readiness & Deployment Gate Report

**Project:** Celebration Sisters Event Decor  
**Frontend Target:** GitHub Pages (`https://celebrationsistersdecor.com/`)  
**Backend Target:** Railway (`zesty-curiosity` / `CelebrationSistersEventDecor`)  
**Database Target:** PostgreSQL (Railway PostgreSQL or Supabase PostgreSQL)  
**Email Target:** Resend + Svix Verified Delivery Webhooks  
**Current Classification:** **CODE READY / STAGING READY — PRODUCTION APPROVAL REQUIRED** (Not yet Staging Verified or Production Verified because live PostgreSQL, Railway deployment, Resend inbox delivery, and GitHub push/PR sit outside the AI Studio execution sandbox).

---

## 1. Environment Variables Required for Staging & Production

All non-secret variable declarations are documented in `.env.example`. Configure the following secrets directly in Railway (never commit `.env`):

| Variable | Required In Prod | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV=production` | Yes | Enforces strict fail-closed boot checks, cookie security, and TLS validation |
| `DATABASE_URL` | Yes | PostgreSQL connection URI (`?sslmode=` stripped cleanly by `buildPostgresSslConfig()`) |
| `PERSISTENCE_ADAPTER=postgres` | Yes | Activates PostgreSQL persistence |
| `PGSSLMODE=verify-full` | Yes (public DB hosts) | Enforces verified TLS 1.2+ certificate & hostname checks (use `disable` ONLY on private `.railway.internal` mesh if explicitly desired) |
| `DATABASE_CA_CERT` or `DATABASE_CA_CERT_BASE64` or `PGSSLROOTCERT` | Yes (if provider uses custom CA) | Provider root CA certificate PEM; eliminates `SELF_SIGNED_CERT_IN_CHAIN` without weakening `rejectUnauthorized` |
| `SESSION_SECRET` | Yes | Strong 32+ byte random secret for session HMAC signing |
| `ALLOWED_ORIGINS` | Yes | Comma-separated origins (`https://celebrationsistersdecor.com`) |
| `RESEND_API_KEY` | Yes (for live email) | Resend API credential |
| `EMAIL_FROM` | Yes (for live email) | Verified sender identity on `celebrationsistersdecor.com` |
| `EMAIL_LIVE_DELIVERY_ENABLED=true` | Only after Staging Verification | Explicit gate allowing live external email dispatch |
| `RESEND_WEBHOOK_SECRET` | Yes (for delivery reconciliation) | Svix signing secret (`whsec_...`) for `POST /api/webhooks/resend` |
| `STAFF_NOTIFICATION_EMAIL` | Yes (for live studio alerts) | Internal Columbia, SC studio alert recipient address |

---

## 2. Controlled Operator Release Sequence

### Stage 1: Git Synchronization & Pull Request (Operator Workstation)
Because `.git` and `gh` CLI are not present in this sandbox:
1. Pull latest `main` from `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`.
2. Inspect open PR #13 and reconcile with `main`.
3. Create branch `feature/phase15-consultation-completion` and apply the Phase 15 workspace changes.
4. Push branch and open a Pull Request targeting `main`; confirm GitHub Actions CI (`CI Verification & Production Hardening Checks` + `Docker Production Image Build Check`) passes green.

### Stage 2: Staging Database & Railway Backend Verification
1. Apply migrations `001` through `008` cleanly in order on fresh vanilla Railway PostgreSQL or Supabase PostgreSQL with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <file>` (no manual `auth` schema shim required after Phase 15R) and re-run `008` once to verify live idempotency.
2. Deploy the PR branch to Railway Staging with `DATABASE_CA_CERT` / `DATABASE_CA_CERT_BASE64`, `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, and `STAFF_NOTIFICATION_EMAIL`.
4. Verify `/health` (`200`), `/ready` (`200` with `tls.rejectUnauthorized === true` and zero cert-chain errors), and outbox worker polling heartbeats.
5. Register `https://<staging-backend>/api/webhooks/resend` in Resend Dashboard and execute a live consultation booking -> verify real inbox delivery -> verify signed webhook transitions job from `ProviderAccepted` to `Delivered`.
6. Execute live reschedule, client detail update, proposal handoff, admin dead-letter retry, and token revocation in staging.

### Stage 3: Explicit Owner Approval Gate -> Production Promotion
**Do NOT promote to production until Stage 2 is 100% verified and explicit owner approval is recorded.**
1. Merge verified PR into `main`.
2. Run migrations `001`–`008` against production PostgreSQL after taking a verified database snapshot/backup.
3. Deploy Railway production backend and confirm GitHub Pages deployment to `https://celebrationsistersdecor.com/`.
4. Verify `/health`, `/ready`, live slot availability, and one controlled post-deploy canary consultation booking (then cancel canary to release the slot).

---

## 3. Rollback Plan

- **Application Rollback:** Revert Railway deployment to the previous healthy release image and revert GitHub Pages commit if needed.
- **Database Safety:** Migration `008` is strictly additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`). Existing Phase 14 application code continues operating cleanly even with Migration `008` applied, avoiding destructive schema rollback risk.
- **Email Circuit Breaker:** Set `EMAIL_LIVE_DELIVERY_ENABLED=false` in Railway environment variables to immediately pause outbound emails while continuing to record bookings and queue outbox jobs safely.
