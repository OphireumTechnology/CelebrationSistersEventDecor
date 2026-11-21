# Celebration Sisters — Phase 1 Local PostgreSQL Read-Only Audit

This is **not** a remote database repair agent. GitHub-hosted CI only parses and checks the script. It never receives local PostgreSQL credentials or reaches localhost. Do not expose TCP/5432 to the internet.

## Local prerequisites

- PowerShell 7 (pwsh), PostgreSQL psql on PATH (or supply -PsqlPath).
- Existing dedicated PostgreSQL audit login with CONNECT and sufficient catalog visibility. **Never use postgres, a superuser, or a BYPASSRLS role.**
- An approved local test database, such as celebration_sisters_fresh_test.
- Store credentials in Windows' supported PostgreSQL password file or a temporary local PGPASSWORD environment variable; never commit, paste into workflow logs, or put credentials in command-line arguments.

## Manual execution (on the Windows machine)

```powershell
$env:PGHOST = 'localhost'
$env:PGPORT = '5432'
$env:PGDATABASE = 'celebration_sisters_fresh_test'
$env:PGUSER = 'celebration_auditor'
# Configure the password securely outside the repository.
pwsh -NoProfile -File ./scripts/audit-postgres-readonly.ps1 -PsqlPath 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
```

The output `artifacts/postgres-audit.json` contains only server/database/role metadata and aggregate counts, never application records. Keep the report local unless reviewed for disclosure. The script enforces a read-only transaction, session read-only mode, statement and lock timeouts, and refuses postgres/superuser/BYPASSRLS roles.

## Interpretation

- `public_dml_exposed_tables > 0` fails the audit.
- `rls_disabled_tables > 0` requires a scoped review; not every public table must use RLS.
- `migration_ledger_present = false` requires migration review; **do not automatically apply migrations**.
- No check here proves end-to-end application access, tenant isolation, backups, recovery, or production readiness.

## Safety and future automation

The GitHub Actions workflow runs on **GitHub-hosted Windows** and performs static validation only. It does not use self-hosted runners or database credentials. A future locally scheduled audit should run under a locked-down Windows service account and dedicated read-only PostgreSQL login, with controlled logs and no untrusted PR workflows. Database repairs, DDL, migrations, data deletion, production secrets and deployments remain separately approval-gated.
