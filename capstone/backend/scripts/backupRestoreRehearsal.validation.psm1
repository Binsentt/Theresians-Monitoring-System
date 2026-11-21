Set-StrictMode -Version Latest

$script:ReleaseVersions = @(18..26)
$script:Pre026Versions = @(18..25)
$script:AggregateTables = @(
  'accounts','activity_logs','admin_audit_logs','announcements','folders','game_results',
  'learning_files','login_otp_device_skips','playtime_deletion_tombstones','playtime_sessions',
  'questions','student_ai_insights','student_game_progress','student_quest_milestones',
  'teacher_class_assignments','teacher_student_relationships','website_sessions'
)
$script:ReceiptColumns = @(
  @{ Name='student_id'; Type='integer'; NotNull=$true; Default='none' },
  @{ Name='learning_cycle_version'; Type='integer'; NotNull=$true; Default='none' },
  @{ Name='save_commit_id_hash'; Type='text'; NotNull=$true; Default='none' },
  @{ Name='payload_sha256'; Type='text'; NotNull=$true; Default='none' },
  @{ Name='activity_event_key'; Type='text'; NotNull=$true; Default='none' },
  @{ Name='response_status'; Type='smallint'; NotNull=$true; Default='201' },
  @{ Name='response_body'; Type='jsonb'; NotNull=$false; Default='none' },
  @{ Name='created_at'; Type='timestamp with time zone'; NotNull=$true; Default='current_timestamp' },
  @{ Name='completed_at'; Type='timestamp with time zone'; NotNull=$false; Default='none' }
)
$script:ReceiptConstraints = [ordered]@{
  game_progress_save_commits_pkey = @{ Type='p'; Columns=@('student_id','learning_cycle_version','save_commit_id_hash'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; NullsNotDistinct=$false; CheckExpressions=@() }
  game_progress_save_commits_activity_event_unique = @{ Type='u'; Columns=@('student_id','activity_event_key'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; NullsNotDistinct=$false; CheckExpressions=@() }
  game_progress_save_commits_student_id_fkey = @{ Type='f'; Columns=@('student_id'); ReferencedSchema='public'; ReferencedTable='accounts'; ReferencedColumns=@('id'); MatchType='SIMPLE'; UpdateAction='NO ACTION'; DeleteAction='CASCADE'; NullsNotDistinct=$false; CheckExpressions=@() }
  game_progress_save_commits_learning_cycle_version_check = @{ Type='c'; Columns=@('learning_cycle_version'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; NullsNotDistinct=$false; CheckExpressions=@('learning_cycle_version>=0') }
  game_progress_save_commits_save_commit_id_hash_check = @{ Type='c'; Columns=@('save_commit_id_hash'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; NullsNotDistinct=$false; CheckExpressions=@("save_commit_id_hash~'^[0-9a-f]{64}$'") }
  game_progress_save_commits_payload_sha256_check = @{ Type='c'; Columns=@('payload_sha256'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; NullsNotDistinct=$false; CheckExpressions=@("payload_sha256~'^[0-9a-f]{64}$'") }
  game_progress_save_commits_response_status_check = @{ Type='c'; Columns=@('response_status'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; NullsNotDistinct=$false; CheckExpressions=@('response_statusbetween200and299','response_status>=200andresponse_status<=299') }
  game_progress_save_commits_completion_consistency = @{ Type='c'; Columns=@('response_body','completed_at'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; NullsNotDistinct=$false; CheckExpressions=@('response_bodyisnull=completed_atisnull') }
}

function ConvertTo-ConstraintSignature {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Definition)
  $pattern = "('(?:[^']|'')*')|([^']+)"
  $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
    param($match)
    if ($match.Groups[1].Success) { return $match.Groups[1].Value }
    return ($match.Groups[2].Value -replace '\s+','').ToLowerInvariant()
  }
  return [regex]::Replace($Definition,$pattern,$evaluator)
}

function Assert-ApprovedRecoverySource {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExpectedSourceCommit,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ApprovalReference,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ActualSourceCommit
  )
  if ($ExpectedSourceCommit -notmatch '^[a-fA-F0-9]{40}$') { throw 'STOP: an explicit 40-character approved recovery source commit is required.' }
  if ($ApprovalReference -notmatch '^[A-Za-z0-9._:/-]{3,128}$') { throw 'STOP: a separate approval reference is required.' }
  if ($ActualSourceCommit -ine $ExpectedSourceCommit) { throw 'STOP: actual source commit does not match the approved recovery source commit.' }
}

function Assert-InteractiveAuthenticationEnvironment {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][System.Collections.IDictionary]$EnvironmentVariables)
  $overridingLibpqVariables = @(
    'PGPASSWORD','PGPASSFILE','PGSERVICE','PGSERVICEFILE','PGSYSCONFDIR',
    'PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGOPTIONS','PGAPPNAME',
    'PGCONNECT_TIMEOUT','PGCLIENTENCODING','PGSSLMODE','PGREQUIRESSL','PGSSLCOMPRESSION',
    'PGSSLCERT','PGSSLKEY','PGSSLROOTCERT','PGSSLCRL','PGSSLCRLDIR','PGGSSENCMODE',
    'PGCHANNELBINDING','PGKRBSRVNAME','PGTARGETSESSIONATTRS','PGLOADBALANCEHOSTS','PGSSLNEGOTIATION'
  )
  foreach ($name in $overridingLibpqVariables) {
    if ($EnvironmentVariables.Contains($name) -and -not [string]::IsNullOrEmpty([string]$EnvironmentVariables[$name])) {
      if ($name -in @('PGPASSWORD','PGPASSFILE')) {
        throw "STOP: $name is present; remove ambient password sources and use only the separately reviewed protected credential file."
      }
      if ($name -eq 'PGOPTIONS') { throw 'STOP: PGOPTIONS is present; role-setting and unreviewed libpq startup options are not allowed.' }
      throw "STOP: $name is present and could override the reviewed PostgreSQL service connection."
    }
  }
}

function Assert-PostgresServiceConfiguration {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory=$true)][System.Collections.IDictionary]$ExpectedUsers,
    [Parameter()][System.Collections.IDictionary]$ExpectedDatabases = @{}
  )
  if ($Text -match '(?im)(?:^|[\s;])(?:password|sslpassword|passfile)\s*=') {
    throw 'STOP: PostgreSQL service configuration contains a credential field.'
  }
  if ($Text -match '(?im)(?:postgres(?:ql)?://|^\s*(?:uri|connection_string)\s*=)') {
    throw 'STOP: PostgreSQL service configuration contains an inline credential-bearing connection string.'
  }
  $allowedKeys = @('host','hostaddr','port','dbname','user','sslmode','sslrootcert','connect_timeout','application_name')
  $sections = [ordered]@{}
  $section = $null
  foreach ($line in ($Text -split "\r?\n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    if ($trimmed -match '^\[([A-Za-z0-9_.-]+)\]$') {
      $section = $Matches[1]
      if ($sections.Contains($section)) { throw 'STOP: PostgreSQL service file contains a duplicate service section.' }
      $sections[$section] = [ordered]@{}
      continue
    }
    if ($null -eq $section -or $trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      throw 'STOP: PostgreSQL service file contains an invalid or out-of-section setting.'
    }
    $key = $Matches[1].ToLowerInvariant()
    $value = $Matches[2]
    if ($key -notin $allowedKeys) { throw "STOP: PostgreSQL service file contains an unsafe or unsupported setting ($key)." }
    if ($sections[$section].Contains($key)) { throw 'STOP: PostgreSQL service file contains a duplicate setting.' }
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '(?:postgres(?:ql)?://|[;\r\n])') { throw 'STOP: PostgreSQL service file contains an invalid setting value.' }
    $sections[$section][$key] = $value
  }
  if ($sections.Count -ne $ExpectedUsers.Count) { throw 'STOP: PostgreSQL service aliases do not match the exact reviewed contract.' }
  foreach ($alias in $ExpectedUsers.Keys) {
    if (-not $sections.Contains($alias)) { throw "STOP: PostgreSQL service alias $alias is missing." }
    $settings = $sections[$alias]
    foreach ($requiredKey in @('host','port','dbname','user')) {
      if (-not $settings.Contains($requiredKey)) { throw "STOP: PostgreSQL service alias $alias is missing $requiredKey." }
    }
    $port = 0
    if (-not [int]::TryParse([string]$settings['port'],[ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw "STOP: PostgreSQL service alias $alias has an invalid port." }
    if ([string]$settings['user'] -cne [string]$ExpectedUsers[$alias]) { throw "STOP: PostgreSQL service alias $alias does not authenticate as its dedicated expected role." }
    if ($ExpectedDatabases.Contains($alias) -and [string]$settings['dbname'] -cne [string]$ExpectedDatabases[$alias]) {
      throw "STOP: PostgreSQL service alias $alias targets a different database than the reviewed target."
    }
  }
}

function Get-ExpectedReleaseMigrationManifest {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$MigrationDirectory,[Parameter(Mandatory=$true)][string]$PreflightSqlPath)
  $sql = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $PreflightSqlPath).Path)
  $manifestMatch = [regex]::Match($sql,'WITH\s+expected\s*\(\s*version\s*,\s*filename\s*,\s*source_sha256\s*\)\s+AS\s*\(\s*VALUES(?<rows>[\s\S]*?)\)\s*SELECT',[System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $manifestMatch.Success) { throw 'STOP: canonical migration manifest is absent from the approved preflight source.' }
  $matches = [regex]::Matches($manifestMatch.Groups['rows'].Value,"\((\d+),\s*'([^']+)',\s*'([a-f0-9]{64})'\)",[System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($matches.Count -ne 9) { throw 'STOP: canonical source manifest does not contain exactly migrations 018-026.' }

  $manifest = [System.Collections.Generic.List[object]]::new()
  $seenVersions = [System.Collections.Generic.HashSet[int]]::new()
  $seenFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($item in $matches) {
    $version = [int]$item.Groups[1].Value
    $filename = $item.Groups[2].Value
    $expectedHash = $item.Groups[3].Value.ToLowerInvariant()
    if (-not $seenVersions.Add($version) -or -not $seenFiles.Add($filename)) { throw 'STOP: canonical migration manifest contains duplicate versions or filenames.' }
    if ($filename -notmatch ('^' + $version.ToString('000') + '_[a-zA-Z0-9_-]+\.sql$')) { throw "STOP: migration $version manifest filename does not match its version." }
    $migrationPath = Join-Path $MigrationDirectory $filename
    if (-not (Test-Path -LiteralPath $migrationPath -PathType Leaf)) { throw "STOP: canonical migration $version file is missing." }
    $contents = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $migrationPath).Path)
    $newline = [string][char]10
    $canonicalText = [regex]::Replace($contents,'\r\n|\r',$newline)
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($canonicalText)
    $actualHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if ($actualHash -cne $expectedHash) { throw "STOP: migration $version source differs from the preflight manifest checksum." }
    $manifest.Add([pscustomobject]@{ Version=$version; Filename=$filename; Checksum=$expectedHash })
  }
  $ordered = @($manifest | Sort-Object Version)
  if (($ordered.Version -join ',') -cne '18,19,20,21,22,23,24,25,26') { throw 'STOP: canonical migration manifest is not exactly ordered 018-026.' }
  return $ordered
}

