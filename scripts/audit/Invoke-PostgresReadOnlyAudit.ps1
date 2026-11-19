[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$DatabaseUrl,[string]$PsqlPath='psql',[string]$OutputDirectory='./audit-output')
$ErrorActionPreference='Stop'
if ($DatabaseUrl -notmatch '^postgres(ql)?://') { throw 'Expected PostgreSQL URI.' }
$sql=Join-Path $PSScriptRoot 'postgres-readonly.sql'
$env:PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000'
$env:PGCONNECT_TIMEOUT='10'
try {
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $report=Join-Path (Resolve-Path $OutputDirectory).Path 'postgres-audit.txt'
  $output=& $PsqlPath -X -w -v ON_ERROR_STOP=1 --dbname=$DatabaseUrl --file=$sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $report -ErrorAction SilentlyContinue
    throw 'Audit failed; database error suppressed to protect connection credentials.'
  }
  $output | Set-Content -LiteralPath $report -Encoding UTF8
  Write-Host "Audit complete: $report"
} finally {
  Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
  Remove-Item Env:PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue
}
