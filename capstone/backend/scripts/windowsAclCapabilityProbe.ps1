$ErrorActionPreference = 'Stop'
$script:stage = 'startup'
$script:root = $null
$script:failures = [Collections.Generic.List[string]]::new()
$script:exitCode = 0
$script:timeoutMs = 20000
$script:killWaitMs = 5000
$script:outputDrainWaitMs = 1000
$script:outputCloseWaitMs = 500
$script:maxOutputChars = 8192
$envMap = $null

function Report([string]$status, [string]$stage, [string]$details) {
  [Console]::Out.WriteLine("[acl-capability] $status stage=$stage $details")
  [Console]::Out.Flush()
}
function Fail([string]$code, [string]$stage, [string]$details) {
  [void]$script:failures.Add($code)
  Report 'FAIL' $stage $details
}
function ErrorKind([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return 'empty' }
  if ($text -match '(?i)access denied') { return 'access-denied' }
  return 'nonempty-other'
}
function Get-PowerShell51StageTrace([string]$output) {
  $expectedEvents = @(
    'complete:script-started'
    'begin:trivial-command'
    'complete:trivial-command'
    'begin:security-module-load'
    'complete:security-module-load'
    'begin:get-acl-command-resolution'
    'complete:get-acl-command-resolution'
    'begin:get-acl-retrieval'
    'complete:get-acl-retrieval'
    'begin:current-identity-read'
    'complete:current-identity-read'
    'begin:acl-owner-read'
    'complete:acl-owner-read'
    'begin:access-rule-enumeration'
    'complete:access-rule-enumeration'
    'begin:approved-grant-verification'
    'begin:approved-sid-set-create'
    'complete:approved-sid-set-create'
    'begin:approved-sid-add-current'
    'complete:approved-sid-add-current'
    'begin:approved-sid-add-system'
    'complete:approved-sid-add-system'
    'begin:approved-sid-add-administrators'
    'complete:approved-sid-add-administrators'
    'begin:unapproved-allow-filter'
    'complete:unapproved-allow-filter'
    'begin:unapproved-sid-project'
    'complete:unapproved-sid-project'
    'begin:unapproved-sid-sort-unique'
    'complete:unapproved-sid-sort-unique'
    'begin:probe-grant-function-prepare'
    'complete:probe-grant-function-prepare'
    'begin:protected-dacl-read'
    'complete:protected-dacl-read'
    'begin:owner-approval-check'
    'complete:owner-approval-check'
    'begin:current-user-grant-check'
    'complete:current-user-grant-check'
    'begin:system-grant-check'
    'complete:system-grant-check'
    'begin:administrators-grant-check'
    'complete:administrators-grant-check'
    'begin:inherited-allow-count'
    'complete:inherited-allow-count'
    'begin:unapproved-allow-count'
    'complete:unapproved-allow-count'
    'complete:approved-grant-verification'
  )
  $knownStages = @(
    'script-started'
    'trivial-command'
    'security-module-load'
    'get-acl-command-resolution'
    'get-acl-retrieval'
    'current-identity-read'
    'acl-owner-read'
    'access-rule-enumeration'
    'approved-grant-verification'
    'approved-sid-set-create'
    'approved-sid-add-current'
    'approved-sid-add-system'
    'approved-sid-add-administrators'
    'unapproved-allow-filter'
    'unapproved-sid-project'
    'unapproved-sid-sort-unique'
    'probe-grant-function-prepare'
    'protected-dacl-read'
    'owner-approval-check'
    'current-user-grant-check'
    'system-grant-check'
    'administrators-grant-check'
    'inherited-allow-count'
    'unapproved-allow-count'
  )
  $markerPrefixCount = [regex]::Matches($output, '(?m)^ACL_PROBE_PS51_STAGE:').Count
  $markerMatches = [regex]::Matches($output, '(?m)^ACL_PROBE_PS51_STAGE:(begin|complete):([a-z-]+)\r?$')
  $observedEvents = @($markerMatches | ForEach-Object { $_.Groups[1].Value + ':' + $_.Groups[2].Value })
  $sequenceValid = $markerPrefixCount -eq $observedEvents.Count -and $observedEvents.Count -le $expectedEvents.Count
  for ($index = 0; $index -lt $observedEvents.Count; $index++) {
    if ($observedEvents[$index] -ne $expectedEvents[$index]) {
      $sequenceValid = $false
      break
    }
  }
  $lastCompletedStage = 'none'
  $currentStage = 'none'
  foreach ($markerMatch in $markerMatches) {
    $phase = $markerMatch.Groups[1].Value
    $stage = $markerMatch.Groups[2].Value
    if ($knownStages -notcontains $stage) {
      $lastCompletedStage = 'unrecognized'
      $currentStage = 'unrecognized'
      continue
    }
    if ($phase -eq 'begin') {
      $currentStage = $stage
    } else {
      $lastCompletedStage = $stage
      $currentStage = 'none'
    }
  }
  $scriptStarted = $observedEvents.Count -gt 0 -and $observedEvents[0] -eq 'complete:script-started'
  return [pscustomobject]@{
    LastCompletedStage = $lastCompletedStage
    CurrentStage = $currentStage
    MarkerCount = $observedEvents.Count
    SequenceValid = $sequenceValid
    Complete = $sequenceValid -and $observedEvents.Count -eq $expectedEvents.Count
    ScriptStarted = $scriptStarted
  }
}

function ChildEnvironment {
  $child = @{}
  foreach ($name in @('PATH','PATHEXT','SystemRoot','ProgramFiles','ProgramFiles(x86)','COMSPEC','TEMP','TMP')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $child[$name] = $value }
  }
  $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot')
  if (-not $systemRoot) { throw [InvalidOperationException]::new('system-root-unavailable') }
  $child['PSModulePath'] = Join-Path (Join-Path (Join-Path (Join-Path $systemRoot 'System32') 'WindowsPowerShell') 'v1.0') 'Modules'
  return $child
}

