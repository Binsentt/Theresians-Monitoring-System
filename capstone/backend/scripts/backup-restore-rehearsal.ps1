[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('CreateProductionBackup', 'RestoreIsolated')]
  [string]$Action,

  [string]$BackupServiceName = 'tq_prod_backup',
  [string]$RestoreServiceName = 'tq_restore_local',
  [Parameter(Mandatory = $true)]
  [string]$ExpectedDatabase,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedServerAddress,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$ExpectedServerPort,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$ExpectedTunnelPort,
  [string]$ServiceFilePath,
  [string]$BackupDirectory,
  [string]$ArchivePath,
  [string]$ExpectedArchiveSha256,
  [string]$ApprovalReference,
  [string]$BackupRoleReviewEvidencePath,
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string]$ExpectedBackupRoleReviewerKeySha256,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{40}$')]
  [string]$ExpectedToolSourceCommit,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{40}$')]
  [string]$ExpectedProductionApplicationCommit,
  [switch]$EncryptedStorageConfirmed,
  [switch]$ExecuteApprovedProductionBackup,
  [switch]$ExecuteIsolatedRestore,
  [string]$PsqlPath = (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'),
  [string]$PgDumpPath = (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\pg_dump.exe'),
  [string]$PgRestorePath = (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\pg_restore.exe'),
  [string]$PgConfigPath = (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\pg_config.exe')
)

$ErrorActionPreference = 'Stop'
$backupRole = 'tq_prod_backup_reader'
$restoreRole = 'tq_restore_operator'
$script:InteractivePassfilePath = $null
$script:ExportedBackupSnapshot = $null
$storageSafetyModule = Join-Path $PSScriptRoot 'backupStorageSafety.validation.psm1'
if (-not (Test-Path -LiteralPath $storageSafetyModule -PathType Leaf)) { throw 'STOP: reviewed storage-safety validator is missing.' }
$backendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (& git -C $backendRoot rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) { throw 'STOP: utility must run from the reviewed Git worktree.' }
$repositoryRoot = [System.IO.Path]::GetFullPath($repositoryRoot)

function Resolve-PathOutsideRepository([string]$PathValue, [string]$Label) {
  if ($PathValue -match '^[A-Za-z]:(?![\\/])') { throw 'STOP: drive-relative storage paths are forbidden.' }
  $resolved = (Resolve-Path -LiteralPath $PathValue).Path
  $full = ConvertTo-TqCanonicalStoragePath $resolved
  if (Test-TqPathWithinRoot -Path $full -Root $repositoryRoot) {
    throw "STOP: $Label must remain outside the repository."
  }
  return $full
}

function Assert-NoReparsePath([string]$PathValue) {
  Assert-TqNoReparsePath -Path $PathValue
}

function Get-ApprovedStorageSids {
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  return @{
    Current = $current
    System = 'S-1-5-18'
    Administrators = 'S-1-5-32-544'
  }
}

function Assert-RestrictedStorageAcl([string]$PathValue, [ValidateSet('ReadOnly', 'ReadWrite', 'Modify')][string]$RequiredAccess, [bool]$RequireProtectedDacl) {
  Assert-NoReparsePath $PathValue
  try { $acl = Get-Acl -LiteralPath $PathValue -ErrorAction Stop }
  catch { throw 'STOP: restricted storage ACL could not be read.' }
  $approved = Get-ApprovedStorageSids
  try { $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
  catch { throw 'STOP: storage owner could not be verified.' }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  Assert-TqRestrictedAclRules -Rules $rules -ApprovedSids $approved -OwnerSid $ownerSid -RequiredAccess $RequiredAccess -RequireProtectedDacl $RequireProtectedDacl -AreAccessRulesProtected $acl.AreAccessRulesProtected
}

function Assert-EncryptedLocalVolume([string]$PathValue) {
  $full = [System.IO.Path]::GetFullPath($PathValue)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($root -notmatch '^[A-Za-z]:\\$') { throw 'STOP: encrypted storage must be a verified local Windows volume.' }
  try { $drive = [System.IO.DriveInfo]::new($root) }
  catch { throw 'STOP: local storage volume type and filesystem could not be verified.' }
  if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -cne 'NTFS') {
    throw 'STOP: backup and restore storage must be on a fixed NTFS volume.'
  }
  if (-not (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue)) {
    throw 'STOP: BitLocker status cannot be verified on this system.'
  }
  try { $volume = Get-BitLockerVolume -MountPoint $root -ErrorAction Stop }
  catch { throw 'STOP: BitLocker encryption/protection status could not be verified.' }
  if ($volume.VolumeStatus -ne 'FullyEncrypted' -or $volume.ProtectionStatus -ne 'On' -or [int]$volume.EncryptionPercentage -ne 100) {
    throw 'STOP: backup or restored Student data must be on a fully encrypted, BitLocker-protected volume.'
  }
}

function Assert-SufficientFreeSpace([string]$PathValue, [long]$DataBytes) {
  if ($DataBytes -le 0) { throw 'STOP: aggregate database/archive size is unavailable; refusing to estimate storage.' }
  $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($PathValue))
  try { $available = ([System.IO.DriveInfo]::new($root)).AvailableFreeSpace }
  catch { throw 'STOP: destination free space could not be verified.' }
  $required = [decimal]$DataBytes * 2 + 1GB
  if ([decimal]$available -lt $required) {
    throw 'STOP: destination lacks the conservative free-space reserve of twice the source size plus 1 GiB.'
  }
}

function Read-PgServiceSection([string]$Alias, [string]$ResolvedServiceFile) {
  $inside = $false
  $settings = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($ResolvedServiceFile, [System.Text.UTF8Encoding]::new($false, $true))) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or $trimmed.StartsWith(';')) { continue }
    if ($trimmed -match '^\[([^\]]+)\]$') {
      if ($inside) { break }
      $inside = $Matches[1] -ceq $Alias
      continue
    }
    if (-not $inside) { continue }
    if ($trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      throw 'STOP: PGSERVICEFILE contains an invalid entry in the selected alias.'
    }
    $key = $Matches[1].ToLowerInvariant()
    $value = $Matches[2].Trim().Trim('"').Trim("'")
    if ($settings.ContainsKey($key)) { throw 'STOP: PGSERVICEFILE has duplicate keys in the selected alias.' }
    if ($key -in @('password', 'sslpassword', 'passfile')) { throw 'STOP: credentials and passfile paths are not allowed in PGSERVICEFILE.' }
    $settings[$key] = $value
  }
  if (-not $inside -or $settings.Count -eq 0) { throw 'STOP: required PGSERVICEFILE alias is missing or empty.' }
  return $settings
}

