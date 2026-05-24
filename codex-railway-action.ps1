$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\Documents\Theresian's Quest- Web"
$report = Join-Path $repo 'codex-railway-action.report.json'

function Write-Report($obj) {
  $obj | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $report -Encoding UTF8
}

Write-Host 'Railway deployment action'
Write-Host 'Paste Railway project token. Input is hidden and will not be saved.'
$secure = Read-Host -AsSecureString 'Railway token'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'No token entered' }
  Write-Report @(@{
    time = (Get-Date).ToUniversalTime().ToString('o')
    step = 'powershell-token-received'
    tokenPresent = $true
    nodeHelper = (Join-Path $repo 'codex-railway-action.js')
    nodeHelperExists = (Test-Path -LiteralPath (Join-Path $repo 'codex-railway-action.js'))
  })
  $env:RAILWAY_TOKEN = $token
  Remove-Item Env:RAILWAY_API_TOKEN -ErrorAction SilentlyContinue
  Push-Location $repo
  try {
    & 'C:\Program Files\nodejs\node.exe' '.\codex-railway-action.js'
    if ($LASTEXITCODE -ne 0) {
      throw "Node helper exited with code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
  Write-Host "Railway action finished. Sanitized report: $report"
} catch {
  Write-Report @(@{
    time = (Get-Date).ToUniversalTime().ToString('o')
    step = 'powershell-error'
    error = $_.Exception.Message
  })
  Write-Host ("Railway action failed: " + $_.Exception.Message)
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $token = $null
  Remove-Item Env:RAILWAY_TOKEN -ErrorAction SilentlyContinue
}
Read-Host 'Press Enter to close'