function Assert-ReleaseMigrationLedger {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Rows,[Parameter(Mandatory=$true)][object[]]$Manifest,[Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode)
  $requiredVersions = if ($SchemaMode -eq 'PreMigration026') { $script:Pre026Versions } else { $script:ReleaseVersions }
  $seen = @{}
  $seenFilenames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($row in $Rows) {
    $version = 0
    if (-not [int]::TryParse([string]$row.Version,[ref]$version)) { throw 'STOP: migration ledger contains an invalid version.' }
    if ($seen.ContainsKey($version)) { throw "STOP: duplicate migration ledger version $version." }
    if (-not $seenFilenames.Add([string]$row.Filename)) { throw 'STOP: duplicate migration ledger filename.' }
    $seen[$version] = $row
    if ($version -notin $script:ReleaseVersions) { throw "STOP: unexpected release migration version $version." }
  }
  if ($SchemaMode -eq 'PreMigration026' -and $seen.ContainsKey(26)) { throw 'STOP: migration 026 is recorded in pre-026 mode.' }
  $missing = @($requiredVersions | Where-Object { -not $seen.ContainsKey($_) })
  if ($missing.Count -gt 0) { throw "STOP: migration ledger has missing versions: $($missing -join ',')." }
  foreach ($version in $requiredVersions) {
    $actual = $seen[$version]
    $expected = $Manifest | Where-Object Version -eq $version | Select-Object -First 1
    if ($null -eq $expected) { throw "STOP: source manifest is missing migration $version." }
    if ([string]$actual.Filename -cne [string]$expected.Filename) { throw "STOP: migration $version filename mismatch." }
    if (([string]$actual.Checksum).Trim().ToLowerInvariant() -cne [string]$expected.Checksum) { throw "STOP: migration $version checksum mismatch." }
  }
  if ($seen.Count -ne $requiredVersions.Count) { throw 'STOP: migration ledger contains an unexpected or pending release migration.' }
}

