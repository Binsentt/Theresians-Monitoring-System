$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot 'backupRestoreRehearsal.validation.psm1'
Import-Module $modulePath -Force
$script:passed = 0
$script:skipped = 0
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
  $caught = $null
  try { & $Action } catch { $caught = $_ }
  if ($null -eq $caught) { throw "Expected rejection matching: $Pattern" }
  if ($caught.Exception.Message -notmatch $Pattern) { throw "Unexpected rejection: $($caught.Exception.Message)" }
}
function Test-Case([string]$Name, [scriptblock]$Action) {
  try { & $Action; $script:passed++; Write-Output "PASS $Name" }
  catch { Write-Error "FAIL $Name : $($_.Exception.Message)`n$($_.ScriptStackTrace)"; throw }
}
$backend = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$migrationDirectory = Join-Path $backend 'migrations'
$preflightPath = Join-Path $PSScriptRoot 'release-migration-preflight.sql'
$rehearsalScript = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'backup-restore-rehearsal.ps1'))
$manifest = @(Get-ExpectedReleaseMigrationManifest -MigrationDirectory $migrationDirectory -PreflightSqlPath $preflightPath)

Test-Case 'approved exact source pin and approval reference' {
  Assert-ApprovedRecoverySource -ExpectedSourceCommit ('a' * 40) -ApprovalReference 'OPS-2026-42' -ActualSourceCommit ('a' * 40)
  Assert-Throws { Assert-ApprovedRecoverySource -ExpectedSourceCommit '' -ApprovalReference 'OPS-2026-42' -ActualSourceCommit ('a' * 40) } 'source commit'
  Assert-Throws { Assert-ApprovedRecoverySource -ExpectedSourceCommit ('a' * 40) -ApprovalReference '' -ActualSourceCommit ('a' * 40) } 'approval reference'
  Assert-Throws { Assert-ApprovedRecoverySource -ExpectedSourceCommit ('a' * 40) -ApprovalReference 'OPS-2026-42' -ActualSourceCommit ('b' * 40) } 'does not match'
}
Test-Case 'interactive authentication rejects ambient password sources and credential-bearing service settings' {
  Assert-InteractiveAuthenticationEnvironment @{}
  Assert-Throws { Assert-InteractiveAuthenticationEnvironment @{ PGPASSWORD = 'synthetic' } } 'PGPASSWORD'
  Assert-Throws { Assert-InteractiveAuthenticationEnvironment @{ PGPASSFILE = 'synthetic-path' } } 'PGPASSFILE'
  Assert-Throws { Assert-InteractiveAuthenticationEnvironment @{ PGOPTIONS = '-c role=postgres' } } 'PGOPTIONS'
  $expectedUsers = [ordered]@{ tq_prod_backup='tq_prod_backup_reader'; tq_prod_preflight='tq_release_preflight_reader'; tq_restore_local='tq_restore_operator'; tq_restore_preflight='tq_release_preflight_reader' }
  $safeService = [string]::Join([Environment]::NewLine, @(
    '[tq_prod_backup]','host=db.example.invalid','port=5432','dbname=production','user=tq_prod_backup_reader','sslmode=require',
    '[tq_prod_preflight]','host=db.example.invalid','port=5432','dbname=production','user=tq_release_preflight_reader','sslmode=require',
    '[tq_restore_local]','host=127.0.0.1','port=55432','dbname=tq_restore_example','user=tq_restore_operator','sslmode=disable',
    '[tq_restore_preflight]','host=127.0.0.1','port=55432','dbname=tq_restore_example','user=tq_release_preflight_reader','sslmode=disable'
  ))
  Assert-PostgresServiceConfiguration -Text $safeService -ExpectedUsers $expectedUsers
  Assert-Throws { Assert-PostgresServiceConfiguration -Text ($safeService + "`noptions=-c role=postgres") -ExpectedUsers $expectedUsers } 'unsafe'
  Assert-Throws { Assert-PostgresServiceConfiguration -Text ($safeService + "`nservice=tq_prod_backup") -ExpectedUsers $expectedUsers } 'unsafe'
  Assert-Throws { Assert-PostgresServiceConfiguration -Text ($safeService + "`ntarget_session_attrs=any") -ExpectedUsers $expectedUsers } 'unsafe'
  $wrongRestoreUser = $safeService.Replace('[tq_restore_local]'+[Environment]::NewLine+'host=127.0.0.1'+[Environment]::NewLine+'port=55432'+[Environment]::NewLine+'dbname=tq_restore_example'+[Environment]::NewLine+'user=tq_restore_operator','[tq_restore_local]'+[Environment]::NewLine+'host=127.0.0.1'+[Environment]::NewLine+'port=55432'+[Environment]::NewLine+'dbname=tq_restore_example'+[Environment]::NewLine+'user=postgres')
  Assert-Throws { Assert-PostgresServiceConfiguration -Text $wrongRestoreUser -ExpectedUsers $expectedUsers } 'role'
  $unsafePass = [string]::Join([Environment]::NewLine, @('[svc]','password=synthetic'))
  Assert-Throws { Assert-PostgresServiceConfiguration -Text $unsafePass -ExpectedUsers $expectedUsers } 'credential'
  $unsafeUri = [string]::Join([Environment]::NewLine, @('[svc]','uri=postgresql://user:secret@localhost/db'))
  Assert-Throws { Assert-PostgresServiceConfiguration -Text $unsafeUri -ExpectedUsers $expectedUsers } 'credential'
  Assert-Throws { Assert-PostgresServiceConfiguration -Text ('[svc]'+[Environment]::NewLine+'dbname=postgresql://user:secret@localhost/db') -ExpectedUsers $expectedUsers } 'credential'
}
Test-Case 'canonical migration manifest matches files and all 018-026 entries' {
  Assert-True ($manifest.Count -eq 9) 'Expected exactly nine release migration entries.'
  Assert-True (($manifest.Version -join ',') -eq '18,19,20,21,22,23,24,25,26') 'Release migration versions are not exactly 018-026.'
  $migration026 = $manifest | Where-Object Version -eq 26
  Assert-True ($migration026.Checksum -eq '334f7b73ddc1c8d6ddcdafd547181f75fbeac85df713d4ba73995fb9c4d23b12') 'Migration 026 canonical checksum changed.'
  foreach ($row in $manifest) { Assert-True ($row.Checksum -match '^[a-f0-9]{64}$') "Invalid checksum for migration $($row.Version)." }
}
$preRows = @($manifest | Where-Object { $_.Version -le 25 } | ForEach-Object { [pscustomobject]@{ Version = $_.Version; Filename = $_.Filename; Checksum = $_.Checksum } })
$postRows = @($manifest | ForEach-Object { [pscustomobject]@{ Version = $_.Version; Filename = $_.Filename; Checksum = $_.Checksum } })
Test-Case 'pre-026 ledger accepts only the exact 018-025 release history' {
  Assert-ReleaseMigrationLedger -Rows $preRows -Manifest $manifest -SchemaMode 'PreMigration026'
  Assert-Throws { Assert-ReleaseMigrationLedger -Rows @($preRows | Where-Object Version -ne 24) -Manifest $manifest -SchemaMode 'PreMigration026' } 'missing'
  Assert-Throws { Assert-ReleaseMigrationLedger -Rows (@($preRows) + @($preRows[0])) -Manifest $manifest -SchemaMode 'PreMigration026' } 'duplicate'
  Assert-Throws { Assert-ReleaseMigrationLedger -Rows (@($preRows) + [pscustomobject]@{ Version = 27; Filename = '027_unexpected.sql'; Checksum = ('c' * 64) }) -Manifest $manifest -SchemaMode 'PreMigration026' } 'unexpected'
  $altered = @($preRows | ForEach-Object { if ($_.Version -eq 25) { [pscustomobject]@{ Version = $_.Version; Filename = $_.Filename; Checksum = ('0' * 64) } } else { $_ } })
  Assert-Throws { Assert-ReleaseMigrationLedger -Rows $altered -Manifest $manifest -SchemaMode 'PreMigration026' } 'checksum'
  $renamed = @($preRows | ForEach-Object { if ($_.Version -eq 25) { [pscustomobject]@{ Version = $_.Version; Filename = '025_wrong.sql'; Checksum = $_.Checksum } } else { $_ } })
  Assert-Throws { Assert-ReleaseMigrationLedger -Rows $renamed -Manifest $manifest -SchemaMode 'PreMigration026' } 'filename'
  $duplicateFilename = @($preRows | ForEach-Object { if ($_.Version -eq 25) { [pscustomobject]@{ Version=$_.Version; Filename=$preRows[0].Filename; Checksum=$_.Checksum } } else { $_ } })
  Assert-Throws { Assert-ReleaseMigrationLedger -Rows $duplicateFilename -Manifest $manifest -SchemaMode 'PreMigration026' } 'duplicate migration ledger filename'
  Assert-Throws { Assert-ReleaseMigrationLedger -Rows $postRows -Manifest $manifest -SchemaMode 'PreMigration026' } '026'
}
Test-Case 'post-026 ledger requires exact 018-026 history' {
  Assert-ReleaseMigrationLedger -Rows $postRows -Manifest $manifest -SchemaMode 'PostMigration026'
  Assert-Throws { Assert-ReleaseMigrationLedger -Rows @($postRows | Where-Object Version -ne 26) -Manifest $manifest -SchemaMode 'PostMigration026' } 'missing'
}
$expectedReceiptColumns = @(
  [pscustomobject]@{ Name='student_id'; Type='integer'; NotNull=$true; Default='' },
  [pscustomobject]@{ Name='learning_cycle_version'; Type='integer'; NotNull=$true; Default='' },
  [pscustomobject]@{ Name='save_commit_id_hash'; Type='text'; NotNull=$true; Default='' },
  [pscustomobject]@{ Name='payload_sha256'; Type='text'; NotNull=$true; Default='' },
  [pscustomobject]@{ Name='activity_event_key'; Type='text'; NotNull=$true; Default='' },
  [pscustomobject]@{ Name='response_status'; Type='smallint'; NotNull=$true; Default='201' },
  [pscustomobject]@{ Name='response_body'; Type='jsonb'; NotNull=$false; Default='' },
  [pscustomobject]@{ Name='created_at'; Type='timestamp with time zone'; NotNull=$true; Default='CURRENT_TIMESTAMP' },
  [pscustomobject]@{ Name='completed_at'; Type='timestamp with time zone'; NotNull=$false; Default='' }
)
$expectedReceiptConstraints = @(
  [pscustomobject]@{ Name='game_progress_save_commits_pkey'; Type='p'; Validated=$true; Enforced=$true; Deferrable=$false; Deferred=$false; NoInherit=$false; NullsNotDistinct=$false; Columns=@('student_id','learning_cycle_version','save_commit_id_hash'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; Definition='PRIMARY KEY (student_id, learning_cycle_version, save_commit_id_hash)' },
  [pscustomobject]@{ Name='game_progress_save_commits_activity_event_unique'; Type='u'; Validated=$true; Enforced=$true; Deferrable=$false; Deferred=$false; NoInherit=$false; NullsNotDistinct=$false; Columns=@('student_id','activity_event_key'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; Definition='UNIQUE (student_id, activity_event_key)' },
  [pscustomobject]@{ Name='game_progress_save_commits_student_id_fkey'; Type='f'; Validated=$true; Enforced=$true; Deferrable=$false; Deferred=$false; NoInherit=$false; NullsNotDistinct=$false; Columns=@('student_id'); ReferencedSchema='public'; ReferencedTable='accounts'; ReferencedColumns=@('id'); MatchType='SIMPLE'; UpdateAction='NO ACTION'; DeleteAction='CASCADE'; Definition='FOREIGN KEY (student_id) REFERENCES accounts(id) ON DELETE CASCADE' },
  [pscustomobject]@{ Name='game_progress_save_commits_learning_cycle_version_check'; Type='c'; Validated=$true; Enforced=$true; Deferrable=$false; Deferred=$false; NoInherit=$false; NullsNotDistinct=$false; Columns=@('learning_cycle_version'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; Definition='learning_cycle_version >= 0' },
  [pscustomobject]@{ Name='game_progress_save_commits_save_commit_id_hash_check'; Type='c'; Validated=$true; Enforced=$true; Deferrable=$false; Deferred=$false; NoInherit=$false; NullsNotDistinct=$false; Columns=@('save_commit_id_hash'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; Definition="save_commit_id_hash ~ '^[0-9a-f]{64}$'" },
  [pscustomobject]@{ Name='game_progress_save_commits_payload_sha256_check'; Type='c'; Validated=$true; Enforced=$true; Deferrable=$false; Deferred=$false; NoInherit=$false; NullsNotDistinct=$false; Columns=@('payload_sha256'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; Definition="payload_sha256 ~ '^[0-9a-f]{64}$'" },
  [pscustomobject]@{ Name='game_progress_save_commits_response_status_check'; Type='c'; Validated=$true; Enforced=$true; Deferrable=$false; Deferred=$false; NoInherit=$false; NullsNotDistinct=$false; Columns=@('response_status'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; Definition='response_status BETWEEN 200 AND 299' },
  [pscustomobject]@{ Name='game_progress_save_commits_completion_consistency'; Type='c'; Validated=$true; Enforced=$true; Deferrable=$false; Deferred=$false; NoInherit=$false; NullsNotDistinct=$false; Columns=@('response_body','completed_at'); ReferencedSchema=''; ReferencedTable=''; ReferencedColumns=@(); MatchType=''; UpdateAction=''; DeleteAction=''; Definition='response_body IS NULL = completed_at IS NULL' }
)
$completeReceipt = [pscustomobject]@{
  TableExists = $true; Relations = @('game_progress_save_commits','game_progress_save_commits_activity_event_unique','game_progress_save_commits_pkey'); Columns = $expectedReceiptColumns
  Constraints = $expectedReceiptConstraints
  Indexes = @('game_progress_save_commits_pkey','game_progress_save_commits_activity_event_unique')
  Triggers = @(); Types = @()
}
Test-Case 'pre-026 receipt state rejects every partial object' {
  Assert-ReceiptSchemaState -SchemaMode 'PreMigration026' -ReceiptState ([pscustomobject]@{ TableExists=$false; Relations=@(); Columns=@(); Constraints=@(); Indexes=@(); Triggers=@(); Types=@() })
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PreMigration026' -ReceiptState ([pscustomobject]@{ TableExists=$false; Relations=@(); Columns=@(); Constraints=@('game_progress_save_commits_pkey'); Indexes=@(); Triggers=@(); Types=@() }) } 'partial'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PreMigration026' -ReceiptState ([pscustomobject]@{ TableExists=$false; Relations=@('game_progress_save_commits_pkey'); Columns=@(); Constraints=@(); Indexes=@(); Triggers=@(); Types=@() }) } 'partial'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PreMigration026' -ReceiptState ([pscustomobject]@{ TableExists=$false; Relations=@('game_progress_save_commits_shadow'); Columns=@(); Constraints=@(); Indexes=@(); Triggers=@(); Types=@() }) } 'partial'
}
Test-Case 'post-026 receipt state requires exact columns, validated constraints, and indexes' {
  Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $completeReceipt
  $unexpectedRelation = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $unexpectedRelation.Relations += 'game_progress_save_commits_shadow'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $unexpectedRelation } 'relation set'
  $missingColumn = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $missingColumn.Columns = @($missingColumn.Columns | Where-Object Name -ne 'payload_sha256')
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $missingColumn } 'column'
  $badConstraint = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($badConstraint.Constraints | Where-Object Name -eq 'game_progress_save_commits_payload_sha256_check').Definition = 'payload_sha256 IS NOT NULL'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $badConstraint } 'constraint'
  $weakened = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($weakened.Constraints | Where-Object Name -eq 'game_progress_save_commits_payload_sha256_check').Definition = "(payload_sha256 ~ '^[0-9a-f]{64}$') OR TRUE"
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $weakened } 'constraint'
  $caseChangedRegex = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($caseChangedRegex.Constraints | Where-Object Name -eq 'game_progress_save_commits_save_commit_id_hash_check').Definition = "save_commit_id_hash ~ '^[0-9A-F]{64}$'"
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $caseChangedRegex } 'constraint'
  $spaceChangedRegex = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($spaceChangedRegex.Constraints | Where-Object Name -eq 'game_progress_save_commits_payload_sha256_check').Definition = "payload_sha256 ~ '^[0-9a-f]{ 64 }$'"
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $spaceChangedRegex } 'constraint'
  $wrongPrimaryKey = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $wrongPrimaryKeyConstraint = $wrongPrimaryKey.Constraints | Where-Object Name -eq 'game_progress_save_commits_pkey'
  $wrongPrimaryKeyConstraint.Columns = @('learning_cycle_version','student_id','save_commit_id_hash')
  $wrongPrimaryKeyConstraint.Definition = 'PRIMARY KEY (learning_cycle_version, student_id, save_commit_id_hash)'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $wrongPrimaryKey } 'constraint'
  $wrongUniqueKey = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $wrongUniqueConstraint = $wrongUniqueKey.Constraints | Where-Object Name -eq 'game_progress_save_commits_activity_event_unique'
  $wrongUniqueConstraint.Columns = @('student_id','learning_cycle_version','activity_event_key')
  $wrongUniqueConstraint.Definition = 'UNIQUE (student_id, learning_cycle_version, activity_event_key)'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $wrongUniqueKey } 'constraint'
  $wrongForeignKey = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($wrongForeignKey.Constraints | Where-Object Name -eq 'game_progress_save_commits_student_id_fkey').ReferencedTable = 'teacher_class_assignments'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $wrongForeignKey } 'constraint'
  $wrongForeignKeyMapping = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($wrongForeignKeyMapping.Constraints | Where-Object Name -eq 'game_progress_save_commits_student_id_fkey').Columns = @('learning_cycle_version')
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $wrongForeignKeyMapping } 'constraint'
  $wrongForeignKeyAction = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($wrongForeignKeyAction.Constraints | Where-Object Name -eq 'game_progress_save_commits_student_id_fkey').DeleteAction = 'SET NULL'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $wrongForeignKeyAction } 'constraint'
  $wrongForeignKeyUpdateAction = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($wrongForeignKeyUpdateAction.Constraints | Where-Object Name -eq 'game_progress_save_commits_student_id_fkey').UpdateAction = 'RESTRICT'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $wrongForeignKeyUpdateAction } 'constraint'
  $wrongForeignKeyMatch = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($wrongForeignKeyMatch.Constraints | Where-Object Name -eq 'game_progress_save_commits_student_id_fkey').MatchType = 'FULL'
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $wrongForeignKeyMatch } 'constraint'
  $nullsNotDistinct = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($nullsNotDistinct.Constraints | Where-Object Name -eq 'game_progress_save_commits_activity_event_unique').NullsNotDistinct = $true
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $nullsNotDistinct } 'NULL uniqueness mode'
  $deferrable = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($deferrable.Constraints | Where-Object Name -eq 'game_progress_save_commits_activity_event_unique').Deferrable = $true
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $deferrable } 'constraint'
  $unvalidated = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($unvalidated.Constraints | Where-Object Name -eq 'game_progress_save_commits_payload_sha256_check').Validated = $false
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $unvalidated } 'constraint'
  $noInherit = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($noInherit.Constraints | Where-Object Name -eq 'game_progress_save_commits_learning_cycle_version_check').NoInherit = $true
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $noInherit } 'constraint'
  $pg18Equivalent = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($pg18Equivalent.Constraints | Where-Object Name -eq 'game_progress_save_commits_response_status_check').Definition = 'response_status >= 200 AND response_status <= 299'
  Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $pg18Equivalent
  $unvalidated = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  ($unvalidated.Constraints | Where-Object Name -eq 'game_progress_save_commits_pkey').Validated = $false
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $unvalidated } 'constraint'
  $missingIndex = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $missingIndex.Indexes = @('game_progress_save_commits_pkey')
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $missingIndex } 'index'
  $unexpectedTrigger = $completeReceipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $unexpectedTrigger.Triggers = @('custom_receipt_trigger')
  Assert-Throws { Assert-ReceiptSchemaState -SchemaMode 'PostMigration026' -ReceiptState $unexpectedTrigger } 'trigger'
}
Test-Case 'aggregate manifests allow only table counts and matching source snapshot' {
  $sourceCounts = @{}
  foreach ($table in (Get-BackupAggregateTables -SchemaMode 'PreMigration026')) { $sourceCounts[$table] = '0' }
  $sourceManifest = [pscustomobject]@{ Version=1; SchemaMode='PreMigration026'; SourceCommit=('a' * 40); SnapshotId='00000003-0000001B-1'; ArchiveSha256=('b' * 64); Counts=$sourceCounts }
  $restoredCounts = @{} + $sourceCounts
  Assert-AggregateManifest -Manifest $sourceManifest -SchemaMode 'PreMigration026' -ExpectedSourceCommit ('a' * 40) -ExpectedArchiveSha256 ('b' * 64)
  Assert-AggregateCountsMatch -SourceManifest $sourceManifest -RestoredCounts $restoredCounts -SchemaMode 'PreMigration026'
  $restoredCounts['accounts'] = '1'
  Assert-Throws { Assert-AggregateCountsMatch -SourceManifest $sourceManifest -RestoredCounts $restoredCounts -SchemaMode 'PreMigration026' } 'count mismatch'
  $badSnapshot = $sourceManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $badSnapshot.SnapshotId = 'invalid; SELECT 1'
  Assert-Throws { Assert-AggregateManifest -Manifest $badSnapshot -SchemaMode 'PreMigration026' -ExpectedSourceCommit ('a' * 40) -ExpectedArchiveSha256 ('b' * 64) } 'snapshot'
  $badValue = @{} + $sourceCounts; $badValue['accounts'] = '12.5'
  Assert-Throws { Assert-AggregateCountsMatch -SourceManifest $sourceManifest -RestoredCounts $badValue -SchemaMode 'PreMigration026' } 'aggregate'
}
Test-Case 'restore target authenticates and executes as the dedicated role without SET ROLE' {
  $safeTarget = @('tq_restore_example','tq_restore_operator','tq_restore_operator','127.0.0.1','55432','0','0','0','0','t','f')
  Assert-IsolatedRestoreTarget -Fields $safeTarget -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432
  $badDatabase = @('production','tq_restore_operator','tq_restore_operator','127.0.0.1','55432','0','0','0','0','t','f')
  Assert-Throws { Assert-IsolatedRestoreTarget -Fields $badDatabase -ExpectedDatabase 'production' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432 } 'allowlist'
  $badAddress = @('tq_restore_example','tq_restore_operator','tq_restore_operator','192.0.2.10','55432','0','0','0','0','t','f')
  Assert-Throws { Assert-IsolatedRestoreTarget -Fields $badAddress -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '192.0.2.10' -ExpectedServerPort 55432 } 'loopback'
  $wrongLogin = @('tq_restore_example','postgres','tq_restore_operator','127.0.0.1','55432','0','0','0','0','t','f')
  Assert-Throws { Assert-IsolatedRestoreTarget -Fields $wrongLogin -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432 } 'session_user'
  $wrongEffectiveRole = @('tq_restore_example','tq_restore_operator','postgres','127.0.0.1','55432','0','0','0','0','t','f')
  Assert-Throws { Assert-IsolatedRestoreTarget -Fields $wrongEffectiveRole -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432 } 'current_user'
  $notEmpty = @('tq_restore_example','tq_restore_operator','tq_restore_operator','127.0.0.1','55432','1','0','0','0','t','f')
  Assert-Throws { Assert-IsolatedRestoreTarget -Fields $notEmpty -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432 } 'empty'
  $nonemptyCustomType = @('tq_restore_example','tq_restore_operator','tq_restore_operator','127.0.0.1','55432','0','0','1','0','t','f')
  Assert-Throws { Assert-IsolatedRestoreTarget -Fields $nonemptyCustomType -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432 } 'empty'
  $admin = @('tq_restore_example','postgres','postgres','127.0.0.1','55432','0','0','0','0','t','f')
  Assert-Throws { Assert-IsolatedRestoreTarget -Fields $admin -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432 } 'isolated non-admin'
}
Test-Case 'restored target identity must still be the exact loopback database owner before local preflight grants' {
  $restored = @('tq_restore_example','tq_restore_operator','tq_restore_operator','127.0.0.1','55432','18','4','6','0','t','f')
  Assert-IsolatedRestoreIdentity -Fields $restored -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432
  $wrongOwner = @('tq_restore_example','tq_restore_operator','tq_restore_operator','127.0.0.1','55432','18','4','6','0','f','f')
  Assert-Throws { Assert-IsolatedRestoreIdentity -Fields $wrongOwner -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '127.0.0.1' -ExpectedServerPort 55432 } 'database owner'
  Assert-Throws { Assert-IsolatedRestoreIdentity -Fields $restored -ExpectedDatabase 'tq_restore_example' -ExpectedServerAddress '192.0.2.10' -ExpectedServerPort 55432 } 'loopback'
}
Test-Case 'isolated restore grants only preflight ledger columns after restore success and before read-only verification' {
  $scriptNormalized = $rehearsalScript -replace "`r`n?", "`n"
  $restoreSuccess = $scriptNormalized.IndexOf('if($restoreExit -ne 0)', [StringComparison]::Ordinal)
  $prepareCall = [regex]::Match($scriptNormalized, '(?m)^    Invoke-RestorePreflightAccessPreparation\s*$')
  $prepareAccess = if ($prepareCall.Success) { $prepareCall.Index } else { -1 }
  $readOnlyVerify = $scriptNormalized.IndexOf('Invoke-SchemaAndLedgerValidation -ServiceName $RestorePreflightServiceName', $prepareAccess)
  Assert-True ($restoreSuccess -ge 0 -and $prepareAccess -gt $restoreSuccess -and $readOnlyVerify -gt $prepareAccess) 'Restore identity and ledger grants must occur only after successful restore and before the read-only preflight.'
  Assert-True ($rehearsalScript.Contains('REVOKE TEMP ON DATABASE $quotedDatabase FROM PUBLIC;')) 'Restored preflight role must not inherit PUBLIC TEMP on the isolated target.'
  Assert-True ($rehearsalScript.Contains('GRANT USAGE ON SCHEMA public TO $preflightRole;')) 'Preflight role requires explicit public-schema USAGE on the isolated target.'
  Assert-True ($rehearsalScript.Contains('GRANT SELECT (version, filename, checksum) ON TABLE public.schema_migrations TO $preflightRole;')) 'Preflight role must receive only the three required ledger columns.'
  Assert-True ($rehearsalScript -notmatch '(?i)GRANT\s+SELECT\s+ON\s+ALL\s+TABLES|GRANT\s+ALL\s+ON\s+SCHEMA|GRANT\s+SELECT\s+ON\s+public\.') 'Restore must not grant application-row access to the preflight role.'
  Assert-True ($rehearsalScript.Contains('if($dumpExit -ne 0){throw')) 'A failing pg_dump must leave a partial artifact and stop before finalization.'
  Assert-True ($rehearsalScript.Contains('if($restoreExit -ne 0){throw')) 'A failing pg_restore must stop before applying local preflight grants or claiming readiness.'
}