function Assert-PgServiceConfiguration([string]$Alias, [string]$ExpectedRole, [bool]$IsProduction) {
  $resolvedFile = Resolve-PathOutsideRepository $ServiceFilePath 'PGSERVICEFILE'
  [void](Assert-StoragePath $resolvedFile)
  Assert-RestrictedStorageAcl $resolvedFile 'ReadOnly' $true
  $settings = Read-PgServiceSection $Alias $resolvedFile
  if ($settings.user -cne $ExpectedRole -or $settings.dbname -cne $ExpectedDatabase -or -not $settings.host) {
    throw 'STOP: selected PGSERVICEFILE alias does not match the approved database/role inputs.'
  }
  if ($IsProduction) {
    if (-not $ExpectedTunnelPort -or $ExpectedTunnelPort -lt 1 -or $ExpectedTunnelPort -gt 65535) {
      throw 'STOP: the verified local SSH tunnel port must be supplied explicitly.'
    }
    $service = [pscustomobject]@{ ServiceName = $Alias; Settings = $settings }
    Assert-TqPgServiceSettings -Service $service -ExpectedServiceName $BackupServiceName -ExpectedDatabase $ExpectedDatabase -ExpectedRole $backupRole -ExpectedTunnelPort $ExpectedTunnelPort -ExpectedCaPath $settings.sslrootcert
    $currentUserSid = (Get-ApprovedStorageSids).Current
    [void](Assert-TqProtectedLocalFile -PathValue $resolvedFile -Label 'PGSERVICEFILE' -RepositoryRoot $repositoryRoot -CurrentUserSid $currentUserSid)
    $rootCertificate = Resolve-PathOutsideRepository $settings.sslrootcert 'PostgreSQL TLS root certificate'
    [void](Assert-StoragePath $rootCertificate)
    [void](Assert-TqProtectedLocalFile -PathValue $rootCertificate -Label 'PostgreSQL TLS root certificate' -RepositoryRoot $repositoryRoot -CurrentUserSid $currentUserSid)
    $certificateMetadata = Get-TqRootCertificateMetadata -CertificatePath $rootCertificate
    Assert-TqPinnedPostgresRootCertificate -Metadata $certificateMetadata
  } else {
    if ($settings.host -cne 'localhost' -or $settings.hostaddr -cne '127.0.0.1' -or $settings.port -cne [string]$ExpectedTunnelPort) {
      throw 'STOP: isolated restore service must bind to localhost/127.0.0.1 and the exact approved restore port.'
    }
  }
  return $settings
}
function Assert-OperatorConnectionFiles {
  if ((Test-Path Env:PGPASSWORD) -or (Test-Path Env:PGPASSFILE)) {
    throw 'STOP: clear PGPASSWORD and PGPASSFILE environment overrides; the PostgreSQL clients must request the password interactively.'
  }
  if (-not $ServiceFilePath -or -not (Test-Path -LiteralPath $ServiceFilePath -PathType Leaf)) { throw 'STOP: a PGSERVICEFILE is required.' }
  foreach ($tool in @($PsqlPath, $PgDumpPath, $PgRestorePath, $PgConfigPath)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'STOP: PostgreSQL 18 client tools are incomplete.' }
  }
}

function Set-InteractivePassfileOverride([string]$ResolvedServiceFile) {
  $serviceDirectory = Split-Path -LiteralPath $ResolvedServiceFile -Parent
  Assert-RestrictedStorageAcl $serviceDirectory 'Modify' $true
  $candidate = Join-Path $serviceDirectory ('.tq-prompt-only-' + [guid]::NewGuid().ToString('N') + '.pgpass')
  if (Test-Path -LiteralPath $candidate) { throw 'STOP: prompt-only PostgreSQL passfile path unexpectedly exists.' }
  $script:InteractivePassfilePath = $candidate
  # Pin libpq to a guaranteed-absent file in a protected directory. This
  # prevents it from falling back to the Windows profile pgpass.conf while
  # leaving interactive password prompting enabled; no password file is made.
  $env:PGPASSFILE = $candidate
}

function Assert-InteractivePassfileAbsent {
  if ($script:InteractivePassfilePath -and (Test-Path -LiteralPath $script:InteractivePassfilePath)) {
    throw 'STOP: the protected prompt-only passfile path was unexpectedly created; do not continue or inspect it in logs.'
  }
}

function Read-BoundedSnapshotOutputLine([System.IO.StreamReader]$Reader, [datetime]$DeadlineUtc, [System.Diagnostics.Process]$Process) {
  if ($Process.HasExited) { throw 'STOP: exported snapshot psql process exited before publishing its readiness record.' }
  $remaining = [int][Math]::Max(1, [Math]::Ceiling(($DeadlineUtc - [DateTime]::UtcNow).TotalMilliseconds))
  $lineTask = $Reader.ReadLineAsync()
  try {
    if (-not $lineTask.Wait($remaining)) { throw 'STOP: exported snapshot readiness output timed out.' }
    return $lineTask.GetAwaiter().GetResult()
  } catch {
    if ($_.Exception.Message -like 'STOP:*') { throw }
    throw 'STOP: exported snapshot readiness output could not be read.'
  }
}

