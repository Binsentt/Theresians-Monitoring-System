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

function Assert-NoReparsePath([string]$PathValue) {
  $full = [System.IO.Path]::GetFullPath($PathValue)
  $cursor = $full
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'STOP: backup inputs and destinations cannot traverse a reparse point.'
    }
    $parent = Split-Path -LiteralPath $cursor -Parent
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
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
  if ($RequireProtectedDacl -and -not $acl.AreAccessRulesProtected) {
    throw 'STOP: sensitive input or backup directory must have a protected DACL.'
  }

  $approved = Get-ApprovedStorageSids
  $approvedValues = @($approved.Current, $approved.System, $approved.Administrators)
  try { $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
  catch { throw 'STOP: storage owner could not be verified.' }
  if ($ownerSid -notin $approvedValues) { throw 'STOP: storage owner is not an approved local identity.' }

  $allowRules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })
  foreach ($rule in $allowRules) {
    if ($rule.IdentityReference.Value -notin $approvedValues) {
      throw 'STOP: storage ACL grants access to an unapproved identity.'
    }
  }

  $rightsBySid = @{}
  foreach ($rule in $allowRules) {
    $sid = $rule.IdentityReference.Value
    if (-not $rightsBySid.ContainsKey($sid)) { $rightsBySid[$sid] = 0 }
    $rightsBySid[$sid] = $rightsBySid[$sid] -bor [int]$rule.FileSystemRights
  }
  $fullControl = [int][System.Security.AccessControl.FileSystemRights]::FullControl
  foreach ($sid in @($approved.System, $approved.Administrators)) {
    if (-not $rightsBySid.ContainsKey($sid) -or (($rightsBySid[$sid] -band $fullControl) -ne $fullControl)) {
      throw 'STOP: SYSTEM and Administrators must retain FullControl on protected backup storage.'
    }
  }
  if (-not $rightsBySid.ContainsKey($approved.Current)) { throw 'STOP: the current operator has no direct approved storage grant.' }
  $operatorRights = $rightsBySid[$approved.Current]
  $requiredMask = switch ($RequiredAccess) {
    'ReadOnly' { [int][System.Security.AccessControl.FileSystemRights]::Read }
    'ReadWrite' { [int][System.Security.AccessControl.FileSystemRights]::Read -bor [int][System.Security.AccessControl.FileSystemRights]::Write }
    'Modify' { [int][System.Security.AccessControl.FileSystemRights]::Modify }
  }
  if (($operatorRights -band $requiredMask) -ne $requiredMask) {
    throw 'STOP: the current operator lacks the minimum direct access required for this path.'
  }
}

