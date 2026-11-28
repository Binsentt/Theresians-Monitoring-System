function Get-TqBackupRoleReviewPublicKeyFingerprint {
  param([Parameter(Mandatory = $true)][string]$PublicKeyXml)

  if ($PublicKeyXml -notmatch '\A<RSAKeyValue><Modulus>([A-Za-z0-9+/=]+)</Modulus><Exponent>([A-Za-z0-9+/=]+)</Exponent></RSAKeyValue>\z') {
    throw 'STOP: backup-role review public key has an unsupported format.'
  }
  $modulusText = $Matches[1]
  $exponentText = $Matches[2]
  try {
    $modulus = [Convert]::FromBase64String($modulusText)
    $exponent = [Convert]::FromBase64String($exponentText)
  } catch {
    throw 'STOP: backup-role review public key is malformed.'
  }
  $modulusBitLength = 0
  if ($modulus.Length -gt 0) {
    $leadingByte = [int]$modulus[0]
    while ($leadingByte -gt 0) {
      $modulusBitLength++
      $leadingByte = $leadingByte -shr 1
    }
    $modulusBitLength += ($modulus.Length - 1) * 8
  }
  $exponentIsUsable = $exponent.Length -ge 1 -and $exponent.Length -le 8 -and
    $exponent[0] -ne 0 -and ($exponent[$exponent.Length - 1] -band 1) -eq 1 -and
    ($exponent.Length -gt 1 -or $exponent[0] -ge 3)
  if ([Convert]::ToBase64String($modulus) -cne $modulusText -or
      [Convert]::ToBase64String($exponent) -cne $exponentText -or
      $modulus.Length -gt 1024 -or $modulusBitLength -lt 2048 -or
      -not $exponentIsUsable -or $modulus[0] -eq 0) {
    throw 'STOP: backup-role review RSA key must be canonical and at least 2048 bits.'
  }
  $canonical = "TQ-BACKUP-ROLE-REVIEW-KEY-V1" + [char]10 + $modulusText + [char]10 + $exponentText + [char]10
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($canonical)))).Replace('-', '').ToUpperInvariant()
  } finally {
    $sha.Dispose()
  }
}

function New-TqBackupRoleReviewPayload {
  param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Fields)

  $required = @(
    'reviewer_id', 'decision', 'scope', 'database', 'role', 'server_address',
    'server_port', 'tool_source_sha', 'application_source_sha',
    'routine_inventory_sha256', 'issued_utc', 'expires_utc', 'reviewer_key_sha256'
  )
  if (@($Fields.Keys | Where-Object { $_ -notin $required }).Count -ne 0 -or
      @($required | Where-Object { -not $Fields.Contains($_) }).Count -ne 0) {
    throw 'STOP: backup-role review attestation fields are incomplete or unexpected.'
  }
  if ([string]$Fields['decision'] -cne 'APPROVED' -or
      [string]$Fields['scope'] -cne 'nonwriting-side-effects-and-source-integrity' -or
      [string]$Fields['role'] -cne 'tq_prod_backup_reader' -or
      [string]$Fields['reviewer_id'] -notmatch '^[A-Za-z0-9][A-Za-z0-9._@-]{2,127}$' -or
      [string]$Fields['database'] -notmatch '^[A-Za-z0-9_.-]{1,63}$' -or
      [string]$Fields['server_address'] -match '[\r\n|=]' -or
      [string]$Fields['server_port'] -notmatch '^[1-9][0-9]{0,4}$' -or
      [int]$Fields['server_port'] -gt 65535 -or
      [string]$Fields['tool_source_sha'] -notmatch '^[a-f0-9]{40}$' -or
      [string]$Fields['application_source_sha'] -notmatch '^[a-f0-9]{40}$' -or
      [string]$Fields['routine_inventory_sha256'] -notmatch '^[a-f0-9]{64}$' -or
      [string]$Fields['reviewer_key_sha256'] -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'STOP: backup-role review attestation contains an invalid approval, identity, digest, or scope.'
  }
  $parsedAddress = $null
  if (-not [System.Net.IPAddress]::TryParse([string]$Fields['server_address'], [ref]$parsedAddress)) {
    throw 'STOP: backup-role review attestation target address is invalid.'
  }
  foreach ($name in @('issued_utc', 'expires_utc')) {
    if ([string]$Fields[$name] -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') {
      throw 'STOP: backup-role review attestation time format is invalid.'
    }
    try {
      [void][DateTime]::ParseExact([string]$Fields[$name], "yyyy-MM-dd'T'HH:mm:ss'Z'",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    } catch {
      throw 'STOP: backup-role review attestation time is invalid.'
    }
  }

  $lines = @(
    'TQ_BACKUP_ROLE_REVIEW_V1',
    "reviewer_id=$($Fields['reviewer_id'])",
    "decision=$($Fields['decision'])",
    "scope=$($Fields['scope'])",
    "database=$($Fields['database'])",
    "role=$($Fields['role'])",
    "server_address=$($parsedAddress.ToString())",
    "server_port=$($Fields['server_port'])",
    "tool_source_sha=$($Fields['tool_source_sha'])",
    "application_source_sha=$($Fields['application_source_sha'])",
    "routine_inventory_sha256=$($Fields['routine_inventory_sha256'])",
    "issued_utc=$($Fields['issued_utc'])",
    "expires_utc=$($Fields['expires_utc'])",
    "reviewer_key_sha256=$(([string]$Fields['reviewer_key_sha256']).ToUpperInvariant())"
  )
  return (($lines -join [char]10) + [char]10)
}