$runnerSource = @'
using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
namespace TqAclCapabilityProbe {
    public sealed class CapturedText { public string Text { get; set; } public bool Truncated { get; set; } }
    public sealed class ProcessResult {
        public bool Started { get; set; } public bool Exited { get; set; } public bool TimedOut { get; set; }
        public bool OutputComplete { get; set; } public int ExitCode { get; set; }
        public long ElapsedMilliseconds { get; set; } public string StandardOutput { get; set; }
        public string StandardError { get; set; } public bool StandardOutputTruncated { get; set; }
        public bool StandardErrorTruncated { get; set; } public string ErrorCategory { get; set; }
    }
    public static class BoundedProcessRunner {
        private static CapturedText ReadCapped(StreamReader reader, int limit) {
            var text = new StringBuilder(Math.Min(limit, 1024)); var buffer = new char[1024]; var truncated = false; int count;
            while ((count = reader.Read(buffer, 0, buffer.Length)) > 0) {
                var keep = Math.Min(count, Math.Max(0, limit - text.Length));
                if (keep > 0) text.Append(buffer, 0, keep);
                if (keep < count) truncated = true;
            }
            return new CapturedText { Text = text.ToString(), Truncated = truncated };
        }
        private static void WaitTasks(Task<CapturedText> stdout, Task<CapturedText> stderr, int milliseconds) {
            if (stdout == null || stderr == null) return;
            try { Task.WaitAll(new Task[] { stdout, stderr }, milliseconds); } catch (AggregateException) { }
        }
        private static void Capture(ProcessResult result, Task<CapturedText> stdout, Task<CapturedText> stderr) {
            result.OutputComplete = stdout != null && stderr != null &&
                stdout.Status == TaskStatus.RanToCompletion && stderr.Status == TaskStatus.RanToCompletion;
            if (stdout != null && stdout.Status == TaskStatus.RanToCompletion) {
                result.StandardOutput = stdout.Result.Text; result.StandardOutputTruncated = stdout.Result.Truncated;
            }
            if (stderr != null && stderr.Status == TaskStatus.RanToCompletion) {
                result.StandardError = stderr.Result.Text; result.StandardErrorTruncated = stderr.Result.Truncated;
            }
            if (!result.OutputComplete && result.ErrorCategory == "none") {
                result.ErrorCategory = (stdout != null && stdout.IsFaulted) || (stderr != null && stderr.IsFaulted)
                    ? "output-read-failure" : "output-drain-timeout";
            }
        }
        public static ProcessResult Run(string executable, string[] arguments, IDictionary environment,
            int timeoutMs, int killWaitMs, int drainWaitMs, int closeWaitMs, int outputLimit) {
            var timer = Stopwatch.StartNew(); Process process = null;
            Task<CapturedText> stdout = null; Task<CapturedText> stderr = null;
            var result = new ProcessResult { ExitCode = -1, StandardOutput = "", StandardError = "", ErrorCategory = "none" }; bool forcedOutputClose = false;
            try {
                var start = new ProcessStartInfo {
                    FileName = executable, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                start.Environment.Clear();
                foreach (DictionaryEntry item in environment) start.Environment[(string)item.Key] = (string)item.Value;
                foreach (var argument in arguments) start.ArgumentList.Add(argument);
                process = new Process { StartInfo = start };
                if (!process.Start()) { result.ErrorCategory = "process-start-failed"; return result; }
                result.Started = true;
                stdout = Task.Run(() => ReadCapped(process.StandardOutput, outputLimit));
                stderr = Task.Run(() => ReadCapped(process.StandardError, outputLimit));
                result.Exited = process.WaitForExit(timeoutMs);
                if (!result.Exited) {
                    result.TimedOut = true;
                    try { process.Kill(true); } catch (Exception ex) { result.ErrorCategory = "process-tree-termination-" + ex.GetType().Name; }
                    try { result.Exited = process.WaitForExit(killWaitMs); } catch (Exception ex) { result.ErrorCategory = "process-wait-" + ex.GetType().Name; }
                }
                WaitTasks(stdout, stderr, drainWaitMs);
                if (!stdout.IsCompleted || !stderr.IsCompleted) {
                    try { process.Kill(true); } catch { }
                    try { if (!process.HasExited) process.WaitForExit(killWaitMs); } catch { }
                    WaitTasks(stdout, stderr, closeWaitMs);
                    if (!stdout.IsCompleted || !stderr.IsCompleted) {
                        forcedOutputClose = true;
                        try { process.StandardOutput.Close(); } catch { }
                        try { process.StandardError.Close(); } catch { }
                        WaitTasks(stdout, stderr, closeWaitMs);
                    }
                }
                Capture(result, stdout, stderr);
                if (forcedOutputClose) {
                    result.OutputComplete = false;
                    if (result.ErrorCategory == "none") result.ErrorCategory = "output-drain-timeout";
                }
                if (result.Exited) result.ExitCode = process.ExitCode;
            }
            catch (Exception ex) {
                result.ErrorCategory = ex.GetType().Name;
                if (process != null && result.Started) {
                    try { if (!process.HasExited) process.Kill(true); } catch { }
                    try { result.Exited = process.WaitForExit(killWaitMs); } catch { }
                    WaitTasks(stdout, stderr, closeWaitMs);
                    if (stdout != null && stderr != null && (!stdout.IsCompleted || !stderr.IsCompleted)) {
                        forcedOutputClose = true;
                        try { process.StandardOutput.Close(); } catch { }
                        try { process.StandardError.Close(); } catch { }
                        WaitTasks(stdout, stderr, closeWaitMs);
                    }
                    Capture(result, stdout, stderr);
                    if (forcedOutputClose) {
                        result.OutputComplete = false;
                        if (result.ErrorCategory == "none") result.ErrorCategory = "output-drain-timeout";
                    }
                    if (result.Exited) { try { result.ExitCode = process.ExitCode; } catch { } }
                }
            }
            finally {
                if (process != null) process.Dispose();
                timer.Stop(); result.ElapsedMilliseconds = timer.ElapsedMilliseconds;
            }
            return result;
        }
    }
}
'@

$inspectionSource = @'
param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][ValidateSet('0','1')][string]$RequireInheritedGrants
)
$ErrorActionPreference = 'Stop'
function Test-FullControlGrant($rules, [string]$sid, [bool]$requireInherited) {
  $full = [int][Security.AccessControl.FileSystemRights]::FullControl
  $needed = [int]([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -ne $sid) { continue }
    if ($requireInherited -ne [bool]$rule.IsInherited) { continue }
    if (([int]$rule.FileSystemRights -band $full) -ne $full) { continue }
    if (-not $requireInherited -and (([int]$rule.InheritanceFlags -band $needed) -ne $needed -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None)) { continue }
    return $true
  }
  return $false
}
try {
  $acl = Get-Acl -LiteralPath $TargetPath -ErrorAction Stop
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $allow = @($rules | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow })
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $systemSid = 'S-1-5-18'
  $administratorsSid = 'S-1-5-32-544'
  $approved = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [void]$approved.Add($currentSid)
  [void]$approved.Add($systemSid)
  [void]$approved.Add($administratorsSid)
  $unapprovedSids = @($allow |
    Where-Object { -not $approved.Contains($_.IdentityReference.Value) } |
    ForEach-Object { $_.IdentityReference.Value } |
    Sort-Object -Unique)
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $expectedAccounts = @{
    CurrentUserGrant = ([Security.Principal.SecurityIdentifier]::new($currentSid)).Translate([Security.Principal.NTAccount]).Value
    SystemGrant = ([Security.Principal.SecurityIdentifier]::new($systemSid)).Translate([Security.Principal.NTAccount]).Value
    AdministratorsGrant = ([Security.Principal.SecurityIdentifier]::new($administratorsSid)).Translate([Security.Principal.NTAccount]).Value
  }
  $state = [pscustomobject]@{
    Protected = [bool]$acl.AreAccessRulesProtected
    AllowCount = $allow.Count
    InheritedAllowCount = @($allow | Where-Object { $_.IsInherited }).Count
    UnapprovedAllowSids = $unapprovedSids
    OwnerApproved = $approved.Contains($ownerSid)
    CurrentUserGrant = Test-FullControlGrant $allow $currentSid ($RequireInheritedGrants -eq '1')
    SystemGrant = Test-FullControlGrant $allow $systemSid ($RequireInheritedGrants -eq '1')
    AdministratorsGrant = Test-FullControlGrant $allow $administratorsSid ($RequireInheritedGrants -eq '1')
    CurrentUserSid = $currentSid
    ExpectedAccounts = $expectedAccounts
  }
  [Console]::Out.WriteLine('ACL_INSPECTION_JSON:' + ($state | ConvertTo-Json -Compress -Depth 5))
  exit 0
}
catch {
  [Console]::Error.WriteLine("ACL_INSPECTION_FAILED category=$($_.Exception.GetType().Name)")
  exit 21
}
'@

