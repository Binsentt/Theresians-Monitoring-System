$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot 'backupRoleReview.validation.psm1'
Import-Module -Name $modulePath -Force -ErrorAction Stop

$passed = 0
$failed = 0
$rsa = [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048)
$publicParameters = $rsa.ExportParameters($false)
$publicKeyXml = '<RSAKeyValue><Modulus>' + [Convert]::ToBase64String($publicParameters.Modulus) + '</Modulus><Exponent>' + [Convert]::ToBase64String($publicParameters.Exponent) + '</Exponent></RSAKeyValue>'
$keyFingerprint = Get-TqBackupRoleReviewPublicKeyFingerprint -PublicKeyXml $publicKeyXml
$weakModulus = New-Object byte[] 256
$weakModulus[0] = 0x7f
for ($i = 1; $i -lt $weakModulus.Length; $i++) { $weakModulus[$i] = 0xff }
$weakKeyXml = '<RSAKeyValue><Modulus>' + [Convert]::ToBase64String($weakModulus) + '</Modulus><Exponent>' + [Convert]::ToBase64String([byte[]]@(1,0,1)) + '</Exponent></RSAKeyValue>'
$exponentOneKeyXml = '<RSAKeyValue><Modulus>' + [Convert]::ToBase64String($publicParameters.Modulus) + '</Modulus><Exponent>' + [Convert]::ToBase64String([byte[]]@(1)) + '</Exponent></RSAKeyValue>'
$evenExponentKeyXml = '<RSAKeyValue><Modulus>' + [Convert]::ToBase64String($publicParameters.Modulus) + '</Modulus><Exponent>' + [Convert]::ToBase64String([byte[]]@(2)) + '</Exponent></RSAKeyValue>'
foreach ($weakExponentCase in @(
  @{ Name = 'RSA exponent one rejection'; Xml = $exponentOneKeyXml },
  @{ Name = 'even RSA exponent rejection'; Xml = $evenExponentKeyXml }
)) {
  try {
    [void](Get-TqBackupRoleReviewPublicKeyFingerprint -PublicKeyXml $weakExponentCase.Xml)
    $failed++
    Write-Output "FAIL: $($weakExponentCase.Name)"
  } catch {
    $passed++
    Write-Output "PASS: $($weakExponentCase.Name)"
  }
}
try {
  [void](Get-TqBackupRoleReviewPublicKeyFingerprint -PublicKeyXml $weakKeyXml)
  $failed++
  Write-Output 'FAIL: sub-2048-bit RSA key rejection'
} catch {
  $passed++
  Write-Output 'PASS: sub-2048-bit RSA key rejection'
}
$now = [DateTime]::UtcNow
$issued = $now.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$expires = $now.AddHours(2).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$expected = @{
  ExpectedDatabase = 'synthetic_backup_db'
  ExpectedServerAddress = '127.0.0.1'
  ExpectedServerPort = 5432
  ExpectedToolSourceSha = ('a' * 40)
  ExpectedApplicationSourceSha = ('b' * 40)
  ExpectedRoutineInventorySha256 = ('c' * 64)
  ExpectedReviewerKeySha256 = $keyFingerprint
}

function New-SyntheticEvidence {
  param(
    [string]$ReviewerId = 'synthetic-reviewer',
    [string]$Decision = 'APPROVED',
    [string]$Scope = 'nonwriting-side-effects-and-source-integrity',
    [string]$Database = 'synthetic_backup_db',
    [string]$ServerAddress = '127.0.0.1',
    [string]$ServerPort = '5432',
    [string]$ToolSha = ('a' * 40),
    [string]$ApplicationSha = ('b' * 40),
    [string]$InventorySha = ('c' * 64),
    [string]$IssuedUtc = $issued,
    [string]$ExpiresUtc = $expires,
    [string]$KeySha = $keyFingerprint,
    [switch]$CorruptSignature
  )
  $lines = @(
    'TQ_BACKUP_ROLE_REVIEW_V1',
    "reviewer_id=$ReviewerId",
    "decision=$Decision",
    "scope=$Scope",
    "database=$Database",
    'role=tq_prod_backup_reader',
    "server_address=$ServerAddress",
    "server_port=$ServerPort",
    "tool_source_sha=$ToolSha",
    "application_source_sha=$ApplicationSha",
    "routine_inventory_sha256=$InventorySha",
    "issued_utc=$IssuedUtc",
    "expires_utc=$ExpiresUtc",
    "reviewer_key_sha256=$KeySha"
  )
  $payload = (($lines -join [char]10) + [char]10)
  $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $oid = [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256')
  $signature = $rsa.SignData($payloadBytes, $oid)
  if ($CorruptSignature) { $signature[0] = [byte]($signature[0] -bxor 1) }
  $lines += 'public_key_xml_base64=' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($publicKeyXml))
  $lines += 'signature_sha256_rsa_base64=' + [Convert]::ToBase64String($signature)
  return ($lines -join [char]10)
}

