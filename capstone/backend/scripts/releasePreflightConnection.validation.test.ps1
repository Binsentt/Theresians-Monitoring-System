$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'releasePreflightConnection.validation.psm1') -Force

$script:Assertions = 0
function Assert-True([bool]$Condition, [string]$Message) {
  $script:Assertions++
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Message) {
  $script:Assertions++
  try { & $Action; throw "ASSERTION FAILED: $Message did not throw." }
  catch {
    if ($_.Exception.Message -like 'ASSERTION FAILED:*') { throw }
    if ($Pattern -and $_.Exception.Message -notmatch $Pattern) {
      throw "ASSERTION FAILED: $Message returned an unexpected sanitized error category."
    }
  }
}

$caPath = 'C:\Synthetic\Protected\root.crt'
$baseText = @"
# Synthetic fixture. Never contains a password.
[tq_release_preflight]
host=localhost
hostaddr=127.0.0.1
port=55432
dbname=tq_synthetic_metadata
user=tq_release_preflight_reader
sslmode=verify-full
sslrootcert=$caPath
"@
$service = ConvertFrom-TqPgServiceFileText -Text $baseText
Assert-TqPgServiceSettings -Service $service -ExpectedServiceName 'tq_release_preflight' `
  -ExpectedDatabase 'tq_synthetic_metadata' -ExpectedRole 'tq_release_preflight_reader' `
  -ExpectedTunnelPort 55432 -ExpectedCaPath $caPath
Assert-True ($service.Settings['host'] -ceq 'localhost') 'host identity must remain localhost for verify-full SAN matching'
Assert-True ($service.Settings['hostaddr'] -ceq '127.0.0.1') 'network route must remain loopback IPv4'

Assert-Throws {
  $extraSetting = ConvertFrom-TqPgServiceFileText ($baseText + "`npassword=synthetic-secret-value")
  Assert-TqPgServiceSettings -Service $extraSetting -ExpectedServiceName 'tq_release_preflight' `
    -ExpectedDatabase 'tq_synthetic_metadata' -ExpectedRole 'tq_release_preflight_reader' `
    -ExpectedTunnelPort 55432 -ExpectedCaPath $caPath
} 'seven approved' 'password/unknown service setting'
Assert-Throws { ConvertFrom-TqPgServiceFileText ($baseText + "`nhost=localhost") } 'duplicate' 'duplicate service setting'
Assert-Throws { ConvertFrom-TqPgServiceFileText ($baseText + "`n[other_service]`napplication_name=other") } 'exactly one' 'additional service section'
Assert-Throws { ConvertFrom-TqPgServiceFileText ("include=/tmp/other.conf`n" + $baseText) } 'unsupported directive' 'service-file include directive'

$badHost = ConvertFrom-TqPgServiceFileText ($baseText -replace 'host=localhost', 'host=remote.example')
Assert-Throws { Assert-TqPgServiceSettings -Service $badHost -ExpectedServiceName 'tq_release_preflight' `
  -ExpectedDatabase 'tq_synthetic_metadata' -ExpectedRole 'tq_release_preflight_reader' `
  -ExpectedTunnelPort 55432 -ExpectedCaPath $caPath } 'does not match' 'non-local TLS host'
$badAddress = ConvertFrom-TqPgServiceFileText ($baseText -replace 'hostaddr=127.0.0.1', 'hostaddr=192.0.2.8')
Assert-Throws { Assert-TqPgServiceSettings -Service $badAddress -ExpectedServiceName 'tq_release_preflight' `
  -ExpectedDatabase 'tq_synthetic_metadata' -ExpectedRole 'tq_release_preflight_reader' `
  -ExpectedTunnelPort 55432 -ExpectedCaPath $caPath } 'does not match' 'non-loopback route'
