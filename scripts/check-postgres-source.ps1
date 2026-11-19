# Offline, read-only repository source check.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dir = Join-Path $root 'db/migrations'
$expected = 1..6 | ForEach-Object { '{0:D3}' -f $_ }
$files = @(Get-ChildItem -LiteralPath $dir -Filter '*.sql' -File | Sort-Object Name)
$actual = @($files | ForEach-Object { if ($_.Name -match '^(\d{3})_[a-z0-9_]+\.sql$') { $Matches[1] } else { throw "Invalid migration name: $($_.Name)" } })
if (($actual -join ',') -ne ($expected -join ',')) { throw "Expected versions $($expected -join ','); found $($actual -join ',')" }
foreach ($f in $files) {
  $sql = Get-Content -LiteralPath $f.FullName -Raw
  if ($sql -match '(?i)\b(DROP\s+TABLE|TRUNCATE\s+TABLE)\b') { throw "Destructive table DDL in $($f.Name)" }
}
Write-Host "PASS: $($files.Count) ordered migration files; no DROP TABLE or TRUNCATE TABLE."