function Assert-ReceiptSchemaState {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode,[Parameter(Mandatory=$true)][object]$ReceiptState)
  $objects = @()
  foreach ($name in @('Relations','Constraints','Indexes','Triggers','Types')) {
    $objects += @($ReceiptState.$name | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.Name } } | Where-Object { $_ -like 'game_progress_save_commits*' })
  }
  $tableExists = [bool]$ReceiptState.TableExists
  if ($SchemaMode -eq 'PreMigration026') {
    if ($tableExists -or $objects.Count -gt 0 -or @($ReceiptState.Columns).Count -gt 0) { throw 'STOP: partial migration-026 receipt objects exist in pre-026 mode.' }
    return
  }
  if (-not $tableExists) { throw 'STOP: post-026 receipt table is missing.' }
  $relations = @($ReceiptState.Relations | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.Name } } | Sort-Object)
  $expectedRelations = @('game_progress_save_commits','game_progress_save_commits_activity_event_unique','game_progress_save_commits_pkey')
  if ($relations.Count -ne $expectedRelations.Count -or ($relations -join '|') -cne ($expectedRelations -join '|')) { throw 'STOP: receipt relation set is incomplete or unexpected.' }

  $columns = @($ReceiptState.Columns)
  if ($columns.Count -ne $script:ReceiptColumns.Count) { throw 'STOP: receipt column count does not match migration 026.' }
  foreach ($expected in $script:ReceiptColumns) {
    $actual = @($columns | Where-Object { [string]$_.Name -ceq $expected.Name })
    if ($actual.Count -ne 1) { throw "STOP: receipt column $($expected.Name) is missing or duplicated." }
    $actual = $actual[0]
    if ([string]$actual.Type -cne $expected.Type -or [bool]$actual.NotNull -ne [bool]$expected.NotNull) { throw "STOP: receipt column $($expected.Name) type or nullability mismatch." }
    $defaultText = ([string]$actual.Default).Trim().ToLowerInvariant()
    if ($expected.Default -eq 'none') {
      if ($defaultText -ne '') { throw "STOP: receipt column $($expected.Name) has an unexpected default." }
    } elseif ($expected.Name -eq 'created_at') {
      if ($defaultText -notmatch '^current_timestamp(?:\(\d+\))?$') { throw 'STOP: receipt created_at default mismatch.' }
    } elseif ($expected.Name -eq 'response_status') {
      if ($defaultText -notmatch "^'?201'?(?:::smallint)?$") { throw 'STOP: receipt response_status default mismatch.' }
    }
  }

  $constraints = @($ReceiptState.Constraints)
  if ($constraints.Count -ne $script:ReceiptConstraints.Count) { throw 'STOP: receipt constraint set is incomplete or unexpected.' }
  foreach ($entry in $script:ReceiptConstraints.GetEnumerator()) {
    $actual = @($constraints | Where-Object { [string]$_.Name -ceq [string]$entry.Key })
    if ($actual.Count -ne 1) { throw "STOP: receipt constraint $($entry.Key) is missing or duplicated." }
    $actual = $actual[0]
    if ([string]$actual.Type -cne [string]$entry.Value.Type -or -not [bool]$actual.Validated -or
        [bool]$actual.Deferrable -or [bool]$actual.Deferred -or [bool]$actual.NoInherit -or
        -not [bool]$actual.Enforced) { throw "STOP: receipt constraint $($entry.Key) has incompatible enforcement or validation flags." }
    $actualColumns = @($actual.Columns | ForEach-Object { [string]$_ })
    if (($actualColumns -join '|') -cne ($entry.Value.Columns -join '|')) { throw "STOP: receipt constraint $($entry.Key) has an incorrect ordered column mapping." }
    if ($entry.Value.Type -eq 'f') {
      $actualReferencedColumns = @($actual.ReferencedColumns | ForEach-Object { [string]$_ })
      $referenceMismatch = -not [string]::Equals([string]$actual.ReferencedSchema,[string]$entry.Value.ReferencedSchema,[StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$actual.ReferencedTable,[string]$entry.Value.ReferencedTable,[StringComparison]::Ordinal) -or
        -not [string]::Equals(($actualReferencedColumns -join '|'),($entry.Value.ReferencedColumns -join '|'),[StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$actual.MatchType,[string]$entry.Value.MatchType,[StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$actual.UpdateAction,[string]$entry.Value.UpdateAction,[StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$actual.DeleteAction,[string]$entry.Value.DeleteAction,[StringComparison]::Ordinal)
      if ($referenceMismatch) {
        throw "STOP: receipt constraint $($entry.Key) foreign key has an incorrect reference, mapping, or action."
      }
    } elseif ($entry.Value.Type -ne 'c' -and (
        [string]$actual.ReferencedSchema -or [string]$actual.ReferencedTable -or @($actual.ReferencedColumns).Count -gt 0 -or
        [string]$actual.MatchType -or [string]$actual.UpdateAction -or [string]$actual.DeleteAction)) {
      throw "STOP: non-foreign-key constraint $($entry.Key) contains unexpected reference metadata."
    }
    if ([bool]$actual.NullsNotDistinct -ne [bool]$entry.Value.NullsNotDistinct) { throw "STOP: receipt constraint $($entry.Key) has an unexpected NULL uniqueness mode." }
    if ($entry.Value.Type -eq 'c') {
      $definition = ConvertTo-ConstraintSignature -Definition ([string]$actual.Definition)
      $expectedDefinitions = @($entry.Value.CheckExpressions | ForEach-Object { ConvertTo-ConstraintSignature -Definition ([string]$_) })
      if ($definition -cnotin $expectedDefinitions) { throw "STOP: receipt CHECK constraint $($entry.Key) expression differs from the reviewed PostgreSQL 16/18 allowlist." }
    }
  }

  $indexes = @($ReceiptState.Indexes | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.Name } } | Sort-Object)
  $expectedIndexes = @('game_progress_save_commits_activity_event_unique','game_progress_save_commits_pkey')
  if ($indexes.Count -ne 2 -or ($indexes -join '|') -cne ($expectedIndexes -join '|')) { throw 'STOP: receipt index set is incomplete or unexpected.' }
  if (@($ReceiptState.Triggers).Count -gt 0) { throw 'STOP: unexpected receipt trigger exists.' }
  if (@($ReceiptState.Types).Count -gt 0) { throw 'STOP: unexpected standalone receipt type exists.' }
}

function Get-BackupAggregateTables {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode)
  $tables = @($script:AggregateTables)
  if ($SchemaMode -eq 'PostMigration026') { $tables += 'game_progress_save_commits' }
  return $tables
}