function RunBounded([string]$executable, [string[]]$arguments, [hashtable]$environment) {
  $nativeExecutable = [string]$executable
  $nativeArguments = [string[]]@($arguments | ForEach-Object { [string]$_ })
  $nativeEnvironment = @{}
  foreach ($name in $environment.Keys) { $nativeEnvironment[[string]$name] = [string]$environment[$name] }
  return [TqAclCapabilityProbe.BoundedProcessRunner]::Run(
    $nativeExecutable, $nativeArguments, $nativeEnvironment, $script:timeoutMs, $script:killWaitMs,
    $script:outputDrainWaitMs, $script:outputCloseWaitMs, $script:maxOutputChars
  )
}
function Summary([string]$path, [bool]$requireInheritedGrants = $false) {
  $inspectionStage = 'acl-inspection-' + $script:stage
  $inspectionEnvironment = @{}
  foreach ($name in $envMap.Keys) { $inspectionEnvironment[$name] = $envMap[$name] }
  $inspectionEnvironment['PSModulePath'] = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $envMap['PSModulePath']
  $inspection = RunBounded $script:pwshPath @(
    '-NoLogo','-NoProfile','-NonInteractive','-File',$script:inspectorPath,
    '-TargetPath',$path,'-RequireInheritedGrants',([string][int]$requireInheritedGrants)
  ) $inspectionEnvironment
  Report-Process $inspectionStage $inspection
  $failureKind = if ($script:stage -eq 'initial-acl-precondition') { 'setup-precondition' } else { 'acl-inspection-failed' }
  Require-Process $inspectionStage $inspection $failureKind
  $prefix = 'ACL_INSPECTION_JSON:'
  $jsonLines = @($inspection.StandardOutput -split "\r?\n" | Where-Object { $_.StartsWith($prefix, [StringComparison]::Ordinal) })
  if ($jsonLines.Count -ne 1) {
    Fail 'acl-inspection-invalid-output' $inspectionStage 'expected-one-sanitized-acl-summary'
    throw [InvalidOperationException]::new('acl-inspection-invalid-output')
  }
  try {
    $raw = $jsonLines[0].Substring($prefix.Length) | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    Fail 'acl-inspection-invalid-output' $inspectionStage 'sanitized-acl-summary-parse-failed'
    throw [InvalidOperationException]::new('acl-inspection-invalid-output')
  }
  [pscustomobject]@{
    Protected = [bool]$raw.Protected
    AllowCount = [int]$raw.AllowCount
    InheritedAllowCount = [int]$raw.InheritedAllowCount
    UnapprovedAllowSids = @($raw.UnapprovedAllowSids | ForEach-Object { [string]$_ })
    OwnerApproved = [bool]$raw.OwnerApproved
    CurrentUserGrant = [bool]$raw.CurrentUserGrant
    SystemGrant = [bool]$raw.SystemGrant
    AdministratorsGrant = [bool]$raw.AdministratorsGrant
    CurrentUserSid = [string]$raw.CurrentUserSid
    ExpectedAccounts = @{
      CurrentUserGrant = [string]$raw.ExpectedAccounts.CurrentUserGrant
      SystemGrant = [string]$raw.ExpectedAccounts.SystemGrant
      AdministratorsGrant = [string]$raw.ExpectedAccounts.AdministratorsGrant
    }
  }
}
function Report-Process([string]$stage, $result) {
  $ok = $result.Started -and $result.Exited -and -not $result.TimedOut -and $result.ExitCode -eq 0 -and
    $result.OutputComplete -and -not $result.StandardOutputTruncated -and -not $result.StandardErrorTruncated
  Report $(if ($ok) { 'PASS' } else { 'FAIL' }) $stage "elapsedMs=$($result.ElapsedMilliseconds) started=$($result.Started) exitCode=$($result.ExitCode) timedOut=$($result.TimedOut) exited=$($result.Exited) outputComplete=$($result.OutputComplete) outputTruncated=$($result.StandardOutputTruncated -or $result.StandardErrorTruncated) errorCategory=$($result.ErrorCategory) stderrCategory=$(ErrorKind $result.StandardError)"
}
function Require-Process([string]$stage, $result, [string]$failureKind) {
  if ($result.TimedOut) { Fail 'process-timeout' $stage 'bounded-process-timeout'; throw [InvalidOperationException]::new('process-timeout') }
  if (-not $result.Started -or -not $result.Exited -or $result.ExitCode -ne 0) { Fail $failureKind $stage 'process-did-not-exit-successfully'; throw [InvalidOperationException]::new($failureKind) }
  if (-not $result.OutputComplete -or $result.StandardOutputTruncated -or $result.StandardErrorTruncated) { Fail 'process-output-incomplete' $stage 'bounded-output-not-complete'; throw [InvalidOperationException]::new('process-output-incomplete') }
}
function Require-RestrictedState($state, [string]$stage) {
  if (-not ($state.Protected -and $state.InheritedAllowCount -eq 0 -and $state.UnapprovedAllowSids.Count -eq 0 -and $state.OwnerApproved)) {
    Fail 'mutation-not-persisted' $stage 'restricted-dacl-state-not-observed'
    throw [InvalidOperationException]::new('mutation-not-persisted')
  }
}
function Test-NativeReadback([string]$text, [string]$target, [hashtable]$expectedAccounts) {
  $found = @{ CurrentUserGrant = $false; SystemGrant = $false; AdministratorsGrant = $false }
  $inheritedMarker = $text -match '\(I\)'
  foreach ($sourceLine in ($text -split "\r?\n")) {
    $line = $sourceLine.Trim()
    if ($line.StartsWith($target, [StringComparison]::OrdinalIgnoreCase)) { $line = $line.Substring($target.Length).Trim() }
    if ($line -notmatch '^(?<identity>.+?):(?<ace>.*)$') { continue }
    $identity = $Matches.identity.Trim(); $ace = $Matches.ace
    if ($ace -notmatch '\(OI\)' -or $ace -notmatch '\(CI\)' -or $ace -notmatch '\(F\)') { continue }
    foreach ($key in @('CurrentUserGrant','SystemGrant','AdministratorsGrant')) {
      if ($identity.Equals($expectedAccounts[$key], [StringComparison]::OrdinalIgnoreCase)) { $found[$key] = $true }
    }
  }
  [pscustomobject]@{ HasInheritedMarker = $inheritedMarker; CurrentUserGrant = $found.CurrentUserGrant; SystemGrant = $found.SystemGrant; AdministratorsGrant = $found.AdministratorsGrant }
}

