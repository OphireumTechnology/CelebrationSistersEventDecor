#Requires -Version 7.0
<#
.SYNOPSIS
  Read-only PostgreSQL security audit for Celebration Sisters.
.DESCRIPTION
  Uses an existing least-privilege PostgreSQL login. No migrations, DDL, writes,
  secrets, customer rows or backup contents are emitted.
  Requires PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD (or secure pgpass).
  This script never creates users or modifies permissions.
#>
[CmdletBinding()]
param(
  [string]$PsqlPath = 'psql',
  [string]$ReportPath = 'artifacts/postgres-audit.json'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $env:PGDATABASE -or -not $env:PGUSER) {
  throw 'PGDATABASE and PGUSER are required. Use a dedicated read-only audit account.'
}
if ($env:PGUSER -eq 'postgres') {
  throw 'Refusing to audit using the postgres superuser. Configure a dedicated read-only account.'
}
$originalOptions = $env:PGOPTIONS
try {
  # Force read-only mode even for accidental queries and enforce bounded execution.
  $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'
  $sql = @'
BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'database', current_database(),
  'audit_role', current_user,
  'server_version', current_setting('server_version'),
  'role_is_superuser', (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
  'role_bypasses_rls', (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
  'public_tables', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
  'rls_disabled_tables', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity),
  'public_dml_exposed_tables', (
    SELECT count(*) FROM pg_tables
    WHERE schemaname = 'public' AND (
      has_table_privilege('PUBLIC', format('%I.%I', schemaname, tablename), 'SELECT') OR
      has_table_privilege('PUBLIC', format('%I.%I', schemaname, tablename), 'INSERT') OR
      has_table_privilege('PUBLIC', format('%I.%I', schemaname, tablename), 'UPDATE') OR
      has_table_privilege('PUBLIC', format('%I.%I', schemaname, tablename), 'DELETE')
    )
  ),
  'migration_ledger_present', to_regclass('public.schema_migrations') IS NOT NULL
)::text;
COMMIT;
'@
  # Single psql invocation; never print a connection string or password.
  $result = @($sql | & $PsqlPath -X -q -A -t -v ON_ERROR_STOP=1 2>&1)
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL audit query failed. Check local connection and read-only role permissions.' }
  $jsonLine = @($result | Where-Object { $_ -match '^\{' })
  if ($jsonLine.Count -ne 1) { throw 'Unexpected PostgreSQL audit output.' }
  $report = $jsonLine[0] | ConvertFrom-Json
  if ($report.role_is_superuser -or $report.role_bypasses_rls) {
    throw 'Audit login is privileged; refusing to certify least-privilege access.'
  }
  $parent = Split-Path -Parent $ReportPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $report | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 -Path $ReportPath
  Write-Output "Read-only PostgreSQL audit completed. Report: $ReportPath"
  if ($report.public_dml_exposed_tables -gt 0) { throw 'PUBLIC table DML exposure detected.' }
} finally {
  $env:PGOPTIONS = $originalOptions
}
