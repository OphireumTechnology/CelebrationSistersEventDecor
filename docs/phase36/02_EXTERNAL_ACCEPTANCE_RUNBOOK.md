# Phase 36 — External Staging Acceptance Execution Runbook (14 Remaining Gates)

**Target Commit SHA:** `ec53aa660a70f83430fd6245089254ab03b85098` (`release/phase29-35-production-readiness`)  
**Safety Policy:** Execute **strictly against isolated staging infrastructure**. Do **not** run staging write harnesses against production PostgreSQL, production Railway, or live customer email addresses.

---

## Gate 1 — Isolated Staging PostgreSQL 16+ Migrations, FORCE RLS, Concurrency & Backup/Restore (`DB-05`, `DB-06`, `OPS-03`)

**Required Credentials & Binaries:** `psql`, `pg_dump`, `pg_restore`, isolated staging `DATABASE_URL`, isolated empty `STAGING_RESTORE_DATABASE_URL`.

```bash
# 1. Read-only migration plan verification (zero writes)
DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/run-migrations.ts --dry-run

# 2. Apply migrations 001..008, verify NOBYPASSRLS isolation (10 checks),
#    execute 2/3/10/25-way 23P01 exclusion races, and run full pg_dump/pg_restore drill
STAGING_DB_CONFIRM=YES_ISOLATED_STAGING \
DATABASE_URL="$STAGING_DATABASE_URL" \
STAGING_RESTORE_DATABASE_URL="$STAGING_RESTORE_DATABASE_URL" \
npx tsx scripts/verify-staging-postgres.ts --backup-restore-drill
```

**Pass Criteria:** JSON output reports `"ok": true`, `migrationsApplied: 8`, `NOBYPASSRLS` checks `10/10` pass, `23P01` concurrency winners strictly `1` per race, and restored database verifies schema & row parity.

---

## Gate 2 — Resend DNS Publishing & Domain Verification (`MAIL-04`)

Publish the following DNS records on `celebrationsistersdecor.com` (currently live DNS shows Porkbun-only SPF and `NXDOMAIN` for `_dmarc`, `resend._domainkey`, and `send` MX):

| Type | Host / Name | Target / Value |
|---|---|---|
| `TXT` | `@` (`celebrationsistersdecor.com`) | Merge Resend SPF mechanism into existing SPF record (single valid SPF record) |
| `TXT` | `resend._domainkey` | DKIM public key issued by Resend dashboard |
| `MX` | `send` | Resend bounce/return-path MX host (priority `10`) |
| `TXT` | `send` | Resend return-path SPF (`v=spf1 include:amazonses.com ~all` per Resend dashboard) |
| `TXT` | `_dmarc` | `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@celebrationsistersdecor.com` |

Verify propagation before testing live mail:

```bash
dig +short TXT celebrationsistersdecor.com
dig +short TXT resend._domainkey.celebrationsistersdecor.com
dig +short MX send.celebrationsistersdecor.com
dig +short TXT _dmarc.celebrationsistersdecor.com
```

---

## Gate 3 — Isolated Staging Railway + Supabase Auth + Resend Live Delivery & Webhooks (`BE-06`, `AUTH-06`, `MAIL-05`, `MAIL-06`, `SEC-06`)

Configure isolated staging Railway variables (`NODE_ENV=production`, `PERSISTENCE_ADAPTER=postgres`, `DATABASE_URL`, `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFICATION_EMAIL`, `RESEND_WEBHOOK_SECRET`, `EMAIL_LIVE_DELIVERY_ENABLED=true`, `ALLOWED_ORIGINS`), deploy `release/phase29-35-production-readiness`, and register the staging Resend webhook endpoint (`https://<staging-railway>/api/webhooks/resend`).

```bash
# 1. Strict readiness & operational contract check (requires /ready HTTP 200 ready)
npx tsx scripts/verify-deployment-and-rollback.ts \
  --url "$STAGING_API_BASE_URL" \
  --origin "$STAGING_FRONTEND_ORIGIN" \
  --strict

# 2. Full staging API, Supabase auth config, live Resend delivery & Svix webhook verification
# IMPORTANT: STAGING_RESEND_TEST_EMAIL must be an approved real internal QA mailbox
# (RFC 2606 domains like example.com are intentionally blocked in production mode).
STAGING_API_CONFIRM=YES_ISOLATED_STAGING \
STAGING_API_BASE_URL="$STAGING_API_BASE_URL" \
STAGING_FRONTEND_ORIGIN="$STAGING_FRONTEND_ORIGIN" \
STAGING_RESEND_TEST_EMAIL="$APPROVED_QA_MAILBOX" \
RESEND_WEBHOOK_SECRET="$STAGING_RESEND_WEBHOOK_SECRET" \
STAGING_REQUIRE_SUPABASE_AUTH=true \
STAGING_REQUIRE_RESEND_LIVE=true \
npx tsx scripts/verify-staging-railway-and-resend.ts
```

**Pass Criteria:**
- `GET /ready` returns `HTTP 200` with `productionReady: true`, `checks: { database: true, migrations: true, schemaObjects: true, auth: true, email: true, worker: true }`.
- Approved QA mailbox receives confirmation email; Resend webhook updates outbox status to `Delivered`; invalid/expired Svix signatures return `401`; duplicate `svix-id` returns `deduplicated: true`.
- Bound staging admin signs in via `POST /api/auth/login`, enrolls/verifies RFC 6238 TOTP MFA (`aal2`), confirms superseded `aal1` JTI fails closed (`401`), and cross-account read/write attempts return `403`.

---

## Gate 4 — Staging Browser E2E, Rollback Rehearsal & Alerting (`BOOK-05`, `BOOK-06`, `OPS-04`, `OPS-05`)

```bash
# 1. Full Desktop & Mobile Chromium acceptance against isolated staging frontend + API
TARGET_FRONTEND_URL="$STAGING_FRONTEND_ORIGIN" \
TARGET_API_URL="$STAGING_API_BASE_URL" \
npx tsx scripts/phase16-browser-acceptance.ts

# 2. Railway Rollback Rehearsal (via Railway CLI/dashboard on staging service):
#    - Redeploy previous staging release image, confirm GET /health 200 & GET /ready 200
#    - Roll forward back to ec53aa66, confirm persisted booking record remains intact
# 3. Alerting Validation:
#    - Trigger simulated /ready 503 / dead-letter condition in staging and confirm alert receipt
```

---

## Gate 5 — Owner Cutover Approval (`OPS-06`)

Only after Gates 1–4 pass (`47 / 48` verified, `STAGING_VERIFIED`) should the release package be elevated to `PRODUCTION_APPROVAL_REQUIRED` for explicit owner authorization of production migration, production credentials, live customer email activation, and production cutover smoke checks.
