# Railway Production Deployment & Configuration Checklist
## Celebration Sisters Event Decor

- **Railway Project:** `zesty-curiosity`
- **Railway Service:** `CelebrationSistersEventDecor`
- **Backend Runtime:** Compiled Express API (`dist-server/server.mjs`) via multi-stage `Dockerfile` (`node:22-alpine`)
- **Frontend Static Host:** GitHub Pages (`https://ophireumtechnology.github.io/CelebrationSistersEventDecor/`)
- **Database & Identity:** Supabase PostgreSQL + Supabase Auth

> **Security Policy:** Never paste or commit secret values into Git, Pull Requests, or this checklist. Enter all secrets directly in the Railway Service Variables panel or via authenticated Railway CLI (`railway variables set`).

---

## 1. Build, Start, and Healthcheck Configuration

`railway.json` declaratively configures the Railway service:

| Setting | Value |
| --- | --- |
| Builder | `DOCKERFILE` (`Dockerfile`) |
| Build Command | `npm run build` (`vite build` + `esbuild server.ts -> dist-server/server.mjs`) |
| Start Command | `node dist-server/server.mjs` |
| Bind Host & Port | `0.0.0.0:${PORT}` (Railway injects `PORT`) |
| Healthcheck Path | `/health` (liveness: `200 OK`) |
| Readiness Probe | `/ready` (executes live PostgreSQL `SELECT 1`; returns `503` if DB unreachable) |
| Restart Policy | `ON_FAILURE` (max 5 retries) |

---

## 2. Required Railway Service Variables (Names & Purpose Only)

| Variable Name | Required in Prod | Scope | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | Yes (`production`) | Runtime | Enforces PostgreSQL persistence, disables demo role switcher, disables static shared MFA passcode, enables HSTS and secure cookies. |
| `PORT` | Injected by Railway | Runtime | HTTP listener port bound on `0.0.0.0`. |
| `PERSISTENCE_ADAPTER` | Yes (`postgres`) | Persistence | Activates transactional PostgreSQL repository (`server/repositories/postgresRepository.ts`). |
| `DATABASE_URL` | Yes | Secret / DB | Supabase PostgreSQL connection string (SSL enabled automatically for non-localhost hosts). |
| `PG_POOL_MAX` | Optional (default `10`) | Persistence | Maximum `pg.Pool` connections per Railway replica. |
| `PG_CONNECT_TIMEOUT_MS` | Optional (default `5000`) | Persistence | PostgreSQL connection acquisition timeout in milliseconds. |
| `SESSION_SECRET` | Yes (>= 24 chars) | Secret / Auth | HMAC-SHA256 signing secret for HttpOnly session cookies. Server refuses production startup if missing or < 24 characters. |
| `SUPABASE_URL` | Yes | Auth | Supabase project URL used to resolve JWKS (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) and validate JWT `iss`. |
| `SUPABASE_ANON_KEY` | Yes | Auth (Public) | Exposed safely via `/api/auth/config` for frontend Supabase client initialization. |
| `SUPABASE_JWT_SECRET` | Optional (HS256 fallback) | Secret / Auth | Used only if Supabase project signs access tokens with HS256 instead of RS256/ES256 JWKS. |
| `ALLOWED_ORIGINS` | Yes | Security / CORS | Comma-separated exact origins, e.g. `https://ophireumtechnology.github.io,https://celebrationsisters.com`. |
| `CROSS_ORIGIN_COOKIES` | Yes (`true` if Pages -> Railway cookies) | Security / Auth | Enables `SameSite=None; Secure; HttpOnly` for cross-site authenticated browser requests. |
| `RESEND_API_KEY` | Yes for live email | Secret / Email | Resend HTTPS API key for consultation confirmation, staff alerts, and status update emails. |
| `EMAIL_FROM` | Yes for live email | Email | Verified Resend sender identity (e.g. `Celebration Sisters <concierge@celebrationsisters.com>`). |
| `STAFF_NOTIFICATION_EMAIL` | Yes for live email | Email | Internal Columbia, SC studio alert recipient address. |
| `EMAIL_LIVE_DELIVERY_ENABLED` | Set `true` only after approval | Email Gate | Safety kill-switch preventing unapproved outbound email sends. |
| `GEMINI_API_KEY` | Optional | Secret / AI | Server-side Gemini API key for AI Event Concierge and Concept Studio. |

---

## 3. GitHub Pages Public Repository Variables

Configure under **GitHub Repository -> Settings -> Secrets and variables -> Actions -> Variables** (non-secret public values only):

- `VITE_API_BASE_URL`: Production Railway public URL (e.g. `https://<railway-domain>.up.railway.app`)
- `VITE_SUPABASE_URL`: Supabase project URL
- `VITE_SUPABASE_ANON_KEY`: Supabase public anon key

---

## 4. Database Migration & Admin Identity Linking Runbook

1. Validate SQL migrations locally before applying:
   ```bash
   npx tsx scripts/verify-migrations.ts
   ```
2. Apply additive SQL migrations in order against Supabase PostgreSQL (see `db/MIGRATIONS.md`):
   - `db/migrations/001_initial_schema.sql`
   - `db/migrations/002_rls_policies.sql`
   - `db/migrations/003_auth_identity.sql`
   - `db/migrations/004_production_hardening.sql`
   - `db/migrations/005_rls_event_planner_and_invoices.sql`
3. Run a read-only migration integrity check before importing any legacy JSON records:
   ```bash
   npx tsx scripts/migrate-json-to-postgres.ts
   ```
4. Bind privileged accounts (`admin`, `staff`, `event_planner`, `vendor`) to their verified Supabase Auth UUIDs (`supabase_user_id` / `POST /api/admin/users/:id/link-identity`). Email-only matching never grants privileged access.
5. Enroll each executive administrator in RFC 6238 TOTP MFA (`POST /api/auth/mfa/totp/enroll` or Supabase Auth `aal2` MFA) before relying on `/api/admin/*` endpoints.

---

## 5. GitHub Synchronization Commands (Run Locally with Authenticated Git Credentials)

Because the AI Studio sandbox does not have a `.git` repository or write credentials, sync from an authorized developer workstation:

```bash
git checkout main
git pull origin main
git checkout -b development/phase-11-production-integration
# Copy/apply verified workspace files, verify with:
npm ci && npm audit --audit-level=high && npx tsx scripts/verify-migrations.ts && npm run lint && npm test && npm run build
git status
git add -A
git commit -m "chore(phase-11): deterministic lockfile, migration 005 RLS fixes, AI & payment hardening"
git push -u origin development/phase-11-production-integration
gh pr create --base main --head development/phase-11-production-integration \
  --title "Phase 11: Deterministic Lockfile, Supabase RLS 005, AI/Payment Hardening & Release Prep" \
  --body "Implements Phase 11 Blocks 11.1-11.11. Do not merge until CI, Docker build, and staging acceptance pass."
```

---

## 6. Post-Deployment Verification & Rollback

1. Verify `GET https://<railway-url>/health` returns HTTP `200` with `ok: true` and `status: "alive"`.
2. Verify `GET https://<railway-url>/ready` returns HTTP `200` with `ok: true`, `persistence.adapter: "postgres"`, and `persistence.connected: true`.
3. Verify `GET https://<railway-url>/api/auth/config` confirms `readyForProductionAuth: true`, `mfaPolicy: "totp_required_for_admin"`, and leaks no secret keys.
4. If `/ready` returns `503` or any regression occurs, immediately roll back to the previous healthy Railway deployment in the `zesty-curiosity` dashboard before retrying migrations or variable updates.
