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

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedSourceCommit
)

function Write-PreflightDiagnosticStage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][ValidateSet('begin','complete')][string]$Phase,
    [Parameter(Mandatory=$true)][ValidateSet(
      'preflight-entry','backend-root-resolution','validator-module-path-check',
      'security-module-import','get-acl-command-resolution','validator-module-import',
      'repository-root-lookup','ambient-libpq-check','psql-path-check',
      'credential-validation','server-address-validation','source-head-lookup',
      'source-head-comparison','reviewed-input-cleanliness'
    )][string]$Operation
  )
  if ($env:TQ_RELEASE_PREFLIGHT_DIAGNOSTICS -ceq '1') {
    [Console]::Error.WriteLine("TQ_PREFLIGHT_STAGE:$Phase`:$Operation")
    [Console]::Error.Flush()
  }
}

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'preflight-entry'
$ErrorActionPreference = 'Stop'
$expectedRole = 'tq_release_preflight_reader'
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'preflight-entry'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'backend-root-resolution'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$validationModule = Join-Path $PSScriptRoot 'backupRestoreRehearsal.validation.psm1'
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'backend-root-resolution'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'validator-module-path-check'
if (-not (Test-Path -LiteralPath $validationModule -PathType Leaf)) {
  throw 'STOP: reviewed PostgreSQL credential-validation module is missing.'
}
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'validator-module-path-check'
try {
  Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'security-module-import'
  Import-Module -Name Microsoft.PowerShell.Security -ErrorAction Stop
  Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'security-module-import'

  Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'get-acl-command-resolution'
  $getAclCommand = Get-Command -Name Get-Acl -CommandType Cmdlet -ErrorAction Stop
  if ($getAclCommand.ModuleName -ne 'Microsoft.PowerShell.Security') {
    throw 'STOP: Windows PowerShell security module resolved to an unexpected ACL command.'
  }
  Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'get-acl-command-resolution'
} catch {
  if ($_.Exception.Message -like 'STOP:*') { throw }
  throw 'STOP: Windows PowerShell security module is unavailable or ACL command cannot be resolved.'
}
Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'validator-module-import'
Import-Module $validationModule -Force
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'validator-module-import'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'repository-root-lookup'
$repositoryRoot = (& git -C $backendRoot rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
  throw 'STOP: this utility must run from a Git checkout of the reviewed release source.'
}
$repositoryRoot = [System.IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\')
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'repository-root-lookup'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'ambient-libpq-check'
$ambientLibpqNames = @(
  'PGPASSWORD','PGPASSFILE','PGSERVICE','PGSERVICEFILE','PGSYSCONFDIR',
  'PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGOPTIONS','PGAPPNAME',
  'PGCONNECT_TIMEOUT','PGCLIENTENCODING','PGSSLMODE','PGREQUIRESSL','PGSSLCOMPRESSION',
  'PGSSLCERT','PGSSLKEY','PGSSLROOTCERT','PGSSLCRL','PGSSLCRLDIR','PGGSSENCMODE',
  'PGCHANNELBINDING','PGKRBSRVNAME','PGTARGETSESSIONATTRS','PGLOADBALANCEHOSTS','PGSSLNEGOTIATION'
)
$ambientLibpqVariables = @{}
foreach ($name in $ambientLibpqNames) {
  $environmentPath = 'Env:' + $name
  if (Test-Path $environmentPath) { $ambientLibpqVariables[$name] = [Environment]::GetEnvironmentVariable($name) }
}
Assert-InteractiveAuthenticationEnvironment -EnvironmentVariables $ambientLibpqVariables
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'ambient-libpq-check'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'psql-path-check'
if (-not (Test-Path -LiteralPath $PsqlPath -PathType Leaf)) { throw 'STOP: PostgreSQL 18 psql.exe was not found.' }
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'psql-path-check'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'credential-validation'
$reviewedCredentialFiles = Assert-ReviewedPreflightCredentialFiles `
  -PassfilePath $PassfilePath `
  -ServiceFilePath $ServiceFilePath `
  -RepositoryRoot $repositoryRoot `
  -ServiceName $ServiceName `
  -ExpectedUsers ([ordered]@{ tq_release_preflight = $expectedRole }) `
  -ExpectedDatabases ([ordered]@{ tq_release_preflight = $ExpectedDatabase })
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'credential-validation'
$passfile = $reviewedCredentialFiles.PassfilePath
$serviceFile = $reviewedCredentialFiles.ServiceFilePath
Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'server-address-validation'
try { [void][System.Net.IPAddress]::Parse($ExpectedServerAddress) } catch { throw 'STOP: expected server address must be a literal IPv4 or IPv6 address.' }
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'server-address-validation'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'source-head-lookup'
$sourceHead = (& git -C $repositoryRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0) {
  throw 'STOP: release source HEAD does not match the approved commit.'
}
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'source-head-lookup'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'source-head-comparison'
if ($sourceHead -ne $ExpectedSourceCommit) {
  throw 'STOP: release source HEAD does not match the approved commit.'
}
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'source-head-comparison'

Write-PreflightDiagnosticStage -Phase 'begin' -Operation 'reviewed-input-cleanliness'
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
Write-PreflightDiagnosticStage -Phase 'complete' -Operation 'reviewed-input-cleanliness'

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