try {
  if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw [InvalidOperationException]::new('expected-pwsh-7') }
  Report 'PASS' 'outer-workflow-shell' "edition=$($PSVersionTable.PSEdition) version=$($PSVersionTable.PSVersion.ToString())"
  if (-not ('TqAclCapabilityProbe.BoundedProcessRunner' -as [type])) { Add-Type -TypeDefinition $runnerSource -Language CSharp -ErrorAction Stop | Out-Null }

  $temp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP')
  if (-not $temp -or -not (Test-Path -LiteralPath $temp -PathType Container)) {
    Fail 'setup-precondition' 'runner-temp' 'runner-temporary-directory-unavailable'
    throw [InvalidOperationException]::new('runner-temp-unavailable')
  }
  $temp = [IO.Path]::GetFullPath($temp)
  $script:root = Join-Path $temp ('tq-acl-probe-' + [guid]::NewGuid().ToString('N'))
  $prefix = $temp.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $script:root.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    Fail 'setup-precondition' 'temp-containment' 'probe-directory-outside-runner-temp'
    throw [InvalidOperationException]::new('temp-containment-failed')
  }
  [void](New-Item -ItemType Directory -Path $script:root -ErrorAction Stop)
  $target = Join-Path $script:root 'target'
  [void](New-Item -ItemType Directory -Path $target -ErrorAction Stop)
  $envMap = ChildEnvironment
  $script:pwshPath = Join-Path $PSHOME 'pwsh.exe'
  if (-not (Test-Path -LiteralPath $script:pwshPath -PathType Leaf)) {
    Fail 'setup-precondition' 'acl-inspection-runtime' 'pwsh-7-executable-unavailable'
    throw [InvalidOperationException]::new('pwsh-7-executable-unavailable')
  }
  $script:inspectorPath = Join-Path $script:root 'readback-acl-pwsh7.ps1'
  [IO.File]::WriteAllText($script:inspectorPath, $inspectionSource, [Text.UTF8Encoding]::new($false))

  $script:stage = 'filesystem-precondition'
  $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($target))
  $reparseCount = 0; $cursor = $item
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $reparseCount++ }
    $cursor = $cursor.Parent
  }
  $filesystemOk = $item.PSIsContainer -and $drive.DriveFormat -eq 'NTFS' -and $reparseCount -eq 0
  Report $(if ($filesystemOk) { 'PASS' } else { 'FAIL' }) $script:stage "filesystem=$($drive.DriveType)/$($drive.DriveFormat) reparseComponents=$reparseCount"
  if (-not $filesystemOk) { Fail 'setup-precondition' $script:stage 'expected-ntfs-directory-without-reparse-components'; throw [InvalidOperationException]::new('filesystem-precondition-failed') }

  $script:stage = 'initial-acl-precondition'
  $before = Summary $target
  $initialOk = (-not $before.Protected) -and $before.InheritedAllowCount -gt 0 -and $before.OwnerApproved
  Report $(if ($initialOk) { 'PASS' } else { 'FAIL' }) $script:stage "allowCount=$($before.AllowCount) inheritedAllowCount=$($before.InheritedAllowCount) unapprovedAllowCount=$($before.UnapprovedAllowSids.Count) ownerApproved=$($before.OwnerApproved) protected=$($before.Protected)"
  if (-not $initialOk) { Fail 'setup-precondition' $script:stage 'initial-dacl-unsuitable-for-experiment'; throw [InvalidOperationException]::new('initial-acl-precondition-failed') }

  $icacls = (Get-Command icacls.exe -CommandType Application -ErrorAction Stop).Source
  $script:stage = 'disable-inheritance'
  $disableResult = RunBounded $icacls @($target, '/inheritance:r') $envMap
  $afterDisable = Summary $target
  Report-Process $script:stage $disableResult
  Report $(if ($afterDisable.Protected -and $afterDisable.InheritedAllowCount -eq 0 -and $afterDisable.OwnerApproved) { 'PASS' } else { 'FAIL' }) 'disable-inheritance-readback' "protected=$($afterDisable.Protected) inheritedAllowCount=$($afterDisable.InheritedAllowCount) ownerApproved=$($afterDisable.OwnerApproved) unapprovedAllowCount=$($afterDisable.UnapprovedAllowSids.Count)"
  Require-Process $script:stage $disableResult 'mutation-command-failure'
  if (-not $afterDisable.Protected -or $afterDisable.InheritedAllowCount -ne 0 -or -not $afterDisable.OwnerApproved) { Fail 'mutation-not-persisted' $script:stage 'inheritance-state-not-observed'; throw [InvalidOperationException]::new('mutation-not-persisted') }

  $script:stage = 'remove-unapproved-explicit-allows'
  foreach ($badSid in @($afterDisable.UnapprovedAllowSids)) {
    $removeResult = RunBounded $icacls @($target, '/remove:g', ('*' + $badSid)) $envMap
    $afterRemove = Summary $target
    Report-Process $script:stage $removeResult
    $stillPresent = $afterRemove.UnapprovedAllowSids -contains $badSid
    Report $(if (-not $stillPresent) { 'PASS' } else { 'FAIL' }) 'remove-unapproved-explicit-allows-readback' "remainingUnapprovedAllowCount=$($afterRemove.UnapprovedAllowSids.Count)"
    Require-Process $script:stage $removeResult 'mutation-command-failure'
    if ($stillPresent -or -not $afterRemove.Protected -or $afterRemove.InheritedAllowCount -ne 0 -or -not $afterRemove.OwnerApproved) { Fail 'mutation-not-persisted' $script:stage 'unapproved-grant-remains-after-removal'; throw [InvalidOperationException]::new('mutation-not-persisted') }
  }
  $afterRemoval = Summary $target
  Require-RestrictedState $afterRemoval 'post-removal-state'

  $expectedAccounts = $afterRemoval.ExpectedAccounts
  $expectedGrants = @(
    [pscustomobject]@{ Key = 'CurrentUserGrant'; Sid = $afterRemoval.CurrentUserSid; Label = 'current-user' }
    [pscustomobject]@{ Key = 'SystemGrant'; Sid = 'S-1-5-18'; Label = 'system' }
    [pscustomobject]@{ Key = 'AdministratorsGrant'; Sid = 'S-1-5-32-544'; Label = 'administrators' }
  )
  foreach ($grant in $expectedGrants) {
    $script:stage = 'grant-' + $grant.Label
    $grantArgument = '*' + $grant.Sid + ':(OI)(CI)F'
    $grantResult = RunBounded $icacls @($target, '/grant:r', $grantArgument) $envMap
    $afterGrant = Summary $target
    Report-Process $script:stage $grantResult
    $grantPresent = [bool]$afterGrant.PSObject.Properties[$grant.Key].Value
    Report $(if ($grantPresent) { 'PASS' } else { 'FAIL' }) ($script:stage + '-readback') "protected=$($afterGrant.Protected) inheritedAllowCount=$($afterGrant.InheritedAllowCount) unapprovedAllowCount=$($afterGrant.UnapprovedAllowSids.Count) ownerApproved=$($afterGrant.OwnerApproved) fullControlGrant=$grantPresent"
    Require-Process $script:stage $grantResult 'mutation-command-failure'
    if (-not ($afterGrant.Protected -and $afterGrant.InheritedAllowCount -eq 0 -and $afterGrant.UnapprovedAllowSids.Count -eq 0 -and $afterGrant.OwnerApproved -and $grantPresent)) {
      Fail 'mutation-not-persisted' $script:stage 'approved-full-control-grant-not-observed'
      throw [InvalidOperationException]::new('mutation-not-persisted')
    }
  }

  $script:stage = 'verify-usable-directory'
  $accessProbeFile = Join-Path $target 'acl-use-probe.txt'
  try {
    [IO.File]::WriteAllText($accessProbeFile, 'synthetic ACL capability')
    $readText = [IO.File]::ReadAllText($accessProbeFile)
    if ($readText -ne 'synthetic ACL capability') { throw [InvalidOperationException]::new('synthetic-readback-mismatch') }
    $childState = Summary $accessProbeFile $true
    $childOk = -not $childState.Protected -and $childState.InheritedAllowCount -gt 0 -and
      $childState.UnapprovedAllowSids.Count -eq 0 -and $childState.OwnerApproved -and
      $childState.CurrentUserGrant -and $childState.SystemGrant -and $childState.AdministratorsGrant
    Report $(if ($childOk) { 'PASS' } else { 'FAIL' }) $script:stage "writeRead=$($readText -eq 'synthetic ACL capability') inheritedAllowCount=$($childState.InheritedAllowCount) unapprovedAllowCount=$($childState.UnapprovedAllowSids.Count) ownerApproved=$($childState.OwnerApproved) currentUserFullControl=$($childState.CurrentUserGrant) systemFullControl=$($childState.SystemGrant) administratorsFullControl=$($childState.AdministratorsGrant)"
    if (-not $childOk) { Fail 'mutation-not-persisted' $script:stage 'usable-inherited-access-not-observed'; throw [InvalidOperationException]::new('usable-inherited-access-not-observed') }
  }
  finally {
    if (Test-Path -LiteralPath $accessProbeFile -PathType Leaf) { Remove-Item -LiteralPath $accessProbeFile -Force -ErrorAction Stop }
  }

  $script:stage = 'final-powershell-readback'
  $final = Summary $target
  $finalOk = $final.Protected -and $final.InheritedAllowCount -eq 0 -and $final.UnapprovedAllowSids.Count -eq 0 -and
    $final.OwnerApproved -and $final.CurrentUserGrant -and $final.SystemGrant -and $final.AdministratorsGrant
  Report $(if ($finalOk) { 'PASS' } else { 'FAIL' }) $script:stage "allowCount=$($final.AllowCount) inheritedAllowCount=$($final.InheritedAllowCount) unapprovedAllowCount=$($final.UnapprovedAllowSids.Count) ownerApproved=$($final.OwnerApproved) currentUserFullControl=$($final.CurrentUserGrant) systemFullControl=$($final.SystemGrant) administratorsFullControl=$($final.AdministratorsGrant)"
  if (-not $finalOk) { Fail 'mutation-not-persisted' $script:stage 'complete-approved-acl-not-observed'; throw [InvalidOperationException]::new('final-acl-state-invalid') }

  $script:stage = 'native-icacls-readback'
  $nativeResult = RunBounded $icacls @($target) $envMap
  Report-Process $script:stage $nativeResult
  Require-Process $script:stage $nativeResult 'native-readback-mismatch'
  $nativeState = Test-NativeReadback $nativeResult.StandardOutput $target $expectedAccounts
  $nativeOk = -not $nativeState.HasInheritedMarker -and $nativeState.CurrentUserGrant -and $nativeState.SystemGrant -and $nativeState.AdministratorsGrant
  Report $(if ($nativeOk) { 'PASS' } else { 'FAIL' }) $script:stage "inheritedMarker=$($nativeState.HasInheritedMarker) currentUserFullControl=$($nativeState.CurrentUserGrant) systemFullControl=$($nativeState.SystemGrant) administratorsFullControl=$($nativeState.AdministratorsGrant)"
  if (-not $nativeOk) { Fail 'native-readback-mismatch' $script:stage 'native-grants-or-inheritance-disagree'; throw [InvalidOperationException]::new('native-readback-mismatch') }

  $script:stage = 'windows-powershell-51-readback'
  $childLines = @(
    'param([string]$Target)'
    '$ErrorActionPreference = ''Stop'''
    'function Write-Stage([string]$Phase, [string]$Name) {'
    '  [Console]::Out.WriteLine(''ACL_PROBE_PS51_STAGE:'' + $Phase + '':'' + $Name)'
    '  [Console]::Out.Flush()'
    '}'
    'try {'
    '  Write-Stage ''complete'' ''script-started'''
    '  Write-Stage ''begin'' ''trivial-command'''
    '  $null = 1 + 1'
    '  Write-Stage ''complete'' ''trivial-command'''
    '  Write-Stage ''begin'' ''security-module-load'''
    '  Import-Module -Name Microsoft.PowerShell.Security -ErrorAction Stop'
    '  Write-Stage ''complete'' ''security-module-load'''
    '  Write-Stage ''begin'' ''get-acl-command-resolution'''
    '  $getAclCommand = Get-Command -Name Get-Acl -CommandType Cmdlet -ErrorAction Stop'
    '  if ($getAclCommand.ModuleName -ne ''Microsoft.PowerShell.Security'') { throw [InvalidOperationException]::new(''get-acl-command-module-mismatch'') }'
    '  Write-Stage ''complete'' ''get-acl-command-resolution'''
    '  Write-Stage ''begin'' ''get-acl-retrieval'''
    '  $acl = Get-Acl -LiteralPath $Target -ErrorAction Stop'
    '  Write-Stage ''complete'' ''get-acl-retrieval'''
    '  Write-Stage ''begin'' ''current-identity-read'''
    '  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()'
    '  if ($null -eq $identity -or $null -eq $identity.User) { throw [InvalidOperationException]::new(''current-identity-unavailable'') }'
    '  $currentSid = $identity.User.Value'
    '  Write-Stage ''complete'' ''current-identity-read'''
    '  Write-Stage ''begin'' ''acl-owner-read'''
    '  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value'
    '  Write-Stage ''complete'' ''acl-owner-read'''
    '  Write-Stage ''begin'' ''access-rule-enumeration'''
    '  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))'
    '  $allow = @($rules | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow })'
    '  Write-Stage ''complete'' ''access-rule-enumeration'''
    '  Write-Stage ''begin'' ''approved-grant-verification'''
    '  Write-Stage ''begin'' ''approved-sid-set-create'''
    '  $systemSid = ''S-1-5-18''; $administratorsSid = ''S-1-5-32-544'''
    '  $approved = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)'
    '  Write-Stage ''complete'' ''approved-sid-set-create'''
    '  Write-Stage ''begin'' ''approved-sid-add-current'''
    '  [void]$approved.Add($currentSid)'
    '  Write-Stage ''complete'' ''approved-sid-add-current'''
    '  Write-Stage ''begin'' ''approved-sid-add-system'''
    '  [void]$approved.Add($systemSid)'
    '  Write-Stage ''complete'' ''approved-sid-add-system'''
    '  Write-Stage ''begin'' ''approved-sid-add-administrators'''
    '  [void]$approved.Add($administratorsSid)'
    '  Write-Stage ''complete'' ''approved-sid-add-administrators'''
    '  Write-Stage ''begin'' ''unapproved-allow-filter'''
    '  $unapprovedAllowRules = @($allow | Where-Object { -not $approved.Contains($_.IdentityReference.Value) })'
    '  Write-Stage ''complete'' ''unapproved-allow-filter'''
    '  Write-Stage ''begin'' ''unapproved-sid-project'''
    '  $unapprovedSidValues = @($unapprovedAllowRules | ForEach-Object { $_.IdentityReference.Value })'
    '  Write-Stage ''complete'' ''unapproved-sid-project'''
    '  Write-Stage ''begin'' ''unapproved-sid-sort-unique'''
    '  $unapprovedSids = @($unapprovedSidValues | Sort-Object -Unique)'
    '  Write-Stage ''complete'' ''unapproved-sid-sort-unique'''
    '  Write-Stage ''begin'' ''probe-grant-function-prepare'''
    '  function Test-ProbeGrant([string]$sid, [bool]$inherited) {'
    '    $full = [int][Security.AccessControl.FileSystemRights]::FullControl'
    '    $needed = [int]([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)'
    '    foreach ($rule in $allow) {'
    '      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IsInherited -ne $inherited -or $rule.IdentityReference.Value -ne $sid) { continue }'
    '      if (([int]$rule.FileSystemRights -band $full) -ne $full) { continue }'
    '      if (-not $inherited -and (([int]$rule.InheritanceFlags -band $needed) -ne $needed -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None)) { continue }'
    '      return $true'
    '    }'
    '    return $false'
    '  }'
    '  Write-Stage ''complete'' ''probe-grant-function-prepare'''
    '  Write-Stage ''begin'' ''protected-dacl-read'''
    '  $protected = ([bool]$acl.AreAccessRulesProtected).ToString().ToLowerInvariant()'
    '  Write-Stage ''complete'' ''protected-dacl-read'''
    '  Write-Stage ''begin'' ''owner-approval-check'''
    '  $ownerApproved = $approved.Contains($ownerSid).ToString().ToLowerInvariant()'
    '  Write-Stage ''complete'' ''owner-approval-check'''
    '  Write-Stage ''begin'' ''current-user-grant-check'''
    '  $userGrant = (Test-ProbeGrant $currentSid $false).ToString().ToLowerInvariant()'
    '  Write-Stage ''complete'' ''current-user-grant-check'''
    '  Write-Stage ''begin'' ''system-grant-check'''
    '  $systemGrant = (Test-ProbeGrant $systemSid $false).ToString().ToLowerInvariant()'
    '  Write-Stage ''complete'' ''system-grant-check'''
    '  Write-Stage ''begin'' ''administrators-grant-check'''
    '  $administratorsGrant = (Test-ProbeGrant $administratorsSid $false).ToString().ToLowerInvariant()'
    '  Write-Stage ''complete'' ''administrators-grant-check'''
    '  Write-Stage ''begin'' ''inherited-allow-count'''
    '  $inheritedAllowCount = @($allow | Where-Object { $_.IsInherited }).Count'
    '  Write-Stage ''complete'' ''inherited-allow-count'''
    '  Write-Stage ''begin'' ''unapproved-allow-count'''
    '  $unapprovedCount = $unapprovedSids.Count'
    '  Write-Stage ''complete'' ''unapproved-allow-count'''
    '  Write-Stage ''complete'' ''approved-grant-verification'''
    '  [Console]::Out.WriteLine("ACL_PROBE_PS51:version=$($PSVersionTable.PSVersion.ToString());protected=$protected;allow=$($allow.Count);inherited=$inheritedAllowCount;unapproved=$unapprovedCount;ownerApproved=$ownerApproved;userFullControl=$userGrant;systemFullControl=$systemGrant;administratorsFullControl=$administratorsGrant")'
    '  exit 0'
    '} catch { [Console]::Error.WriteLine("ACL_PROBE_PS51:read-failed;category=$($_.Exception.GetType().Name)"); exit 21 }'
  )
  $childPath = Join-Path $script:root 'readback-winps51.ps1'
  [IO.File]::WriteAllText($childPath, ($childLines -join [Environment]::NewLine), [Text.Encoding]::ASCII)
  $systemDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
  $powershell51 = Join-Path (Join-Path (Join-Path $systemDirectory 'WindowsPowerShell') 'v1.0') 'powershell.exe'
  if (-not (Test-Path -LiteralPath $powershell51 -PathType Leaf)) { Fail 'powershell-51-readback-mismatch' $script:stage 'windows-powershell-51-unavailable'; throw [InvalidOperationException]::new('powershell-51-unavailable') }
  $readback51 = RunBounded $powershell51 @('-NoLogo','-NoProfile','-NonInteractive','-File',$childPath,'-Target',$target) $envMap
  $stageTrace = Get-PowerShell51StageTrace $readback51.StandardOutput
  $startupEvidence = if (-not $readback51.Started) {
    'process-not-started'
  } elseif ($stageTrace.ScriptStarted) {
    'script-entered'
  } else {
    'unconfirmed-no-script-marker'
  }
  $readbackMatch = [regex]::Match($readback51.StandardOutput, '(?m)^ACL_PROBE_PS51:version=([^;]+);protected=(true|false);allow=(\d+);inherited=(\d+);unapproved=(\d+);ownerApproved=(true|false);userFullControl=(true|false);systemFullControl=(true|false);administratorsFullControl=(true|false)\r?$')
  $versionOk = $readbackMatch.Success -and $readbackMatch.Groups[1].Value -match '^5\.1(\.|$)'
  $readbackAgrees = $readbackMatch.Success -and
    ($readbackMatch.Groups[2].Value -eq $final.Protected.ToString().ToLowerInvariant()) -and
    ([int]$readbackMatch.Groups[3].Value -eq $final.AllowCount) -and
    ([int]$readbackMatch.Groups[4].Value -eq $final.InheritedAllowCount) -and
    ([int]$readbackMatch.Groups[5].Value -eq $final.UnapprovedAllowSids.Count) -and
    ($readbackMatch.Groups[6].Value -eq $final.OwnerApproved.ToString().ToLowerInvariant()) -and
    ($readbackMatch.Groups[7].Value -eq $final.CurrentUserGrant.ToString().ToLowerInvariant()) -and
    ($readbackMatch.Groups[8].Value -eq $final.SystemGrant.ToString().ToLowerInvariant()) -and
    ($readbackMatch.Groups[9].Value -eq $final.AdministratorsGrant.ToString().ToLowerInvariant())
  $ps51Ok = -not $readback51.TimedOut -and $readback51.Started -and $readback51.Exited -and
    $readback51.ExitCode -eq 0 -and $readback51.OutputComplete -and
    -not $readback51.StandardOutputTruncated -and -not $readback51.StandardErrorTruncated -and
    $versionOk -and $readbackAgrees -and $stageTrace.SequenceValid -and $stageTrace.Complete
  Report $(if ($ps51Ok) { 'PASS' } else { 'FAIL' }) $script:stage "version=$(if($readbackMatch.Success){$readbackMatch.Groups[1].Value}else{'unavailable'}) elapsedMs=$($readback51.ElapsedMilliseconds) exitCode=$($readback51.ExitCode) timedOut=$($readback51.TimedOut) outputComplete=$($readback51.OutputComplete) agreesWithPwsh=$readbackAgrees lastCompletedStage=$($stageTrace.LastCompletedStage) currentStage=$($stageTrace.CurrentStage) markerCount=$($stageTrace.MarkerCount) stageTraceValid=$($stageTrace.SequenceValid) startupEvidence=$startupEvidence errorCategory=$($readback51.ErrorCategory) stderrCategory=$(ErrorKind $readback51.StandardError)"
  if ($readback51.TimedOut) { Fail 'process-timeout' $script:stage 'windows-powershell-51-readback-timeout'; throw [InvalidOperationException]::new('process-timeout') }
  if (-not $ps51Ok) { Fail 'powershell-51-readback-mismatch' $script:stage 'readback-disagrees-with-final-acl'; throw [InvalidOperationException]::new('powershell-51-readback-mismatch') }

  if ($script:failures.Count -eq 0) { Report 'PASS' 'final-capability-result' 'failureCount=0' }
}
catch {
  Report 'FAIL' $script:stage "errorCategory=$($_.Exception.GetType().Name)"
  $script:exitCode = 1
}
finally {
  if ($script:root -and (Test-Path -LiteralPath $script:root)) {
    try {
      $unexpected = @(Get-ChildItem -LiteralPath $script:root -Force | Where-Object { $_.Name -notin @('target','readback-winps51.ps1','readback-acl-pwsh7.ps1') })
      $targetPath = Join-Path $script:root 'target'
      $targetContents = if (Test-Path -LiteralPath $targetPath) { @(Get-ChildItem -LiteralPath $targetPath -Force) } else { @() }
      if ($unexpected.Count -or $targetContents.Count) {
        Report 'FAIL' 'cleanup' 'unexpected-content-preserved'
        $script:exitCode = 1
      } else {
        if (-not $envMap) { $envMap = ChildEnvironment }
        $rootLiteral = "'" + $script:root.Replace("'", "''") + "'"
        $cleanupCode = '$ErrorActionPreference = "Stop"; Remove-Item -LiteralPath ' + $rootLiteral + ' -Recurse -Force -ErrorAction Stop; [Console]::Out.WriteLine("ACL_PROBE_CLEANUP_REMOVED"); exit 0'
        $cleanupEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanupCode))
        $cleanupExecutable = Join-Path $PSHOME 'pwsh.exe'
        $cleanupResult = RunBounded $cleanupExecutable @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$cleanupEncoded) $envMap
        $removed = $cleanupResult.Started -and $cleanupResult.Exited -and -not $cleanupResult.TimedOut -and
          $cleanupResult.ExitCode -eq 0 -and $cleanupResult.OutputComplete -and
          $cleanupResult.StandardOutput -match 'ACL_PROBE_CLEANUP_REMOVED' -and
          -not (Test-Path -LiteralPath $script:root)
        Report $(if ($removed) { 'PASS' } else { 'FAIL' }) 'cleanup' "elapsedMs=$($cleanupResult.ElapsedMilliseconds) exitCode=$($cleanupResult.ExitCode) timedOut=$($cleanupResult.TimedOut) outputComplete=$($cleanupResult.OutputComplete) errorCategory=$($cleanupResult.ErrorCategory) treeRemoved=$([bool]$removed) stderrCategory=$(ErrorKind $cleanupResult.StandardError)"
        if (-not $removed) { $script:exitCode = 1 }
      }
    }
    catch {
      Report 'FAIL' 'cleanup' "errorCategory=$($_.Exception.GetType().Name)"
      $script:exitCode = 1
    }
  }
  else { Report 'PASS' 'cleanup' 'owned-temp-tree-absent' }
}
exit $script:exitCode
