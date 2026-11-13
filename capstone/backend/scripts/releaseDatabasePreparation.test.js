const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REQUIRED_SCHEMA } = require('../database/startupSchemaReadiness');
const { RELEASE_MIGRATIONS, migrationChecksum } = require('../releaseMigrations');

const scripts = __dirname;
const read = (name) => fs.readFileSync(path.join(scripts, name), 'utf8');
const readIsolatedBackendWorkflow = (
  workflowPathOverride = process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH
) => {
  const hasOverride = workflowPathOverride !== undefined;
  if (hasOverride && !workflowPathOverride.trim()) {
    throw new Error('STUDENT_PROGRESS_CI_WORKFLOW_PATH is configured but empty.');
  }

  const workflowPath = hasOverride
    ? path.resolve(workflowPathOverride)
    : path.resolve(scripts, '../../../.github/workflows/backend-network-isolated.yml');

  try {
    return fs.readFileSync(workflowPath, 'utf8');
  } catch (error) {
    const source = hasOverride
      ? `STUDENT_PROGRESS_CI_WORKFLOW_PATH override "${workflowPathOverride}"`
      : `repository-relative backend workflow "${workflowPath}"`;
    throw new Error(`Unable to read ${source} (resolved path: "${workflowPath}"): ${error.message}`, { cause: error });
  }
};

