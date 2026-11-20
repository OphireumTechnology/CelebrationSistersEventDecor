# Phase 35 — Security Hardening Acceptance

**Deliverable Mapping:** `docs/phase29-35/07_SECURITY_HARDENING_ACCEPTANCE.md`  
**Audit Timestamp:** `2026-11-20T13:58Z`  
**Security Domain Status:** **PARTIALLY VERIFIED (`5/6` — `SEC-06` BLOCKED on live staging PG RLS + Supabase Auth pen-test)**

---

## 1. Security Verification Matrix

| ID | Control | Status | Evidence |
|---|---|---|---|
| `SEC-01` | CORS Allowlist, OWASP Headers & Proxy Trust | **VERIFIED** | Live Railway `OPTIONS` allowed `https://celebrationsistersdecor.com` (`204`), rejected `https://evil.example.com` (`403 CORS_ORIGIN_DENIED`); HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control: no-store`, and bounded `trust proxy = 1` confirmed. |
| `SEC-02` | Input Validation, Fuzzing & HTML Escaping | **VERIFIED** | Zod schemas enforce request validation; `escapeHtml` sanitizes all outbound email templates; malformed cookies and prototype keys (`__proto__`, `constructor`, `prototype`) safely ignored (`tests/production-hardening.test.ts` Test 76). |
| `SEC-03` | Error Sanitization & Structured Log Redaction | **VERIFIED** | `classifyDatabaseError` strips SQL/table/PII details; `/ready` sentinel tests confirm zero credential leakage; Phase 29–35 fix in `server/observability.ts` restores non-PII `emailProvider`/`emailLiveEnabled` startup visibility while continuing to redact all email PII and secret tokens (`tests/phase29-35-readiness-hardening.test.ts` Test 73). |
| `SEC-04` | Phase 28 Payment Fail-Closed Boundary | **VERIFIED** | Production client milestone self-payment endpoint returns `501 PAYMENT_PROVIDER_NOT_INTEGRATED`. |
| `SEC-05` | Blocking Dependency Audit (`npm audit --audit-level=high`) | **VERIFIED** | Passed on identical `package.json` dependency graph in GitHub Actions Run `44679267813` (`main` `288d20ea`). Static secret scan (`ci.yml` regex) returned `0` matches across `src`, `server`, `scripts`, `docs`. |
| `SEC-06` | Live Staging Cross-Account RLS & Supabase JWT Pen-Test | **BLOCKED** | Requires isolated staging PostgreSQL (`verify-staging-postgres.ts` 10-point `NOBYPASSRLS` suite) and live staging Supabase Auth test accounts. |

---

## 2. Frontend Bundle Secret Audit

Audited live production asset `https://celebrationsistersdecor.com/assets/index-Bjd91YG6.js` (`461,720` bytes):
- Zero Supabase service-role keys, zero Resend API keys, zero webhook secrets, zero query-string token leaks (`hasQueryTokenLeak: false`, `hasServiceRoleLeak: false`).
