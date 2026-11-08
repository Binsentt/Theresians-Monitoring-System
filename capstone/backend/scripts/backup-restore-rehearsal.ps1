[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('CreateProductionBackup', 'RestoreIsolated')]
  [string]$Action,

  [string]$BackupServiceName = 'tq_prod_backup',
  [string]$RestoreServiceName = 'tq_restore_local',
  [string]$ExpectedDatabase,
  [string]$ExpectedServerAddress,
  [ValidateRange(1, 65535)]
  [int]$ExpectedServerPort = 5432,
  [string]$PassfilePath,
  [string]$ServiceFilePath,
  [string]$BackupDirectory,
  [string]$ArchivePath,
  [string]$ExpectedArchiveSha256,
  [string]$ApprovalReference,
  [string]$ExpectedSourceCommit = '8a9ab3b6a3cfa3a6652538c62673c4655b03642d',
  [switch]$EncryptedStorageConfirmed,
  [switch]$ExecuteApprovedProductionBackup,
  [switch]$ExecuteIsolatedRestore,
  [string]$PsqlPath = (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'),
  [string]$PgDumpPath = (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\pg_dump.exe'),
  [string]$PgRestorePath = (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\pg_restore.exe')
)

$ErrorActionPreference = 'Stop'
$backupRole = 'tq_prod_backup_reader'
$restoreRole = 'tq_restore_operator'
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (& git -C $backendRoot rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) { throw 'STOP: utility must run from the reviewed Git worktree.' }
$repositoryRoot = [System.IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\')

function Resolve-PathOutsideRepository([string]$PathValue, [string]$Label) {
  $resolved = (Resolve-Path -LiteralPath $PathValue).Path
  $full = [System.IO.Path]::GetFullPath($resolved).TrimEnd('\')
  if ($full.Equals($repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      $full.StartsWith($repositoryRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: $Label must remain outside the repository."
  }
  return $full
}

function Assert-OperatorConnectionFiles {
  if (Test-Path Env:PGPASSWORD) { throw 'STOP: remove PGPASSWORD and use the protected PGPASSFILE.' }
  if (-not $PassfilePath -or -not (Test-Path -LiteralPath $PassfilePath -PathType Leaf)) { throw 'STOP: a protected PGPASSFILE is required.' }
  if (-not $ServiceFilePath -or -not (Test-Path -LiteralPath $ServiceFilePath -PathType Leaf)) { throw 'STOP: a PGSERVICEFILE is required.' }
  [void](Resolve-PathOutsideRepository $PassfilePath 'PGPASSFILE')
  [void](Resolve-PathOutsideRepository $ServiceFilePath 'PGSERVICEFILE')
  foreach ($tool in @($PsqlPath, $PgDumpPath, $PgRestorePath)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'STOP: PostgreSQL 18 client tools are incomplete.' }
  }
}

function Invoke-PsqlAudit([string]$Service, [string]$Role, [string]$SqlFile) {
  $arguments = @(
    '--dbname', "service=$Service", '-X', '-q', '-P', 'pager=off', '-w',
    '-v', 'ON_ERROR_STOP=1',
    '-v', "expected_database=$ExpectedDatabase",
    '-v', "expected_role=$Role",
    '-v', "expected_server_address=$ExpectedServerAddress",
    '-v', "expected_server_port=$ExpectedServerPort",
    '-f', (Join-Path $PSScriptRoot $SqlFile)
  )
  $output = & $PsqlPath @arguments 2>&1
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) { Write-Output $line }
  if ($exitCode -ne 0) { throw "STOP: $SqlFile failed with psql exit code $exitCode." }
}

function Assert-StoragePath([string]$PathValue) {
  $full = Resolve-PathOutsideRepository $PathValue 'backup or restore artifact'
  $temporaryRoots = @($env:TEMP, $env:TMP, $env:RUNNER_TEMP) | Where-Object { $_ }
  foreach ($tempRoot in $temporaryRoots) {
    $tempFull = [System.IO.Path]::GetFullPath($tempRoot).TrimEnd('\')
    if ($full.Equals($tempFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith($tempFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'STOP: backup artifacts cannot be stored in a temporary or CI directory.'
    }
  }
  return $full
}

Assert-OperatorConnectionFiles
if (-not $ExpectedSourceCommit -or $ExpectedSourceCommit -notmatch '^[a-f0-9]{40}$') {
  throw 'STOP: an exact reviewed release source commit is required.'
}
$sourceHead = (& git -C $repositoryRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceHead -ne $ExpectedSourceCommit) {
  throw 'STOP: backup/restore source HEAD does not match the reviewed release commit.'
}
$reviewedInputs = @(
  'capstone/backend/scripts/backup-restore-rehearsal.ps1',
  'capstone/backend/scripts/backup-role-preflight.sql',
  'capstone/backend/scripts/release-migration-preflight.sql',
  'capstone/backend/scripts/release-migration-026-prerequisite-preflight.sql',
  'capstone/backend/migrations'
)
$sourceStatus = @(& git -C $repositoryRoot status --porcelain --untracked-files=all -- $reviewedInputs 2>$null)
if ($LASTEXITCODE -ne 0 -or $sourceStatus.Count -gt 0) {
  throw 'STOP: backup/preflight files or migrations are modified/untracked; use a clean reviewed release commit.'
}
if ($BackupServiceName -ne 'tq_prod_backup') { throw 'STOP: production backups must use the dedicated tq_prod_backup service alias.' }
if ($RestoreServiceName -ne 'tq_restore_local') { throw 'STOP: restore must use the isolated tq_restore_local service alias.' }
if (-not $ExpectedDatabase -or -not $ExpectedServerAddress) { throw 'STOP: approved database identity inputs are required.' }

$previousServiceFile = $env:PGSERVICEFILE
$previousPassfile = $env:PGPASSFILE
$previousPgOptions = $env:PGOPTIONS
try {
  $env:PGSERVICEFILE = (Resolve-PathOutsideRepository $ServiceFilePath 'PGSERVICEFILE')
  $env:PGPASSFILE = (Resolve-PathOutsideRepository $PassfilePath 'PGPASSFILE')

  if ($Action -eq 'CreateProductionBackup') {
    if (-not $ExecuteApprovedProductionBackup) { throw 'STOP: add -ExecuteApprovedProductionBackup only after a separate, explicit backup approval.' }
    if (-not $EncryptedStorageConfirmed) { throw 'STOP: confirm the external backup destination is encrypted and access-restricted.' }
    if ($ApprovalReference -notmatch '^[A-Za-z0-9._:/-]{3,128}$') { throw 'STOP: a separately approved change/reference ID is required.' }
    if (-not (Test-Path -LiteralPath $BackupDirectory -PathType Container)) { throw 'STOP: create and verify the encrypted backup directory before use.' }
    $destination = Assert-StoragePath $BackupDirectory
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $archive = Join-Path $destination "theresians-production-$stamp.dump"
    $partial = "$archive.partial"
    $dumpLog = "$archive.pg_dump.log"
    $tocPath = "$archive.toc.txt"
    $hashPath = "$archive.sha256.txt"
    if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $partial)) { throw 'STOP: refusing to overwrite an existing archive.' }

    $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'
    Write-Output "Approval reference: $ApprovalReference"
    Write-Output 'Running the fixed catalog-only backup role audit.'
    Invoke-PsqlAudit $BackupServiceName $backupRole 'backup-role-preflight.sql'

    Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
    $dumpArguments = @(
      '--no-password', '--format=custom', '--compress=6', '--lock-wait-timeout=5s',
      "--file=$partial", "--dbname=service=$BackupServiceName"
    )
    & $PgDumpPath @dumpArguments 2> $dumpLog
    $dumpExit = $LASTEXITCODE
    if ($dumpExit -ne 0) { throw "STOP: pg_dump failed (exit $dumpExit); partial archive and protected log were retained." }
    Move-Item -LiteralPath $partial -Destination $archive

    & $PgRestorePath '--list' $archive 1> $tocPath 2> "$archive.pg_restore-list.log"
    $listExit = $LASTEXITCODE
    if ($listExit -ne 0) { throw "STOP: pg_restore could not list the archive (exit $listExit); archive and logs were retained." }
    $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText($hashPath, "$digest  $([System.IO.Path]::GetFileName($archive))`r`n", [System.Text.UTF8Encoding]::new($false))
    Write-Output "PASS: custom archive created and TOC validated. SHA256=$digest"
    Write-Output 'Keep the archive, digest, and logs only in the approved encrypted operations storage.'
    return
  }

  if ($Action -eq 'RestoreIsolated') {
    if (-not $ExecuteIsolatedRestore) { throw 'STOP: add -ExecuteIsolatedRestore only for an approved disposable restore rehearsal.' }
    if (-not $EncryptedStorageConfirmed) { throw 'STOP: confirm the source archive is on encrypted, access-restricted storage.' }
    if (-not $ArchivePath -or -not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw 'STOP: provide an existing archive outside the repository.' }
    if ($ExpectedArchiveSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'STOP: expected archive SHA256 is required.' }
    $archive = Resolve-PathOutsideRepository $ArchivePath 'backup archive'
    $actualDigest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actualDigest -ine $ExpectedArchiveSha256) { throw 'STOP: archive checksum does not match the approved digest.' }
    $tocPath = "$archive.restore-input.toc.txt"
    & $PgRestorePath '--list' $archive 1> $tocPath 2> "$archive.restore-input-list.log"
    if ($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $tocPath).Length -eq 0) {
      throw 'STOP: backup archive TOC could not be verified before restore.'
    }
    $restoreDatabase = $ExpectedDatabase
    if ($restoreDatabase -notmatch '^tq_restore_[a-z0-9_]+$') { throw 'STOP: restore database must use the tq_restore_* isolated-name allowlist.' }
    $parsedAddress = [System.Net.IPAddress]::Parse($ExpectedServerAddress)
    if (-not [System.Net.IPAddress]::IsLoopback($parsedAddress)) { throw 'STOP: restore server address must be loopback.' }

    $targetSql = @'
BEGIN READ ONLY;
SELECT current_database(), current_user, COALESCE(host(inet_server_addr()), ''), inet_server_port(),
       (SELECT COUNT(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p','v','m','f','S')),
       (SELECT COUNT(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'),
       (SELECT COUNT(*) FROM pg_catalog.pg_namespace n WHERE n.nspname <> 'public' AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'),
       COALESCE(has_schema_privilege(current_user, 'public', 'CREATE'), false),
       COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit
                        OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=role_row.oid)
                 FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname=current_user), true);
ROLLBACK;
'@
    $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'
    $targetOutput = & $PsqlPath '--dbname' "service=$RestoreServiceName" '-X' '-q' '-A' '-t' '-F' '|' '-w' '--command' $targetSql 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'STOP: isolated restore target metadata check failed.' }
    $targetRows = @($targetOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($targetRows.Count -ne 1) { throw 'STOP: isolated restore target metadata was not a single aggregate row.' }
    $targetRow = $targetRows[0]
    $fields = ([string]$targetRow).Trim().Split('|')
    if ($fields.Count -ne 9 -or $fields[0] -cne $restoreDatabase -or $fields[1] -cne $restoreRole -or
        $fields[2] -cne $ExpectedServerAddress -or $fields[3] -cne [string]$ExpectedServerPort -or
        $fields[4] -ne '0' -or $fields[5] -ne '0' -or $fields[6] -ne '0' -or
        $fields[7] -ne 't' -or $fields[8] -ne 'f') {
      throw 'STOP: isolated restore target is not the approved empty loopback database with a non-inheriting, non-admin local restore role.'
    }

    Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
    $restoreLog = "$archive.restore.log"
    $restoreArguments = @(
      '--no-password', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges',
      "--dbname=service=$RestoreServiceName", $archive
    )
    & $PgRestorePath @restoreArguments 1> $restoreLog 2> "$archive.restore-error.log"
    if ($LASTEXITCODE -ne 0) { throw 'STOP: isolated pg_restore failed; inspect the restricted restore logs.' }

    $verifySql = @'
BEGIN READ ONLY;
SELECT current_database() = :'expected_database'
       AND current_user = :'expected_role'
       AND to_regclass('public.schema_migrations') IS NOT NULL
       AND to_regclass('public.game_progress_save_commits') IS NOT NULL AS restored_schema_ready,
       (SELECT COUNT(*) FROM public.schema_migrations WHERE version BETWEEN 18 AND 26)::integer AS release_ledger_row_count,
       (SELECT MAX(version) FROM public.schema_migrations WHERE version BETWEEN 18 AND 26) AS latest_release_ledger_version;
ROLLBACK;
'@
    $verifyOutput = & $PsqlPath '--dbname' "service=$RestoreServiceName" '-X' '-q' '-A' '-t' '-F' '|' '-w' '-v' 'ON_ERROR_STOP=1' '-v' "expected_database=$restoreDatabase" '-v' "expected_role=$restoreRole" '--command' $verifySql 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'STOP: restored database verification query failed.' }
    $verifyRows = @($verifyOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($verifyRows.Count -ne 1) { throw 'STOP: restored database verification did not return a single aggregate row.' }
    $verifyRow = $verifyRows[0]
    $verifyFields = ([string]$verifyRow).Trim().Split('|')
    if ($verifyFields.Count -ne 3 -or $verifyFields[0] -ne 't' -or $verifyFields[1] -ne '9' -or $verifyFields[2] -ne '26') {
      throw 'STOP: restored database did not meet the release-schema and migration-ledger checks.'
    }
    Write-Output 'PASS: archive checksum, isolated empty target, single-transaction restore, and metadata-only readiness query passed.'
    Write-Output 'The restore intentionally does not recreate cluster roles or restore into production.'
  }
}
finally {
  if ($null -eq $previousServiceFile) { Remove-Item Env:PGSERVICEFILE -ErrorAction SilentlyContinue } else { $env:PGSERVICEFILE = $previousServiceFile }
  if ($null -eq $previousPassfile) { Remove-Item Env:PGPASSFILE -ErrorAction SilentlyContinue } else { $env:PGPASSFILE = $previousPassfile }
  if ($null -eq $previousPgOptions) { Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue } else { $env:PGOPTIONS = $previousPgOptions }
}
