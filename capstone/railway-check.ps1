$ErrorActionPreference = "Continue"

$Report = Join-Path (Get-Location) "railway-sanitized-report.txt"
$ExpectedCommit = "79ce484"
$Domain = "https://theresiansquest.com"

function Add-Section($Title) {
  "`n============================================================" | Add-Content $Report
  $Title | Add-Content $Report
  "============================================================" | Add-Content $Report
}

function Run-Safe($Title, $Command) {
  Add-Section $Title
  try {
    "COMMAND: $Command" | Add-Content $Report
    cmd /c $Command 2>&1 | Add-Content $Report
  } catch {
    "ERROR: $($_.Exception.Message)" | Add-Content $Report
  }
}

function Redact-Secrets($Text) {
  $Text `
    -replace '(?i)(DATABASE_URL\s*=\s*)\S+', '$1[REDACTED]' `
    -replace '(?i)(RESEND_API_KEY\s*=\s*)\S+', '$1[REDACTED]' `
    -replace '(?i)(EMAIL_FROM\s*=\s*).+', '$1[REDACTED]' `
    -replace '(?i)(EMAIL_FROM_NAME\s*=\s*).+', '$1[REDACTED]' `
    -replace '(?i)(APP_URL\s*=\s*)\S+', '$1[REDACTED]' `
    -replace '(?i)(token|secret|password|pass|key)\s*[:=]\s*\S+', '$1=[REDACTED]'
}

if (Test-Path $Report) { Remove-Item $Report -Force }

Add-Section "LOCAL CONTEXT"
"Timestamp: $(Get-Date -Format o)" | Add-Content $Report
"PWD: $(Get-Location)" | Add-Content $Report
"Expected commit: $ExpectedCommit" | Add-Content $Report
"Domain: $Domain" | Add-Content $Report

Run-Safe "GIT STATUS" "git status -sb"
Run-Safe "LOCAL HEAD" "git rev-parse --short HEAD"
Run-Safe "ORIGIN MAIN" "git rev-parse --short origin/main"
Run-Safe "RECENT COMMITS" "git log --oneline -8"

Run-Safe "RAILWAY VERSION" "railway --version"
Run-Safe "RAILWAY WHOAMI" "railway whoami"
Run-Safe "RAILWAY STATUS" "railway status"

Run-Safe "RAILWAY HELP - DEPLOYMENTS" "railway deployments --help"
Run-Safe "RAILWAY DEPLOYMENTS" "railway deployments"

Run-Safe "RAILWAY LOGS HELP" "railway logs --help"
Run-Safe "RAILWAY LATEST BUILD LOGS" "railway logs --build --lines 300"
Run-Safe "RAILWAY LATEST RUNTIME LOGS" "railway logs --lines 300"

Add-Section "RAILWAY CONFIG FILES"
"--- capstone/railway.toml ---" | Add-Content $Report
if (Test-Path ".\railway.toml") { Get-Content ".\railway.toml" | Add-Content $Report } else { "missing" | Add-Content $Report }

"--- capstone/nixpacks.toml ---" | Add-Content $Report
if (Test-Path ".\nixpacks.toml") { Get-Content ".\nixpacks.toml" | Add-Content $Report } else { "missing" | Add-Content $Report }

"--- root railway.toml, if running from capstone parent exists ---" | Add-Content $Report
if (Test-Path "..\railway.toml") { Get-Content "..\railway.toml" | Add-Content $Report } else { "missing" | Add-Content $Report }

Add-Section "ENV VARIABLE NAMES ONLY"
try {
  $vars = railway variables 2>&1
  $names = $vars |
    ForEach-Object { ($_ -split '=')[0].Trim() } |
    Where-Object { $_ -match '^[A-Z0-9_]+$' } |
    Sort-Object -Unique
  $names | Add-Content $Report
} catch {
  "Could not list variable names: $($_.Exception.Message)" | Add-Content $Report
}

Add-Section "LIVE HTML AND BUNDLE CHECK"
try {
  $CacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $HtmlUrl = "$Domain/?codex_cache_bust=$CacheBust"
  $Html = (Invoke-WebRequest -Uri $HtmlUrl -UseBasicParsing -TimeoutSec 30).Content

  "HTML length: $($Html.Length)" | Add-Content $Report
  "HTML contains expected commit ${ExpectedCommit}: $($Html.Contains($ExpectedCommit))" | Add-Content $Report
  "HTML contains Create a New Password: $($Html.Contains('Create a New Password'))" | Add-Content $Report
  "HTML contains ChangePasswordScreen: $($Html.Contains('ChangePasswordScreen'))" | Add-Content $Report

  $Scripts = [regex]::Matches($Html, '<script[^>]+src=["'']([^"'']+\.js[^"'']*)["'']') |
    ForEach-Object { $_.Groups[1].Value } |
    Sort-Object -Unique

  "Script files found:" | Add-Content $Report
  $Scripts | Add-Content $Report

  foreach ($Script in $Scripts) {
    if ($Script.StartsWith("http")) {
      $ScriptUrl = $Script
    } elseif ($Script.StartsWith("/")) {
      $ScriptUrl = "$Domain$Script"
    } else {
      $ScriptUrl = "$Domain/$Script"
    }

    "`n--- JS bundle: $ScriptUrl ---" | Add-Content $Report
    try {
      $Js = (Invoke-WebRequest -Uri "$ScriptUrl?codex_cache_bust=$CacheBust" -UseBasicParsing -TimeoutSec 60).Content
      "JS length: $($Js.Length)" | Add-Content $Report
      "contains Create a New Password: $($Js.Contains('Create a New Password'))" | Add-Content $Report
      "contains ChangePasswordScreen: $($Js.Contains('ChangePasswordScreen'))" | Add-Content $Report
      "contains temporary-password warning: $($Js.Contains('Please change your temporary password before continuing'))" | Add-Content $Report
      "contains /change-password route string: $($Js.Contains('/change-password'))" | Add-Content $Report
      "contains redirect marker Navigate/login nearby: $($Js.Contains('/login'))" | Add-Content $Report
    } catch {
      "Could not fetch JS bundle: $($_.Exception.Message)" | Add-Content $Report
    }
  }
} catch {
  "Live bundle check failed: $($_.Exception.Message)" | Add-Content $Report
}

Add-Section "DIRECT ROUTE CHECKS"
foreach ($Path in @("/login", "/change-password")) {
  try {
    $Url = "$Domain$Path?codex_cache_bust=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    $Resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 30
    "${Path} status: $($Resp.StatusCode)" | Add-Content $Report
    "${Path} final URL: $($Resp.BaseResponse.ResponseUri)" | Add-Content $Report
    "${Path} contains Create a New Password: $($Resp.Content.Contains('Create a New Password'))" | Add-Content $Report
  } catch {
    "${Path} check failed: $($_.Exception.Message)" | Add-Content $Report
  }
}

# Final pass redaction
$Clean = Redact-Secrets (Get-Content $Report -Raw)
Set-Content -Path $Report -Value $Clean -Encoding UTF8

Write-Host "Done. Sanitized report written to:"
Write-Host $Report