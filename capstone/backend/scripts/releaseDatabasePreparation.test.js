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

  const expectedTables = [...new Set(expectedColumns.map((entry) => entry.split('.')[0]))].sort();
  const tableManifests = [...sql.matchAll(/WITH required_tables\(table_name\) AS \(\s*VALUES([\s\S]*?)\)\s*SELECT/g)];
  assert.equal(tableManifests.length, 2, 'constraint and index inventories must each declare a statement-scoped table manifest');
  const tableNamesFrom = (inventory) => [...inventory[1].matchAll(/\('([^']+)'\)/g)]
    .map(([, table]) => table)
    .sort();
  for (const manifest of tableManifests) {
    assert.deepEqual(tableNamesFrom(manifest), expectedTables);
  }
  assert.match(sql, /SELECT relation\.relname,[\s\S]*?relation\.relname IN \(SELECT table_name FROM required_tables\)/);
  assert.match(sql, /SELECT schemaname,tablename,indexname,indexdef[\s\S]*?tablename IN \(SELECT table_name FROM required_tables\)/);
  assert.doesNotMatch(sql, /IN \(SELECT DISTINCT table_name FROM required_columns\)/i,
    'the 269-column CTE must not be referenced outside its statement');
});

test('post-migration preflight uses canonical migration hashes and only least-privilege ledger columns', () => {
  const sql = read('release-migration-preflight.sql');
  const migrationRows = [...sql.matchAll(/\((1[8-9]|2[0-6]), '([^']+)', '([a-f0-9]{64})'\)/g)]
    .map(([, version, filename, checksum]) => ({
      version: Number(version),
      file: filename,
      checksum,
    }));
  const expectedMigrations = RELEASE_MIGRATIONS
    .filter(({ version }) => version >= 18 && version <= 26)
    .map((migration) => ({
      version: migration.version,
      file: migration.file,
      checksum: migrationChecksum(fs.readFileSync(path.join(scripts, '../migrations', migration.file), 'utf8').replace(/\r\n/g, '\n')),
    }));

  assert.equal(migrationRows.length, expectedMigrations.length * 2, 'both post-migration ledger checks must list versions 018 through 026');
  for (let offset = 0; offset < migrationRows.length; offset += expectedMigrations.length) {
    assert.deepEqual(migrationRows.slice(offset, offset + expectedMigrations.length), expectedMigrations);
  }
  assert.doesNotMatch(sql, /\bm\.applied_at\b/i, 'the restricted reader must not require an unapproved ledger column');
});

test('preflight role audit reports inherited TEMP access and the disposable fixture removes it before passing', () => {
  const roleAudit = read('release-preflight-role-audit.sql');
  assert.match(roleAudit, /database_temp_privilege_absent/);
  assert.match(roleAudit, /^\\echo Preflight role audit: .*database_temp_privilege_absent=:database_temp_privilege_absent.*role_audit_ok=:role_audit_ok/m);
  assert.doesNotMatch(roleAudit, /^\\echo 'Preflight role audit/m);

  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(harness, /GRANT TEMPORARY ON DATABASE .* TO PUBLIC/);
  assert.match(harness, /REVOKE TEMPORARY ON DATABASE .* FROM PUBLIC/);
  assert.match(harness, /database_temp_privilege_absent=f/);
});

test('isolated backend workflow provisions and sentinel-marks every new synthetic preflight database', () => {
  const workflow = fs.readFileSync(path.join(scripts, '../../../.github/workflows/backend-network-isolated.yml'), 'utf8');
  assert.match(workflow, /codex\/database-release-preparation-20261108/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/codex\/database-release-preparation-20261108'/);
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
  assert.match(harness, /passedScenarioCount, 22/);
  assert.match(harness, /assertCiContainer\(\)/);
});

test('backup utility has separate explicit backup and isolated-restore gates', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const sql = read('backup-role-preflight.sql');
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(script, /ExecuteApprovedProductionBackup/);
  assert.match(script, /ExecuteIsolatedRestore/);
  assert.match(script, /ExpectedSourceCommit/);
  assert.match(script, /EncryptedStorageConfirmed/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore/);
  assert.match(script, /--single-transaction/);
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
  const backupRoleSetupStart = harness.indexOf('const createBackupRole =');
  const backupRoleSetupEnd = harness.indexOf('const backupRoleAudit =', backupRoleSetupStart);
  assert.ok(backupRoleSetupStart >= 0 && backupRoleSetupEnd > backupRoleSetupStart,
    'synthetic backup role setup must be present before its audit');
  const backupRoleSetup = harness.slice(backupRoleSetupStart, backupRoleSetupEnd);
  assert.match(backupRoleSetup, /const createBackupRole = psql\('postgres', 'postgres',/);
  assert.match(backupRoleSetup, /const grantBackupRoleRead = psql\(CASES\.valid, 'postgres',/,
    'backup table/schema grants must be applied inside the synthetic target database');
  assert.match(backupRoleSetup, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO tq_prod_backup_reader/);
  const backupAuditSummary = sql.split(/\r?\n/).find((line) =>
    line.startsWith('\\echo Backup-role catalog counts:'));
  assert.ok(backupAuditSummary, 'backup-role audit must print expanded aggregate diagnostics on failure');
  for (const field of [
    'target_identity_ok',
    'dedicated_non_admin_role_ok',
    'database_privileges_ok',
    'unreadable_relation_count',
    'unreadable_sequence_count',
    'relation_write_privilege_count',
    'sequence_write_privilege_count',
    'schema_create_privilege_count',
    'unusable_schema_count',
    'row_security_relation_count',
    'foreign_table_count',
    'backup_role_ok',
  ]) {
    assert.ok(backupAuditSummary.includes(`:${field}`), `backup-role audit must report ${field}`);
  }
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