function ConvertFrom-BackupAggregateOutput {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$Lines,[Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode)
  $allowed = @(Get-BackupAggregateTables -SchemaMode $SchemaMode)
  $seen = @{}
  foreach ($line in $Lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = ([string]$line).Trim().Split('|')
    if ($parts.Count -ne 2) { throw 'STOP: aggregate output row has an invalid shape.' }
    $table = $parts[0]
    if ($table -notin $allowed) { throw 'STOP: aggregate output contains an unexpected table.' }
    if ($seen.ContainsKey($table)) { throw "STOP: duplicate aggregate row for $table." }
    $count = [long]0
    if (-not [long]::TryParse($parts[1],[System.Globalization.NumberStyles]::None,[System.Globalization.CultureInfo]::InvariantCulture,[ref]$count) -or $count -lt 0) { throw 'STOP: aggregate output contains an invalid row count.' }
    $seen[$table] = [string]$count
  }
  $missing = @($allowed | Where-Object { -not $seen.ContainsKey($_) })
  if ($missing.Count -gt 0) { throw 'STOP: aggregate output is missing an expected table.' }
  if ($seen.Count -ne $allowed.Count) { throw 'STOP: aggregate output contains an unexpected table.' }
  $rows = foreach ($table in $allowed) { [pscustomobject]@{ TableName=$table; RowCount=$seen[$table] } }
  return $rows
}

function ConvertTo-StrictAggregateMap {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][object]$Counts,[Parameter(Mandatory=$true)][string[]]$AllowedTables)
  $map = [ordered]@{}
  if ($Counts -is [System.Collections.IDictionary]) {
    foreach ($key in $Counts.Keys) { $map[[string]$key] = $Counts[$key] }
  } else {
    foreach ($property in $Counts.PSObject.Properties) { $map[$property.Name] = $property.Value }
  }
  if ($map.Count -ne $AllowedTables.Count) { throw 'STOP: aggregate manifest has an incomplete or unexpected table-count set.' }
  foreach ($table in $AllowedTables) {
    if (-not $map.Contains($table)) { throw 'STOP: aggregate manifest is missing an allowed table count.' }
    $count = [long]0
    if (-not [long]::TryParse([string]$map[$table],[System.Globalization.NumberStyles]::None,[System.Globalization.CultureInfo]::InvariantCulture,[ref]$count) -or $count -lt 0) { throw 'STOP: aggregate manifest contains an invalid count.' }
    $map[$table] = [string]$count
  }
  foreach ($key in $map.Keys) { if ($key -notin $AllowedTables) { throw 'STOP: aggregate manifest contains an unexpected table.' } }
  return $map
}

