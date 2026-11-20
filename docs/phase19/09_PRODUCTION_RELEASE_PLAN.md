# Phase 19 — 09 Production Release Plan

**Repository:** `https://github.com/OphireumTechnology/CelebrationSistersEventDecor`  
**Current Release Classification:** **`CODE_READY`**  
**Target Production Domains:** `https://celebrationsistersdecor.com/` (GitHub Pages) + `https://celebrationsisterseventdecor-production.up.railway.app/` (Railway)  
**Plan Timestamp:** `2026-11-20T04:32Z`

---

## 1. Honest Release Classification Gate

| Gate | Status | Blocking Requirement to Advance |
|---|---|---|
| **`CODE_READY`** | **ACHIEVED** | 94/94 automated tests, 20/20 Chromium acceptance, 0 secret leaks, fail-closed compiled smoke test, CI/Pages regex defect fixed, concurrent rate-limit race fixed. |
| `STAGING_READY` | **PENDING** | Push branch `repair/phase19-final-production-readiness`, pass GitHub CI + `docker build`, deploy isolated Railway Staging service + Staging PostgreSQL + Staging Supabase + Staging Resend. |
| `STAGING_VERIFIED` | **PENDING** | Execute `run-migrations.ts`, `verify-staging-postgres.ts --backup-restore-drill`, and `verify-staging-railway-and-resend.ts` (with `STAGING_REQUIRE_SUPABASE_AUTH=true` & `STAGING_REQUIRE_RESEND_LIVE=true`) to achieve 20/20 verified staging evidence. |
| `PRODUCTION_APPROVAL_REQUIRED` | **PENDING** | Executive / owner sign-off after `STAGING_VERIFIED` evidence package is complete. |
| `PRODUCTION_DEPLOYED` / `PRODUCTION_VERIFIED` | **NOT STARTED** | Strictly gated behind explicit approval. |

---

## 2. Production Secret & Variable Inventory (Names Only — Zero Secret Values)

### Railway Backend Production Service
- `NODE_ENV=production`, `PORT=3000`, `TRUST_PROXY=1`, `PERSISTENCE_ADAPTER=postgres`, `ALLOW_DEMO_AUTH=false`
- `ALLOWED_ORIGINS=https://celebrationsistersdecor.com,https://www.celebrationsistersdecor.com`
- `SESSION_SECRET` (cryptographically random >= 32 bytes)
- `DATABASE_URL`, `PGSSLMODE` (`disable` ONLY for `*.railway.internal`, `verify-full` for public proxies), `PG_POOL_MAX`, `PG_CONNECT_TIMEOUT_MS`, `RATE_LIMIT_DB_TIMEOUT_MS`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
- `RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET`, `EMAIL_LIVE_DELIVERY_ENABLED=true`

### GitHub Actions Repository Variables (Public Frontend Build Only — Never Service Keys)
- `VITE_API_BASE_URL=https://celebrationsisterseventdecor-production.up.railway.app`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

---

## 3. Pre-Cutover Backup, Migration & Rollback Procedure (After Approval Only)

### Step A — Mandatory Pre-Migration PostgreSQL Backup
```bash
pg_dump --format=custom --no-owner --no-privileges \
  --file="cs_prod_pre_phase19_$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$PRODUCTION_DATABASE_URL"
```

### Step B — Apply Canonical Migrations `001` – `008`
```bash
DATABASE_URL="$PRODUCTION_DATABASE_URL" npx tsx scripts/run-migrations.ts
# Re-run to verify 0 pending / 0 checksum drift:
DATABASE_URL="$PRODUCTION_DATABASE_URL" npx tsx scripts/run-migrations.ts
```

### Step C — Merge PR & Deploy
1. Merge `repair/phase19-final-production-readiness` into `main` after CI + Docker build + staging sign-off.
2. Confirm GitHub Actions `Deploy Celebration Sisters frontend to GitHub Pages` succeeds and deploys updated bundle (`X-Consultation-Token` header transport + `Retry Availability` + `Reserving Slot...` guard).
3. Confirm Railway auto-deploys `main` and passes `/health` + `/ready`.

### Step D — Rollback Procedure
- **Application Rollback:** Redeploy prior Railway deployment (`b9316bc9618f9dce666ddbe5dbe465db531a93b7`) and revert `main` via `git revert <merge-sha>` to redeploy prior GitHub Pages bundle.
- **Database Rollback (if migration fails mid-cutover):** Each migration (`001`–`008`) runs inside an explicit `BEGIN`/`COMMIT` transaction (`ROLLBACK` on error). For full state recovery, restore the pre-cutover `pg_dump` custom archive via `pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$PRODUCTION_DATABASE_URL" <backup.dump>`.
- **Email Kill-Switch:** Set `EMAIL_LIVE_DELIVERY_ENABLED=false` on Railway to pause outbound delivery immediately while preserving durable outbox auditing.

---

## 4. Post-Deploy Production Smoke Verification & Monitoring

1. `GET /health` -> `200 OK` (`status: "alive"`).
2. `GET /ready` -> `200 OK` with:
   - `persistence.connected: true`
   - `persistence.schema.rateLimitTablePresent: true`
   - `persistence.schema.migrationsTablePresent: true`
   - `persistence.schema.migrationsAppliedCount: 8`
   - `auth.readyForProductionAuth: true`
   - `email.configured: true`, `email.liveDeliveryEnabled: true`
3. `GET /api/auth/config` -> `demoPersonasAvailable: false`, `allowedOriginsCount: 2`.
4. `GET /api/consultations/availability?days=14&method=video&timezone=America/New_York` -> `200 OK` with studio slots.
5. `GET /api/consultations/status?referenceCode=CS-2026-0065` -> `400 SCOPED_TOKEN_REQUIRED` (zero `503`).
6. Monitor structured logs (`rate_limit_store_error`, `resend_webhook_signature_rejected`, HTTP `5xx`, PostgreSQL latency) for 30 minutes post-cutover.
