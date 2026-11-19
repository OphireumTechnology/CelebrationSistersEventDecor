# Runs only catalog queries in a read-only transaction. No credentials in arguments.
[CmdletBinding()]
param(
  [string]$HostName = '127.0.0.1',
  [int]$Port = 5432,
  [string]$Database = 'railway',
  [string]$UserName = 'audit_reader',
  [string]$Psql = 'psql'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sqlPath = Join-Path $root 'db/audits/read_only_audit.sql'
if (-not (Test-Path $sqlPath)) { throw "Audit SQL missing: $sqlPath" }
# Do not print connection strings or passwords; use .pgpass/PGPASSFILE or prompt.
$scriptSql = Get-Content -LiteralPath $sqlPath -Raw
$wrappedSql = "BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '2s';" + [Environment]::NewLine + $scriptSql + [Environment]::NewLine + "ROLLBACK;"
$oldOptions = $env:PGOPTIONS
try {
  $env:PGOPTIONS = '-c default_transaction_read_only=on'
  $wrappedSql | & $Psql -X -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $UserName -d $Database
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL audit failed (exit $LASTEXITCODE)." }
} finally {
  $env:PGOPTIONS = $oldOptions
}
