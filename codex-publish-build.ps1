$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReportPath = Join-Path $RepoRoot "codex-publish-build.report.json"
$TargetCommit = "7c57831dcfb1a33be330eaa9061bca5ca87e263c"
$BundlePath = Join-Path $RepoRoot "capstone\build\static\js\main.ffeaa1f7.js"
$TempIndex = Join-Path $RepoRoot "codex-temp-git-index"
$Report = [System.Collections.Generic.List[object]]::new()

function Add-Report {
  param([hashtable]$Entry)
  $Entry.time = (Get-Date).ToUniversalTime().ToString("o")
  $Report.Add([pscustomobject]$Entry)
  $Report | ConvertTo-Json -Depth 8 | Set-Content -Path $ReportPath -Encoding UTF8
  Write-Host ($Entry.step)
}

function Invoke-Git {
  param([string[]]$Arguments)
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & git @Arguments 2>&1
    $status = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  return [pscustomobject]@{
    status = $status
    output = (($output | ForEach-Object { $_.ToString() }) -join "`n")
  }
}

Set-Location $RepoRoot
Add-Report @{ step = "start"; repoRoot = $RepoRoot; targetCommit = $TargetCommit }

if (!(Test-Path $BundlePath)) {
  throw "Expected fresh bundle was not found: $BundlePath"
}

$Bundle = Get-Content -Raw $BundlePath
$BundleCheck = [ordered]@{
  hasBasicAddition = $Bundle.Contains("Basic Addition")
  hasNormalAverage = $Bundle.Contains("Normal / Average")
  hasLocalhost = ($Bundle.Contains("localhost") -or $Bundle.Contains("127.0.0.1") -or $Bundle.Contains("0.0.0.0"))
  bytes = $Bundle.Length
}
Add-Report @{ step = "bundle-check"; bundle = $BundleCheck }

if (!$BundleCheck.hasBasicAddition -or !$BundleCheck.hasNormalAverage -or $BundleCheck.hasLocalhost) {
  throw "Fresh bundle verification failed. Refusing to publish."
}

$remote = Invoke-Git @("ls-remote", "origin", "refs/heads/main")
Add-Report @{ step = "remote-main"; status = $remote.status; output = $remote.output }
if ($remote.status -ne 0) {
  throw "Could not read GitHub main. Complete GitHub sign-in in this terminal, then rerun this script."
}

$remoteSha = (($remote.output -split "\s+")[0]).Trim()
if ($remoteSha -ne $TargetCommit) {
  throw "Remote main is $remoteSha, expected $TargetCommit. Refusing to publish over a changed main branch."
}

Remove-Item -LiteralPath $TempIndex -Force -ErrorAction SilentlyContinue
$env:GIT_INDEX_FILE = $TempIndex

try {
  $readTree = Invoke-Git @("read-tree", $TargetCommit)
  Add-Report @{ step = "read-tree"; status = $readTree.status; output = $readTree.output }
  if ($readTree.status -ne 0) { throw "git read-tree failed" }

  $add = Invoke-Git @("add", "-A", "--", "capstone/build")
  Add-Report @{ step = "stage-build"; status = $add.status; output = $add.output }
  if ($add.status -ne 0) { throw "git add failed" }

  $tree = Invoke-Git @("write-tree")
  Add-Report @{ step = "write-tree"; status = $tree.status; output = $tree.output }
  if ($tree.status -ne 0) { throw "git write-tree failed" }
  $treeSha = $tree.output.Trim()

  $commit = Invoke-Git @("commit-tree", $treeSha, "-p", $TargetCommit, "-m", "fix: publish current production frontend build")
  Add-Report @{ step = "commit-tree"; status = $commit.status; output = $commit.output }
  if ($commit.status -ne 0) { throw "git commit-tree failed" }
  $commitSha = $commit.output.Trim()

  $push = Invoke-Git @("push", "origin", "$commitSha`:refs/heads/main")
  Add-Report @{ step = "push-main"; status = $push.status; output = $push.output; commit = $commitSha }
  if ($push.status -ne 0) {
    throw "git push failed. Complete GitHub sign-in in this terminal if prompted, then rerun this script."
  }

  Add-Report @{ step = "complete"; commit = $commitSha }
  Write-Host "Published build commit: $commitSha"
}
finally {
  Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue
}
