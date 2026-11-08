[CmdletBinding()]
param(
  [ValidateSet('PreMigration026', 'PostMigration026')]
  [string]$Stage = 'PreMigration026',

  [Parameter(Mandatory = $true)]
  [ValidateSet('tq_release_preflight')]
  [string]$ServiceName,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ExpectedDatabase,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ExpectedServerAddress,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$ExpectedServerPort,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$PassfilePath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ServiceFilePath,

  [string]$PsqlPath = (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'),
  [string]$ExpectedSourceCommit = '8a9ab3b6a3cfa3a6652538c62673c4655b03642d'
)

$ErrorActionPreference = 'Stop'
$expectedRole = 'tq_release_preflight_reader'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (& git -C $backendRoot rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
  throw 'STOP: this utility must run from a Git checkout of the reviewed release source.'
}
$repositoryRoot = [System.IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\')

function Assert-OutsideRepository([string]$PathValue, [string]$Label) {
  $resolved = (Resolve-Path -LiteralPath $PathValue).Path
  $full = [System.IO.Path]::GetFullPath($resolved).TrimEnd('\')
  if ($full.Equals($repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      $full.StartsWith($repositoryRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: $Label must remain outside the repository."
  }
  return $full
}

if (Test-Path Env:PGPASSWORD) {
  throw 'STOP: PGPASSWORD is present in the process environment. Remove it and use the protected PGPASSFILE instead.'
}
if (-not (Test-Path -LiteralPath $PsqlPath -PathType Leaf)) { throw 'STOP: PostgreSQL 18 psql.exe was not found.' }
$passfile = Assert-OutsideRepository $PassfilePath 'PGPASSFILE'
$serviceFile = Assert-OutsideRepository $ServiceFilePath 'PGSERVICEFILE'
try { [void][System.Net.IPAddress]::Parse($ExpectedServerAddress) } catch { throw 'STOP: expected server address must be a literal IPv4 or IPv6 address.' }

$sourceHead = (& git -C $repositoryRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceHead -ne $ExpectedSourceCommit) {
  throw 'STOP: release source HEAD does not match the approved commit.'
}
$reviewedInputs = @(
  'capstone/backend/scripts/run-release-preflight.ps1',
  'capstone/backend/scripts/release-preflight-role-audit.sql',
  'capstone/backend/scripts/release-migration-026-prerequisite-preflight.sql',
  'capstone/backend/scripts/release-migration-preflight.sql',
  'capstone/backend/migrations'
)
$sourceStatus = @(& git -C $repositoryRoot status --porcelain --untracked-files=all -- $reviewedInputs 2>$null)
if ($LASTEXITCODE -ne 0 -or $sourceStatus.Count -gt 0) {
  throw 'STOP: reviewed preflight files or migrations are modified/untracked; use a clean reviewed release commit.'
}

$previousServiceFile = $env:PGSERVICEFILE
$previousPassfile = $env:PGPASSFILE
$previousPgOptions = $env:PGOPTIONS
try {
  $env:PGSERVICEFILE = $serviceFile
  $env:PGPASSFILE = $passfile
  $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'

  function Invoke-ReviewedPsqlFile([string]$FileName) {
    $file = Join-Path $PSScriptRoot $FileName
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "STOP: reviewed SQL file is missing: $FileName" }
    $arguments = @(
      '--dbname', "service=$ServiceName", '-X', '-q', '-P', 'pager=off', '-w',
      '-v', 'ON_ERROR_STOP=1',
      '-v', "expected_database=$ExpectedDatabase",
      '-v', "expected_role=$expectedRole",
      '-v', "expected_server_address=$ExpectedServerAddress",
      '-v', "expected_server_port=$ExpectedServerPort",
      '-f', $file
    )
    $output = & $PsqlPath @arguments 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) { Write-Output $line }
    if ($exitCode -ne 0) { throw "STOP: $FileName returned psql exit code $exitCode." }
  }

  Write-Output "Reviewed release source: $sourceHead"
  Write-Output 'Verified reviewed SQL and migration inputs are tracked and clean.'
  Write-Output 'Running catalog-only least-privilege role audit.'
  Invoke-ReviewedPsqlFile 'release-preflight-role-audit.sql'
  if ($Stage -eq 'PreMigration026') {
    Write-Output 'Running the read-only migration-026 prerequisite preflight.'
    Invoke-ReviewedPsqlFile 'release-migration-026-prerequisite-preflight.sql'
  } else {
    Write-Output 'Running the current-main post-migration schema preflight.'
    Invoke-ReviewedPsqlFile 'release-migration-preflight.sql'
  }
  Write-Output 'PASS: both read-only preflight scripts completed successfully.'
}
finally {
  if ($null -eq $previousServiceFile) { Remove-Item Env:PGSERVICEFILE -ErrorAction SilentlyContinue } else { $env:PGSERVICEFILE = $previousServiceFile }
  if ($null -eq $previousPassfile) { Remove-Item Env:PGPASSFILE -ErrorAction SilentlyContinue } else { $env:PGPASSFILE = $previousPassfile }
  if ($null -eq $previousPgOptions) { Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue } else { $env:PGOPTIONS = $previousPgOptions }
}