function Assert-AggregateManifest {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][object]$Manifest,[Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode,[Parameter(Mandatory=$true)][string]$ExpectedSourceCommit,[Parameter(Mandatory=$true)][string]$ExpectedArchiveSha256)
  $expectedKeys = @('Version','SchemaMode','SourceCommit','SnapshotId','ArchiveSha256','Counts')
  $actualKeys = @($Manifest.PSObject.Properties.Name | Sort-Object)
  if (($actualKeys -join '|') -cne (($expectedKeys | Sort-Object) -join '|')) { throw 'STOP: aggregate manifest contains unexpected or missing fields.' }
  if ([int]$Manifest.Version -ne 1) { throw 'STOP: aggregate manifest version is unsupported.' }
  if ([string]$Manifest.SchemaMode -cne $SchemaMode) { throw 'STOP: aggregate manifest schema mode does not match the selected restore mode.' }
  if ([string]$Manifest.SourceCommit -notmatch '^[a-fA-F0-9]{40}$' -or [string]$Manifest.SourceCommit -ine $ExpectedSourceCommit) { throw 'STOP: aggregate manifest recovery source does not match the approved source commit.' }
  if ([string]$Manifest.SnapshotId -notmatch '^[A-Fa-f0-9]+-[A-Fa-f0-9]+-\d+$') { throw 'STOP: aggregate manifest snapshot identifier is invalid.' }
  if ([string]$Manifest.ArchiveSha256 -notmatch '^[a-fA-F0-9]{64}$' -or [string]$Manifest.ArchiveSha256 -ine $ExpectedArchiveSha256) { throw 'STOP: aggregate manifest archive checksum is invalid or does not match the approved checksum.' }
  $allowed = @(Get-BackupAggregateTables -SchemaMode $SchemaMode)
  [void](ConvertTo-StrictAggregateMap -Counts $Manifest.Counts -AllowedTables $allowed)
}

function Assert-AggregateCountsMatch {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][object]$SourceManifest,[Parameter(Mandatory=$true)][object]$RestoredCounts,[Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode)
  $allowed = @(Get-BackupAggregateTables -SchemaMode $SchemaMode)
  if ([string]$SourceManifest.SchemaMode -cne $SchemaMode) { throw 'STOP: source aggregate schema mode differs from restored schema mode.' }
  $expected = ConvertTo-StrictAggregateMap -Counts $SourceManifest.Counts -AllowedTables $allowed
  $actual = ConvertTo-StrictAggregateMap -Counts $RestoredCounts -AllowedTables $allowed
  foreach ($table in $allowed) { if ($expected[$table] -cne $actual[$table]) { throw "STOP: aggregate count mismatch for table $table." } }
}

function Assert-IsolatedRestoreIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string[]]$Fields,
    [Parameter(Mandatory=$true)][string]$ExpectedDatabase,
    [Parameter(Mandatory=$true)][string]$ExpectedServerAddress,
    [Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$ExpectedServerPort
  )
  if ($ExpectedDatabase -notmatch '^tq_restore_[a-z0-9_]+$') { throw 'STOP: restore database name is outside the isolated allowlist.' }
  $address = $null
  try { $address = [System.Net.IPAddress]::Parse($ExpectedServerAddress) } catch { throw 'STOP: restore server address is not a literal IP.' }
  if (-not [System.Net.IPAddress]::IsLoopback($address)) { throw 'STOP: restore server address is not loopback.' }
  if ($Fields.Count -ne 11 -or $Fields[0] -cne $ExpectedDatabase -or
      $Fields[1] -cne 'tq_restore_operator' -or $Fields[2] -cne 'tq_restore_operator' -or
      $Fields[3] -cne $ExpectedServerAddress -or $Fields[4] -cne [string]$ExpectedServerPort -or
      $Fields[9] -ne 't' -or $Fields[10] -ne 'f') {
    throw 'STOP: restore connection must authenticate as the dedicated session_user and execute as the same current_user database owner, be loopback-only with local schema privileges, and use an isolated non-admin role.'
  }
}

function Assert-IsolatedRestoreTarget {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string[]]$Fields,
    [Parameter(Mandatory=$true)][string]$ExpectedDatabase,
    [Parameter(Mandatory=$true)][string]$ExpectedServerAddress,
    [Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$ExpectedServerPort
  )
  Assert-IsolatedRestoreIdentity -Fields $Fields -ExpectedDatabase $ExpectedDatabase -ExpectedServerAddress $ExpectedServerAddress -ExpectedServerPort $ExpectedServerPort
  if ($Fields[5] -ne '0' -or $Fields[6] -ne '0' -or $Fields[7] -ne '0' -or $Fields[8] -ne '0') {
    throw 'STOP: isolated restore target must be empty before restore.'
  }
}

