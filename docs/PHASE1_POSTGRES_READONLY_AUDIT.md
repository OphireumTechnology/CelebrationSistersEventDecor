# Phase 1 — Read-only PostgreSQL audit

This change introduces no database migration, application code modification, credential change, or deployment.

## Local execution
Use a dedicated non-superuser, NOBYPASSRLS, SELECT-only account. Never use the postgres superuser or application write credentials.

From a trusted PowerShell terminal:
pwsh ./scripts/audit/Invoke-PostgresReadOnlyAudit.ps1 -DatabaseUrl 'postgresql://readonly@localhost:5432/celebration_sisters_fresh_test'

Avoid embedding passwords in command arguments; use a local libpq password file. URI arguments may be visible to local process monitoring. The script disables interactive password prompting, uses read-only transaction defaults, and applies statement and lock timeouts. The output directory is local and must not be committed or shared publicly.

Run static validation with:
pwsh ./scripts/audit/Test-PostgresAudit.ps1

The GitHub workflow performs only static validation; it does not connect to a database or read secrets. RLS policy metadata is not proof of tenant isolation; that requires a separately authorized identity-based test. Do not run against production without separate approval and a read-only role. Rotate any credentials previously exposed in screenshots.
