const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REQUIRED_SCHEMA } = require('../database/startupSchemaReadiness');
const { RELEASE_MIGRATIONS, migrationChecksum } = require('../releaseMigrations');

const scripts = __dirname;
const read = (name) => fs.readFileSync(path.join(scripts, name), 'utf8');

test('read-only preflight audit is fixed to catalog and migration-ledger metadata', () => {
  const sql = read('release-preflight-role-audit.sql');
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.match(sql, /statement_timeout\s*=\s*'10s'/i);
  assert.match(sql, /lock_timeout\s*=\s*'2s'/i);
  assert.match(sql, /tq_release_preflight_reader/);
  assert.match(sql, /schema_migrations/);
  assert.match(sql, /application_relation_select_count/);
  assert.match(sql, /has_column_privilege/);
  assert.match(sql, /has_any_column_privilege/);
  assert.match(sql, /extra_ledger_column_select_count/);
  assert.match(sql, /executable_security_definer_function_count/);
  assert.match(sql, /ROLLBACK/i);
  assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|CREATE\b|ALTER\b|DROP\b)/im);
  assert.doesNotMatch(sql, /SELECT\s+.+\s+FROM\s+public\.(?:accounts|game_results|playtime_sessions)\b/is);
});

test('Windows preflight utility uses a service alias, rejects inline passwords, and gates source/identity', () => {
  const script = read('run-release-preflight.ps1');
  assert.match(script, /tq_release_preflight_reader/);
  assert.match(script, /PGPASSWORD/);
  assert.match(script, /-w/);
  assert.match(script, /service=/);
  assert.match(script, /ExpectedSourceCommit/);
  assert.match(script, /reviewed preflight files or migrations are modified\/untracked/);
  assert.match(script, /release-preflight-role-audit\.sql/);
  assert.match(script, /release-migration-026-prerequisite-preflight\.sql/);
  assert.match(script, /release-migration-preflight\.sql/);
  assert.match(script, /PreMigration026/);
  assert.match(script, /PostMigration026/);
});

