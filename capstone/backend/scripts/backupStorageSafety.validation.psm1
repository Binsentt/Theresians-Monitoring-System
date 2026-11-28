Set-StrictMode -Version Latest

function ConvertTo-TqCanonicalStoragePath {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '^[A-Za-z]:(?![\\/])') {
    throw 'STOP: storage path is empty or drive-relative.'
  }
  try { $full = [System.IO.Path]::GetFullPath($Path) }
  catch { throw 'STOP: storage path could not be canonicalized.' }
  $root = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrEmpty($root)) { throw 'STOP: storage path has no filesystem root.' }
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)) }
  return $full
}

function Test-TqPathWithinRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $pathFull = ConvertTo-TqCanonicalStoragePath $Path
  $rootFull = ConvertTo-TqCanonicalStoragePath $Root
  if ($pathFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  $separator = [System.IO.Path]::DirectorySeparatorChar
  $prefix = if ($rootFull.EndsWith([string]$separator, [System.StringComparison]::Ordinal)) { $rootFull } else { $rootFull + $separator }
  return $pathFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-TqArtifactPathNotVolumeRoot {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = ConvertTo-TqCanonicalStoragePath $Path
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: an artifact or storage directory cannot be a volume root.'
  }
  return $full
}

function Assert-TqNoReparsePath {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)

  $cursor = ConvertTo-TqCanonicalStoragePath $Path
  while ($cursor) {
    try {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    } catch {
      if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
        throw 'STOP: a storage path component could not be inspected for reparse points.'
      }
      $root = [System.IO.Path]::GetPathRoot($cursor)
      if ($cursor.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'STOP: no existing storage path ancestor could be inspected.'
      }
      $parentInfo = [System.IO.Directory]::GetParent($cursor)
      $parent = if ($parentInfo) { $parentInfo.FullName } else { $null }
      if (-not $parent -or $parent -eq $cursor) {
        throw 'STOP: no existing storage path ancestor could be inspected.'
      }
      $cursor = $parent
      continue
    }

    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'STOP: backup inputs and destinations cannot traverse a reparse point.'
    }
    $root = [System.IO.Path]::GetPathRoot($cursor)
    if ($cursor.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $parentInfo = [System.IO.Directory]::GetParent($cursor)
    $parent = if ($parentInfo) { $parentInfo.FullName } else { $null }
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}

function Assert-TqRestrictedAclRules {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][System.Security.AccessControl.FileSystemAccessRule[]]$Rules,
    [Parameter(Mandatory = $true)][hashtable]$ApprovedSids,
    [Parameter(Mandatory = $true)][string]$OwnerSid,
    [Parameter(Mandatory = $true)][ValidateSet('ReadOnly', 'ReadWrite', 'Modify')][string]$RequiredAccess,
    [Parameter(Mandatory = $true)][bool]$RequireProtectedDacl,
    [Parameter(Mandatory = $true)][bool]$AreAccessRulesProtected
  )

  if ($RequireProtectedDacl -and -not $AreAccessRulesProtected) {
    throw 'STOP: sensitive storage DACL is not protected.'
  }
  $approvedValues = @($ApprovedSids.Current, $ApprovedSids.System, $ApprovedSids.Administrators)
  if ($OwnerSid -notin $approvedValues) { throw 'STOP: storage owner is not an approved local identity.' }

  $rightsBySid = @{}
  foreach ($rule in $Rules) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
      throw 'STOP: storage DACL contains a deny ACE; effective access is not accepted as verified.'
    }
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      throw 'STOP: storage DACL contains an unsupported access rule.'
    }
    if ($sid -notin $approvedValues) { throw 'STOP: storage ACL grants access to an unapproved identity.' }
    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if (-not $rightsBySid.ContainsKey($sid)) { $rightsBySid[$sid] = 0 }
    $rightsBySid[$sid] = $rightsBySid[$sid] -bor [int]$rule.FileSystemRights
  }

  $fullControl = [int][System.Security.AccessControl.FileSystemRights]::FullControl
  foreach ($sid in @($ApprovedSids.System, $ApprovedSids.Administrators)) {
    if (-not $rightsBySid.ContainsKey($sid) -or (($rightsBySid[$sid] -band $fullControl) -ne $fullControl)) {
      throw 'STOP: SYSTEM and Administrators must have applicable FullControl grants on the protected storage object.'
    }
  }
  if (-not $rightsBySid.ContainsKey($ApprovedSids.Current)) { throw 'STOP: the current operator has no applicable direct approved storage grant.' }
  $requiredMask = switch ($RequiredAccess) {
    'ReadOnly' { [int][System.Security.AccessControl.FileSystemRights]::Read }
    'ReadWrite' { [int][System.Security.AccessControl.FileSystemRights]::Read -bor [int][System.Security.AccessControl.FileSystemRights]::Write }
    'Modify' { [int][System.Security.AccessControl.FileSystemRights]::Modify }
  }
  if (($rightsBySid[$ApprovedSids.Current] -band $requiredMask) -ne $requiredMask) {
    throw 'STOP: the current operator lacks the minimum applicable direct access required for this path.'
  }
}

Export-ModuleMember -Function ConvertTo-TqCanonicalStoragePath, Test-TqPathWithinRoot, Assert-TqArtifactPathNotVolumeRoot, Assert-TqNoReparsePath, Assert-TqRestrictedAclRules
