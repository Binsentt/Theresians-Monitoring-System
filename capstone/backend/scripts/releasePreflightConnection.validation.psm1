$script:ProductionRootCaSha256 = '9A84D18ED0BB44450D38DA6F35A3C4E22AD68192A0C91A2C96DD16E5C17C04DF'
$script:FullControlMask = [int][System.Security.AccessControl.FileSystemRights]::FullControl

function Get-TqAmbientPgOverrideNames {
  $names = @(Get-ChildItem Env: | ForEach-Object { $_.Name } | Where-Object { $_ -match '^PG' })
  if (Test-Path Env:DATABASE_URL) { $names += 'DATABASE_URL' }
  if (Test-Path Env:DB_SSL) { $names += 'DB_SSL' }
  return @($names | Sort-Object -Unique)
}

function Assert-TqNoAmbientPgOverrides {
  param([string[]]$VariableNames = @(Get-TqAmbientPgOverrideNames))
  $overrides = @($VariableNames | Where-Object { $_ -match '^PG' -or $_ -in @('DATABASE_URL', 'DB_SSL') } | Sort-Object -Unique)
  if ($overrides.Count -gt 0) {
    throw "STOP: remove ambient PostgreSQL connection/TLS overrides before preflight: $($overrides -join ', '). Values were not read."
  }
}

function ConvertFrom-TqPgServiceFileText {
  param([Parameter(Mandatory = $true)][string]$Text)

  $sectionNames = New-Object 'System.Collections.Generic.List[string]'
  $settings = @{}
  $activeSection = $null
  foreach ($line in ($Text -split '\r?\n')) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or $trimmed.StartsWith(';')) { continue }
    if ($trimmed -match '^\[([^\]\s]+)\]$') {
      $activeSection = $Matches[1]
      $sectionNames.Add($activeSection)
      continue
    }
    if (-not $activeSection -or $trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      throw 'STOP: PostgreSQL service file contains an unsupported directive or malformed setting.'
    }
    $key = $Matches[1].ToLowerInvariant()
    $value = $Matches[2]
    if (-not $value -or $value -match '[\x00-\x1f"'']|[#;]') {
      throw 'STOP: PostgreSQL service setting value is empty or uses unsupported quoting/control syntax.'
    }
    if ($settings.ContainsKey($key)) { throw 'STOP: PostgreSQL service file contains a duplicate setting.' }
    $settings[$key] = $value
  }

  if ($sectionNames.Count -ne 1) { throw 'STOP: PostgreSQL service file must contain exactly one service section.' }
  return [pscustomobject]@{ ServiceName = $sectionNames[0]; Settings = $settings }
}