test('read-only preflight audit is fixed to catalog and migration-ledger metadata', () => {
  const sql = read('release-preflight-role-audit.sql');
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.match(sql, /statement_timeout\s*=\s*'10s'/i);
  assert.match(sql, /lock_timeout\s*=\s*'2s'/i);
  assert.match(sql, /tq_release_preflight_reader/);
  assert.match(sql, /schema_migrations/);
  assert.match(sql, /application_relation_select_count/);
  assert.match(sql, /has_column_privilege/);
  assert.match(sql, /^\\echo Preflight role audit counts: .*role_membership_count=:role_membership_count\r?$/m);
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
    checksum: migrationChecksum(fs.readFileSync(path.join(scripts, '../migrations', migration.file), 'utf8')),
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

test('pre-migration 026 constraint and index diagnostics use independent exact 17-table scopes', () => {
  const sql = read('release-migration-026-prerequisite-preflight.sql');
  const expectedTables = Object.keys(REQUIRED_SCHEMA)
    .filter((tableName) => tableName !== 'game_progress_save_commits')
    .sort();
  const cteStarts = [...sql.matchAll(/WITH required_tables\(table_name\) AS \(/g)]
    .map((match) => match.index);
  assert.equal(cteStarts.length, 2, 'constraint and index queries must each define a statement-local table CTE');

  const assertScopedTables = (query, label) => {
    const cte = query.match(/WITH required_tables\(table_name\) AS \(\s*VALUES([\s\S]*?)\)\s*SELECT/);
    assert.ok(cte, `${label} diagnostic must define required_tables in its own statement`);
    const tables = [...cte[1].matchAll(/\('([^']+)'\)/g)].map(([, tableName]) => tableName).sort();
    assert.equal(tables.length, 17, `${label} diagnostic must stay within the 17-table pre-migration scope`);
    assert.deepEqual(tables, expectedTables, `${label} diagnostic must use the canonical pre-migration table set`);
    assert.doesNotMatch(query, /required_columns/, `${label} diagnostic must not reference an out-of-scope column CTE`);
  };

  const constraintEnd = sql.indexOf('ORDER BY relation.relname,c.conname;', cteStarts[0]);
  assert.ok(constraintEnd > cteStarts[0]);
  const constraintQuery = sql.slice(cteStarts[0], constraintEnd + 'ORDER BY relation.relname,c.conname;'.length);
  assertScopedTables(constraintQuery, 'constraint');
  assert.match(constraintQuery, /pg_catalog\.pg_constraint/);
  assert.match(constraintQuery, /relation\.relname IN \(SELECT table_name FROM required_tables\)/);

  const indexEnd = sql.indexOf('ORDER BY tablename,indexname;', cteStarts[1]);
  assert.ok(indexEnd > cteStarts[1]);
  const indexQuery = sql.slice(cteStarts[1], indexEnd + 'ORDER BY tablename,indexname;'.length);
  assertScopedTables(indexQuery, 'index');
  assert.match(indexQuery, /pg_catalog\.pg_indexes/);
  assert.match(indexQuery, /tablename IN \(SELECT table_name FROM required_tables\)/);
});

test('configured backend workflow override is used', () => {
  const previousOverride = process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH;
  process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH = __filename;

  try {
    assert.equal(readIsolatedBackendWorkflow(), fs.readFileSync(__filename, 'utf8'));
  } finally {
    if (previousOverride === undefined) delete process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH;
    else process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH = previousOverride;
  }
});

test('configured backend workflow override fails clearly when it cannot be read', () => {
  const missingWorkflowPath = path.join(scripts, 'missing-backend-network-isolated.yml');

  assert.throws(
    () => readIsolatedBackendWorkflow(missingWorkflowPath),
    (error) => error instanceof Error
      && error.message.includes('STUDENT_PROGRESS_CI_WORKFLOW_PATH')
      && error.message.includes(missingWorkflowPath)
  );
});

test('isolated backend workflow provisions and sentinel-marks every new synthetic preflight database', () => {
  const workflow = readIsolatedBackendWorkflow();
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

test('disposable preflight databases remove inherited PUBLIC TEMP and test rejection plus restoration', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  const databaseSetup = harness.match(/for \(const \[mode, database\] of Object\.entries\(CASES\)\) \{([\s\S]*?)\n\}/);
  assert.ok(databaseSetup, 'all fixed disposable databases must share the restricted setup');
  const revokeTempAt = databaseSetup[1].indexOf('REVOKE TEMP ON DATABASE ${database} FROM PUBLIC;');
  const grantConnectAt = databaseSetup[1].indexOf('GRANT CONNECT ON DATABASE ${database} TO ${ROLE};');
  assert.ok(revokeTempAt >= 0 && grantConnectAt > revokeTempAt, 'revoke PUBLIC TEMP before role audit setup');

  const grantAt = harness.indexOf('const grantPublicTemp');
  const auditAt = harness.indexOf('const publicTempRoleAudit', grantAt);
  const revokeAt = harness.indexOf('const revokePublicTemp =', auditAt);
  const restoredAuditAt = harness.indexOf('const restoredPublicTempAudit', revokeAt);
  assert.ok(grantAt >= 0 && auditAt > grantAt && revokeAt > auditAt && restoredAuditAt > revokeAt,
    'the test must reject inherited TEMP, revoke it, then confirm the valid role audit is restored');
  assert.match(harness, /assert\.equal\(publicTempRoleAudit\.status, 3/);
  assert.match(harness, /assert\.equal\(restoredPublicTempAudit\.status, 0/);
});

test('backup fixture grants schema privileges in the disposable target database', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  const roleSetupAt = harness.indexOf("const createBackupRole = psql('postgres', 'postgres'");
  const databaseGrantsAt = harness.indexOf("const grantBackupRole = psql(CASES.valid, 'postgres'");
  const auditAt = harness.indexOf('const backupRoleAudit');
  assert.ok(roleSetupAt >= 0 && databaseGrantsAt > roleSetupAt && auditAt > databaseGrantsAt);
  const roleSetup = harness.slice(roleSetupAt, databaseGrantsAt);
  const databaseGrants = harness.slice(databaseGrantsAt, auditAt);
  assert.doesNotMatch(roleSetup, /GRANT (?:USAGE ON SCHEMA|SELECT ON ALL)/);
  assert.match(databaseGrants, /GRANT USAGE ON SCHEMA public TO tq_prod_backup_reader/);
  assert.match(databaseGrants, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO tq_prod_backup_reader/);
  assert.match(databaseGrants, /GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO tq_prod_backup_reader/);
});
test('backup utility has separate explicit backup and isolated-restore gates', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const sql = read('backup-role-preflight.sql');
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
  assert.match(sql, /^\\echo Backup-role catalog counts: .*foreign_table_count=:foreign_table_count\r?$/m);
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