$badPort = ConvertFrom-TqPgServiceFileText ($baseText -replace 'port=55432', 'port=5432')
Assert-Throws { Assert-TqPgServiceSettings -Service $badPort -ExpectedServiceName 'tq_release_preflight' `
  -ExpectedDatabase 'tq_synthetic_metadata' -ExpectedRole 'tq_release_preflight_reader' `
  -ExpectedTunnelPort 55432 -ExpectedCaPath $caPath } 'does not match' 'unexpected tunnel port'
$badSsl = ConvertFrom-TqPgServiceFileText ($baseText -replace 'sslmode=verify-full', 'sslmode=require')
Assert-Throws { Assert-TqPgServiceSettings -Service $badSsl -ExpectedServiceName 'tq_release_preflight' `
  -ExpectedDatabase 'tq_synthetic_metadata' -ExpectedRole 'tq_release_preflight_reader' `
  -ExpectedTunnelPort 55432 -ExpectedCaPath $caPath } 'does not match' 'non-verify-full TLS'
$badCa = ConvertFrom-TqPgServiceFileText ($baseText -replace 'root.crt', 'other.crt')
Assert-Throws { Assert-TqPgServiceSettings -Service $badCa -ExpectedServiceName 'tq_release_preflight' `
  -ExpectedDatabase 'tq_synthetic_metadata' -ExpectedRole 'tq_release_preflight_reader' `
  -ExpectedTunnelPort 55432 -ExpectedCaPath $caPath } 'does not match' 'unapproved CA path'

Assert-TqNoAmbientPgOverrides -VariableNames @()
Assert-Throws { Assert-TqNoAmbientPgOverrides -VariableNames @('PGHOST', 'PGSSLMODE', 'PGPASSWORD', 'DATABASE_URL') } 'PGHOST|DATABASE_URL' 'ambient libpq overrides'
$environmentError = $null
try { Assert-TqNoAmbientPgOverrides -VariableNames @('PGPASSWORD') } catch { $environmentError = $_.Exception.Message }
Assert-True ($environmentError -notmatch 'synthetic-secret-value') 'environment error must never expose values'

$syntheticPgpass = 'localhost:55432:tq_synthetic_metadata:tq_release_preflight_reader:synthetic\:colon\\slash'
$pgpassMatch = Assert-TqPgPassfileContentMatchesService -Text $syntheticPgpass -Service $service
Assert-True ($pgpassMatch.MatchCount -eq 1 -and $pgpassMatch.LookupHost -ceq 'localhost' -and $pgpassMatch.CredentialPresent) `
  'the exact service tuple must resolve one non-empty passfile credential using host rather than hostaddr'
Assert-True (($pgpassMatch | ConvertTo-Json -Compress) -notmatch 'synthetic|colon|slash') `
  'passfile validation results must never return credential contents'
Assert-Throws {
  Assert-TqPgPassfileContentMatchesService -Text '127.0.0.1:55432:tq_synthetic_metadata:tq_release_preflight_reader:synthetic-only' `
    -Service $service
} 'exactly one exact tuple' 'passfile keyed only by hostaddr instead of service host'
Assert-Throws {
  Assert-TqPgPassfileContentMatchesService -Text "*:*:*:*:synthetic-wildcard`n$syntheticPgpass" -Service $service
} 'exactly one exact tuple' 'wildcard entry shadows or ambiguates exact credentials'
Assert-Throws {
  Assert-TqPgPassfileContentMatchesService -Text 'localhost:55432:tq_synthetic_metadata:tq_release_preflight_reader:' -Service $service
} 'exactly one exact tuple' 'empty matching password'
Assert-Throws {
  Assert-TqPgPassfileContentMatchesService -Text 'localhost:55432:tq_synthetic_metadata:tq_release_preflight_reader:synthetic:extra' -Service $service
} 'malformed' 'unescaped colon in passfile record'
Assert-Throws {
  Assert-TqPgPassfileContentMatchesService -Text 'localhost:55432:tq_synthetic_metadata:other_reader:synthetic-only' -Service $service
} 'exactly one exact tuple' 'wrong passfile role'