function Assert-NoReparsePointPath {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($root)) { throw 'STOP: storage path has no verifiable filesystem root.' }
  $current = $root
  $relative = $full.Substring($root.Length)
  $separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar,[System.IO.Path]::AltDirectorySeparatorChar)
  foreach ($part in $relative.Split($separators,[System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $part
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      Assert-NoReparsePointAttributes -Attributes $item.Attributes
    } else { break }
  }
  return $full
}

function Assert-NoReparsePointAttributes {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][System.IO.FileAttributes]$Attributes)
  if (($Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'STOP: storage path contains a symbolic link, junction, or other reparse point.'
  }
}

function Test-RestrictedStorageAclDescriptor {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][object]$Acl,
    [Parameter(Mandatory=$true)][string]$CurrentUserSid
  )
  try {
    $allowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    [void]$allowed.Add($CurrentUserSid)
    [void]$allowed.Add('S-1-5-18')
    [void]$allowed.Add('S-1-5-32-544')
    $ownerSid = $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not $allowed.Contains($ownerSid)) { throw 'STOP: storage destination owner is outside the approved local identity set.' }
    $accessRules = $Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    foreach ($rule in $accessRules) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
      $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if (-not $allowed.Contains($sid)) { throw "STOP: storage ACL grants access to an unapproved identity ($sid)." }
    }
  } catch {
    if ($_.Exception.Message -like 'STOP:*') { throw }
    throw 'STOP: storage ACL is unavailable or cannot be independently verified.'
  }
}

function Assert-RestrictedStorageAcl {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Path)
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'STOP: Windows storage ACL semantics cannot be verified on this platform.'
  }
  try {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Test-RestrictedStorageAclDescriptor -Acl $acl -CurrentUserSid $currentSid
  } catch {
    if ($_.Exception.Message -like 'STOP:*') { throw }
    throw 'STOP: storage ACL is unavailable or cannot be independently verified.'
  }
}

function Assert-ReviewedPreflightCredentialFiles {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$PassfilePath,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ServiceFilePath,
    [Parameter(Mandatory=$true)][string]$RepositoryRoot,
    [Parameter(Mandatory=$true)][string]$ServiceName,
    [Parameter(Mandatory=$true)][System.Collections.IDictionary]$ExpectedUsers,
    [Parameter(Mandatory=$true)][System.Collections.IDictionary]$ExpectedDatabases
  )

  if (-not (Test-Path -LiteralPath $RepositoryRoot -PathType Container)) {
    throw 'STOP: reviewed repository root is missing or is not a directory.'
  }
  $repositoryFullPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path).TrimEnd('\')
  $validatedPaths = [ordered]@{}
  foreach ($entry in @(
    [pscustomobject]@{ Name='PGPASSFILE'; Path=$PassfilePath },
    [pscustomobject]@{ Name='PGSERVICEFILE'; Path=$ServiceFilePath }
  )) {
    if ([string]::IsNullOrWhiteSpace($entry.Path)) { throw "STOP: $($entry.Name) path is required." }
    $fullPath = Assert-NoReparsePointPath -Path $entry.Path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "STOP: required $($entry.Name) file is missing or is not a regular file." }
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "STOP: $($entry.Name) must be a regular file without reparse attributes."
    }

    $parentPath = [System.IO.Path]::GetDirectoryName($fullPath)
    [void](Assert-NoReparsePointPath -Path $parentPath)
    Assert-RestrictedStorageAcl -Path $parentPath
    Assert-RestrictedStorageAcl -Path $fullPath

    $resolvedPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $fullPath -ErrorAction Stop).Path)
    $repositoryPrefix = $repositoryFullPath + [System.IO.Path]::DirectorySeparatorChar
    if ($resolvedPath.Equals($repositoryFullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $resolvedPath.StartsWith($repositoryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "STOP: $($entry.Name) must remain outside the repository."
    }
    $validatedPaths[$entry.Name] = $resolvedPath
  }

  $passfileStream = $null
  try {
    $passfileStream = [System.IO.File]::Open(
      $validatedPaths['PGPASSFILE'],
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
  } catch {
    throw 'STOP: PGPASSFILE cannot be opened for reading by the current operator; credential contents were not displayed.'
  } finally {
    if ($null -ne $passfileStream) { $passfileStream.Dispose() }
  }

  try {
    $serviceText = [System.IO.File]::ReadAllText($validatedPaths['PGSERVICEFILE'])
  } catch {
    throw 'STOP: PostgreSQL service file is unreadable; credential contents were not displayed.'
  }
  if (-not $ExpectedUsers.Contains($ServiceName) -or -not $ExpectedDatabases.Contains($ServiceName)) {
    throw 'STOP: reviewed PostgreSQL service alias, role, and database must be explicitly specified.'
  }
  $expectedServiceUsers = [ordered]@{ $ServiceName = $ExpectedUsers[$ServiceName] }
  $expectedServiceDatabases = [ordered]@{ $ServiceName = $ExpectedDatabases[$ServiceName] }
  Assert-PostgresServiceConfiguration -Text $serviceText -ExpectedUsers $expectedServiceUsers -ExpectedDatabases $expectedServiceDatabases

  return [pscustomobject]@{
    PassfilePath = $validatedPaths['PGPASSFILE']
    ServiceFilePath = $validatedPaths['PGSERVICEFILE']
  }
}

function Assert-EncryptionEvidence {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$EvidencePath,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExpectedEvidenceSha256,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$EvidenceReference,
    [Parameter()][AllowNull()][object]$AutomaticEncryptionStatus
  )
  $full = [System.IO.Path]::GetFullPath($Path)
  $volumeRoot = [System.IO.Path]::GetPathRoot($full)
  if ($volumeRoot -notmatch '^[A-Za-z]:\\$') { throw 'STOP: only a fixed, local drive-letter volume has a supported encryption verification contract.' }
  try { $drive = [System.IO.DriveInfo]::new($volumeRoot) } catch { throw 'STOP: destination volume identity cannot be verified.' }
  if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { throw 'STOP: destination is not on a fixed local volume.' }
  if ($null -ne $AutomaticEncryptionStatus) {
    $reportedMount = [string]$AutomaticEncryptionStatus.MountPoint
    if ($reportedMount -match '^[A-Za-z]:$') { $reportedMount += '\' }
    if ($reportedMount -ine $volumeRoot -or [string]$AutomaticEncryptionStatus.VolumeStatus -cne 'FullyEncrypted' -or
        [string]$AutomaticEncryptionStatus.ProtectionStatus -cne 'On' -or [int]$AutomaticEncryptionStatus.EncryptionPercentage -ne 100) {
      throw 'STOP: automatic volume-encryption evidence does not prove the destination volume is fully encrypted and protected.'
    }
    return
  }
  if (-not $EvidencePath -or $ExpectedEvidenceSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or -not $EvidenceReference) {
    throw 'STOP: independently verifiable encryption evidence and its separately recorded digest/reference are required.'
  }
  if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf)) { throw 'STOP: encryption evidence file is missing.' }
  $evidenceFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $EvidencePath).Path)
  $actualEvidenceHash = (Get-FileHash -LiteralPath $evidenceFull -Algorithm SHA256 -ErrorAction Stop).Hash
  if ($actualEvidenceHash -ine $ExpectedEvidenceSha256) { throw 'STOP: encryption evidence digest differs from the separately recorded digest.' }
  try { $evidence = [System.IO.File]::ReadAllText($evidenceFull) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'STOP: encryption evidence is unreadable or invalid JSON.' }
  $requiredEvidenceKeys = @('Version','VolumeRoot','Provider','VolumeStatus','ProtectionStatus','EncryptionPercentage','VerifiedAt','VerifiedBy','VerificationReference','SourceCommand') | Sort-Object
  if ((@($evidence.PSObject.Properties.Name | Sort-Object) -join '|') -cne ($requiredEvidenceKeys -join '|')) { throw 'STOP: encryption evidence has an unexpected or incomplete shape.' }
  $verifiedAt = [DateTimeOffset]::MinValue
  if ([int]$evidence.Version -ne 1 -or [string]$evidence.VolumeRoot -ine $volumeRoot -or [string]$evidence.Provider -cne 'BitLocker' -or
      [string]$evidence.VolumeStatus -cne 'FullyEncrypted' -or [string]$evidence.ProtectionStatus -cne 'On' -or
      [int]$evidence.EncryptionPercentage -ne 100 -or [string]::IsNullOrWhiteSpace([string]$evidence.VerifiedBy) -or
      [string]$evidence.VerificationReference -cne $EvidenceReference -or
      [string]$evidence.SourceCommand -notin @('Get-BitLockerVolume','manage-bde -status') -or
      -not [DateTimeOffset]::TryParse([string]$evidence.VerifiedAt,[ref]$verifiedAt) -or $verifiedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
    throw 'STOP: external encryption evidence is unsupported, mismatched, or not a complete protected-volume attestation.'
  }
}

