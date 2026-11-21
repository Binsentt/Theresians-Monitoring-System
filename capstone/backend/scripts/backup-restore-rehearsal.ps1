[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('CreateProductionBackup','RestoreIsolated')][string]$Action,
  [Parameter(Mandatory=$true)][ValidateSet('PreMigration026','PostMigration026')][string]$SchemaMode,
  [Parameter(Mandatory=$true)][string]$ExpectedDatabase,
  [Parameter(Mandatory=$true)][string]$ExpectedServerAddress,
  [Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$ExpectedServerPort,
  [Parameter(Mandatory=$true)][string]$ExpectedSourceCommit,
  [Parameter(Mandatory=$true)][string]$ApprovalReference,
  [Parameter(Mandatory=$true)][string]$ServiceFilePath,
  [string]$BackupDirectory,
  [string]$SnapshotId,
  [string]$ArchivePath,
  [string]$AggregateManifestPath,
  [string]$ExpectedArchiveSha256,
  [string]$ExpectedAggregateManifestSha256,
  [string]$ExpectedCompletionManifestSha256,
  [string]$EncryptionEvidencePath,
  [string]$ExpectedEncryptionEvidenceSha256,
  [string]$EncryptionEvidenceReference,
  [string]$BackupServiceName='tq_prod_backup',
  [string]$ProductionPreflightServiceName='tq_prod_preflight',
  [string]$RestoreServiceName='tq_restore_local',
  [string]$RestorePreflightServiceName='tq_restore_preflight',
  [switch]$ExecuteApprovedProductionBackup,
  [switch]$ExecuteIsolatedRestore,
  [string]$PsqlPath=(Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'),
  [string]$PgDumpPath=(Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\pg_dump.exe'),
  [string]$PgRestorePath=(Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\pg_restore.exe')
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'backupRestoreRehearsal.validation.psm1') -Force -ErrorAction Stop

$backupRole='tq_prod_backup_reader'
$preflightRole='tq_release_preflight_reader'
$restoreRole='tq_restore_operator'
$roleAuditSql=Join-Path $PSScriptRoot 'release-preflight-role-audit.sql'
$readinessSql=if($SchemaMode -eq 'PreMigration026'){Join-Path $PSScriptRoot 'release-migration-026-prerequisite-preflight.sql'}else{Join-Path $PSScriptRoot 'release-migration-preflight.sql'}
$backendRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot=(& git -C $backendRoot rev-parse --show-toplevel 2>$null).Trim()
if($LASTEXITCODE -ne 0 -or -not $repositoryRoot){throw 'STOP: utility must run from the reviewed Git worktree.'}
$repositoryRoot=[System.IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\')

function Resolve-PathOutsideRepository([string]$PathValue,[string]$Label){
  if(-not $PathValue){throw "STOP: $Label path is required."}
  $lexicalPath=[System.IO.Path]::GetFullPath($PathValue)
  [void](Assert-NoReparsePointPath -Path $lexicalPath)
  $resolved=(Resolve-Path -LiteralPath $PathValue).Path
  $full=[System.IO.Path]::GetFullPath($resolved).TrimEnd('\')
  if($full.Equals($repositoryRoot,[System.StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($repositoryRoot+'\',[System.StringComparison]::OrdinalIgnoreCase)){throw "STOP: $Label must remain outside the repository."}
  return $full
}
function Assert-StoragePath([string]$PathValue,[string]$Label){
  if(-not $PathValue){throw "STOP: $Label path is required."}
  $full=[System.IO.Path]::GetFullPath($PathValue)
  $directory=if(Test-Path -LiteralPath $full -PathType Container){$full}else{[System.IO.Path]::GetDirectoryName($full)}
  $automaticStatus=$null
  $bitLockerCommand=Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue
  if($bitLockerCommand){
    $mountPoint=[System.IO.Path]::GetPathRoot($directory).TrimEnd('\')
    try{
      $volumes=@(Get-BitLockerVolume -MountPoint $mountPoint -ErrorAction Stop)
      if($volumes.Count -gt 1){throw 'STOP: more than one BitLocker volume matched the approved storage path.'}
      if($volumes.Count -eq 1){$automaticStatus=$volumes[0]}
    }catch{
      if($_.Exception.Message -like 'STOP:*'){throw}
      $automaticStatus=$null
    }
  }
  [void](Assert-BackupStorageDirectory -Path $directory -RepositoryRoot $repositoryRoot -TemporaryRoots @($env:TEMP,$env:TMP,$env:RUNNER_TEMP) -EncryptionEvidencePath $EncryptionEvidencePath -ExpectedEncryptionEvidenceSha256 $ExpectedEncryptionEvidenceSha256 -EncryptionEvidenceReference $EncryptionEvidenceReference -AutomaticEncryptionStatus $automaticStatus)
  [void](Assert-NoReparsePointPath -Path $full)
  if(Test-Path -LiteralPath $full -PathType Leaf){Assert-RestrictedStorageAcl -Path $full}
  return $full
}
function Assert-ServiceAlias([string]$Text,[string]$Alias){
  $pattern='(?im)^\s*\['+[regex]::Escape($Alias)+'\]\s*$'
  if([regex]::Matches($Text,$pattern).Count -ne 1){throw "STOP: service file must define exactly one [$Alias] alias."}
}
function Invoke-PsqlScript([string]$ServiceName,[string]$SqlPath,[string]$Role){
  $nativeArgs=@('--dbname',"service=$ServiceName",'-X','-q','-v','ON_ERROR_STOP=1','-v',"expected_database=$ExpectedDatabase",'-v',"expected_role=$Role",'-v',"expected_server_address=$ExpectedServerAddress",'-v',"expected_server_port=$ExpectedServerPort",'--password','-f',$SqlPath)
  $null=& $PsqlPath @nativeArgs
  if($LASTEXITCODE -ne 0){throw 'STOP: selected read-only release schema preflight failed.'}
}
function Invoke-PsqlRows([string]$ServiceName,[string]$Sql){
  $nativeArgs=@('--dbname',"service=$ServiceName",'-X','-q','-A','-t','-F','|','-v','ON_ERROR_STOP=1','--password')
  $nativeArgs+=@('--command',$Sql)
  $output=@(& $PsqlPath @nativeArgs)
  if($LASTEXITCODE -ne 0){throw 'STOP: read-only metadata or aggregate query failed.'}
  return $output
}
function Get-ReleaseLedgerRows([string]$ServiceName){
  $sql='SELECT version, filename, BTRIM(checksum) FROM public.schema_migrations WHERE version >= 18 ORDER BY version;'
  $lines=@(Invoke-PsqlRows $ServiceName $sql)
  $rows=[System.Collections.Generic.List[object]]::new()
  foreach($line in $lines){
    if([string]::IsNullOrWhiteSpace([string]$line)){continue}
    $fields=([string]$line).Trim().Split('|')
    if($fields.Count -ne 3){throw 'STOP: migration ledger output is malformed.'}
    $rows.Add([pscustomobject]@{Version=$fields[0];Filename=$fields[1];Checksum=$fields[2]})
  }
  return $rows.ToArray()
}
function Get-ReceiptMetadata([string]$ServiceName){
  $sql=@'
SELECT jsonb_build_object(
 'TableExists', EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='game_progress_save_commits' AND c.relkind IN ('r','p')),
 'Relations', COALESCE((SELECT jsonb_agg(c.relname ORDER BY c.relname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'game_progress_save_commits%'), '[]'::jsonb),
 'Columns', COALESCE((SELECT jsonb_agg(jsonb_build_object('Name',a.attname,'Type',pg_catalog.format_type(a.atttypid,a.atttypmod),'NotNull',a.attnotnull,'Default',COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'')) ORDER BY a.attnum) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relname='game_progress_save_commits' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped), '[]'::jsonb),
 'Constraints', COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'Name',con.conname,'Type',con.contype::text,'Validated',con.convalidated,'Deferrable',con.condeferrable,
   'Deferred',con.condeferred,'NoInherit',con.connoinherit,
   'Enforced',COALESCE((pg_catalog.to_jsonb(con)->>'conenforced')::boolean,true),
   'NullsNotDistinct',COALESCE((pg_catalog.to_jsonb(con)->>'connullsnotdistinct')::boolean,false),
   'Definition',pg_catalog.pg_get_expr(con.conbin,con.conrelid),
   'Columns',COALESCE((SELECT jsonb_agg(key_attribute.attname ORDER BY key_column.ordinality)
     FROM unnest(con.conkey) WITH ORDINALITY AS key_column(attnum,ordinality)
     JOIN pg_catalog.pg_attribute key_attribute ON key_attribute.attrelid=con.conrelid AND key_attribute.attnum=key_column.attnum),'[]'::jsonb),
   'ReferencedSchema',COALESCE(referenced_namespace.nspname,''),'ReferencedTable',COALESCE(referenced_class.relname,''),
   'ReferencedColumns',COALESCE((SELECT jsonb_agg(reference_attribute.attname ORDER BY reference_column.ordinality)
     FROM unnest(con.confkey) WITH ORDINALITY AS reference_column(attnum,ordinality)
     JOIN pg_catalog.pg_attribute reference_attribute ON reference_attribute.attrelid=con.confrelid AND reference_attribute.attnum=reference_column.attnum),'[]'::jsonb),
   'MatchType',CASE con.confmatchtype WHEN 'f' THEN 'FULL' WHEN 'p' THEN 'PARTIAL' WHEN 's' THEN 'SIMPLE' ELSE '' END,
   'UpdateAction',CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE '' END,
   'DeleteAction',CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE '' END
 ) ORDER BY con.conname)
   FROM pg_catalog.pg_constraint con
   JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   LEFT JOIN pg_catalog.pg_class referenced_class ON referenced_class.oid=con.confrelid
   LEFT JOIN pg_catalog.pg_namespace referenced_namespace ON referenced_namespace.oid=referenced_class.relnamespace
   WHERE n.nspname='public' AND c.relname='game_progress_save_commits'), '[]'::jsonb),
 'Indexes', COALESCE((SELECT jsonb_agg(index_class.relname ORDER BY index_class.relname) FROM pg_catalog.pg_index idx JOIN pg_catalog.pg_class table_class ON table_class.oid=idx.indrelid JOIN pg_catalog.pg_class index_class ON index_class.oid=idx.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=table_class.relnamespace WHERE n.nspname='public' AND table_class.relname='game_progress_save_commits'), '[]'::jsonb),
 'Triggers', COALESCE((SELECT jsonb_agg(t.tgname ORDER BY t.tgname) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND (t.tgname LIKE 'game_progress_save_commits%' OR c.relname='game_progress_save_commits')), '[]'::jsonb),
 'Types', COALESCE((SELECT jsonb_agg(t.typname ORDER BY t.typname) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname LIKE 'game_progress_save_commits%' AND t.typrelid=0), '[]'::jsonb)
)::text;
'@
  $lines=@(Invoke-PsqlRows $ServiceName $sql)
  if($lines.Count -ne 1){throw 'STOP: receipt schema metadata query did not return one aggregate JSON row.'}
  try{return ($lines[0]|ConvertFrom-Json -ErrorAction Stop)}catch{throw 'STOP: receipt schema metadata JSON is invalid.'}
}
function Invoke-SchemaAndLedgerValidation([string]$ServiceName){
  Invoke-PsqlScript -ServiceName $ServiceName -SqlPath $roleAuditSql -Role $preflightRole
  Invoke-PsqlScript -ServiceName $ServiceName -SqlPath $readinessSql -Role $preflightRole
  $manifest=@(Get-ExpectedReleaseMigrationManifest -MigrationDirectory (Join-Path $backendRoot 'migrations') -PreflightSqlPath (Join-Path $PSScriptRoot 'release-migration-preflight.sql'))
  $rows=@(Get-ReleaseLedgerRows -ServiceName $ServiceName)
  Assert-ReleaseMigrationLedger -Rows $rows -Manifest $manifest -SchemaMode $SchemaMode
  $receipt=Get-ReceiptMetadata -ServiceName $ServiceName
  Assert-ReceiptSchemaState -SchemaMode $SchemaMode -ReceiptState $receipt
}
function Get-AggregateCounts([string]$ServiceName,[switch]$ImportSnapshot){
  $sql=New-BackupAggregateSql -SchemaMode $SchemaMode -ImportSnapshot:$ImportSnapshot -SnapshotId $SnapshotId
  $lines=@(Invoke-PsqlRows -ServiceName $ServiceName -Sql $sql)
  $rows=@(ConvertFrom-BackupAggregateOutput -Lines $lines -SchemaMode $SchemaMode)
  $counts=[ordered]@{}
  foreach($row in $rows){$counts[$row.TableName]=$row.RowCount}
  return $counts
}
function Get-TargetMetadata([string]$ServiceName){
  $sql=@'
BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
SELECT current_database(),session_user,current_user,COALESCE(host(inet_server_addr()),''),inet_server_port(),
 (SELECT COUNT(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p','v','m','f','S')),
 (SELECT COUNT(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'),
 (SELECT COUNT(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND t.typrelid=0),
 (SELECT COUNT(*) FROM pg_catalog.pg_namespace n WHERE n.nspname<>'public' AND n.nspname<>'information_schema' AND n.nspname !~ '^pg_'),
 (SELECT pg_catalog.pg_get_userbyid(database_record.datdba) = current_user FROM pg_catalog.pg_database AS database_record WHERE database_record.datname = current_database())
   AND COALESCE(has_schema_privilege(current_user,'public','CREATE'),false),
 COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=role_row.oid) FROM pg_catalog.pg_roles role_row WHERE role_row.rolname=current_user),true);
ROLLBACK;
'@
  $lines=@(Invoke-PsqlRows -ServiceName $ServiceName -Sql $sql)
  if($lines.Count -ne 1){throw 'STOP: isolated restore target identity query did not return one row.'}
  $fields=([string]$lines[0]).Trim().Split('|')
  if($fields.Count -ne 11){throw 'STOP: isolated restore target identity row is malformed.'}
  return $fields
}
function Invoke-RestorePreflightAccessPreparation {
  $target = @(Get-TargetMetadata -ServiceName $RestoreServiceName)
  Assert-IsolatedRestoreIdentity -Fields $target -ExpectedDatabase $ExpectedDatabase -ExpectedServerAddress $ExpectedServerAddress -ExpectedServerPort $ExpectedServerPort
  $previousOptions = $env:PGOPTIONS
  try {
    $env:PGOPTIONS='-c statement_timeout=10000 -c lock_timeout=2000'
    $quotedDatabase='"' + $ExpectedDatabase + '"'
    $sql=@"
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
REVOKE TEMP ON DATABASE $quotedDatabase FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $preflightRole;
GRANT SELECT (version, filename, checksum) ON TABLE public.schema_migrations TO $preflightRole;
COMMIT;
"@
    [void](Invoke-PsqlRows -ServiceName $RestoreServiceName -Sql $sql)
  } finally {
    if($null -eq $previousOptions){Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue}else{$env:PGOPTIONS=$previousOptions}
  }
}

$actualHead=(& git -C $repositoryRoot rev-parse HEAD 2>$null).Trim()
$headExit=$LASTEXITCODE
Assert-ApprovedRecoverySource -ExpectedSourceCommit $ExpectedSourceCommit -ApprovalReference $ApprovalReference -ActualSourceCommit $actualHead
if($headExit -ne 0){throw 'STOP: source commit could not be verified.'}
$reviewedInputs=@(
 'capstone/backend/releaseMigrations.js','capstone/backend/database/startupSchemaReadiness.js',
 'capstone/backend/scripts/backup-restore-rehearsal.ps1','capstone/backend/scripts/backupRestoreRehearsal.validation.psm1',
 'capstone/backend/scripts/backupRestoreRehearsal.validation.test.ps1','capstone/backend/scripts/backup-role-preflight.sql',
 'capstone/backend/scripts/release-preflight-role-audit.sql','capstone/backend/scripts/release-migration-preflight.sql','capstone/backend/scripts/release-migration-026-prerequisite-preflight.sql',
 'capstone/backend/migrations'
)
$sourceStatus=@(& git -C $repositoryRoot status --porcelain --untracked-files=all -- $reviewedInputs 2>$null)
if($LASTEXITCODE -ne 0 -or $sourceStatus.Count -gt 0){throw 'STOP: backup/preflight files or migrations are modified/untracked; use a clean reviewed release commit.'}
if($BackupServiceName -cne 'tq_prod_backup' -or $ProductionPreflightServiceName -cne 'tq_prod_preflight' -or $RestoreServiceName -cne 'tq_restore_local' -or $RestorePreflightServiceName -cne 'tq_restore_preflight'){throw 'STOP: PostgreSQL service aliases do not match the reviewed fixed contract.'}
if($ExpectedDatabase -notmatch '^[A-Za-z0-9_.-]{1,63}$'){throw 'STOP: expected database name is invalid.'}
try{$expectedAddress=[System.Net.IPAddress]::Parse($ExpectedServerAddress)}catch{throw 'STOP: expected server address must be a literal IP.'}
if($expectedAddress.ToString() -cne $ExpectedServerAddress){throw 'STOP: expected server address is not canonical.'}
$present=@{}
foreach($name in @('PGPASSWORD','PGPASSFILE','PGHOST','PGPORT','PGUSER','PGDATABASE','PGSERVICE','PGOPTIONS')){if(Test-Path "Env:$name"){$present[$name]='present'}}
Assert-InteractiveAuthenticationEnvironment -EnvironmentVariables $present
foreach($name in @('PGHOST','PGPORT','PGUSER','PGDATABASE','PGSERVICE')){if($present.ContainsKey($name)){throw "STOP: ambient $name may override the reviewed service alias."}}
$serviceFile=Resolve-PathOutsideRepository $ServiceFilePath 'PGSERVICEFILE'
[void](Assert-NoReparsePointPath -Path $serviceFile)
Assert-RestrictedStorageAcl -Path $serviceFile
$serviceText=[System.IO.File]::ReadAllText($serviceFile)
Assert-PostgresServiceConfiguration -Text $serviceText -ExpectedUsers ([ordered]@{
  $BackupServiceName=$backupRole
  $ProductionPreflightServiceName=$preflightRole
  $RestoreServiceName=$restoreRole
  $RestorePreflightServiceName=$preflightRole
})
foreach($alias in @($BackupServiceName,$ProductionPreflightServiceName,$RestoreServiceName,$RestorePreflightServiceName)){Assert-ServiceAlias -Text $serviceText -Alias $alias}
foreach($tool in @($PsqlPath,$PgDumpPath,$PgRestorePath)){if(-not(Test-Path -LiteralPath $tool -PathType Leaf)){throw 'STOP: PostgreSQL 18 client tools are required.'}}
if(-not(Test-Path -LiteralPath $readinessSql -PathType Leaf) -or -not(Test-Path -LiteralPath $roleAuditSql -PathType Leaf)){throw 'STOP: selected read-only schema or least-privilege role preflight SQL is missing.'}

$previousServiceFile=$env:PGSERVICEFILE
$previousPgOptions=$env:PGOPTIONS
try{
  $env:PGSERVICEFILE=$serviceFile
  $env:PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'
  if($Action -eq 'CreateProductionBackup'){
    if(-not $ExecuteApprovedProductionBackup){throw 'STOP: explicit backup execution approval switch is required.'}
    if(-not(Test-Path -LiteralPath $BackupDirectory -PathType Container)){throw 'STOP: approved encrypted backup directory must already exist.'}
    if($SnapshotId -notmatch '^[A-Fa-f0-9]+-[A-Fa-f0-9]+-\d+$'){throw 'STOP: valid exported snapshot ID required; keep its source transaction open until backup and aggregate capture finish.'}
    $destination=Assert-StoragePath $BackupDirectory 'backup destination'
    Invoke-SchemaAndLedgerValidation -ServiceName $ProductionPreflightServiceName
    $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
    $archive=Join-Path $destination "theresians-production-$stamp.dump"
    $partial="$archive.partial"
    $tocPartial="$partial.toc.txt"
    $tocFinal="$archive.toc.txt"
    $manifestPartial="$archive.aggregates.json.partial"
    $manifestPath="$archive.aggregates.json"
    $hashPath="$archive.sha256.txt"
    $hashPartial="$hashPath.partial"
    $completionPartial="$archive.complete.json.partial"
    $completionPath="$archive.complete.json"
    foreach($path in @($archive,$partial,$tocPartial,$tocFinal,$manifestPartial,$manifestPath,$hashPartial,$hashPath,$completionPartial,$completionPath)){if(Test-Path -LiteralPath $path){throw 'STOP: refusing to overwrite an existing backup artifact.'}}
    Invoke-PsqlScript -ServiceName $BackupServiceName -SqlPath (Join-Path $PSScriptRoot 'backup-role-preflight.sql') -Role $backupRole
    $env:PGOPTIONS='-c default_transaction_read_only=on -c lock_timeout=2000'
    $dumpArgs=@('--password','--format=custom','--compress=6','--lock-wait-timeout=5s',"--snapshot=$SnapshotId","--file=$partial","--dbname=service=$BackupServiceName")
    & $PgDumpPath @dumpArgs
    $dumpExit=$LASTEXITCODE
    if($dumpExit -ne 0){throw "STOP: pg_dump failed with exit code $dumpExit; incomplete output remains marked .partial."}
    & $PgRestorePath '--list' $partial 1> $tocPartial
    if($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $tocPartial).Length -eq 0){throw 'STOP: custom archive TOC validation failed.'}
    $digest=(Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourceCounts=Get-AggregateCounts -ServiceName $BackupServiceName -ImportSnapshot
    $manifest=[ordered]@{Version=1;SchemaMode=$SchemaMode;SourceCommit=$ExpectedSourceCommit.ToLowerInvariant();SnapshotId=$SnapshotId;ArchiveSha256=$digest;Counts=$sourceCounts}
    [void](ConvertTo-StrictAggregateMap -Counts $sourceCounts -AllowedTables @(Get-BackupAggregateTables -SchemaMode $SchemaMode))
    [System.IO.File]::WriteAllText($manifestPartial,($manifest|ConvertTo-Json -Depth 5),[System.Text.UTF8Encoding]::new($false))
    $aggregateDigest=(Get-FileHash -LiteralPath $manifestPartial -Algorithm SHA256).Hash.ToLowerInvariant()
    $tocDigest=(Get-FileHash -LiteralPath $tocPartial -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText("$hashPartial","$digest  $([System.IO.Path]::GetFileName($archive))$([Environment]::NewLine)",[System.Text.UTF8Encoding]::new($false))
    $hashDigest=(Get-FileHash -LiteralPath $hashPartial -Algorithm SHA256).Hash.ToLowerInvariant()
    $completion=[ordered]@{
      Version=1;SchemaMode=$SchemaMode;SourceCommit=$ExpectedSourceCommit.ToLowerInvariant();SnapshotId=$SnapshotId
      ArchiveName=[System.IO.Path]::GetFileName($archive);ArchiveSha256=$digest
      TocName=[System.IO.Path]::GetFileName($tocFinal);TocSha256=$tocDigest
      AggregateManifestName=[System.IO.Path]::GetFileName($manifestPath);AggregateManifestSha256=$aggregateDigest
      HashFileName=[System.IO.Path]::GetFileName($hashPath);HashFileSha256=$hashDigest
    }
    [System.IO.File]::WriteAllText($completionPartial,($completion|ConvertTo-Json -Depth 4),[System.Text.UTF8Encoding]::new($false))
    $completionDigest=(Get-FileHash -LiteralPath $completionPartial -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item -LiteralPath $partial -Destination $archive
    Move-Item -LiteralPath $tocPartial -Destination $tocFinal
    Move-Item -LiteralPath $manifestPartial -Destination $manifestPath
    Move-Item -LiteralPath $hashPartial -Destination $hashPath
    Move-Item -LiteralPath $completionPartial -Destination $completionPath
    Write-Output 'PASS: source schema, exact release ledger, snapshot-consistent custom dump, TOC, aggregate counts, checksums, and last-written completion marker verified.'
    Write-Output "Aggregate manifest SHA-256: $aggregateDigest"
    Write-Output "Completion marker SHA-256: $completionDigest"
    Write-Output 'Record both digests separately from the backup artifacts.'
    Write-Output 'Keep artifacts only in the approved encrypted operations location.'
    return
  }
  if($Action -eq 'RestoreIsolated'){
    if(-not $ExecuteIsolatedRestore){throw 'STOP: explicit isolated-restore execution approval switch is required.'}
    if(-not $ArchivePath -or -not(Test-Path -LiteralPath $ArchivePath -PathType Leaf)){throw 'STOP: verified backup archive is required.'}
    if(-not $ExpectedCompletionManifestSha256 -or $ExpectedCompletionManifestSha256 -notmatch '^[A-Fa-f0-9]{64}$'){throw 'STOP: separately recorded completion-marker SHA-256 is required.'}
    if($ExpectedArchiveSha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'STOP: expected archive SHA-256 is required.'}
    $archive=Assert-StoragePath $ArchivePath 'backup archive'
    $aggregatePath="$archive.aggregates.json"
    if(-not $AggregateManifestPath -or [System.IO.Path]::GetFullPath($AggregateManifestPath) -cne [System.IO.Path]::GetFullPath($aggregatePath)){throw 'STOP: aggregate manifest path must be the archive bundle sidecar.'}
    $tocFinal="$archive.toc.txt"
    $hashPath="$archive.sha256.txt"
    $completionPath="$archive.complete.json"
    foreach($path in @($aggregatePath,$tocFinal,$hashPath,$completionPath)){
      [void](Assert-NoReparsePointPath -Path $path)
      if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'STOP: backup bundle is incomplete; required sidecar or completion marker is missing.'}
      Assert-RestrictedStorageAcl -Path $path
    }
    foreach($partialPath in @("$archive.partial","$archive.toc.txt.partial","$archive.aggregates.json.partial","$archive.sha256.txt.partial","$archive.complete.json.partial")){
      if(Test-Path -LiteralPath $partialPath){throw 'STOP: incomplete partial backup artifacts are present; bundle cannot be restored.'}
    }
    $actualCompletionDigest=(Get-FileHash -LiteralPath $completionPath -Algorithm SHA256).Hash
    if($actualCompletionDigest -ine $ExpectedCompletionManifestSha256){throw 'STOP: completion-marker checksum does not match the separately recorded digest.'}
    if($ExpectedAggregateManifestSha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'STOP: separately recorded aggregate manifest SHA-256 is required.'}
    $actualAggregateDigest=(Get-FileHash -LiteralPath $aggregatePath -Algorithm SHA256).Hash
    if($actualAggregateDigest -ine $ExpectedAggregateManifestSha256){throw 'STOP: aggregate manifest checksum does not match the separately recorded digest.'}
    $actualDigest=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if($actualDigest -ine $ExpectedArchiveSha256){throw 'STOP: archive checksum does not match approved digest.'}
    try{$completionManifest=[System.IO.File]::ReadAllText($completionPath)|ConvertFrom-Json -ErrorAction Stop}catch{throw 'STOP: completion marker is unreadable or invalid JSON.'}
    Assert-BackupCompletionManifest -Manifest $completionManifest -ArchivePath $archive -AggregateManifestPath $aggregatePath -ExpectedSourceCommit $ExpectedSourceCommit -SchemaMode $SchemaMode -ExpectedArchiveSha256 $ExpectedArchiveSha256 -ExpectedAggregateManifestSha256 $ExpectedAggregateManifestSha256
    $actualTocDigest=(Get-FileHash -LiteralPath $tocFinal -Algorithm SHA256).Hash
    if($actualTocDigest -ine [string]$completionManifest.TocSha256){throw 'STOP: archived TOC checksum does not match completion marker.'}
    $actualHashDigest=(Get-FileHash -LiteralPath $hashPath -Algorithm SHA256).Hash
    if($actualHashDigest -ine [string]$completionManifest.HashFileSha256){throw 'STOP: archive checksum sidecar does not match completion marker.'}
    $hashText=[System.IO.File]::ReadAllText($hashPath).Trim()
    $expectedHashText="$ExpectedArchiveSha256  $([System.IO.Path]::GetFileName($archive))"
    if($hashText -ine $expectedHashText){throw 'STOP: archive checksum sidecar content is inconsistent.'}
    try{$sourceManifest=[System.IO.File]::ReadAllText($aggregatePath)|ConvertFrom-Json -ErrorAction Stop}catch{throw 'STOP: source aggregate manifest is unreadable or invalid JSON.'}
    Assert-AggregateManifest -Manifest $sourceManifest -SchemaMode $SchemaMode -ExpectedSourceCommit $ExpectedSourceCommit -ExpectedArchiveSha256 $ExpectedArchiveSha256
    if([string]$completionManifest.SnapshotId -cne [string]$sourceManifest.SnapshotId){throw 'STOP: completion marker and aggregate manifest refer to different snapshots.'}
    $tocPath="$archive.restore-input.toc.txt"
    if(Test-Path -LiteralPath $tocPath){throw 'STOP: refusing to overwrite existing restore TOC artifact.'}
    & $PgRestorePath '--list' $archive 1> $tocPath
    if($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $tocPath).Length -eq 0){throw 'STOP: archive TOC could not be verified before restore.'}
    $restoreDatabase=$ExpectedDatabase
    $target=@(Get-TargetMetadata -ServiceName $RestoreServiceName)
    Assert-IsolatedRestoreTarget -Fields $target -ExpectedDatabase $restoreDatabase -ExpectedServerAddress $ExpectedServerAddress -ExpectedServerPort $ExpectedServerPort
    $restoreArgs=@('--password','--exit-on-error','--single-transaction','--no-owner','--no-privileges',"--dbname=service=$RestoreServiceName",$archive)
    Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
    & $PgRestorePath @restoreArgs *> $null
    $restoreExit=$LASTEXITCODE
    if($restoreExit -ne 0){throw "STOP: isolated pg_restore failed with exit code $restoreExit; no readiness claim is made."}
    Invoke-RestorePreflightAccessPreparation
    $env:PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'
    Invoke-SchemaAndLedgerValidation -ServiceName $RestorePreflightServiceName
    $restoredCounts=Get-AggregateCounts -ServiceName $RestoreServiceName
    Assert-AggregateCountsMatch -SourceManifest $sourceManifest -RestoredCounts $restoredCounts -SchemaMode $SchemaMode
    Write-Output 'PASS: isolated restore passed exact schema and migration validation; receipt metadata and aggregate table counts match the exported source snapshot.'
    Write-Output 'No production database was targeted and no cluster roles were restored.'
  }
}
finally{
  if($null -eq $previousServiceFile){Remove-Item Env:PGSERVICEFILE -ErrorAction SilentlyContinue}else{$env:PGSERVICEFILE=$previousServiceFile}
  if($null -eq $previousPgOptions){Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue}else{$env:PGOPTIONS=$previousPgOptions}
}