$userSid = 'S-1-5-21-111111111-222222222-333333333-1001'
$full = [int][System.Security.AccessControl.FileSystemRights]::FullControl
$validRules = @(
  [pscustomobject]@{ Sid = $userSid; AccessControlType = 'Allow'; IsInherited = $false; Rights = $full },
  [pscustomobject]@{ Sid = 'S-1-5-18'; AccessControlType = 'Allow'; IsInherited = $false; Rights = $full },
  [pscustomobject]@{ Sid = 'S-1-5-32-544'; AccessControlType = 'Allow'; IsInherited = $false; Rights = $full }
)
$validAcl = [pscustomobject]@{ OwnerSid = $userSid; Rules = $validRules }
Assert-TqRestrictedAclRecord -Record $validAcl -CurrentUserSid $userSid -Label 'synthetic file'
Assert-True $true 'approved owner, current user, SYSTEM, and Administrators FullControl grants pass'

$badAcl = [pscustomobject]@{ OwnerSid = $userSid; Rules = @($validRules + [pscustomobject]@{
  Sid = 'S-1-1-0'; AccessControlType = 'Allow'; IsInherited = $false; Rights = $full
}) }
Assert-Throws { Assert-TqRestrictedAclRecord -Record $badAcl -CurrentUserSid $userSid -Label 'synthetic file' } 'exact protected' 'unapproved ACL identity'
$inheritedRules = @($validRules)
$inheritedRules[0] = [pscustomobject]@{ Sid = $userSid; AccessControlType = 'Allow'; IsInherited = $true; Rights = $full }
$badAcl = [pscustomobject]@{ OwnerSid = $userSid; Rules = $inheritedRules }
Assert-Throws { Assert-TqRestrictedAclRecord -Record $badAcl -CurrentUserSid $userSid -Label 'synthetic file' } 'exact protected' 'inherited ACL rule'
$denyRules = @($validRules)
$denyRules[1] = [pscustomobject]@{ Sid = 'S-1-5-18'; AccessControlType = 'Deny'; IsInherited = $false; Rights = $full }
$badAcl = [pscustomobject]@{ OwnerSid = $userSid; Rules = $denyRules }
Assert-Throws { Assert-TqRestrictedAclRecord -Record $badAcl -CurrentUserSid $userSid -Label 'synthetic file' } 'exact protected' 'Deny ACL rule'
$badAcl = [pscustomobject]@{ OwnerSid = 'S-1-5-32-544'; Rules = $validRules }
Assert-Throws { Assert-TqRestrictedAclRecord -Record $badAcl -CurrentUserSid $userSid -Label 'synthetic file' } 'exact protected' 'unexpected ACL owner'