function Assert-BackupStorageDirectory {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$RepositoryRoot,
    [Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$TemporaryRoots,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$EncryptionEvidencePath,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExpectedEncryptionEvidenceSha256,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$EncryptionEvidenceReference,
    [Parameter()][AllowNull()][object]$AutomaticEncryptionStatus
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw 'STOP: backup storage directory must already exist.' }
  $full = Assert-NoReparsePointPath -Path $Path
  $repository = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
  if ($full.Equals($repository,[System.StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($repository + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: backup storage must remain outside the repository.'
  }
  foreach ($tempRoot in $TemporaryRoots | Where-Object { $_ }) {
    $temp = [System.IO.Path]::GetFullPath($tempRoot).TrimEnd('\')
    if ($full.Equals($temp,[System.StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($temp + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'STOP: backup artifacts cannot be stored in a temporary or CI directory.'
    }
  }
  Assert-RestrictedStorageAcl -Path $full
  $existingItems = @(Get-ChildItem -LiteralPath $full -Force -Recurse -ErrorAction Stop)
  foreach ($item in $existingItems) {
    [void](Assert-NoReparsePointPath -Path $item.FullName)
    Assert-RestrictedStorageAcl -Path $item.FullName
  }
  if ($null -ne $AutomaticEncryptionStatus) {
    Assert-EncryptionEvidence -Path $full -EvidencePath '' -ExpectedEvidenceSha256 '' -EvidenceReference '' -AutomaticEncryptionStatus $AutomaticEncryptionStatus
    return $full
  }
  if (-not $EncryptionEvidencePath -or $ExpectedEncryptionEvidenceSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or -not $EncryptionEvidenceReference) {
    throw 'STOP: independently verifiable encryption evidence and its separately recorded digest/reference are required.'
  }
  [void](Assert-NoReparsePointPath -Path $EncryptionEvidencePath)
  if (-not (Test-Path -LiteralPath $EncryptionEvidencePath -PathType Leaf)) { throw 'STOP: encryption evidence file is missing.' }
  $evidenceFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $EncryptionEvidencePath).Path)
  if ($evidenceFull.Equals($full,[System.StringComparison]::OrdinalIgnoreCase) -or $evidenceFull.StartsWith($full + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: encryption evidence must be stored separately from the backup destination.'
  }
  $evidenceRepository = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
  if ($evidenceFull.Equals($evidenceRepository,[System.StringComparison]::OrdinalIgnoreCase) -or $evidenceFull.StartsWith($evidenceRepository + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: encryption evidence must remain outside the repository.'
  }
  foreach ($tempRoot in $TemporaryRoots | Where-Object { $_ }) {
    $temp = [System.IO.Path]::GetFullPath($tempRoot).TrimEnd('\')
    if ($evidenceFull.Equals($temp,[System.StringComparison]::OrdinalIgnoreCase) -or $evidenceFull.StartsWith($temp + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'STOP: encryption evidence must remain outside temporary or CI directories.'
    }
  }
  Assert-RestrictedStorageAcl -Path $evidenceFull
  Assert-EncryptionEvidence -Path $full -EvidencePath $evidenceFull -ExpectedEvidenceSha256 $ExpectedEncryptionEvidenceSha256 -EvidenceReference $EncryptionEvidenceReference -AutomaticEncryptionStatus $AutomaticEncryptionStatus
  return $full
}

function Assert-BackupCompletionManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][object]$Manifest,
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [Parameter(Mandatory=$true)][string]$AggregateManifestPath,
    [Parameter(Mandatory=$true)][string]$ExpectedSourceCommit,
    [Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode,
    [Parameter(Mandatory=$true)][string]$ExpectedArchiveSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedAggregateManifestSha256
  )
  $expectedKeys = @('Version','SchemaMode','SourceCommit','SnapshotId','ArchiveName','ArchiveSha256','TocName','TocSha256','AggregateManifestName','AggregateManifestSha256','HashFileName','HashFileSha256') | Sort-Object
  if ((@($Manifest.PSObject.Properties.Name | Sort-Object) -join '|') -cne ($expectedKeys -join '|')) { throw 'STOP: backup completion marker has an unexpected or incomplete shape.' }
  $archiveName = [System.IO.Path]::GetFileName($ArchivePath)
  $aggregateName = [System.IO.Path]::GetFileName($AggregateManifestPath)
  if ([int]$Manifest.Version -ne 1 -or [string]$Manifest.SchemaMode -cne $SchemaMode -or
      [string]$Manifest.SourceCommit -inotmatch '^[A-Fa-f0-9]{40}$' -or [string]$Manifest.SourceCommit -ine $ExpectedSourceCommit -or
      [string]$Manifest.SnapshotId -notmatch '^[A-Fa-f0-9]+-[A-Fa-f0-9]+-\d+$' -or
      [string]$Manifest.ArchiveName -cne $archiveName -or [string]$Manifest.AggregateManifestName -cne $aggregateName -or
      [string]$Manifest.TocName -cne "$archiveName.toc.txt" -or [string]$Manifest.HashFileName -cne "$archiveName.sha256.txt" -or
      [string]$Manifest.ArchiveSha256 -ine $ExpectedArchiveSha256 -or [string]$Manifest.AggregateManifestSha256 -ine $ExpectedAggregateManifestSha256 -or
      [string]$Manifest.TocSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or [string]$Manifest.HashFileSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'STOP: backup completion marker does not identify the complete approved artifact set.'
  }
}

function New-BackupAggregateSql {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode,
    [switch]$ImportSnapshot,
    [string]$SnapshotId
  )
  $tables = @(Get-BackupAggregateTables -SchemaMode $SchemaMode)
  $selects = foreach ($table in $tables) { "SELECT '$table'::text AS table_name, COUNT(*)::bigint AS row_count FROM public.$table" }
  $lines = [System.Collections.Generic.List[string]]::new()
  if ($ImportSnapshot) {
    if ($SnapshotId -notmatch '^[A-Fa-f0-9]+-[A-Fa-f0-9]+-\d+$') { throw 'STOP: exported snapshot identifier is invalid.' }
    $lines.Add('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')
    $lines.Add("SET TRANSACTION SNAPSHOT '$SnapshotId';")
  } else {
    $lines.Add('BEGIN READ ONLY;')
  }
  $lines.Add("SET LOCAL statement_timeout = '10min';")
  $lines.Add("SET LOCAL lock_timeout = '2s';")
  $lines.Add('SELECT table_name, row_count')
  $lines.Add('FROM (')
  $lines.Add(($selects -join ' UNION ALL '))
  $lines.Add(') AS table_counts')
  $lines.Add('ORDER BY table_name;')
  $lines.Add('ROLLBACK;')
  return ($lines -join [Environment]::NewLine)
}

Export-ModuleMember -Function @(
  'Assert-ApprovedRecoverySource','Assert-InteractiveAuthenticationEnvironment','Assert-PostgresServiceConfiguration',
  'Get-ExpectedReleaseMigrationManifest','Assert-ReleaseMigrationLedger','Assert-ReceiptSchemaState',
  'Get-BackupAggregateTables','ConvertFrom-BackupAggregateOutput','ConvertTo-StrictAggregateMap',
  'Assert-AggregateManifest','Assert-AggregateCountsMatch','Assert-IsolatedRestoreIdentity','Assert-IsolatedRestoreTarget','New-BackupAggregateSql',
  'Assert-NoReparsePointPath','Assert-NoReparsePointAttributes','Test-RestrictedStorageAclDescriptor','Assert-RestrictedStorageAcl','Assert-ReviewedPreflightCredentialFiles','Assert-EncryptionEvidence','Assert-BackupStorageDirectory','Assert-BackupCompletionManifest'
)
