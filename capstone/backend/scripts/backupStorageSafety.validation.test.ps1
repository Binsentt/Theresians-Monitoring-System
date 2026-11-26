$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot 'backupStorageSafety.validation.psm1'
Import-Module -Name $module -Force

function Assert-Throws([scriptblock]$Action, [string]$Label) {
  $thrown = $false
  try { & $Action } catch { $thrown = $true }
  if (-not $thrown) { throw "FAIL: expected rejection: $Label" }
}

function Assert-ThrowsContaining([scriptblock]$Action, [string]$Label, [string]$ExpectedText) {
  try { & $Action }
  catch {
    if ($_.Exception.Message -match [regex]::Escape($ExpectedText)) { return }
    throw "FAIL: $Label failed for the wrong reason."
  }
  throw "FAIL: expected rejection: $Label"
}

$driveRoot = [System.IO.Path]::GetPathRoot($PWD.Path)
$normal = Join-Path $driveRoot 'Theresians-Backup-Synthetic'
$withSlash = $normal + '\'
if ((ConvertTo-TqCanonicalStoragePath $normal) -cne (ConvertTo-TqCanonicalStoragePath $withSlash)) {
  throw 'FAIL: normal absolute paths with or without a trailing separator must canonicalize identically.'
}
if (-not (Test-TqPathWithinRoot -Path (Join-Path $normal 'artifact.dump') -Root $normal)) {
  throw 'FAIL: child path must be recognized under its canonical root.'
}
if (Test-TqPathWithinRoot -Path ($normal + '-sibling\artifact.dump') -Root $normal) {
  throw 'FAIL: sibling-prefix path must not be treated as a child.'
}
Assert-Throws { ConvertTo-TqCanonicalStoragePath 'C:relative\artifact.dump' } 'drive-relative path'
Assert-Throws { Assert-TqArtifactPathNotVolumeRoot $driveRoot } 'volume root artifact'

$current = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-111-222-333-1001')
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$users = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$approved = @{ Current = $current.Value; System = $system.Value; Administrators = $admins.Value }
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$none = [System.Security.AccessControl.InheritanceFlags]::None
$noPropagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$deny = [System.Security.AccessControl.AccessControlType]::Deny
$validRules = @(
  [System.Security.AccessControl.FileSystemAccessRule]::new($current, $full, $none, $noPropagation, $allow),
  [System.Security.AccessControl.FileSystemAccessRule]::new($system, $full, $none, $noPropagation, $allow),
  [System.Security.AccessControl.FileSystemAccessRule]::new($admins, $full, $none, $noPropagation, $allow)
)
Assert-TqRestrictedAclRules -Rules $validRules -ApprovedSids $approved -OwnerSid $current.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $true
Assert-Throws {
  $blocked = @($validRules) + [System.Security.AccessControl.FileSystemAccessRule]::new($current, [System.Security.AccessControl.FileSystemRights]::Modify, $none, $noPropagation, $deny)
  Assert-TqRestrictedAclRules -Rules $blocked -ApprovedSids $approved -OwnerSid $current.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $true
} 'explicit deny ACE'
Assert-Throws {
  $blocked = @($validRules) + [System.Security.AccessControl.FileSystemAccessRule]::new($users, [System.Security.AccessControl.FileSystemRights]::Modify, $none, $noPropagation, $deny)
  Assert-TqRestrictedAclRules -Rules $blocked -ApprovedSids $approved -OwnerSid $current.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $true
} 'group deny ACE'
$inheritOnly = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $current, $full, [System.Security.AccessControl.InheritanceFlags]::ContainerInherit,
  [System.Security.AccessControl.PropagationFlags]::InheritOnly, $allow)
Assert-Throws {
  Assert-TqRestrictedAclRules -Rules @($inheritOnly, $validRules[1], $validRules[2]) -ApprovedSids $approved -OwnerSid $current.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $true
} 'inherit-only operator grant'
Assert-Throws {
  Assert-TqRestrictedAclRules -Rules @($validRules[0], $inheritOnly, $validRules[2]) -ApprovedSids $approved -OwnerSid $current.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $true
} 'inherit-only SYSTEM grant'
Assert-Throws {
  Assert-TqRestrictedAclRules -Rules @($validRules[0], $validRules[1], $inheritOnly) -ApprovedSids $approved -OwnerSid $current.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $true
} 'inherit-only Administrators grant'
Assert-Throws {
  $unapprovedAllow = [System.Security.AccessControl.FileSystemAccessRule]::new($users, $full, $none, $noPropagation, $allow)
  Assert-TqRestrictedAclRules -Rules (@($validRules) + $unapprovedAllow) -ApprovedSids $approved -OwnerSid $current.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $true
} 'unapproved allow ACE'
Assert-Throws {
  Assert-TqRestrictedAclRules -Rules $validRules -ApprovedSids $approved -OwnerSid $users.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $true
} 'unapproved DACL owner'
Assert-Throws {
  Assert-TqRestrictedAclRules -Rules $validRules -ApprovedSids $approved -OwnerSid $current.Value -RequiredAccess Modify -RequireProtectedDacl $true -AreAccessRulesProtected $false
} 'unprotected sensitive DACL'

$junctionRoot = Join-Path $env:TEMP ('tq-storage-junction-' + [guid]::NewGuid().ToString('N'))
$junctionTarget = Join-Path $junctionRoot 'target'
$junctionPath = Join-Path $junctionRoot 'link'
[void][System.IO.Directory]::CreateDirectory($junctionTarget)
$missingChild = Join-Path $junctionRoot 'not-created\nested\synthetic.dump'
Assert-TqNoReparsePath -Path $missingChild
$junctionCreated = $false
try {
  try {
    $null = & $env:ComSpec /d /c "mklink /J `"$junctionPath`" `"$junctionTarget`"" 2>$null
    $junctionCreated = $LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $junctionPath -PathType Container)
  } catch {
    $junctionCreated = $false
  }
  if ($junctionCreated) {
    Assert-ThrowsContaining {
      Assert-TqNoReparsePath (Join-Path $junctionPath 'synthetic.dump')
    } 'reparse-point ancestor' 'reparse point'
  } elseif ($env:TQ_REQUIRE_REPARSE_FIXTURE -eq '1') {
    throw 'FAIL: required disposable junction could not be created for the reparse-point regression.'
  } else {
    Write-Output 'SKIP: reparse-point fixture creation is blocked by the local execution environment.'
  }
} finally {
  if (Test-Path -LiteralPath $junctionPath) { [System.IO.Directory]::Delete($junctionPath, $false) }
  if (Test-Path -LiteralPath $junctionTarget) { [System.IO.Directory]::Delete($junctionTarget, $false) }
  if (Test-Path -LiteralPath $junctionRoot) { [System.IO.Directory]::Delete($junctionRoot, $false) }
}

Write-Output 'PASS: storage path canonicalization and synthetic ACL effective-access tests.'