function Assert-TqBackupRoleReviewEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$EvidenceText,
    [Parameter(Mandatory = $true)][string]$ExpectedDatabase,
    [Parameter(Mandatory = $true)][string]$ExpectedServerAddress,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$ExpectedServerPort,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedToolSourceSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedApplicationSourceSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRoutineInventorySha256,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedReviewerKeySha256
  )

  $hasBom = $EvidenceText.Length -gt 0 -and [int][char]$EvidenceText[0] -eq 0xFEFF
  if ($hasBom -or $EvidenceText.Length -gt 16384) {
    throw 'STOP: backup-role review evidence has a BOM or exceeds the 16 KiB limit.'
  }
  $normalized = [regex]::Replace($EvidenceText, "\r\n?|\n", [string][char]10)
  $lines = @($normalized.Split([char]10))
  if ($lines.Count -eq 17 -and $lines[16] -ceq '') { $lines = @($lines[0..15]) }
  if ($lines.Count -ne 16 -or $lines[0] -cne 'TQ_BACKUP_ROLE_REVIEW_V1') {
    throw 'STOP: backup-role review evidence structure is invalid.'
  }
  $names = @(
    'reviewer_id', 'decision', 'scope', 'database', 'role', 'server_address',
    'server_port', 'tool_source_sha', 'application_source_sha',
    'routine_inventory_sha256', 'issued_utc', 'expires_utc', 'reviewer_key_sha256',
    'public_key_xml_base64', 'signature_sha256_rsa_base64'
  )
  $values = @{}
  for ($i = 0; $i -lt $names.Count; $i++) {
    $prefix = $names[$i] + '='
    $line = [string]$lines[$i + 1]
    if (-not $line.StartsWith($prefix, [StringComparison]::Ordinal)) {
      throw 'STOP: backup-role review evidence has missing, duplicate, reordered, or unexpected fields.'
    }
    $values[$names[$i]] = $line.Substring($prefix.Length)
  }

  $fields = [ordered]@{}
  foreach ($name in @(
    'reviewer_id', 'decision', 'scope', 'database', 'role', 'server_address',
    'server_port', 'tool_source_sha', 'application_source_sha',
    'routine_inventory_sha256', 'issued_utc', 'expires_utc', 'reviewer_key_sha256'
  )) { $fields[$name] = $values[$name] }
  $payload = New-TqBackupRoleReviewPayload -Fields $fields

  if ($fields.database -cne $ExpectedDatabase -or
      $fields.role -cne 'tq_prod_backup_reader' -or
      $fields.server_address -cne ([System.Net.IPAddress]::Parse($ExpectedServerAddress).ToString()) -or
      [int]$fields.server_port -ne $ExpectedServerPort -or
      $fields.tool_source_sha -cne $ExpectedToolSourceSha -or
      $fields.application_source_sha -cne $ExpectedApplicationSourceSha -or
      $fields.routine_inventory_sha256 -cne $ExpectedRoutineInventorySha256 -or
      $fields.reviewer_key_sha256 -cne $ExpectedReviewerKeySha256.ToUpperInvariant()) {
    throw 'STOP: backup-role review evidence contradicts the approved database, source, routine inventory, or reviewer-key inputs.'
  }

  $issued = [DateTime]::ParseExact($fields.issued_utc, "yyyy-MM-dd'T'HH:mm:ss'Z'",
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
  $expires = [DateTime]::ParseExact($fields.expires_utc, "yyyy-MM-dd'T'HH:mm:ss'Z'",
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
  $now = [DateTime]::UtcNow
  if ($issued -gt $now.AddMinutes(5) -or $expires -le $now -or
      $expires -le $issued -or $expires -gt $issued.AddDays(7)) {
    throw 'STOP: backup-role review evidence is not yet valid, expired, or valid for more than seven days.'
  }

  try {
    $keyXmlBytes = [Convert]::FromBase64String($values.public_key_xml_base64)
    $signatureBytes = [Convert]::FromBase64String($values.signature_sha256_rsa_base64)
  } catch {
    throw 'STOP: backup-role review signature or public key encoding is malformed.'
  }
  if ([Convert]::ToBase64String($keyXmlBytes) -cne $values.public_key_xml_base64 -or
      [Convert]::ToBase64String($signatureBytes) -cne $values.signature_sha256_rsa_base64 -or
      $signatureBytes.Length -lt 256 -or $signatureBytes.Length -gt 1024) {
    throw 'STOP: backup-role review signature or public key encoding is non-canonical.'
  }
  try { $keyXml = [System.Text.UTF8Encoding]::new($false, $true).GetString($keyXmlBytes) }
  catch { throw 'STOP: backup-role review public key is not strict UTF-8.' }
  $actualKeyFingerprint = Get-TqBackupRoleReviewPublicKeyFingerprint -PublicKeyXml $keyXml
  if ($actualKeyFingerprint -cne $fields.reviewer_key_sha256.ToUpperInvariant()) {
    throw 'STOP: backup-role review public key does not match its signed fingerprint.'
  }

  if ($keyXml -notmatch '\A<RSAKeyValue><Modulus>([A-Za-z0-9+/=]+)</Modulus><Exponent>([A-Za-z0-9+/=]+)</Exponent></RSAKeyValue>\z') {
    throw 'STOP: backup-role review public key structure is invalid.'
  }
  $rsa = [System.Security.Cryptography.RSACryptoServiceProvider]::new()
  $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  try {
    $parameters = [System.Security.Cryptography.RSAParameters]::new()
    $parameters.Modulus = [Convert]::FromBase64String($Matches[1])
    $parameters.Exponent = [Convert]::FromBase64String($Matches[2])
    $rsa.ImportParameters($parameters)
    $signatureValid = $rsa.VerifyData($payloadBytes, [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), $signatureBytes)
  } catch {
    throw 'STOP: backup-role review signature could not be verified.'
  } finally {
    $rsa.Dispose()
  }
  if (-not $signatureValid) { throw 'STOP: backup-role review signature is invalid.' }
  $payloadHasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $payloadSha256 = ([BitConverter]::ToString($payloadHasher.ComputeHash($payloadBytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $payloadHasher.Dispose()
  }

  return [pscustomobject]@{
    Status = 'PASS'
    ReviewerId = $fields.reviewer_id
    ExpiresUtc = $expires
    RoutineInventorySha256 = $fields.routine_inventory_sha256
    ReviewerKeySha256 = $fields.reviewer_key_sha256
    SignedPayloadSha256 = $payloadSha256
  }
}

function Register-TqBackupRoleReviewEvidenceUse {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$PayloadSha256,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RegistryDirectory
  )

  if (-not [System.IO.Path]::IsPathRooted($RegistryDirectory)) {
    throw 'STOP: backup-role review-use registry directory must be an absolute path.'
  }
  try { $directory = [System.IO.Path]::GetFullPath($RegistryDirectory) }
  catch { throw 'STOP: backup-role review-use registry directory is invalid.' }
  if (-not [System.IO.Directory]::Exists($directory)) {
    throw 'STOP: backup-role review-use registry directory must already exist.'
  }
  if ($directory.Equals([System.IO.Path]::GetPathRoot($directory), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: backup-role review-use registry cannot be a volume root.'
  }

  $cursor = $directory
  while ($cursor) {
    try { $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop }
    catch { throw 'STOP: backup-role review-use registry path could not be inspected.' }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'STOP: backup-role review-use registry cannot traverse reparse points.'
    }
    $root = [System.IO.Path]::GetPathRoot($cursor)
    if ($cursor.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = [System.IO.Directory]::GetParent($cursor)
    if ($null -eq $parent -or $parent.FullName -ceq $cursor) {
      throw 'STOP: backup-role review-use registry path has no verifiable root.'
    }
    $cursor = $parent.FullName
  }

  try {
    $legacyReceipt = Get-ChildItem -LiteralPath $directory -Force -File -ErrorAction Stop |
      Where-Object { $_.Name -match '\A\.tq-backup-role-review-[a-f0-9]{64}\.used\z' } |
      Select-Object -First 1
  } catch {
    throw 'STOP: legacy backup-role review receipts could not be inventoried safely.'
  }
  if ($null -ne $legacyReceipt) {
    throw 'STOP: legacy raw-evidence use receipt requires reconciliation before canonical claims.'
  }

  $markerPath = Join-Path $directory ('.tq-backup-role-review-payload-' + $PayloadSha256 + '.used')
  $usedAtUtc = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
  $record = "TQ_BACKUP_ROLE_REVIEW_PAYLOAD_USE_V1`nPayloadSha256=$PayloadSha256`nUsedAtUtc=$usedAtUtc`n"
  $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes($record)
  try {
    $stream = [System.IO.FileStream]::new(
      $markerPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
  } catch {
    if ([System.IO.File]::Exists($markerPath)) {
      throw 'STOP: backup-role review signed payload already has a use receipt or interrupted claim; obtain a new independent review.'
    }
    throw 'STOP: backup-role review evidence use could not be durably recorded.'
  }

  return [pscustomobject]@{
    Status = 'PASS'
    MarkerPath = $markerPath
    PayloadSha256 = $PayloadSha256
    UsedAtUtc = [DateTime]::ParseExact($usedAtUtc, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
  }
}

Export-ModuleMember -Function @(
  'Get-TqBackupRoleReviewPublicKeyFingerprint',
  'New-TqBackupRoleReviewPayload',
  'Assert-TqBackupRoleReviewEvidence',
  'Register-TqBackupRoleReviewEvidenceUse'
)