$syntheticCertDir = Join-Path ([System.IO.Path]::GetTempPath()) ('tq-rootca-validator-' + [guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($syntheticCertDir)
$rsa = $null
$syntheticCert = $null
try {
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=synthetic-root', $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign, $true
    )
  )
  $syntheticCert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(30))
  $der = $syntheticCert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  $base64 = [Convert]::ToBase64String($der)
  $wrappedBase64 = [regex]::Replace($base64, '.{1,64}', "`$0`n")
  $pem = "-----BEGIN CERTIFICATE-----`n$wrappedBase64-----END CERTIFICATE-----`n"
  $pemPath = Join-Path $syntheticCertDir 'valid.pem'
  [System.IO.File]::WriteAllText($pemPath, $pem, [System.Text.UTF8Encoding]::new($false))

  $parsedCertificate = Get-TqRootCertificateMetadata -CertificatePath $pemPath
  Assert-True ($parsedCertificate.IsCa -and $parsedCertificate.IsSelfIssued) 'valid BOM-free synthetic CA PEM is accepted and parsed as a CA'
  Assert-True ($parsedCertificate.Subject -ceq 'CN=synthetic-root' -and $parsedCertificate.Issuer -ceq 'CN=synthetic-root') 'synthetic certificate subject and issuer are inspected'
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $expectedSyntheticFingerprint = ([BitConverter]::ToString($sha.ComputeHash($der))).Replace('-', '') }
  finally { $sha.Dispose() }
  Assert-True ($parsedCertificate.Fingerprint -ceq $expectedSyntheticFingerprint) 'certificate metadata uses the DER SHA-256 fingerprint'

  $pemBytes = [System.IO.File]::ReadAllBytes($pemPath)
  $bomBytes = New-Object byte[] ($pemBytes.Length + 3)
  $bomBytes[0] = 0xEF; $bomBytes[1] = 0xBB; $bomBytes[2] = 0xBF
  [System.Array]::Copy($pemBytes, 0, $bomBytes, 3, $pemBytes.Length)
  $bomPath = Join-Path $syntheticCertDir 'bom.pem'
  [System.IO.File]::WriteAllBytes($bomPath, $bomBytes)
  Assert-Throws { Get-TqRootCertificateMetadata -CertificatePath $bomPath } 'BOM-free' 'actual UTF-8 BOM'

  $invalidUtf8Path = Join-Path $syntheticCertDir 'invalid-utf8.pem'
  [System.IO.File]::WriteAllBytes($invalidUtf8Path, [byte[]](0xC3, 0x28))
  Assert-Throws { Get-TqRootCertificateMetadata -CertificatePath $invalidUtf8Path } 'strict UTF-8' 'invalid UTF-8'
} finally {
  if ($syntheticCert) { $syntheticCert.Dispose() }
  if ($rsa) { $rsa.Dispose() }
  if (Test-Path -LiteralPath $syntheticCertDir) { Remove-Item -LiteralPath $syntheticCertDir -Recurse -Force }
}
$pinnedMetadata = [pscustomobject]@{
  Fingerprint = '9A84D18ED0BB44450D38DA6F35A3C4E22AD68192A0C91A2C96DD16E5C17C04DF'
  IsCa = $true
  IsSelfIssued = $true
  NotBeforeUtc = [DateTime]::UtcNow.AddDays(-1)
  NotAfterUtc = [DateTime]::UtcNow.AddDays(1)
}
Assert-TqPinnedPostgresRootCertificate -Metadata $pinnedMetadata
Assert-True $true 'fixed expected CA pin accepts only current CA/self-issued metadata'
$pinnedMetadata.Fingerprint = '00' * 32
Assert-Throws { Assert-TqPinnedPostgresRootCertificate -Metadata $pinnedMetadata } 'fingerprint' 'unapproved root fingerprint'
$pinnedMetadata.Fingerprint = '9A84D18ED0BB44450D38DA6F35A3C4E22AD68192A0C91A2C96DD16E5C17C04DF'
$pinnedMetadata.IsCa = $false
Assert-Throws { Assert-TqPinnedPostgresRootCertificate -Metadata $pinnedMetadata } 'CA constraints' 'missing CA basic constraints'
$pinnedMetadata.IsCa = $true
$pinnedMetadata.IsSelfIssued = $false
Assert-Throws { Assert-TqPinnedPostgresRootCertificate -Metadata $pinnedMetadata } 'issuer' 'untrusted issuer identity'
$pinnedMetadata.IsSelfIssued = $true
$pinnedMetadata.NotBeforeUtc = [DateTime]::UtcNow.AddMinutes(1)
Assert-Throws { Assert-TqPinnedPostgresRootCertificate -Metadata $pinnedMetadata } 'validity' 'not-yet-valid certificate'
$pinnedMetadata.NotBeforeUtc = [DateTime]::UtcNow.AddDays(-1)
$pinnedMetadata.NotAfterUtc = [DateTime]::UtcNow.AddMinutes(-1)
Assert-Throws { Assert-TqPinnedPostgresRootCertificate -Metadata $pinnedMetadata } 'validity' 'expired certificate'

Write-Output "PASS: $script:Assertions synthetic service-file, environment, certificate, pin, and ACL-record assertions."
