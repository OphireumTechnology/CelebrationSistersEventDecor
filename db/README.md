# PostgreSQL source of truth

GitHub tracks the **schema and migration source**, not production records or backups.

## Canonical migrations
Run in ascending order, `001` through `006`, only after approval, backup, compatibility checks, and a staging rehearsal. These migrations contain RLS and authentication behavior and are **not** automatically applied by GitHub Actions. The existing `scripts/verify-migrations.ts` validates file order and RLS coverage without a database.

## Audit
- `scripts/check-postgres-source.ps1`: offline migration naming and destructive-DDL check.
- `scripts/audit-postgres.ps1`: opt-in live PostgreSQL catalog audit. It uses `BEGIN READ ONLY`, a read-only session default, query timeouts, and `ROLLBACK`.
- `db/audits/read_only_audit.sql`: catalog metadata and migration ledger only; no customer rows.
- `.github/workflows/postgres-source-audit.yml`: offline checks on pull requests; no secrets, DB connectivity, migrations, or deployment.

Example for an **approved staging database** with an independently provisioned, least-privilege audit role:

```powershell
./scripts/audit-postgres.ps1 -HostName 127.0.0.1 -Port 5432 -Database staging_db -UserName audit_reader
```

Do not use the PostgreSQL owner/superuser for the audit. The audit role needs SELECT on `public.schema_migrations` and access to system catalogs. Credentials must be supplied through a secure prompt or local credential mechanism, never committed or passed as command-line passwords.

## Railway compatibility
Some existing SQL migrations reference Supabase `auth.uid()`. A plain Railway PostgreSQL instance does not supply that function. Do not apply a guessed compatibility shim or modify canonical migrations on production. Review identity and RLS behavior against the backend's transaction-scoped `app.current_user_id` and `app.current_role` before approving a separately tested migration plan.

## Security and change control
Never commit `DATABASE_URL`, passwords, `.env` files, dumps, production customer data, or connection tunnel output. Rotate any credentials previously exposed in screenshots or logs. Changes to live schema, credentials, Railway variables, and deployment require separate approval.