function Assert-TqPgServiceSettings {
  param(
    [Parameter(Mandatory = $true)][object]$Service,
    [Parameter(Mandatory = $true)][string]$ExpectedServiceName,
    [Parameter(Mandatory = $true)][string]$ExpectedDatabase,
    [Parameter(Mandatory = $true)][string]$ExpectedRole,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$ExpectedTunnelPort,
    [Parameter(Mandatory = $true)][string]$ExpectedCaPath
  )

  $settings = $Service.Settings
  $requiredKeys = @('host', 'hostaddr', 'port', 'dbname', 'user', 'sslmode', 'sslrootcert')
  if ($Service.ServiceName -cne $ExpectedServiceName -or $settings.Count -ne $requiredKeys.Count -or
      @($settings.Keys | Where-Object { $_ -notin $requiredKeys }).Count -ne 0 -or
      @($requiredKeys | Where-Object { -not $settings.ContainsKey($_) }).Count -ne 0) {
    throw 'STOP: PostgreSQL service file must contain only the seven approved connection settings.'
  }

  $expectedCa = [System.IO.Path]::GetFullPath($ExpectedCaPath)
  $configuredCa = [System.IO.Path]::GetFullPath([string]$settings['sslrootcert'])
  if ($settings['host'] -cne 'localhost' -or $settings['hostaddr'] -cne '127.0.0.1' -or
      $settings['port'] -cne [string]$ExpectedTunnelPort -or
      $settings['dbname'] -cne $ExpectedDatabase -or $settings['user'] -cne $ExpectedRole -or
      $settings['sslmode'] -cne 'verify-full' -or
      -not $configuredCa.Equals($expectedCa, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: PostgreSQL service file does not match the approved loopback, role, database, tunnel-port, and verify-full CA configuration.'
  }
}

function ConvertFrom-TqPgPassfileRecord {
  param([Parameter(Mandatory = $true)][string]$Line)

  $fields = New-Object 'System.Collections.Generic.List[string]'
  $field = New-Object System.Text.StringBuilder
  $escaped = $false
  foreach ($character in $Line.ToCharArray()) {
    if ($escaped) {
      if ($character -ne [char]58 -and $character -ne [char]92) {
        throw 'STOP: PGPASSFILE contains a malformed or unsupported record.'
      }
      [void]$field.Append($character)
      $escaped = $false
      continue
    }
    if ($character -eq [char]92) {
      $escaped = $true
      continue
    }
    if ($character -eq [char]58) {
      $fields.Add($field.ToString())
      [void]$field.Clear()
      continue
    }
    [void]$field.Append($character)
  }
  if ($escaped) { throw 'STOP: PGPASSFILE contains a malformed or unsupported record.' }
  $fields.Add($field.ToString())
  if ($fields.Count -ne 5) { throw 'STOP: PGPASSFILE contains a malformed or unsupported record.' }
  return ,($fields.ToArray())
}

function Assert-TqPgPassfileContentMatchesService {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][object]$Service
  )

  $settings = $Service.Settings
  $expected = @([string]$settings['host'], [string]$settings['port'],
    [string]$settings['dbname'], [string]$settings['user'])
  $matches = New-Object 'System.Collections.Generic.List[object]'
  foreach ($line in [regex]::Split($Text, "`r`n|`n|`r")) {
    if ($line.Length -eq 0 -or $line.StartsWith('#', [System.StringComparison]::Ordinal)) { continue }
    $fields = ConvertFrom-TqPgPassfileRecord -Line $line
    $matchesService = $true
    for ($index = 0; $index -lt 4; $index++) {
      if ($fields[$index] -cne '*' -and $fields[$index] -cne $expected[$index]) {
        $matchesService = $false
        break
      }
    }
    if ($matchesService) { $matches.Add($fields) }
  }

  if ($matches.Count -ne 1) {
    throw 'STOP: PGPASSFILE must contain exactly one exact tuple for the validated PostgreSQL service.'
  }
  $selected = $matches[0]
  for ($index = 0; $index -lt 4; $index++) {
    if ($selected[$index] -cne $expected[$index]) {
      throw 'STOP: PGPASSFILE must contain exactly one exact tuple for the validated PostgreSQL service.'
    }
  }
  if ($selected[4].Length -eq 0) {
    throw 'STOP: PGPASSFILE must contain exactly one exact tuple for the validated PostgreSQL service.'
  }

  # With both host and hostaddr configured, libpq uses host for passfile
  # matching and hostaddr only for routing. Never return the password field.
  return [pscustomobject]@{
    MatchCount = 1
    LookupHost = [string]$settings['host']
    CredentialPresent = $true
  }
}

function Get-TqRootCertificateMetadata {
  param([Parameter(Mandatory = $true)][string]$CertificatePath)

  try {
    $bytes = [System.IO.File]::ReadAllBytes($CertificatePath)
    $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
  } catch {
    throw 'STOP: verified PostgreSQL root CA file is missing or is not strict UTF-8 PEM.'
  }
  if ($text.StartsWith([string][char]0xFEFF, [System.StringComparison]::Ordinal)) { throw 'STOP: verified PostgreSQL root CA must be BOM-free PEM.' }
  $match = [regex]::Match($text, '\A-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\s*\z')
  if (-not $match.Success) { throw 'STOP: verified PostgreSQL root CA must contain exactly one clean PEM certificate.' }
  $base64 = $match.Groups[1].Value -replace '\s', ''
  try { $der = [Convert]::FromBase64String($base64) } catch { throw 'STOP: PostgreSQL root CA PEM has malformed Base64.' }
  if (-not $base64 -or [Convert]::ToBase64String($der) -cne $base64) {
    throw 'STOP: PostgreSQL root CA PEM has non-canonical Base64.'
  }
  try {
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
  } catch {
    throw 'STOP: PostgreSQL root CA is not valid X.509.'
  }
  try {
    $basicConstraints = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | Select-Object -First 1
    $isCa = $false
    if ($basicConstraints) {
      $isCa = ([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]$basicConstraints).CertificateAuthority
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($certificate.RawData))).Replace('-', '') }
    finally { $sha.Dispose() }
    return [pscustomobject]@{
      Fingerprint = $fingerprint
      Subject = $certificate.Subject
      Issuer = $certificate.Issuer
      NotBeforeUtc = $certificate.NotBefore.ToUniversalTime()
      NotAfterUtc = $certificate.NotAfter.ToUniversalTime()
      IsCa = $isCa
      IsSelfIssued = ($certificate.Subject -ceq $certificate.Issuer)
    }
  } finally { $certificate.Dispose() }
}