test('pre-migration 026 SQL matches current source metadata and stays metadata-only/read-only', () => {
  const sql = read('release-migration-026-prerequisite-preflight.sql');
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.match(sql, /SET LOCAL statement_timeout = '10s'/i);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/i);
  assert.match(sql, /ROLLBACK/i);
  assert.match(sql, /migration 024 is pending/i);
  assert.match(sql, /migration 026 is the expected pending migration/i);
  assert.match(sql, /partial or incompatible migration 026 objects exist/i);
  assert.match(sql, /17 tables and 269 columns/i);
  assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|CREATE\b|ALTER\b|DROP\b)\b/im);
  assert.doesNotMatch(sql, /SELECT\s+.+\s+FROM\s+public\.(?:accounts|game_results|playtime_sessions)\b/is);

  const migrationSection = sql.match(/WITH expected\(version, filename, source_sha256\) AS \(\s*VALUES([\s\S]*?)\), applied/);
  assert.ok(migrationSection, 'the migration checksum manifest must be present');
  const migrationRows = [...migrationSection[1].matchAll(/\((\d+), '([^']+)', '([a-f0-9]{64})'\)/g)]
    .map(([, version, filename, checksum]) => ({
      version: Number(version),
      file: filename,
      checksum,
    }));
  const expectedMigrations = RELEASE_MIGRATIONS.map((migration) => ({
    version: migration.version,
    file: migration.file,
    checksum: migrationChecksum(fs.readFileSync(path.join(scripts, '../migrations', migration.file), 'utf8').replace(/\r\n/g, '\n')),
  }));
  assert.deepEqual(migrationRows, expectedMigrations);

  const columnsSection = sql.match(/WITH required_columns\(table_name, column_name\) AS \(\s*VALUES([\s\S]*?)\), schema_contract/);
  assert.ok(columnsSection, 'the exact startup column manifest must be present');
  const requiredColumns = [...columnsSection[1].matchAll(/\('([^']+)', '([^']+)'\)/g)]
    .map(([, table, column]) => `${table}.${column}`)
    .sort();
  const expectedColumns = Object.entries(REQUIRED_SCHEMA)
    .filter(([table]) => table !== 'game_progress_save_commits')
    .flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`))
    .sort();
  assert.equal(expectedColumns.length, 269);
  assert.deepEqual(requiredColumns, expectedColumns);
});

test('isolated backend workflow provisions and sentinel-marks every new synthetic preflight database', () => {
  const workflowPathCandidates = [
    process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH,
    path.resolve(scripts, '../../../.github/workflows/backend-network-isolated.yml'),
    path.resolve(scripts, '../../.github/workflows/backend-network-isolated.yml'),
  ].filter(Boolean);
  const workflowPath = workflowPathCandidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(workflowPath, `backend workflow must exist at one of: ${workflowPathCandidates.join(', ')}`);
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  for (const database of [
    'tq_preflight_pre_026_test_ci',
    'tq_preflight_partial_receipt_026_test_ci',
    'tq_preflight_026_applied_test_ci',
    'tq_preflight_pre_024_test_ci',
  ]) {
    assert.equal(workflow.split(database).length - 1, 2, `${database} must be both created and stamped with the disposable sentinel`);
  }
  assert.match(workflow, /--network none/);
  assert.match(workflow, /persist-credentials: false/);
});

test('disposable PostgreSQL harness exercises read-only backup audit and isolated archive restore', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(harness, /pg_dump/);
  assert.match(harness, /pg_restore/);
  assert.match(harness, /--single-transaction/);
  assert.match(harness, /--no-owner/);
  assert.match(harness, /synthetic-only-backup-probe/);
  assert.match(harness, /tq_restore_backup_test_ci/);
  assert.match(harness, /passedScenarioCount, 23/);
  assert.match(harness, /assertCiContainer\(\)/);
});

test('backup utility has separate explicit backup and isolated-restore gates', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const sql = read('backup-role-preflight.sql');
  assert.match(script, /ExecuteApprovedProductionBackup/);
  assert.match(script, /ExecuteIsolatedRestore/);
  assert.match(script, /ExpectedSourceCommit/);
  assert.match(script, /EncryptionEvidencePath/);
  assert.match(script, /ExpectedEncryptionEvidenceSha256/);
  assert.match(script, /Assert-BackupStorageDirectory/);
  assert.doesNotMatch(script, /EncryptedStorageConfirmed/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore/);
  assert.match(script, /--single-transaction/);
  assert.match(script, /& \$PgRestorePath @restoreArgs \*>\s*\$null/, 'restore diagnostics must not stream row values to terminal logs');
  assert.match(script, /--exit-on-error/);
  assert.match(script, /restore-input\.toc\.txt/);
  assert.match(script, /backup\/preflight files or migrations are modified\/untracked/);
  assert.match(script, /pg_auth_members/);
  assert.doesNotMatch(script, /--clean\b|--create\b/i);
  assert.match(script, /tq_prod_backup/);
  assert.match(script, /tq_restore_/);
  assert.match(sql, /unreadable_relation_count/);
  assert.match(sql, /row_security_relation_count/);
  assert.match(sql, /relation_write_privilege_count/);
  assert.match(sql, /rolinherit/);
  assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|CREATE\b|ALTER\b|DROP\b)/im);
  assert.doesNotMatch(sql, /SELECT\s+.+\s+FROM\s+public\.(?:accounts|game_results|playtime_sessions)\b/is);
});

test('migration 026 remains additive and runner accepts only the exact approved pending list', () => {
  const migration = fs.readFileSync(path.join(scripts, '../migrations/026_game_progress_save_commit_idempotency.sql'), 'utf8');
  const runner = fs.readFileSync(path.join(scripts, 'run-approved-release-migrations.js'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.game_progress_save_commits/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|DROP\b)/im);
  assert.match(runner, /assertExactVersions\(actualVersions, plan\.expectedVersions\)/);
  assert.match(runner, /database migration filename does not match this source revision/);
  assert.match(runner, /database migration checksum does not match this source revision/);
  assert.match(runner, /migration 024/i);
});

test('offline backup rehearsal pins source, forces interactive auth, and validates mode-specific snapshots', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const validation = read('backupRestoreRehearsal.validation.psm1');

  assert.match(script, /Set-StrictMode\s+-Version\s+Latest/);
  assert.match(script, /\[Parameter\(Mandatory=\$true\)\]\[string\]\$ExpectedSourceCommit/);
  assert.doesNotMatch(script, /\$ExpectedSourceCommit\s*=/);
  assert.match(script, /ValidateSet\('PreMigration026','PostMigration026'\)/);
  assert.match(script, /Assert-ApprovedRecoverySource/);
  assert.match(script, /Assert-ReleaseMigrationLedger/);
  assert.match(script, /Assert-ReceiptSchemaState/);
  assert.match(script, /release-preflight-role-audit\.sql/);
  assert.match(script, /NOT\s+t\.tgisinternal/i, 'receipt validation must ignore PostgreSQL internal FK triggers');
  assert.doesNotMatch(script, /relkind\s+NOT\s+IN\s*\('i','I'\)/i, 'pre-026 receipt scan must include named index relations');
  assert.match(script, /pg_catalog\.pg_type[\s\S]*?typrelid=0/, 'restore target preflight must detect standalone user-defined types');
  assert.match(script, /rolreplication/, 'restore target role must not have replication privilege');
  assert.match(script, /--password/);
  assert.doesNotMatch(script, /--no-password/);
  assert.doesNotMatch(script, /\$env:PGPASSWORD\s*=/);
  assert.doesNotMatch(script, /\$env:PGPASSFILE\s*=/);
  assert.match(script, /--snapshot=\$SnapshotId/);
  assert.match(script, /ExpectedAggregateManifestSha256/);
  assert.match(script, /Assert-IsolatedRestoreTarget/);
  assert.match(script, /return \$fields/);
  assert.doesNotMatch(script, /return ,\$fields/);
  assert.match(script, /--single-transaction/);
  assert.doesNotMatch(script, /--clean\b|--create\b/i);
  assert.doesNotMatch(script, /\$Variables\b/, 'psql wrapper must not use an undefined variables collection');
  assert.match(script, /\$tocFinal="\$archive\.toc\.txt"/, 'completed TOC path must be checked before writing');
  assert.match(script, /foreach\(\$path in @\(\$archive,\$partial,\$tocPartial,\$tocFinal/);

  const tableBlock = validation.match(/\$script:AggregateTables\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(tableBlock, 'aggregate table allowlist must be explicit');
  const tables = [...tableBlock[1].matchAll(/'([^']+)'/g)].map(([, table]) => table);
  assert.deepEqual(tables, Object.keys(REQUIRED_SCHEMA).filter((table) => table !== 'game_progress_save_commits'));
  assert.match(validation, /SET TRANSACTION SNAPSHOT '\$SnapshotId'/);
  const aggregateBuilderStart = validation.indexOf('function New-BackupAggregateSql');
  assert.notEqual(aggregateBuilderStart, -1, 'aggregate SQL builder must exist');
  const aggregateBuilder = validation.slice(aggregateBuilderStart);
  assert.doesNotMatch(aggregateBuilder, /SELECT\s+\*|student_id|student_name|question_text|answer_text|email/i);
  assert.match(validation, /duplicate migration ledger filename/);
});

test('backup and migration preflight role audits reject column-level write grants', () => {
  for (const name of ['backup-role-preflight.sql', 'release-migration-preflight.sql']) {
    const sql = read(name);
    assert.match(sql, /has_any_column_privilege\([^\n]+,\s*'INSERT'\)/i, `${name} must reject column INSERT grants`);
    assert.match(sql, /has_any_column_privilege\([^\n]+,\s*'UPDATE'\)/i, `${name} must reject column UPDATE grants`);
    assert.match(sql, /has_any_column_privilege\([^\n]+,\s*'REFERENCES'\)/i, `${name} must reject column REFERENCES grants`);
  }
});
