$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$sql=Get-Content (Join-Path $PSScriptRoot 'postgres-readonly.sql') -Raw
$runner=Get-Content (Join-Path $PSScriptRoot 'Invoke-PostgresReadOnlyAudit.ps1') -Raw
$workflow=Get-Content (Join-Path $root '.github/workflows/postgres-readonly-audit.yml') -Raw
if ($sql -match '(?im)^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|DO|CALL)\s') { throw 'Mutating SQL detected.' }
if ($runner -notmatch 'default_transaction_read_only=on') { throw 'Read-only enforcement missing.' }
if ($runner -notmatch '\-X \-w') { throw 'psql safety flags missing.' }
if ($workflow -match '\$\{\{\s*secrets\.') { throw 'CI must not use secrets.' }
if ($workflow -match 'railway up|deploy-pages') { throw 'Deployment prohibited.' }
Write-Host 'PASS: static read-only invariants'
