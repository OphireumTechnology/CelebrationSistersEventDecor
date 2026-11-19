# Phase 16 — Railway Backend Integration & Split-Origin Architecture Report

**Backend Runtime:** Node.js 22 / Express / TypeScript compiled to `dist-server/server.mjs` (315.6 kB)  
**Frontend Origin:** `https://celebrationsistersdecor.com` (GitHub Pages custom domain)  
**Production Container:** Multi-stage `Dockerfile` (`node:22-bookworm-slim`, non-root `USER node`, `EXPOSE 3000`, `HEALTHCHECK` on `/health`)

---

## 1. Verified Backend & Split-Origin Controls

| Control | Evidence | Status |
| --- | --- | --- |
| **Fail-Closed Production Startup** | `NODE_ENV=production PORT=3198 node dist-server/server.mjs` without `DATABASE_URL` / `SESSION_SECRET` exited non-zero immediately. | **VERIFIED** |
| **Compiled Production Bundle Boot & Probes** | `dist-server/server.mjs` booted cleanly; `/health` returned `{"ok":true,"status":"alive"}`; `/ready` returned `{"ok":true,"persistence":{"ready":true}}`; `/api/auth/config` returned valid JSON; `SIGTERM` triggered graceful `server_shutdown_initiated` -> `server_shutdown_complete`. | **VERIFIED** |
| **Split-Origin CORS Preflight Repair** | Added `X-Consultation-Token` to `Access-Control-Allow-Headers` in `server/authz.ts`. Automated preflight test confirmed `OPTIONS /api/consultations/status` from `https://celebrationsistersdecor.com` returns `204` with `Access-Control-Allow-Credentials: true` and `X-Consultation-Token`, while `https://evil-phishing.example.net` returns `403`. | **VERIFIED** |
| **Database Outage Fail-Closed (`/ready` HTTP 503)** | `tests/production-hardening.test.ts` verified `/ready` returns `503` on PostgreSQL failure without silent local JSON fallback. | **VERIFIED** |
| **Deterministic Container Lockfile** | Deleted `/bun.lock`; `package-lock.json` synced; `npm ci --dry-run --no-audit --no-fund` passed cleanly (`Dockerfile` lines 12 & 24 use `npm ci`). | **VERIFIED** |
| **Docker Image Build Execution** | `docker` daemon is absent in sandbox; validated cleanly by `.github/workflows/ci.yml` (`docker-build` job) on GitHub Actions. | **BLOCKED (Sandbox lacks Docker)** |
| **Live Railway Staging Service Deployment** | Railway staging credentials are not present in sandbox; no production deployment performed. | **BLOCKED (External Infrastructure)** |

---

## 2. Required Railway Staging Environment Variable Contract

| Variable | Required in Production / Staging | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Enables fail-closed guards, strict cookies, and disables demo auth. |
| `PORT` | `3000` (or Railway injected) | Express bind port. |
| `PERSISTENCE_ADAPTER` | `postgres` | Enforces PostgreSQL persistence (forbids local JSON fallback). |
| `DATABASE_URL` | Required (secret) | Railway / Supabase PostgreSQL connection string. |
| `DATABASE_CA_CERT` / `DATABASE_CA_CERT_BASE64` | Required if custom CA | Verified TLS certificate chain (`rejectUnauthorized: true` always enforced). |
| `SESSION_SECRET` | Required (>= 32 chars) | HMAC-SHA256 session & CSRF signing key. |
| `ALLOWED_ORIGINS` | `https://celebrationsistersdecor.com,https://www.celebrationsistersdecor.com` | Explicit credentialed CORS/CSRF allowlist. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `STAFF_NOTIFICATION_EMAIL`, `EMAIL_LIVE_DELIVERY_ENABLED` | Staged controlled rollout | Canonical email contract (keep `EMAIL_LIVE_DELIVERY_ENABLED=false` until staging verification approves controlled test sends). |