function Start-ExportedBackupSnapshot([string]$Service) {
  if ($Service -notmatch '^[A-Za-z0-9_.-]{1,63}$') { throw 'STOP: exported snapshot service alias is invalid.' }
  $serviceFile = Resolve-PathOutsideRepository $ServiceFilePath 'PGSERVICEFILE'
  $serviceDirectory = Split-Path -LiteralPath $serviceFile -Parent
  Assert-RestrictedStorageAcl $serviceDirectory 'Modify' $true
  $snapshotSqlPath = Join-Path $serviceDirectory ('.tq-exported-snapshot-' + [guid]::NewGuid().ToString('N') + '.sql')
  if (Test-Path -LiteralPath $snapshotSqlPath) { throw 'STOP: exported snapshot SQL path unexpectedly exists.' }
  $snapshotSql = @'
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_catalog.pg_export_snapshot();
\echo TQ_BACKUP_SNAPSHOT_READY
SELECT pg_catalog.pg_sleep(900);
ROLLBACK;
'@
  Write-NewProtectedTextFile $snapshotSqlPath $snapshotSql
  $process = $null
  try {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $PsqlPath
    $startInfo.Arguments = "--dbname=service=$Service -X -q -A -t --set=ON_ERROR_STOP=1 --file=`"$snapshotSqlPath`""
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $false
    $startInfo.RedirectStandardInput = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.EnvironmentVariables['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=0 -c lock_timeout=2000'
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'STOP: exported snapshot psql process did not start.' }
    $deadlineUtc = [DateTime]::UtcNow.AddSeconds(30)
    $snapshotId = $null
    $ready = $false
    while (-not $ready) {
      $line = Read-BoundedSnapshotOutputLine -Reader $process.StandardOutput -DeadlineUtc $deadlineUtc -Process $process
      if ($null -eq $line) { throw 'STOP: exported snapshot psql process closed output before readiness.' }
      if (-not $snapshotId -and $line -match '^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+$') {
        $snapshotId = $line
        continue
      }
      if ($line -ceq 'TQ_BACKUP_SNAPSHOT_READY' -and $snapshotId) { $ready = $true; continue }
      throw 'STOP: exported snapshot psql process returned an unexpected readiness record.'
    }
    $snapshot = [pscustomobject]@{ Process = $process; SnapshotId = $snapshotId; ScriptPath = $snapshotSqlPath }
    Assert-ExportedBackupSnapshotAlive $snapshot
    return $snapshot
  } catch {
    if ($process) {
      try {
        if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(10000) }
      } catch { }
      try { $process.Dispose() } catch { }
    }
    if (Test-Path -LiteralPath $snapshotSqlPath) {
      try { Remove-Item -LiteralPath $snapshotSqlPath -Force -ErrorAction Stop } catch { throw 'STOP: snapshot setup failed and its protected temporary SQL file could not be removed.' }
    }
    if ($_.Exception.Message -like 'STOP:*') { throw }
    throw 'STOP: exported PostgreSQL snapshot could not be established.'
  }
}

function Assert-ExportedBackupSnapshotAlive([object]$Snapshot) {
  if (-not $Snapshot -or -not $Snapshot.Process -or $Snapshot.Process.HasExited -or
      [string]$Snapshot.SnapshotId -notmatch '^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+$') {
    throw 'STOP: exported snapshot transaction ended or its identifier is invalid.'
  }
}

function Stop-ExportedBackupSnapshot([object]$Snapshot) {
  if (-not $Snapshot) { return }
  $cleanupFailed = $false
  try {
    if ($Snapshot.Process -and -not $Snapshot.Process.HasExited) {
      try {
        $Snapshot.Process.Kill()
        if (-not $Snapshot.Process.WaitForExit(10000)) { $cleanupFailed = $true }
      } catch { $cleanupFailed = $true }
    }
    if ($Snapshot.Process -and -not $Snapshot.Process.HasExited) { $cleanupFailed = $true }
    if ($Snapshot.ScriptPath -and (Test-Path -LiteralPath $Snapshot.ScriptPath)) {
      try { Remove-Item -LiteralPath $Snapshot.ScriptPath -Force -ErrorAction Stop }
      catch { $cleanupFailed = $true }
    }
    if ($Snapshot.ScriptPath -and (Test-Path -LiteralPath $Snapshot.ScriptPath)) { $cleanupFailed = $true }
  } finally {
    if ($Snapshot.Process) { $Snapshot.Process.Dispose() }
  }
  $script:ExportedBackupSnapshot = $null
  if ($cleanupFailed) { throw 'STOP: exported snapshot cleanup could not be independently verified.' }
}

function Get-VerifiedToolVersions {
  $versions = @{}
  foreach ($entry in @(
    @{ Name = 'psql'; Path = $PsqlPath },
    @{ Name = 'pg_dump'; Path = $PgDumpPath },
    @{ Name = 'pg_restore'; Path = $PgRestorePath },
    @{ Name = 'pg_config'; Path = $PgConfigPath }
  )) {
    $versionOutput = @(& $entry.Path --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or ($versionOutput -join ' ') -notmatch '(?:PostgreSQL\)\s*|PostgreSQL\s+)18(?:\.|\s|$)') {
      throw 'STOP: every PostgreSQL client tool must be verified as major version 18.'
    }
    $versions[$entry.Name] = ($versionOutput -join ' ').Trim()
  }
  return $versions
}

function Write-NewProtectedTextFile([string]$PathValue, [string]$Contents) {
  $encoding = [System.Text.UTF8Encoding]::new($false)
  $bytes = $encoding.GetBytes($Contents)
  $stream = [System.IO.FileStream]::new($PathValue, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  Assert-ArtifactAcl $PathValue 'ReadWrite'
}

function Get-ReleaseReadiness([object]$Before, [object]$After) {
  if ($Before.Readiness -in @('PRE_MIGRATION_026', 'POST_MIGRATION_026') -and
      $Before.Readiness -ceq $After.Readiness -and
      $Before.Fingerprint -match '^[a-f0-9]{32}$' -and
      $Before.Fingerprint -ceq $After.Fingerprint) {
    return $Before.Readiness
  }
  return 'UNVERIFIED'
}

function Invoke-PsqlAudit([string]$Service, [string]$Role, [string]$SqlFile) {
  $arguments = @(
    '--dbname', "service=$Service", '-X', '-q', '-P', 'pager=off',
    '-v', 'ON_ERROR_STOP=1',
    '-v', "expected_database=$ExpectedDatabase",
    '-v', "expected_role=$Role",
    '-v', "expected_server_address=$ExpectedServerAddress",
    '-v', "expected_server_port=$ExpectedServerPort",
    '-f', (Join-Path $PSScriptRoot $SqlFile)
  )
  $output = @(& $PsqlPath @arguments 2>&1)
  $exitCode = $LASTEXITCODE
  Assert-InteractivePassfileAbsent
  $text = $output -join [Environment]::NewLine
  foreach ($line in $output) {
    if ([string]$line -notmatch '(?m)^BACKUP_ROLE_ROUTINE_INVENTORY_SHA256=') { Write-Host ([string]$line) }
  }
  if ($exitCode -ne 0) { throw "STOP: $SqlFile failed with psql exit code $exitCode." }

  $catalogPass = [regex]::Matches($text, '(?m)^CATALOG_PRIVILEGE_CHECKS=PASS\s*$')
  $sideEffectUnknown = [regex]::Matches($text, '(?m)^OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED:[^\r\n]+$')
  $sideEffectPass = [regex]::Matches($text, '(?m)^OVERALL_BACKUP_ROLE_NONWRITING=PASS\s*$')
  $inventory = [regex]::Matches($text, '(?m)^BACKUP_ROLE_ROUTINE_INVENTORY_SHA256=([a-f0-9]{64})\s*$')
  if ($catalogPass.Count -ne 1 -or $sideEffectUnknown.Count -ne 1 -or $sideEffectPass.Count -ne 0 -or $inventory.Count -ne 1) {
    throw 'STOP: backup-role audit output is missing, duplicate, contradictory, or does not bind an external routine-side-effect review.'
  }
  return [pscustomobject]@{
    CatalogStatus = 'PASS'
    SideEffectStatus = 'UNVERIFIED'
    RoutineInventorySha256 = $inventory[0].Groups[1].Value
  }
}

function Get-VerifiedBackupRoleReview([string]$RoutineInventorySha256) {
  if (-not $BackupRoleReviewEvidencePath -or $ExpectedBackupRoleReviewerKeySha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'STOP: signed, unexpired independent backup-role side-effect review evidence and its separately approved key fingerprint are required.'
  }
  $evidencePath = Resolve-PathOutsideRepository $BackupRoleReviewEvidencePath 'backup-role review evidence'
  [void](Assert-StoragePath $evidencePath)
  Assert-RestrictedStorageAcl $evidencePath 'ReadOnly' $true
  $evidenceItem = Get-Item -LiteralPath $evidencePath -Force -ErrorAction Stop
  if ($evidenceItem.Length -le 0 -or $evidenceItem.Length -gt 16384) {
    throw 'STOP: backup-role review evidence must be a non-empty file no larger than 16 KiB.'
  }
  try {
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    $evidenceText = [System.IO.File]::ReadAllText($evidencePath, $encoding)
  } catch {
    throw 'STOP: backup-role review evidence is not strict UTF-8.'
  }
  $review = Assert-TqBackupRoleReviewEvidence -EvidenceText $evidenceText -ExpectedDatabase $ExpectedDatabase -ExpectedServerAddress $ExpectedServerAddress -ExpectedServerPort $ExpectedServerPort -ExpectedToolSourceSha $ExpectedToolSourceCommit -ExpectedApplicationSourceSha $ExpectedProductionApplicationCommit -ExpectedRoutineInventorySha256 $RoutineInventorySha256 -ExpectedReviewerKeySha256 $ExpectedBackupRoleReviewerKeySha256
  return [pscustomobject]@{
    Status = $review.Status
    ExpiresUtc = $review.ExpiresUtc
    RoutineInventorySha256 = $review.RoutineInventorySha256
    ReviewerKeySha256 = $review.ReviewerKeySha256.ToUpperInvariant()
    EvidenceSha256 = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
function Invoke-ReleaseStateAudit([string]$Service, [string]$Role) {
  $arguments = @(
    '--dbname', "service=$Service", '-X', '-q', '-A', '-t', '-F', '|', '-P', 'pager=off',
    '-v', 'ON_ERROR_STOP=1',
    '-v', "expected_database=$ExpectedDatabase",
    '-v', "expected_role=$Role",
    '-v', "expected_server_address=$ExpectedServerAddress",
    '-v', "expected_server_port=$ExpectedServerPort",
    '-f', (Join-Path $PSScriptRoot 'backup-release-state-preflight.sql')
  )
  $output = @(& $PsqlPath @arguments 2>&1)
  $exitCode = $LASTEXITCODE
  Assert-InteractivePassfileAbsent
  $text = $output -join "`n"
  if ($text -match '(?m)^BACKUP_TARGET_IDENTITY=FAIL\s*$' -or $text -notmatch '(?m)^BACKUP_TARGET_IDENTITY=PASS\s*$') {
    throw 'STOP: backup-state target identity could not be independently verified.'
  }
  $row = [regex]::Match($text, '(?m)^BACKUP_RELEASE_READINESS=(PRE_MIGRATION_026|POST_MIGRATION_026|UNVERIFIED)\|BACKUP_METADATA_FINGERPRINT=([A-Fa-f0-9]{32}|UNAVAILABLE)\|BACKUP_DATABASE_SIZE_BYTES=([0-9]+)\s*$')
  if (-not $row.Success) {
    if ($exitCode -ne 0) { return [pscustomobject]@{ Readiness = 'UNVERIFIED'; Fingerprint = 'UNAVAILABLE'; DatabaseSizeBytes = 0L } }
    throw 'STOP: backup-state audit returned an invalid result.'
  }
  if ($exitCode -ne 0) { throw 'STOP: read-only backup-state audit exited unsuccessfully after target validation.' }
  return [pscustomobject]@{
    Readiness = $row.Groups[1].Value
    Fingerprint = $row.Groups[2].Value.ToLowerInvariant()
    DatabaseSizeBytes = [long]$row.Groups[3].Value
  }
}

function Invoke-ContentIntegrityAudit([string]$Service, [string]$Role, [string]$SnapshotId = '') {
  if ($SnapshotId -and $SnapshotId -notmatch '^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+$') {
    throw 'STOP: exported snapshot identifier is malformed.'
  }
  $arguments = @(
    '--dbname', "service=$Service", '-X', '-q', '-A', '-t', '-P', 'pager=off',
    '-v', 'ON_ERROR_STOP=1',
    '-v', "expected_database=$ExpectedDatabase",
    '-v', "expected_role=$Role",
    '-v', "expected_server_address=$ExpectedServerAddress",
    '-v', "expected_server_port=$ExpectedServerPort",
    '-f', (Join-Path $PSScriptRoot 'backup-restore-integrity-preflight.sql')
  )
  if ($SnapshotId) { $arguments += @('-v', "snapshot_id=$SnapshotId") }
  $output = @(& $PsqlPath @arguments 2>$null)
  $exitCode = $LASTEXITCODE
  Assert-InteractivePassfileAbsent
  if ($exitCode -ne 0) { throw 'STOP: aggregate backup/restore integrity audit failed.' }
  $lines = @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if (@($lines | Where-Object { $_ -ceq 'BACKUP_TARGET_IDENTITY=PASS' }).Count -ne 1 -or
      @($lines | Where-Object { $_ -match '^BACKUP_TARGET_IDENTITY=' -and $_ -cne 'BACKUP_TARGET_IDENTITY=PASS' }).Count -gt 0) {
    throw 'STOP: aggregate integrity target identity output was missing or invalid.'
  }
  $resultRows = @($lines | Where-Object { $_ -match '^BACKUP_CONTENT_INTEGRITY=' })
  if ($resultRows.Count -ne 1) {
    throw 'STOP: aggregate integrity evidence was missing, ambiguous, oversized, or malformed.'
  }
  $matchResult = [regex]::Match($resultRows[0], '^BACKUP_CONTENT_INTEGRITY=PASS\|([a-f0-9]{64})\|([a-f0-9]{64})\|([a-f0-9]{64})\|([a-f0-9]{64})\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)$')
  if (-not $matchResult.Success) { throw 'STOP: aggregate integrity evidence was unverified, oversized, or malformed.' }
  $values = @(
    $matchResult.Groups[1].Value, $matchResult.Groups[2].Value,
    $matchResult.Groups[3].Value, $matchResult.Groups[4].Value,
    $matchResult.Groups[5].Value, $matchResult.Groups[6].Value,
    $matchResult.Groups[7].Value, $matchResult.Groups[8].Value,
    $matchResult.Groups[9].Value
  )
  return [pscustomobject]@{
    ManifestSha256 = (Get-TqSha256Text ($values -join '|'))
    SchemaSha256 = $values[0]
    TableSha256 = $values[1]
    SequenceSha256 = $values[2]
    LargeObjectSha256 = $values[3]
    TableCount = [long]$values[4]
    RowCount = [long]$values[5]
    SequenceCount = [long]$values[6]
    LargeObjectCount = [long]$values[7]
    LargeObjectBytes = [long]$values[8]
  }
}

function Get-TqSha256Text([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Test-ContentIntegrityEqual([object]$Left, [object]$Right) {
  return $Left.ManifestSha256 -ceq $Right.ManifestSha256 -and
    $Left.SchemaSha256 -ceq $Right.SchemaSha256 -and
    $Left.TableSha256 -ceq $Right.TableSha256 -and
    $Left.SequenceSha256 -ceq $Right.SequenceSha256 -and
    $Left.LargeObjectSha256 -ceq $Right.LargeObjectSha256 -and
    $Left.TableCount -eq $Right.TableCount -and $Left.RowCount -eq $Right.RowCount -and
    $Left.SequenceCount -eq $Right.SequenceCount -and
    $Left.LargeObjectCount -eq $Right.LargeObjectCount -and $Left.LargeObjectBytes -eq $Right.LargeObjectBytes
}

function Assert-StoragePath([string]$PathValue) {
  $full = Resolve-PathOutsideRepository $PathValue 'backup or restore artifact'
  Assert-TqNoReparsePath -Path $full
  $full = Assert-TqArtifactPathNotVolumeRoot $full
  $temporaryRoots = @($env:TEMP, $env:TMP, $env:RUNNER_TEMP) | Where-Object { $_ }
  foreach ($tempRoot in $temporaryRoots) {
    $tempFull = ConvertTo-TqCanonicalStoragePath $tempRoot
    if (Test-TqPathWithinRoot -Path $full -Root $tempFull) {
      throw 'STOP: backup artifacts cannot be stored in a temporary or CI directory.'
    }
  }
  return $full
}

function Assert-ArtifactAcl([string]$PathValue, [string]$Access) {
  Assert-RestrictedStorageAcl $PathValue $Access $false
}

Assert-OperatorConnectionFiles
if (-not $ExpectedToolSourceCommit -or -not $ExpectedProductionApplicationCommit) {
  throw 'STOP: exact reviewed tool and production-application source commits are required.'
}
if ($ExpectedToolSourceCommit -notmatch '^[a-f0-9]{40}$' -or $ExpectedProductionApplicationCommit -notmatch '^[a-f0-9]{40}$') {
  throw 'STOP: exact reviewed tool and production-application source commits are required.'
}
$sourceHead = (& git -C $repositoryRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceHead -ne $ExpectedToolSourceCommit) {
  throw 'STOP: backup/restore tool HEAD does not match the reviewed tool source commit.'
}
foreach ($commit in @($ExpectedToolSourceCommit, $ExpectedProductionApplicationCommit)) {
  & git -C $repositoryRoot cat-file -e "$commit^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'STOP: a pinned tool or production-application commit is not present in the verified local Git object database.' }
}
$reviewedInputs = @(
  'capstone/backend/scripts/backup-restore-rehearsal.ps1',
  'capstone/backend/scripts/backupStorageSafety.validation.psm1',
  'capstone/backend/scripts/backup-restore-integrity-preflight.sql',
  'capstone/backend/scripts/postgres-exported-snapshot.integration.cjs',
  'capstone/backend/scripts/backup-role-preflight.sql',
  'capstone/backend/scripts/backup-role-routine-review-export.sql',
  'capstone/backend/scripts/backupRoleReview.validation.psm1',
  'capstone/backend/scripts/releasePreflightConnection.validation.psm1',
  'capstone/backend/scripts/backup-release-state-preflight.sql',
  'capstone/backend/scripts/release-migration-preflight.sql',
  'capstone/backend/scripts/release-migration-026-prerequisite-preflight.sql',
  'capstone/backend/migrations'
)
$sourceStatus = @(& git -C $repositoryRoot status --porcelain --untracked-files=all -- $reviewedInputs 2>$null)
if ($LASTEXITCODE -ne 0 -or $sourceStatus.Count -gt 0) {
  throw 'STOP: backup/preflight files or migrations are modified/untracked; use a clean reviewed release commit.'
}
if ($Action -eq 'CreateProductionBackup') {
  throw 'STOP: production backup remains disabled. MVCC data can share an exported snapshot, but sequence state is non-MVCC and requires a separately reviewed, externally enforced write-quiescence procedure that this build does not implement.'
}
Import-Module -Name $storageSafetyModule -Force -ErrorAction Stop
$connectionValidationModule = Join-Path $PSScriptRoot 'releasePreflightConnection.validation.psm1'
$backupRoleReviewModule = Join-Path $PSScriptRoot 'backupRoleReview.validation.psm1'
foreach ($modulePath in @($connectionValidationModule, $backupRoleReviewModule)) {
  if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { throw 'STOP: required reviewed validation module is missing.' }
  Import-Module -Name $modulePath -Force -ErrorAction Stop
}
if ($BackupServiceName -ne 'tq_prod_backup') { throw 'STOP: production backups must use the dedicated tq_prod_backup service alias.' }
if ($RestoreServiceName -ne 'tq_restore_local') { throw 'STOP: restore must use the isolated tq_restore_local service alias.' }
if (-not $ExpectedDatabase -or -not $ExpectedServerAddress) { throw 'STOP: approved database identity inputs are required.' }

$previousServiceFile = $env:PGSERVICEFILE
$previousPgEnvironment = @{}
try {
  foreach ($variable in @(Get-ChildItem Env:PG* -ErrorAction SilentlyContinue)) {
    $previousPgEnvironment[$variable.Name] = $variable.Value
    Remove-Item -LiteralPath "Env:$($variable.Name)" -ErrorAction SilentlyContinue
  }
  $env:PGSERVICEFILE = (Resolve-PathOutsideRepository $ServiceFilePath 'PGSERVICEFILE')
  Set-InteractivePassfileOverride $env:PGSERVICEFILE
  $env:PGCONNECT_TIMEOUT = '15'
  $toolVersions = Get-VerifiedToolVersions

  if ($Action -eq 'CreateProductionBackup') {
    if (-not $ExecuteApprovedProductionBackup) { throw 'STOP: add -ExecuteApprovedProductionBackup only after a separate, explicit backup approval.' }
    if (-not $EncryptedStorageConfirmed) { throw 'STOP: confirm the external backup destination is encrypted and access-restricted.' }
    if ($ApprovalReference -notmatch '^[A-Za-z0-9._:/-]{3,128}$') { throw 'STOP: a separately approved change/reference ID is required.' }
    if (-not (Test-Path -LiteralPath $BackupDirectory -PathType Container)) { throw 'STOP: create and verify the encrypted backup directory before use.' }
    $destination = Assert-StoragePath $BackupDirectory
    [void](Assert-PgServiceConfiguration $BackupServiceName $backupRole $true)
    Assert-EncryptedLocalVolume $destination
    Assert-RestrictedStorageAcl $destination 'Modify' $true
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $archive = Join-Path $destination "theresians-production-$stamp.dump"
    $partial = "$archive.partial"
    $dumpLog = "$archive.pg_dump.log"
    $tocPath = "$archive.toc.txt"
    $listLog = "$archive.pg_restore-list.log"
    $hashPath = "$archive.sha256.txt"
    $metadataPath = "$archive.metadata.json"
    if (@($archive, $partial, $dumpLog, $tocPath, $listLog, $hashPath, $metadataPath | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0) {
      throw 'STOP: refusing to overwrite an existing archive or sidecar.'
    }

    $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=30min -c lock_timeout=2000'
    Write-Output "Approval reference: $ApprovalReference"
    Write-Output 'Running the fixed catalog-only backup role audit.'
    $roleAuditBefore = Invoke-PsqlAudit $BackupServiceName $backupRole 'backup-role-preflight.sql'
    $roleReviewBefore = Get-VerifiedBackupRoleReview $roleAuditBefore.RoutineInventorySha256
    $beforeState = Invoke-ReleaseStateAudit $BackupServiceName $backupRole
    $script:ExportedBackupSnapshot = Start-ExportedBackupSnapshot $BackupServiceName
    Assert-ExportedBackupSnapshotAlive $script:ExportedBackupSnapshot
    $beforeIntegrity = Invoke-ContentIntegrityAudit $BackupServiceName $backupRole $script:ExportedBackupSnapshot.SnapshotId
    Assert-SufficientFreeSpace $destination $beforeState.DatabaseSizeBytes

    $dumpArguments = @(
      '--format=custom', '--compress=6', '--lock-wait-timeout=5s', "--snapshot=$($script:ExportedBackupSnapshot.SnapshotId)", '--no-tablespaces',
      "--file=$partial", "--dbname=service=$BackupServiceName"
    )
    & $PgDumpPath @dumpArguments 2> $dumpLog
    $dumpExit = $LASTEXITCODE
    Assert-ExportedBackupSnapshotAlive $script:ExportedBackupSnapshot
    Assert-InteractivePassfileAbsent
    if ($dumpExit -ne 0) { throw "STOP: pg_dump failed (exit $dumpExit); partial archive and protected log were retained." }
    try { [System.IO.File]::Move($partial, $archive) }
    catch { throw 'STOP: archive finalization failed; no existing destination was overwritten and the partial archive was retained.' }

    $roleAuditAfter = Invoke-PsqlAudit $BackupServiceName $backupRole 'backup-role-preflight.sql'
    if ($roleAuditAfter.RoutineInventorySha256 -cne $roleAuditBefore.RoutineInventorySha256) {
      throw 'STOP: backup-role routine inventory changed during the archive operation; do not treat the archive as verified.'
    }
    $roleReviewAfter = Get-VerifiedBackupRoleReview $roleAuditAfter.RoutineInventorySha256
    if ($roleReviewAfter.EvidenceSha256 -cne $roleReviewBefore.EvidenceSha256) {
      throw 'STOP: backup-role review evidence changed during the archive operation.'
    }
    $afterState = Invoke-ReleaseStateAudit $BackupServiceName $backupRole
    Assert-ExportedBackupSnapshotAlive $script:ExportedBackupSnapshot
    $afterIntegrity = Invoke-ContentIntegrityAudit $BackupServiceName $backupRole $script:ExportedBackupSnapshot.SnapshotId
    Assert-ExportedBackupSnapshotAlive $script:ExportedBackupSnapshot
    if (-not (Test-ContentIntegrityEqual $beforeIntegrity $afterIntegrity)) {
      throw 'STOP: source aggregate integrity changed across the archive window; retain the archive as unverified and investigate concurrent changes.'
    }
    & $PgRestorePath '--list' $archive 1> $tocPath 2> $listLog
    $listExit = $LASTEXITCODE
    if ($listExit -ne 0) { throw "STOP: pg_restore could not list the archive (exit $listExit); archive and logs were retained." }
    $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $releaseReadiness = Get-ReleaseReadiness $beforeState $afterState
    $metadataFingerprint = if ($beforeState.Fingerprint -match '^[a-f0-9]{32}$' -and $beforeState.Fingerprint -ceq $afterState.Fingerprint) {
      $beforeState.Fingerprint
    } else { 'UNAVAILABLE' }
    Write-NewProtectedTextFile $hashPath "$digest  $([System.IO.Path]::GetFileName($archive))`r`n"
    $metadata = [ordered]@{
      format = 'theresians-logical-backup-manifest-v3'
      archiveFileName = [System.IO.Path]::GetFileName($archive)
      archiveSha256 = $digest
      createdAtUtc = [DateTime]::UtcNow.ToString('o')
      approvalReference = $ApprovalReference
      backupRoleReview = [ordered]@{
        status = $roleReviewBefore.Status
        reviewerKeySha256 = $roleReviewBefore.ReviewerKeySha256
        routineInventorySha256 = $roleReviewBefore.RoutineInventorySha256
        evidenceSha256 = $roleReviewBefore.EvidenceSha256
        expiresAtUtc = $roleReviewBefore.ExpiresUtc.ToString('o')
      }
      toolSourceCommit = $ExpectedToolSourceCommit
      productionApplicationCommit = $ExpectedProductionApplicationCommit
      toolVersions = $toolVersions
      sourceDatabase = [ordered]@{ database = $ExpectedDatabase; serverAddress = $ExpectedServerAddress; serverPort = $ExpectedServerPort }
      sourceStateBeforeDump = $beforeState.Readiness
      sourceStateAfterDump = $afterState.Readiness
      sourceMetadataFingerprintBeforeDump = $beforeState.Fingerprint
      sourceMetadataFingerprintAfterDump = $afterState.Fingerprint
      sourceContentIntegrityBeforeDump = $beforeIntegrity
      sourceContentIntegrityAfterDump = $afterIntegrity
      sourceContentSnapshotPolicy = 'SHARED_EXPORTED_REPEATABLE_READ_SNAPSHOT_FOR_MVCC_DATA'
      sourceSequenceStatePolicy = 'NON_MVCC_REQUIRES_EXTERNAL_WRITE_QUIESCENCE'
      sourceContentSnapshotWarning = 'The aggregate manifests and pg_dump import one exported repeatable-read snapshot for MVCC data. PostgreSQL sequence state is non-MVCC and must remain quiescent under a separately reviewed, externally enforced procedure.'
      restoreReleaseReadiness = $releaseReadiness
      restoreMetadataFingerprint = $metadataFingerprint
      databaseSizeBytes = [Math]::Max($beforeState.DatabaseSizeBytes, $afterState.DatabaseSizeBytes)
      backupScope = 'Single-database custom-format logical archive; no Student rows are emitted to logs.'
      clusterRolesIncluded = $false
      roleMembershipsIncluded = $false
      tablespacesIncluded = $false
      serverConfigurationIncluded = $false
      railwayConfigurationIncluded = $false
      extensionBinariesIncluded = $false
      operatorNote = 'Not complete disaster-recovery coverage. MVCC data shares an exported snapshot; production backup acceptance remains blocked until non-MVCC sequence state is protected by a separately reviewed, externally enforced write-quiescence procedure. Separately reviewed role/extension/configuration recreation and recovery steps remain required.'
    }
    Write-NewProtectedTextFile $metadataPath (($metadata | ConvertTo-Json -Depth 6) + "`r`n")
    foreach ($artifact in @($archive, $dumpLog, $tocPath, $listLog, $hashPath, $metadataPath)) { Assert-ArtifactAcl $artifact 'ReadWrite' }
    Write-Output "PASS: custom archive created and TOC validated. SHA256=$digest"
    Write-Output "Restore-integrity metadata comparison status: $(if ($metadataFingerprint -match '^[a-f0-9]{32}$' -and $beforeIntegrity.ManifestSha256 -ceq $afterIntegrity.ManifestSha256) { 'AVAILABLE' } else { 'UNVERIFIED' })."
    Write-Output 'MVCC source snapshot consistency: PASS. Sequence state remains subject to external write-quiescence and is not covered by the MVCC snapshot.'
    Write-Output "Release readiness: $releaseReadiness. No schema repair or migration was run."
    Write-Output 'Archive scope excludes database-global roles, memberships, tablespaces, server/Railway configuration, and extension binaries; do not describe it as complete disaster recovery.'
    Write-Output 'Keep the archive, manifest, digest, and logs only in the verified encrypted restricted destination; apply a separately approved retention and secure-disposal policy.'
    return
  }

  if ($Action -eq 'RestoreIsolated') {
    if (-not $ExecuteIsolatedRestore) { throw 'STOP: add -ExecuteIsolatedRestore only for an approved disposable restore rehearsal.' }
    if (-not $EncryptedStorageConfirmed) { throw 'STOP: confirm the source archive is on encrypted, access-restricted storage.' }
    if (-not $ArchivePath -or -not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw 'STOP: provide an existing archive outside the repository.' }
    if ($ExpectedArchiveSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'STOP: expected archive SHA256 is required.' }
    $archive = Resolve-PathOutsideRepository $ArchivePath 'backup archive'
    [void](Assert-StoragePath $archive)
    $archiveDirectory = Split-Path -LiteralPath $archive -Parent
    Assert-EncryptedLocalVolume $archiveDirectory
    Assert-RestrictedStorageAcl $archiveDirectory 'ReadOnly' $true
    Assert-ArtifactAcl $archive 'ReadOnly'
    [void](Assert-PgServiceConfiguration $RestoreServiceName $restoreRole $false)
    $actualDigest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actualDigest -ine $ExpectedArchiveSha256) { throw 'STOP: archive checksum does not match the approved digest.' }
    $metadataPath = "$archive.metadata.json"
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw 'STOP: reviewed backup metadata sidecar is required for restore verification.' }
    Assert-ArtifactAcl $metadataPath 'ReadOnly'
    try { $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'STOP: backup metadata sidecar is invalid.' }
    if ($metadata.format -cne 'theresians-logical-backup-manifest-v3' -or
        $metadata.archiveSha256 -ine $actualDigest -or
        $metadata.productionApplicationCommit -cne $ExpectedProductionApplicationCommit -or
        $metadata.toolSourceCommit -cne $ExpectedToolSourceCommit -or
        $metadata.sourceContentSnapshotPolicy -cne 'SHARED_EXPORTED_REPEATABLE_READ_SNAPSHOT_FOR_MVCC_DATA' -or
        $metadata.sourceSequenceStatePolicy -cne 'NON_MVCC_REQUIRES_EXTERNAL_WRITE_QUIESCENCE' -or
        $metadata.sourceContentSnapshotWarning -notmatch 'sequence state is non-MVCC' -or
        $metadata.sourceContentIntegrityBeforeDump.ManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
        $metadata.sourceContentIntegrityBeforeDump.ManifestSha256 -cne $metadata.sourceContentIntegrityAfterDump.ManifestSha256 -or
        $metadata.restoreReleaseReadiness -notin @('PRE_MIGRATION_026', 'POST_MIGRATION_026', 'UNVERIFIED')) {
      throw 'STOP: backup metadata does not match the verified archive and pinned tool/application source commits.'
    }
    $tocPath = "$archive.restore-input.toc.txt"
    $tocLog = "$archive.restore-input-list.log"
    $restoreLog = "$archive.restore.log"
    $restoreErrorLog = "$archive.restore-error.log"
    foreach ($artifact in @($tocPath, $tocLog, $restoreLog, $restoreErrorLog)) {
      if (Test-Path -LiteralPath $artifact) { throw 'STOP: refusing to overwrite a restore verification log.' }
    }
    & $PgRestorePath '--list' $archive 1> $tocPath 2> $tocLog
    if ($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $tocPath).Length -eq 0) {
      throw 'STOP: backup archive TOC could not be verified before restore.'
    }
    Assert-ArtifactAcl $tocPath 'ReadWrite'
    Assert-ArtifactAcl $tocLog 'ReadWrite'
    $restoreDatabase = $ExpectedDatabase
    if ($restoreDatabase -notmatch '^tq_restore_[a-z0-9_]+$') { throw 'STOP: restore database must use the tq_restore_* isolated-name allowlist.' }
    $parsedAddress = [System.Net.IPAddress]::Parse($ExpectedServerAddress)
    if (-not [System.Net.IPAddress]::IsLoopback($parsedAddress)) { throw 'STOP: restore server address must be loopback.' }

    $targetSql = @'
BEGIN READ ONLY;
SELECT current_database(), current_user, COALESCE(host(inet_server_addr()), ''), inet_server_port(),
       (SELECT COUNT(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p','v','m','f','S')),
       (SELECT COUNT(*) FROM pg_catalog.pg_largeobject_metadata),
       (SELECT COUNT(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'),
       (SELECT COUNT(*) FROM pg_catalog.pg_namespace n WHERE n.nspname <> 'public' AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'),
       COALESCE(has_schema_privilege(current_user, 'public', 'CREATE'), false),
       COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit
                        OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=role_row.oid)
                  FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname=current_user), true),
       current_setting('data_directory');
ROLLBACK;
'@
    $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'
    $targetOutput = & $PsqlPath '--dbname' "service=$RestoreServiceName" '-X' '-q' '-A' '-t' '-F' '|' '--command' $targetSql 2>&1
    Assert-InteractivePassfileAbsent
    if ($LASTEXITCODE -ne 0) { throw 'STOP: isolated restore target metadata check failed.' }
    $targetRows = @($targetOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($targetRows.Count -ne 1) { throw 'STOP: isolated restore target metadata was not a single aggregate row.' }
    $targetRow = $targetRows[0]
    $fields = ([string]$targetRow).Trim().Split('|')
    if ($fields.Count -ne 11 -or $fields[0] -cne $restoreDatabase -or $fields[1] -cne $restoreRole -or
        $fields[2] -cne $ExpectedServerAddress -or $fields[3] -cne [string]$ExpectedServerPort -or
        $fields[4] -ne '0' -or $fields[5] -ne '0' -or $fields[6] -ne '0' -or $fields[7] -ne '0' -or
        $fields[8] -ne 't' -or $fields[9] -ne 'f') {
      throw 'STOP: isolated restore target is not the approved empty loopback database with a non-inheriting, non-admin local restore role.'
    }
    $restoreDataDirectory = Assert-StoragePath $fields[10]
    Assert-EncryptedLocalVolume $restoreDataDirectory
    Assert-SufficientFreeSpace $restoreDataDirectory ([long]$metadata.databaseSizeBytes)

    Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
    $restoreArguments = @(
      '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--no-tablespaces',
      "--dbname=service=$RestoreServiceName", $archive
    )
    & $PgRestorePath @restoreArguments 1> $restoreLog 2> $restoreErrorLog
    Assert-InteractivePassfileAbsent
    if ($LASTEXITCODE -ne 0) { throw 'STOP: isolated pg_restore failed; inspect the restricted restore logs.' }

    Assert-ArtifactAcl $restoreLog 'ReadWrite'
    Assert-ArtifactAcl $restoreErrorLog 'ReadWrite'
    $restoredState = Invoke-ReleaseStateAudit $RestoreServiceName $restoreRole
    $restoredIntegrity = Invoke-ContentIntegrityAudit $RestoreServiceName $restoreRole
    $sourceIntegrity = [pscustomobject]$metadata.sourceContentIntegrityBeforeDump
    if (-not (Test-ContentIntegrityEqual $sourceIntegrity $restoredIntegrity)) {
      throw 'STOP: isolated restore aggregate integrity does not match the source manifest; do not accept this restore rehearsal.'
    }
    $expectedFingerprint = [string]$metadata.restoreMetadataFingerprint
    $metadataMatches = $expectedFingerprint -match '^[a-f0-9]{32}$' -and
      $restoredState.Fingerprint -ceq $expectedFingerprint -and
      $restoredState.Readiness -ceq [string]$metadata.restoreReleaseReadiness
    $metadataStatus = if ($metadataMatches) { 'PASS' } else { 'UNVERIFIED' }
    $readinessStatus = if ($metadataMatches) { $restoredState.Readiness } else { 'UNVERIFIED' }
    Write-Output 'PASS: archive digest/TOC checks and transactional isolated restore completed; restored aggregate manifests matched the stored pre-dump reference.'
    Write-Output 'The stored source manifest and pg_dump shared one exported repeatable-read snapshot for MVCC data; sequence state remains separately gated by write-quiescence.'
    Write-Output 'Restore integrity and release-schema readiness remain separate results.'
    Write-Output "Read-only source/restore catalog metadata comparison: $metadataStatus."
    Write-Output "Migration release readiness: $readinessStatus. Archive integrity and migration readiness are separate results."
    Write-Output 'The restore does not recreate cluster roles, role memberships, extension binaries, or Railway/server configuration.'
    if ($readinessStatus -eq 'UNVERIFIED') { Write-Warning 'Release state needs independent review; the archive restore remains available for recovery analysis.' }
  }
}
finally {
  try {
    if ($script:ExportedBackupSnapshot) { Stop-ExportedBackupSnapshot $script:ExportedBackupSnapshot }
  } finally {
    foreach ($variable in @(Get-ChildItem Env:PG* -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath "Env:$($variable.Name)" -ErrorAction SilentlyContinue
    }
    foreach ($name in $previousPgEnvironment.Keys) { Set-Item -Path "Env:$name" -Value $previousPgEnvironment[$name] }
  }
}