Test-Case 'backup storage path requires a non-reparse restricted ACL and independently checked encryption evidence' {
  if (-not $IsWindows) { throw 'Windows ACL and BitLocker evidence tests require a Windows PowerShell host.' }
  $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
  $testRoot = Join-Path $tempRoot ("tq-backup-storage-test-$PID")
  $evidencePath = Join-Path $tempRoot ("tq-bitlocker-evidence-$PID.json")
  $junctionPath = Join-Path $tempRoot ("tq-backup-storage-junction-$PID")
  try {
    New-Item -ItemType Directory -Path $testRoot -ErrorAction Stop | Out-Null
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($currentSid)
    $principals = @($currentSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in $principals) {
      $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    Test-RestrictedStorageAclDescriptor -Acl $acl -CurrentUserSid $currentSid.Value
    $realAclSupported = $true
    try {
      Set-Acl -LiteralPath $testRoot -AclObject $acl -ErrorAction Stop
      Assert-RestrictedStorageAcl -Path $testRoot
    } catch {
      $observedAcl = Get-Acl -LiteralPath $testRoot -ErrorAction Stop
      $managedAppContainerAce = @($observedAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.IsInherited -and $_.IdentityReference.Value -match '^S-1-15-[23]-' }).Count -gt 0
      if ($env:GITHUB_ACTIONS -eq 'true' -or -not $managedAppContainerAce) { throw }
      $realAclSupported = $false
      $script:skipped++
      Write-Output 'SKIP local OS ACL mutation: Codex managed AppContainer ACEs remain inherited by the temp directory; Windows CI must execute the real ACL test without skipping.'
    }
    if ($realAclSupported) {
      $unsafeAcl = Get-Acl -LiteralPath $testRoot -ErrorAction Stop
      $unsafeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))
      Set-Acl -LiteralPath $testRoot -AclObject $unsafeAcl -ErrorAction Stop
      Assert-Throws { Assert-RestrictedStorageAcl -Path $testRoot } 'unapproved identity'
      Set-Acl -LiteralPath $testRoot -AclObject $acl -ErrorAction Stop
      $aclProbe = Join-Path $testRoot 'acl-probe.txt'
      [System.IO.File]::WriteAllText($aclProbe, 'synthetic acl probe', [System.Text.UTF8Encoding]::new($false))
      $fileAcl = [Security.AccessControl.FileSecurity]::new()
      $fileAcl.SetAccessRuleProtection($true, $false)
      $fileAcl.SetOwner($currentSid)
      foreach ($sid in $principals) {
        $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
      }
      Set-Acl -LiteralPath $aclProbe -AclObject $fileAcl -ErrorAction Stop
      Assert-RestrictedStorageAcl -Path $aclProbe
    }
    $broadAcl = [Security.AccessControl.DirectorySecurity]::new()
    $broadAcl.SetOwner($currentSid)
    $broadAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))
    Assert-Throws { Test-RestrictedStorageAclDescriptor -Acl $broadAcl -CurrentUserSid $currentSid.Value } 'unapproved identity'
    $volumeRoot = [System.IO.Path]::GetPathRoot($testRoot)
    $evidence = [ordered]@{ Version=1; VolumeRoot=$volumeRoot; Provider='BitLocker'; VolumeStatus='FullyEncrypted'; ProtectionStatus='On'; EncryptionPercentage=100; VerifiedAt='2026-11-21T00:00:00Z'; VerifiedBy='synthetic-test'; VerificationReference='SYNTHETIC-TEST-01'; SourceCommand='manage-bde -status' }
    [System.IO.File]::WriteAllText($evidencePath, ($evidence | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    $evidenceHash = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash
    Assert-EncryptionEvidence -Path $testRoot -EvidencePath $evidencePath -ExpectedEvidenceSha256 $evidenceHash -EvidenceReference 'SYNTHETIC-TEST-01' -AutomaticEncryptionStatus $null
    Assert-Throws { Assert-EncryptionEvidence -Path $testRoot -EvidencePath $evidencePath -ExpectedEvidenceSha256 ('0' * 64) -EvidenceReference 'SYNTHETIC-TEST-01' -AutomaticEncryptionStatus $null } 'digest'
    Assert-Throws { Assert-EncryptionEvidence -Path $testRoot -EvidencePath '' -ExpectedEvidenceSha256 '' -EvidenceReference '' -AutomaticEncryptionStatus $null } 'encryption evidence'
    $wrongVolume = $evidence | ConvertTo-Json -Compress | ConvertFrom-Json
    $wrongVolume.VolumeRoot = 'Z:\\'
    [System.IO.File]::WriteAllText($evidencePath, ($wrongVolume | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    $wrongVolumeHash = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash
    Assert-Throws { Assert-EncryptionEvidence -Path $testRoot -EvidencePath $evidencePath -ExpectedEvidenceSha256 $wrongVolumeHash -EvidenceReference 'SYNTHETIC-TEST-01' -AutomaticEncryptionStatus $null } 'attestation'
    $autoStatus = [pscustomobject]@{ MountPoint=$volumeRoot; VolumeStatus='FullyEncrypted'; ProtectionStatus='On'; EncryptionPercentage=100 }
    Assert-EncryptionEvidence -Path $testRoot -EvidencePath '' -ExpectedEvidenceSha256 '' -EvidenceReference '' -AutomaticEncryptionStatus $autoStatus
    $autoOff = [pscustomobject]@{ MountPoint=$volumeRoot; VolumeStatus='FullyEncrypted'; ProtectionStatus='Off'; EncryptionPercentage=100 }
    Assert-Throws { Assert-EncryptionEvidence -Path $testRoot -EvidencePath $evidencePath -ExpectedEvidenceSha256 $wrongVolumeHash -EvidenceReference 'SYNTHETIC-TEST-01' -AutomaticEncryptionStatus $autoOff } 'fully encrypted'
    Assert-Throws { Assert-BackupStorageDirectory -Path $testRoot -RepositoryRoot $backend -TemporaryRoots @($tempRoot) -EncryptionEvidencePath $evidencePath -ExpectedEncryptionEvidenceSha256 $wrongVolumeHash -EncryptionEvidenceReference 'SYNTHETIC-TEST-01' -AutomaticEncryptionStatus $autoStatus } 'temporary'
    Assert-Throws { Assert-BackupStorageDirectory -Path $backend -RepositoryRoot $backend -TemporaryRoots @() -EncryptionEvidencePath $evidencePath -ExpectedEncryptionEvidenceSha256 $wrongVolumeHash -EncryptionEvidenceReference 'SYNTHETIC-TEST-01' -AutomaticEncryptionStatus $autoStatus } 'repository'
    [void](Assert-NoReparsePointPath -Path $testRoot)
    Assert-Throws { Assert-NoReparsePointAttributes -Attributes ([System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint) } 'reparse'
    if ($realAclSupported) {
      New-Item -ItemType Junction -Path $junctionPath -Target $testRoot -ErrorAction Stop | Out-Null
      $junctionItem = Get-Item -LiteralPath $junctionPath -Force -ErrorAction Stop
      Assert-True (($junctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) 'Windows junction must carry the reparse-point attribute.'
      Assert-Throws { [void](Assert-NoReparsePointPath -Path (Join-Path $junctionPath 'child')) } 'reparse'
    } elseif ($env:GITHUB_ACTIONS -eq 'true') {
      throw 'Windows CI must execute an actual NTFS junction test; local sandbox skip is not allowed in CI.'
    } else {
      $script:skipped++
      Write-Output 'SKIP local NTFS junction creation: use the separate Windows CI job for real reparse-point coverage.'
    }
  }
  finally {
    if (Test-Path -LiteralPath $junctionPath) { try { [System.IO.Directory]::Delete($junctionPath, $false) } catch { Write-Warning 'Could not remove the test junction; it may require operator cleanup.' } }
    if (Test-Path -LiteralPath $evidencePath) { Remove-Item -LiteralPath $evidencePath -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Force -Recurse -ErrorAction SilentlyContinue }
  }
}

Test-Case 'completion manifest requires exact finalized backup artifact names and hashes' {
  $archive = 'C:\synthetic\backup.dump'
  $aggregate = "$archive.aggregates.json"
  $manifest = [pscustomobject]@{ Version=1; SchemaMode='PreMigration026'; SourceCommit=('a' * 40); SnapshotId='00000003-0000001B-1'; ArchiveName='backup.dump'; ArchiveSha256=('b' * 64); TocName='backup.dump.toc.txt'; TocSha256=('c' * 64); AggregateManifestName='backup.dump.aggregates.json'; AggregateManifestSha256=('d' * 64); HashFileName='backup.dump.sha256.txt'; HashFileSha256=('e' * 64) }
  Assert-BackupCompletionManifest -Manifest $manifest -ArchivePath $archive -AggregateManifestPath $aggregate -ExpectedSourceCommit ('a' * 40) -SchemaMode 'PreMigration026' -ExpectedArchiveSha256 ('b' * 64) -ExpectedAggregateManifestSha256 ('d' * 64)
  $partial = $manifest | ConvertTo-Json -Depth 4 | ConvertFrom-Json
  $partial.ArchiveName = 'backup.dump.partial'
  Assert-Throws { Assert-BackupCompletionManifest -Manifest $partial -ArchivePath $archive -AggregateManifestPath $aggregate -ExpectedSourceCommit ('a' * 40) -SchemaMode 'PreMigration026' -ExpectedArchiveSha256 ('b' * 64) -ExpectedAggregateManifestSha256 ('d' * 64) } 'complete'
}
Test-Case 'aggregate SQL is static, read-only, and cannot select row-level data' {
  $sourceSql = New-BackupAggregateSql -SchemaMode 'PreMigration026' -ImportSnapshot -SnapshotId '00000003-0000001B-1'
  $restoreSql = New-BackupAggregateSql -SchemaMode 'PreMigration026'
  Assert-True ($sourceSql -match "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'") 'Source query must import the exported snapshot.'
  Assert-True ($sourceSql -match 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') 'Source query must be read-only and snapshot consistent.'
  Assert-True ($sourceSql -match 'COUNT\(\*\)') 'Aggregate query must only return table counts.'
  Assert-True ($sourceSql -notmatch '(?i)SELECT\s+\*|student_id|student_name|question_text|answer_text|email') 'Aggregate query contains row-level fields.'
  Assert-True ($restoreSql -match 'BEGIN READ ONLY') 'Restore aggregate query must be read-only.'
}
Test-Case 'aggregate parser rejects unexpected rows and accepts fixed allowlist output' {
  $tables = @(Get-BackupAggregateTables -SchemaMode 'PostMigration026')
  $output = @($tables | ForEach-Object { "$_|0" })
  $counts = @(ConvertFrom-BackupAggregateOutput -Lines $output -SchemaMode 'PostMigration026')
  Assert-True ($counts.Count -eq 18) 'Post-026 aggregate output must contain exactly 18 tables.'
  Assert-Throws { ConvertFrom-BackupAggregateOutput -Lines @($output | Select-Object -First 17) -SchemaMode 'PostMigration026' } 'missing'
  Assert-Throws { ConvertFrom-BackupAggregateOutput -Lines (@($output) + 'accounts|0') -SchemaMode 'PostMigration026' } 'duplicate'
  Assert-Throws { ConvertFrom-BackupAggregateOutput -Lines (@($output) + 'unexpected|0') -SchemaMode 'PostMigration026' } 'unexpected'
}
Write-Output "PASS total=$script:passed skipped=$script:skipped"