function Assert-TqPinnedPostgresRootCertificate {
  param([Parameter(Mandatory = $true)][object]$Metadata)
  $now = [DateTime]::UtcNow
  if ($Metadata.Fingerprint -cne $script:ProductionRootCaSha256 -or -not $Metadata.IsCa -or
      -not $Metadata.IsSelfIssued -or $Metadata.NotBeforeUtc -gt $now -or $Metadata.NotAfterUtc -lt $now) {
    throw 'STOP: PostgreSQL root CA fingerprint, CA constraints, issuer, or validity does not match the verified production trust anchor.'
  }
}

function Assert-TqRestrictedAclRecord {
  param(
    [Parameter(Mandatory = $true)][object]$Record,
    [Parameter(Mandatory = $true)][string]$CurrentUserSid,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $expectedSids = @($CurrentUserSid, 'S-1-5-18', 'S-1-5-32-544')
  $ownerAllowed = $Record.OwnerSid -ceq $CurrentUserSid
  $rules = @($Record.Rules)
  $seen = @{}
  $validRules = $true
  foreach ($rule in $rules) {
    if ($rule.IsInherited -or $rule.AccessControlType -cne 'Allow' -or
        $rule.Rights -ne $script:FullControlMask -or $rule.Sid -notin $expectedSids -or
        $seen.ContainsKey([string]$rule.Sid)) {
      $validRules = $false
      break
    }
    $seen[[string]$rule.Sid] = $true
  }
  if (-not $ownerAllowed -or $rules.Count -ne 3 -or -not $validRules -or
      @($expectedSids | Where-Object { -not $seen.ContainsKey($_) }).Count -ne 0) {
    throw "STOP: $Label ACL is not the exact protected current-user/SYSTEM/Administrators FullControl DACL."
  }
}

function Get-TqAclRecord {
  param([Parameter(Mandatory = $true)][string]$PathValue, [Parameter(Mandatory = $true)][string]$Label)
  try {
    $acl = Get-Acl -LiteralPath $PathValue -ErrorAction Stop
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [pscustomobject]@{
        Sid = $_.IdentityReference.Value
        AccessControlType = [string]$_.AccessControlType
        IsInherited = [bool]$_.IsInherited
        Rights = [int]$_.FileSystemRights
      }
    })
    return [pscustomobject]@{ OwnerSid = $ownerSid; Rules = $rules; AreAccessRulesProtected = [bool]$acl.AreAccessRulesProtected }
  } catch {
    throw "STOP: $Label ACL could not be read safely."
  }
}