function Assert-EncryptedLocalVolume([string]$PathValue) {
  $full = [System.IO.Path]::GetFullPath($PathValue)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($root -notmatch '^[A-Za-z]:\\$') { throw 'STOP: encrypted storage must be a verified local Windows volume.' }
  if (-not (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue)) {
    throw 'STOP: BitLocker status cannot be verified on this system.'
  }
  try { $volume = Get-BitLockerVolume -MountPoint $root -ErrorAction Stop }
  catch { throw 'STOP: BitLocker encryption/protection status could not be verified.' }
  if ($volume.VolumeStatus -ne 'FullyEncrypted' -or $volume.ProtectionStatus -ne 'On') {
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
  'capstone/backend/scripts/backup-role-preflight.sql',
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

    $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'
    Write-Output "Approval reference: $ApprovalReference"
    Write-Output 'Running the fixed catalog-only backup role audit.'
    $roleAuditBefore = Invoke-PsqlAudit $BackupServiceName $backupRole 'backup-role-preflight.sql'
    $roleReviewBefore = Get-VerifiedBackupRoleReview $roleAuditBefore.RoutineInventorySha256
    $beforeState = Invoke-ReleaseStateAudit $BackupServiceName $backupRole
    Assert-SufficientFreeSpace $destination $beforeState.DatabaseSizeBytes

    $dumpArguments = @(
      '--format=custom', '--compress=6', '--lock-wait-timeout=5s', '--no-tablespaces',
      "--file=$partial", "--dbname=service=$BackupServiceName"
    )
    & $PgDumpPath @dumpArguments 2> $dumpLog
    $dumpExit = $LASTEXITCODE
    Assert-InteractivePassfileAbsent
    if ($dumpExit -ne 0) { throw "STOP: pg_dump failed (exit $dumpExit); partial archive and protected log were retained." }
    Move-Item -LiteralPath $partial -Destination $archive

    $roleAuditAfter = Invoke-PsqlAudit $BackupServiceName $backupRole 'backup-role-preflight.sql'
    if ($roleAuditAfter.RoutineInventorySha256 -cne $roleAuditBefore.RoutineInventorySha256) {
      throw 'STOP: backup-role routine inventory changed during the archive operation; do not treat the archive as verified.'
    }
    $roleReviewAfter = Get-VerifiedBackupRoleReview $roleAuditAfter.RoutineInventorySha256
    if ($roleReviewAfter.EvidenceSha256 -cne $roleReviewBefore.EvidenceSha256) {
      throw 'STOP: backup-role review evidence changed during the archive operation.'
    }
    $afterState = Invoke-ReleaseStateAudit $BackupServiceName $backupRole
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
      format = 'theresians-logical-backup-manifest-v1'
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
      operatorNote = 'Not complete disaster-recovery coverage. Separately reviewed role/extension/configuration recreation and recovery steps remain required.'
    }
    Write-NewProtectedTextFile $metadataPath (($metadata | ConvertTo-Json -Depth 6) + "`r`n")
    foreach ($artifact in @($archive, $dumpLog, $tocPath, $listLog, $hashPath, $metadataPath)) { Assert-ArtifactAcl $artifact 'ReadWrite' }
    Write-Output "PASS: custom archive created and TOC validated. SHA256=$digest"
    Write-Output "Restore-integrity metadata comparison status: $(if ($metadataFingerprint -match '^[a-f0-9]{32}$') { 'AVAILABLE' } else { 'UNVERIFIED' })."
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
    if ($metadata.format -cne 'theresians-logical-backup-manifest-v1' -or
        $metadata.archiveSha256 -ine $actualDigest -or
        $metadata.productionApplicationCommit -cne $ExpectedProductionApplicationCommit -or
        $metadata.toolSourceCommit -cne $ExpectedToolSourceCommit -or
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
    $expectedFingerprint = [string]$metadata.restoreMetadataFingerprint
    $metadataMatches = $expectedFingerprint -match '^[a-f0-9]{32}$' -and
      $restoredState.Fingerprint -ceq $expectedFingerprint -and
      $restoredState.Readiness -ceq [string]$metadata.restoreReleaseReadiness
    $metadataStatus = if ($metadataMatches) { 'PASS' } else { 'UNVERIFIED' }
    $readinessStatus = if ($metadataMatches) { $restoredState.Readiness } else { 'UNVERIFIED' }
    Write-Output 'PASS: archive restore integrity checks (SHA-256, custom TOC, empty loopback target, transactional pg_restore) completed.'
    Write-Output 'Restore integrity and release-schema readiness remain separate results.'
    Write-Output "Read-only source/restore catalog metadata comparison: $metadataStatus."
    Write-Output "Migration release readiness: $readinessStatus. Archive integrity and migration readiness are separate results."
    Write-Output 'The restore does not recreate cluster roles, role memberships, extension binaries, or Railway/server configuration.'
    if ($readinessStatus -eq 'UNVERIFIED') { Write-Warning 'Release state needs independent review; the archive restore remains available for recovery analysis.' }
  }
}
finally {
  foreach ($variable in @(Get-ChildItem Env:PG* -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath "Env:$($variable.Name)" -ErrorAction SilentlyContinue
  }
  foreach ($name in $previousPgEnvironment.Keys) { Set-Item -Path "Env:$name" -Value $previousPgEnvironment[$name] }
}
