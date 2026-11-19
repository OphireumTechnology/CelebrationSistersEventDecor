# Phase 12 Pull Request & Transferable Synchronization Guide
## Branch: `development/phase-12-release-integration` -> `main`

- **Authoritative GitHub `main` Baseline SHA:** `cedab61177d38c2e3d65edde5e27f4a470347d21` (*"ci: standardize on npm ci and add migration checks"* — confirmed 100% of Phase 11 changes including `package-lock.json`, migration `005`, `scripts/verify-migrations.ts`, `Dockerfile`, CI/Pages workflows, Express 4 async error guard, AI hardening, and `phase11-release-acceptance.test.ts` are already present on `main`).
- **Superseded Pull Requests:** PR #2, PR #3, PR #4, and PR #5 are superseded by `main` (`cedab61`) and may be closed once GitHub Actions passes on `main` / this branch.

---

## Summary of Phase 12 Changes

1. **Payment Integration Readiness (`docs/PAYMENT_INTEGRATION_ARCHITECTURE.md`):**
   - Complete architecture & phased implementation plan for Stripe Checkout + PaymentIntents + US ACH Direct Debit, HMAC-SHA256 webhook verification, idempotent reconciliation, refunds/disputes, and PCI SAQ-A / RBAC boundaries.
   - Live payment processing remains **`NOT IMPLEMENTED`** until explicit owner & provider approval.
2. **Security Certification Regression Suite (`tests/phase12-security-certification.test.ts`):**
   - Verifies rejection of `alg:none` JWTs, payload-tampered HMAC tokens, and MFA privilege bypass attempts.
   - Verifies anti-session-fixation token rotation on MFA elevation and `Max-Age=0` cookie clearing on logout.
   - Verifies live HTTP `429 RATE_LIMIT_EXCEEDED` with `RateLimit-Limit`, `RateLimit-Remaining`, and `Retry-After` headers.
   - Verifies production PostgreSQL client payment self-marking fails closed with HTTP `501 PAYMENT_PROVIDER_NOT_INTEGRATED` (`liveProcessorVerified: false`) and client status bypass returns `403`.
3. **Deployment Runbook & Transfer Package (`docs/RAILWAY_PRODUCTION_CONFIG.md`, `docs/release/phase-12-release-integration.patch`):**
   - Transferable `git format-patch` artifact built cleanly off `cedab61177d38c2e3d65edde5e27f4a470347d21` and verified via `git apply --check`.

---

## Apply & Push Instructions (Authorized Workstation)

```bash
git checkout main
git pull origin main
git checkout -b development/phase-12-release-integration
git am docs/release/phase-12-release-integration.patch
npm ci && npm audit --audit-level=high && npx tsx scripts/verify-migrations.ts && npm run lint && npm test && npm run build
git push -u origin development/phase-12-release-integration
gh pr create --base main --head development/phase-12-release-integration \
  --title "Phase 12: Payment Architecture, Security Certification Tests & Release Transfer Package" \
  --body-file docs/release/PHASE_12_SYNC_AND_PR.md
```

---

## Remaining Staging Gates Required Before `RELEASE_CANDIDATE` Promotion

- [ ] Remote GitHub Actions (`verify` + `docker-build`) green on `development/phase-12-release-integration`
- [ ] Apply migrations `001`–`005` against approved staging Supabase PostgreSQL instance & verify `/ready`
- [ ] Verify live Supabase Auth registration, login, password recovery, immutable UUID binding & admin TOTP MFA in staging
- [ ] Deploy compiled Express backend (`Dockerfile` + `railway.json`) to Railway staging (`zesty-curiosity` / `CelebrationSistersEventDecor`) and verify HTTPS `/health`, `/ready`, `/api/auth/config`
- [ ] Bind GitHub Pages `VITE_API_BASE_URL` + `VITE_SUPABASE_*` variables to staging and execute desktop/tablet/mobile browser acceptance journeys
- [ ] Verify Resend domain SPF/DKIM & send one authorized staging test email
- [ ] Verify live Gemini API Concierge & Concept Studio in staging (if AI enabled)
- [ ] Explicit owner sign-off prior to merging into `main` or enabling live production credentials