function Assert-TqProtectedLocalFile {
  param(
    [Parameter(Mandatory = $true)][string]$PathValue,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$CurrentUserSid
  )
  if (-not [System.IO.Path]::IsPathRooted($PathValue) -or $PathValue -notmatch '^[A-Za-z]:\\') {
    throw "STOP: $Label must be a local drive path."
  }
  $fullPath = [System.IO.Path]::GetFullPath($PathValue).TrimEnd('\')
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  $repo = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
  if ($fullPath.Equals($repo, [System.StringComparison]::OrdinalIgnoreCase) -or
      $fullPath.StartsWith($repo + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: $Label must remain outside the repository."
  }

  $components = $fullPath.Substring($root.Length).Split('\')
  $cursor = $root
  foreach ($component in $components) {
    if (-not $component) { continue }
    $cursor = Join-Path $cursor $component
    try { $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop }
    catch { throw "STOP: $Label path or an ancestor is unavailable." }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "STOP: $Label path or an ancestor is a reparse point."
    }
  }

  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Length -le 0) { throw "STOP: $Label must be a non-empty regular file." }
  $parentPath = Split-Path -Parent $fullPath
  $parentItem = Get-Item -LiteralPath $parentPath -Force -ErrorAction Stop
  if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "STOP: $Label parent directory is not a regular local directory."
  }

  foreach ($target in @(@{ Path = $parentPath; Description = "$Label parent" }, @{ Path = $fullPath; Description = $Label })) {
    $record = Get-TqAclRecord -PathValue $target.Path -Label $target.Description
    if (-not $record.AreAccessRulesProtected) { throw "STOP: $($target.Description) ACL inherits permissions." }
    Assert-TqRestrictedAclRecord -Record $record -CurrentUserSid $CurrentUserSid -Label $target.Description
  }
  return $fullPath
}

function Assert-TqPreflightConnectionFiles {
  param(
    [Parameter(Mandatory = $true)][string]$ServiceFilePath,
    [Parameter(Mandatory = $true)][string]$PassfilePath,
    [Parameter(Mandatory = $true)][string]$VerifiedCaPath,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedDatabase,
    [Parameter(Mandatory = $true)][string]$ExpectedRole,
    [Parameter(Mandatory = $true)][ValidateSet('tq_release_preflight')][string]$ExpectedServiceName,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$ExpectedTunnelPort
  )
  Assert-TqNoAmbientPgOverrides
  $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $servicePath = Assert-TqProtectedLocalFile -PathValue $ServiceFilePath -Label 'PGSERVICEFILE' -RepositoryRoot $RepositoryRoot -CurrentUserSid $currentUserSid
  $passPath = Assert-TqProtectedLocalFile -PathValue $PassfilePath -Label 'PGPASSFILE' -RepositoryRoot $RepositoryRoot -CurrentUserSid $currentUserSid
  $caPath = Assert-TqProtectedLocalFile -PathValue $VerifiedCaPath -Label 'PostgreSQL root CA' -RepositoryRoot $RepositoryRoot -CurrentUserSid $currentUserSid
  if ($servicePath.Equals($passPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      $servicePath.Equals($caPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      $passPath.Equals($caPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: service, passfile, and CA trust files must be distinct files.'
  }
  try { $serviceText = [System.IO.File]::ReadAllText($servicePath, [System.Text.UTF8Encoding]::new($false, $true)) }
  catch { throw 'STOP: PostgreSQL service file is not strict UTF-8 text.' }
  $service = ConvertFrom-TqPgServiceFileText -Text $serviceText
  Assert-TqPgServiceSettings -Service $service -ExpectedServiceName $ExpectedServiceName `
    -ExpectedDatabase $ExpectedDatabase -ExpectedRole $ExpectedRole -ExpectedTunnelPort $ExpectedTunnelPort -ExpectedCaPath $caPath
  try { $passText = [System.IO.File]::ReadAllText($passPath, [System.Text.UTF8Encoding]::new($false, $true)) }
  catch { throw 'STOP: PostgreSQL passfile is missing or is not strict UTF-8 text.' }
  [void](Assert-TqPgPassfileContentMatchesService -Text $passText -Service $service)
  $passText = $null
  $serviceText = $null
  $certificate = Get-TqRootCertificateMetadata -CertificatePath $caPath
  Assert-TqPinnedPostgresRootCertificate -Metadata $certificate
  return [pscustomobject]@{ ServiceFilePath = $servicePath; PassfilePath = $passPath; VerifiedCaPath = $caPath }
}

Export-ModuleMember -Function Get-TqAmbientPgOverrideNames, Assert-TqNoAmbientPgOverrides, `
  ConvertFrom-TqPgServiceFileText, Assert-TqPgServiceSettings, Assert-TqPgPassfileContentMatchesService, Get-TqRootCertificateMetadata, `
  Assert-TqPinnedPostgresRootCertificate, Assert-TqRestrictedAclRecord, Assert-TqProtectedLocalFile, `
  Assert-TqPreflightConnectionFiles