function Invoke-ExpectPass {
  param([string]$Name, [string]$EvidenceText)
  try {
    $result = Assert-TqBackupRoleReviewEvidence -EvidenceText $EvidenceText @expected
    if ($result.Status -cne 'PASS') { throw 'Unexpected status.' }
    $script:passed++
    Write-Output "PASS: $Name"
  } catch {
    $script:failed++
    Write-Output ("FAIL: $Name - " + $_.Exception.Message)
  }
}

function Invoke-ExpectReject {
  param([string]$Name, [string]$EvidenceText, [hashtable]$Overrides = @{})
  try {
    $caseArgs = @{} + $expected + $Overrides
    $caseArgs.EvidenceText = $EvidenceText
    [void](Assert-TqBackupRoleReviewEvidence @caseArgs)
    $script:failed++
    Write-Output "FAIL: $Name"
  } catch {
    $script:passed++
    Write-Output "PASS: $Name"
  }
}

$valid = New-SyntheticEvidence
Invoke-ExpectPass 'valid independently pinned synthetic signature' $valid
$crlf = $valid.Replace([string][char]10, [string]([char]13) + [char]10)
Invoke-ExpectPass 'CRLF evidence normalization' $crlf

Invoke-ExpectReject 'wrong database' $valid @{ ExpectedDatabase = 'other_database' }
Invoke-ExpectReject 'wrong server address' $valid @{ ExpectedServerAddress = '127.0.0.2' }
Invoke-ExpectReject 'wrong server port' $valid @{ ExpectedServerPort = 55432 }
Invoke-ExpectReject 'wrong tool source SHA' $valid @{ ExpectedToolSourceSha = ('d' * 40) }
Invoke-ExpectReject 'wrong application source SHA' $valid @{ ExpectedApplicationSourceSha = ('e' * 40) }
Invoke-ExpectReject 'wrong routine inventory digest' $valid @{ ExpectedRoutineInventorySha256 = ('f' * 64) }
Invoke-ExpectReject 'wrong independently approved reviewer-key pin' $valid @{ ExpectedReviewerKeySha256 = ('0' * 64) }
$expired = New-SyntheticEvidence -IssuedUtc $now.AddDays(-8).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture) -ExpiresUtc $now.AddDays(-1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
Invoke-ExpectReject 'expired attestation' $expired
$future = New-SyntheticEvidence -IssuedUtc $now.AddHours(1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
Invoke-ExpectReject 'future-issued attestation' $future
$longLived = New-SyntheticEvidence -ExpiresUtc $now.AddDays(8).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
Invoke-ExpectReject 'attestation lifetime over seven days' $longLived
Invoke-ExpectReject 'altered RSA signature' (New-SyntheticEvidence -CorruptSignature)
Invoke-ExpectReject 'contradictory rejected decision' (New-SyntheticEvidence -Decision 'REJECTED')
Invoke-ExpectReject 'contradictory review scope' (New-SyntheticEvidence -Scope 'database-rows-reviewed')
Invoke-ExpectReject 'duplicate field' ($valid.Replace('decision=APPROVED', 'decision=APPROVED' + [char]10 + 'database=attacker'))
$reorderedLines = @($valid.Split([char]10))
$tempLine = $reorderedLines[1]
$reorderedLines[1] = $reorderedLines[4]
$reorderedLines[4] = $tempLine
Invoke-ExpectReject 'reordered fields' ($reorderedLines -join [char]10)
Invoke-ExpectReject 'unexpected field' ($valid + [char]10 + 'unexpected=value')
Invoke-ExpectReject 'BOM-prefixed evidence' ([string][char]0xFEFF + $valid)
Invoke-ExpectReject 'malformed timestamp' (New-SyntheticEvidence -IssuedUtc 'not-a-time')
$truncated = (($valid.Split([char]10) | Select-Object -First 10) -join [char]10)
Invoke-ExpectReject 'truncated evidence' $truncated

$rsa.Dispose()
if ($failed -ne 0) { throw "Backup-role review tests failed: $failed failed, $passed passed." }
Write-Output "Backup-role signed-review tests: $passed passed, 0 failed."
