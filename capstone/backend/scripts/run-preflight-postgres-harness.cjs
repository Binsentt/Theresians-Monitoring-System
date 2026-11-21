'use strict';

// This integration check is intentionally restricted to the PostgreSQL
// container created by backend-network-isolated.yml. It never accepts a URL
// or an arbitrary database name, and it refuses to run outside GitHub CI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { REQUIRED_SCHEMA, SCHEMA_READINESS_SQL } = require('../database/startupSchemaReadiness');
const { RELEASE_MIGRATIONS, migrationChecksum } = require('../releaseMigrations');
const fs = require('node:fs');

const CONTAINER = 'tq-backend-test-postgres';
const ROLE = 'tq_release_preflight_reader';
const SENTINEL_PREFIX = 'tq-disposable-ci:';
const PREFLIGHT_SQL = fs.readFileSync(require('node:path').join(__dirname, 'release-migration-preflight.sql'), 'utf8');
let passedScenarioCount = 0;

assert.match(PREFLIGHT_SQL, /^\s*BEGIN\s+READ\s+ONLY\s*;/im,
  'the operator preflight must remain inside an explicit read-only transaction');
assert.doesNotMatch(PREFLIGHT_SQL,
  /^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|CALL|DO)\b/im,
  'the operator preflight must not execute migration or other mutating SQL');

function recordScenario(label) {
  passedScenarioCount += 1;
  console.log(`PASS: ${label}`);
}
const CASES = Object.freeze({
  valid: 'tq_preflight_valid_test_ci',
  missingLedger: 'tq_preflight_missing_ledger_test_ci',
  missingTable: 'tq_preflight_missing_table_test_ci',
  missingColumn: 'tq_preflight_missing_column_test_ci',
  incompatibleType: 'tq_preflight_incompatible_type_test_ci',
  incompatibleGameStudentIdWidth: 'tq_preflight_game_student_id_width_test_ci',
  malformedLedger: 'tq_preflight_malformed_ledger_test_ci',
  pending024: 'tq_preflight_pending_024_test_ci',
  pending025: 'tq_preflight_pending_025_test_ci',
  missingReceiptConstraint: 'tq_preflight_missing_receipt_constraint_test_ci',
  preMigration026: 'tq_preflight_pre_026_test_ci',
  partialReceipt026: 'tq_preflight_partial_receipt_026_test_ci',
  migration026Applied: 'tq_preflight_026_applied_test_ci',
  preMigration024Pending: 'tq_preflight_pre_024_test_ci',
  wrongFilenameLedger: 'tq_preflight_wrong_filename_ledger_test_ci',
});

function docker(args, input = undefined) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
}

function dockerBinary(args, input = undefined) {
  const result = spawnSync('docker', args, {
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
}

function psql(database, role, sql, variables = {}) {
  const args = ['exec'];
  if (sql !== undefined) args.push('-i');
  args.push(CONTAINER, 'psql',
    '--host=127.0.0.1', '--port=5432', `--username=${role}`, `--dbname=${database}`,
    '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align');
  for (const [key, value] of Object.entries(variables)) args.push(`--set=${key}=${value}`);
  if (sql !== undefined) args.push('--file=-');
  return docker(args, sql);
}

function assertCiContainer() {
  assert.equal(process.env.CI, 'true', 'preflight integration requires CI=true');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'preflight integration is allowed only on GitHub Actions');
  assert.match(process.env.TQ_DISPOSABLE_DB_SENTINEL || '', /^[a-f0-9]{48}$/, 'run-specific disposable sentinel is required');
  const inspect = docker(['inspect', '--format={{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.PortBindings}}', CONTAINER]);
  assert.equal(inspect.status, 0, inspect.stderr);
  const [networkMode, readOnlyRootfs, portBindingsJson] = inspect.stdout.trim().split('|');
  assert.equal(networkMode, 'none', 'PostgreSQL must have no network');
  assert.equal(readOnlyRootfs, 'true', 'PostgreSQL root filesystem must be read-only');
  const portBindings = JSON.parse(portBindingsJson);
  assert.ok(
    portBindings === null
      || (portBindings && typeof portBindings === 'object' && Object.keys(portBindings).length === 0),
    'PostgreSQL must have no published ports',
  );

  const expectedMajor = process.env.TQ_EXPECTED_POSTGRES_MAJOR || '';
  assert.match(expectedMajor, /^(16|18)$/, 'the workflow must declare PostgreSQL 16 or 18 explicitly');
  const serverVersion = docker([
    'exec', CONTAINER, 'psql', '--host=127.0.0.1', '--username=postgres', '--dbname=postgres',
    '--no-psqlrc', '--tuples-only', '--no-align', '--command=SHOW server_version_num;',
  ]);
  assert.equal(serverVersion.status, 0, serverVersion.stderr);
  assert.equal(Math.floor(Number(serverVersion.stdout.trim()) / 10000), Number(expectedMajor),
    `the container must run PostgreSQL ${expectedMajor}, got server_version_num=${serverVersion.stdout.trim()}`);
  recordScenario(`disposable database server is PostgreSQL ${expectedMajor}`);

  for (const database of Object.values(CASES)) {
    assert.match(database, /^tq_preflight_[a-z0-9_]+_test_ci$/);
    const result = docker([
      'exec', CONTAINER, 'psql', '--host=127.0.0.1', '--username=postgres', `--dbname=${database}`,
      '--no-psqlrc', '--tuples-only', '--no-align',
      '--command=SELECT shobj_description(oid, \'pg_database\') FROM pg_database WHERE datname = current_database();',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${SENTINEL_PREFIX}${process.env.TQ_DISPOSABLE_DB_SENTINEL}`,
      `${database} must carry this run's disposable-database marker`);
  }
}

function sqlType(table, column, mode) {
  if (mode === 'incompatibleType' && table === 'accounts' && column === 'current_learning_cycle_version') return 'text';
  if (table === 'accounts' && column === 'game_student_id') {
    return mode === 'incompatibleGameStudentIdWidth' ? 'character varying(6)' : 'character varying(8)';
  }
  const critical = new Map([
    ['accounts.id', 'integer'],
    ['accounts.current_learning_cycle_version', 'integer'],
    ['accounts.session_version', 'integer'],
    ['activity_logs.id', 'integer'],
    ['activity_logs.student_id', 'integer'],
    ['activity_logs.activity_timestamp', 'timestamp with time zone'],
    ['game_results.id', 'integer'],
    ['game_results.resolved_student_id', 'integer'],
    ['game_results.response_time_seconds', 'integer'],
    ['game_progress_save_commits.student_id', 'integer'],
    ['game_progress_save_commits.learning_cycle_version', 'integer'],
    ['game_progress_save_commits.save_commit_id_hash', 'text'],
    ['game_progress_save_commits.payload_sha256', 'text'],
    ['game_progress_save_commits.activity_event_key', 'text'],
    ['game_progress_save_commits.response_status', 'smallint'],
    ['game_progress_save_commits.response_body', 'jsonb'],
    ['game_progress_save_commits.created_at', 'timestamp with time zone'],
    ['game_progress_save_commits.completed_at', 'timestamp with time zone'],
    ['student_game_progress.id', 'integer'],
    ['student_game_progress.student_id', 'integer'],
    ['student_ai_insights.id', 'integer'],
    ['student_ai_insights.student_id', 'integer'],
    ['student_ai_insights.generated_by', 'integer'],
    ['student_ai_insights.insight', 'jsonb'],
    ['learning_files.id', 'integer'],
    ['learning_files.source_file_bytes', 'bytea'],
    ['playtime_sessions.id', 'integer'],
    ['playtime_sessions.student_id', 'integer'],
    ['playtime_sessions.deleted_at', 'timestamp with time zone'],
    ['playtime_sessions.deleted_by', 'integer'],
    ['playtime_sessions.deletion_operation_id', 'uuid'],
    ['playtime_sessions.deletion_reason', 'character varying(1000)'],
    ['website_sessions.id', 'integer'],
    ['website_sessions.account_id', 'integer'],
    ['student_quest_milestones.id', 'integer'],
    ['student_quest_milestones.student_id', 'integer'],
    ['playtime_deletion_tombstones.id', 'integer'],
    ['playtime_deletion_tombstones.deleted_by', 'integer'],
    ['teacher_class_assignments.id', 'integer'],
  ]);
  if (critical.has(`${table}.${column}`)) return critical.get(`${table}.${column}`);
  if (column === 'birthday') return 'date';
  if (column.endsWith('_at') || column.endsWith('_time') || column === 'date_played' || column === 'session_date') {
    return 'timestamp with time zone';
  }
  if (column === 'id' || column.endsWith('_id') || column.endsWith('_version') || column.endsWith('_count')) return 'integer';
  return 'text';
}

function fixtureSql(mode) {
  const statements = [];
  if (mode !== 'missingLedger') {
    statements.push(`CREATE TABLE public.schema_migrations (
      version integer PRIMARY KEY,
      filename varchar(255) NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
  }
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    if (table === 'game_progress_save_commits') {
      if (['preMigration026', 'partialReceipt026', 'preMigration024Pending', 'pending025'].includes(mode)) {
        continue;
      }
      statements.push(fs.readFileSync(
        require('node:path').join(__dirname, '../migrations/026_game_progress_save_commit_idempotency.sql'),
        'utf8',
      ));
      continue;
    }
    if (mode === 'missingTable' && table === 'student_ai_insights') continue;
    const definitions = columns
      .filter((column) => !(mode === 'missingColumn' && table === 'accounts' && column === 'address'))
      .map((column) => `${column} ${sqlType(table, column, mode)}${column === 'id' ? ' PRIMARY KEY' : ''}`);
    statements.push(`CREATE TABLE public.${table} (${definitions.join(', ')});`);
  }
  statements.push(`
    ALTER TABLE public.student_game_progress
      ADD CONSTRAINT fixture_progress_student_fk FOREIGN KEY (student_id)
      REFERENCES public.accounts(id) ON DELETE CASCADE;
    ALTER TABLE public.activity_logs
      ADD CONSTRAINT fixture_activity_student_fk FOREIGN KEY (student_id)
      REFERENCES public.accounts(id) ON DELETE CASCADE;
    ALTER TABLE public.game_results
      ADD CONSTRAINT fixture_game_result_student_fk FOREIGN KEY (resolved_student_id)
      REFERENCES public.accounts(id) ON DELETE SET NULL;
    ALTER TABLE public.playtime_sessions
      ADD CONSTRAINT fixture_playtime_student_fk FOREIGN KEY (student_id)
      REFERENCES public.accounts(id) ON DELETE CASCADE;
    ALTER TABLE public.playtime_sessions
      ADD CONSTRAINT fixture_playtime_deleter_fk FOREIGN KEY (deleted_by)
      REFERENCES public.accounts(id) ON DELETE SET NULL;
    ALTER TABLE public.website_sessions
      ADD CONSTRAINT fixture_website_session_account_fk FOREIGN KEY (account_id)
      REFERENCES public.accounts(id) ON DELETE CASCADE;
    ALTER TABLE public.student_quest_milestones
      ADD CONSTRAINT fixture_milestone_student_fk FOREIGN KEY (student_id)
      REFERENCES public.accounts(id) ON DELETE CASCADE;
    ALTER TABLE public.playtime_deletion_tombstones
      ADD CONSTRAINT fixture_tombstone_deleter_fk FOREIGN KEY (deleted_by)
      REFERENCES public.accounts(id) ON DELETE SET NULL;
    CREATE FUNCTION public.fixture_validate_teacher_assignment() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER teacher_class_assignments_validate_teacher
      BEFORE INSERT OR UPDATE ON public.teacher_class_assignments
      FOR EACH ROW EXECUTE FUNCTION public.fixture_validate_teacher_assignment();
  `);
  if (mode !== 'missingTable') {
    statements.push(`
      ALTER TABLE public.student_ai_insights
        ADD CONSTRAINT fixture_ai_insight_student_fk FOREIGN KEY (student_id)
        REFERENCES public.accounts(id) ON DELETE CASCADE;
      ALTER TABLE public.student_ai_insights
        ADD CONSTRAINT fixture_ai_insight_generator_fk FOREIGN KEY (generated_by)
        REFERENCES public.accounts(id) ON DELETE SET NULL;
    `);
  }

  if (mode === 'pending024') {
    statements.push(`
      INSERT INTO public.accounts (id, name, role, game_student_id) VALUES (1, 'synthetic-only-name', 'student', '123456');
      INSERT INTO public.game_results (id, resolved_student_id) VALUES (1, 1);
      INSERT INTO public.playtime_sessions (id, student_id, deleted_by) VALUES (1, 1, 1);
    `);
  }
  if (mode === 'preMigration024Pending') {
    statements.push(`
      INSERT INTO public.accounts (id, name, role, game_student_id) VALUES (1, 'synthetic-only-name', 'student', '123456');
      INSERT INTO public.game_results (id, resolved_student_id) VALUES (1, 1);
      INSERT INTO public.playtime_sessions (id, student_id, deleted_by) VALUES (1, 1, 1);
    `);
  }
  if (mode === 'missingReceiptConstraint') {
    statements.push('ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_pkey;');
  }
  if (!['pending024', 'missingLedger'].includes(mode)) {
    let migrationsToSeed = RELEASE_MIGRATIONS;
    if (mode === 'preMigration024Pending') {
      migrationsToSeed = RELEASE_MIGRATIONS.filter(({ version }) => version < 24);
    } else if (mode === 'pending025') {
      migrationsToSeed = RELEASE_MIGRATIONS.filter(({ version }) => version < 25);
    } else if (['preMigration026', 'partialReceipt026'].includes(mode)) {
      migrationsToSeed = RELEASE_MIGRATIONS.filter(({ version }) => version < 26);
    }
    statements.push(...migrationsToSeed.map(({ version, file }) => {
      const checksum = mode === 'malformedLedger' && version === 18
        ? '0'.repeat(64)
        : migrationChecksum(fs.readFileSync(require('node:path').join(__dirname, '../migrations', file), 'utf8'));
      const filename = mode === 'wrongFilenameLedger' && version === 18 ? `wrong_${file}` : file;
      return `INSERT INTO public.schema_migrations (version, filename, checksum) VALUES (${version}, '${filename}', '${checksum}');`;
    }));
  } else if (mode === 'pending024') {
    statements.push(...RELEASE_MIGRATIONS.filter(({ version }) => version < 24).map(({ version, file }) => {
      const checksum = migrationChecksum(fs.readFileSync(require('node:path').join(__dirname, '../migrations', file), 'utf8'));
      return `INSERT INTO public.schema_migrations (version, filename, checksum) VALUES (${version}, '${file}', '${checksum}');`;
    }));
  }
  statements.push(`GRANT USAGE ON SCHEMA public TO ${ROLE};`);
  if (mode !== 'missingLedger') {
  statements.push(`GRANT SELECT (version, filename, checksum) ON public.schema_migrations TO ${ROLE};`);
  }
  return statements.join('\n');
}

function invokePreflight(database, overrides = {}) {
  return psql(database, ROLE, PREFLIGHT_SQL, {
    expected_database: database,
    expected_role: ROLE,
    expected_server_address: '127.0.0.1',
    expected_server_port: '5432',
    ...overrides,
  });
}

function invokeStartupReadiness(database) {
  const requiredSchemaJson = JSON.stringify(
    Object.entries(REQUIRED_SCHEMA).map(([table_name, columns]) => ({ table_name, columns })),
  ).replace(/'/g, "''");
  assert.equal((SCHEMA_READINESS_SQL.match(/\$1::jsonb/g) || []).length, 1,
    'startup readiness SQL must have exactly one schema-contract parameter');
  const query = SCHEMA_READINESS_SQL.replace('$1::jsonb', `'${requiredSchemaJson}'::jsonb`);
  return psql(database, ROLE, `BEGIN READ ONLY;\n${query};\nROLLBACK;`);
}

function assertReceiptConstraintMismatch({ label, constraintName, mutationSql, restoreSql }) {
  const mutation = psql(CASES.valid, 'postgres', mutationSql);
  assert.equal(mutation.status, 0, `${label} fixture mutation failed: ${mutation.stderr}`);

  const startup = invokeStartupReadiness(CASES.valid);
  assert.equal(startup.status, 0, `${label} catalog read failed: ${startup.stderr}`);
  assert.ok(
    startup.stdout.trim().split(/\r?\n/).includes(`game_progress_save_commits.${constraintName}`),
    `${label} must be reported by the actual startup readiness SQL: ${startup.stdout}`,
  );

  const preflight = invokePreflight(CASES.valid);
  assert.equal(preflight.status, 3,
    `${label} must fail the release preflight closed: ${preflight.stderr}\n${preflight.stdout}`);
  assert.match(preflight.stdout, /STOP: migration 026 receipt constraints are missing or incompatible/);

  const restore = psql(CASES.valid, 'postgres', restoreSql);
  assert.equal(restore.status, 0, `${label} fixture restore failed: ${restore.stderr}`);
  const recovered = invokeStartupReadiness(CASES.valid);
  assert.equal(recovered.status, 0, `${label} restore query failed: ${recovered.stderr}`);
  assert.equal(recovered.stdout.trim(), '', `${label} must restore the valid startup contract: ${recovered.stdout}`);
  recordScenario(label);
}

function invokeRoleAudit(database) {
  return psql(database, ROLE, fs.readFileSync(
    require('node:path').join(__dirname, 'release-preflight-role-audit.sql'),
    'utf8',
  ), {
    expected_database: database,
    expected_role: ROLE,
    expected_server_address: '127.0.0.1',
    expected_server_port: '5432',
  });
}

function invokePreMigration026(database) {
  return psql(database, ROLE, fs.readFileSync(
    require('node:path').join(__dirname, 'release-migration-026-prerequisite-preflight.sql'),
    'utf8',
  ), {
    expected_database: database,
    expected_role: ROLE,
    expected_server_address: '127.0.0.1',
    expected_server_port: '5432',
  });
}

function invokeBackupRoleAudit(database) {
  return psql(database, 'tq_prod_backup_reader', fs.readFileSync(
    require('node:path').join(__dirname, 'backup-role-preflight.sql'),
    'utf8',
  ), {
    expected_database: database,
    expected_role: 'tq_prod_backup_reader',
    expected_server_address: '127.0.0.1',
    expected_server_port: '5432',
  });
}

assertCiContainer();
const createRole = psql('postgres', 'postgres', `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`);
assert.equal(createRole.status, 0, createRole.stderr);
for (const [mode, database] of Object.entries(CASES)) {
  const revokePublicTemp = psql('postgres', 'postgres', `REVOKE TEMP ON DATABASE ${database} FROM PUBLIC;`);
  assert.equal(revokePublicTemp.status, 0, revokePublicTemp.stderr);
  const grantConnect = psql('postgres', 'postgres', `GRANT CONNECT ON DATABASE ${database} TO ${ROLE};`);
  assert.equal(grantConnect.status, 0, grantConnect.stderr);
  const fixture = psql(database, 'postgres', fixtureSql(mode));
  assert.equal(fixture.status, 0, `${mode} fixture setup failed: ${fixture.stderr}`);
}

const noApplicationSelect = psql(CASES.valid, 'postgres', `
  SELECT NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND relation.relname <> 'schema_migrations'
      AND has_table_privilege('${ROLE}', relation.oid, 'SELECT')
  );
`);
assert.equal(noApplicationSelect.status, 0, noApplicationSelect.stderr);
assert.equal(noApplicationSelect.stdout.trim(), 't', 'preflight role must not have SELECT on any public application-row table');

const valid = invokePreflight(CASES.valid);
assert.equal(valid.status, 0, `valid disposable schema must pass: ${valid.stderr}\n${valid.stdout}`);
assert.ok(valid.stdout.includes('Target database identity and read-only transaction match the approved values.'),
  'the correctly bound synthetic database identity must pass');
assert.match(valid.stdout, /Startup schema contract is complete: 18 tables and 278 required columns are present/);
recordScenario('compatible 18-table/278-column post-migration schema and ledger');

const validStartup = invokeStartupReadiness(CASES.valid);
assert.equal(validStartup.status, 0, `valid startup catalog query must execute read-only: ${validStartup.stderr}`);
assert.equal(validStartup.stdout.trim(), '', `valid startup schema must return no missing objects: ${validStartup.stdout}`);
const receiptShape = psql(CASES.valid, ROLE, `BEGIN READ ONLY;
  SELECT (SELECT count(*) FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.game_progress_save_commits'::regclass
            AND attnum > 0 AND NOT attisdropped)::text || '|' ||
         (SELECT count(*) FROM pg_catalog.pg_constraint
          WHERE conrelid = 'public.game_progress_save_commits'::regclass)::text;
ROLLBACK;`);
assert.equal(receiptShape.status, 0, receiptShape.stderr);
assert.equal(receiptShape.stdout.trim(), '9|8', 'receipt schema must have exactly nine columns and eight constraints');
recordScenario('actual startup readiness SQL accepts nine receipt columns and eight canonical constraints');

const validRoleAudit = invokeRoleAudit(CASES.valid);
assert.equal(validRoleAudit.status, 0, `preflight-only role must pass the catalog audit: ${validRoleAudit.stderr}\n${validRoleAudit.stdout}`);
assert.match(validRoleAudit.stdout, /application_relation_select_count=0/);
assert.match(validRoleAudit.stdout, /extra_ledger_column_select_count=0/);
assert.match(validRoleAudit.stdout, /executable_security_definer_function_count=0/);
assert.match(validRoleAudit.stdout, /table_write_privilege_count=0/);
recordScenario('preflight role passes with migration-ledger SELECT and no application-data SELECT');

const grantPublicTemp = psql('postgres', 'postgres', `GRANT TEMP ON DATABASE ${CASES.valid} TO PUBLIC;`);
assert.equal(grantPublicTemp.status, 0, grantPublicTemp.stderr);
const publicTempRoleAudit = invokeRoleAudit(CASES.valid);
const revokePublicTemp = psql('postgres', 'postgres', `REVOKE TEMP ON DATABASE ${CASES.valid} FROM PUBLIC;`);
assert.equal(revokePublicTemp.status, 0, revokePublicTemp.stderr);
assert.equal(publicTempRoleAudit.status, 3,
  `an inherited PUBLIC TEMP privilege must fail the least-privilege audit: ${publicTempRoleAudit.stderr}\n${publicTempRoleAudit.stdout}`);
assert.match(publicTempRoleAudit.stdout, /STOP: preflight role identity or least-privilege requirements failed/);
recordScenario('inherited PUBLIC TEMP privilege fails the least-privilege audit');

const grantBroadLedgerRead = psql(CASES.valid, 'postgres', `GRANT SELECT ON public.schema_migrations TO ${ROLE};`);
assert.equal(grantBroadLedgerRead.status, 0, grantBroadLedgerRead.stderr);
const broadLedgerRole = invokeRoleAudit(CASES.valid);
assert.equal(broadLedgerRole.status, 3, `table-wide migration-ledger SELECT must fail the least-privilege audit: ${broadLedgerRole.stderr}\n${broadLedgerRole.stdout}`);
assert.match(broadLedgerRole.stdout, /extra_ledger_column_select_count=1/);
const revokeBroadLedgerRead = psql(CASES.valid, 'postgres', `REVOKE SELECT ON public.schema_migrations FROM ${ROLE};`);
assert.equal(revokeBroadLedgerRead.status, 0, revokeBroadLedgerRead.stderr);
recordScenario('table-wide migration-ledger SELECT is rejected when only three checksum columns are required');

const grantApplicationColumnRead = psql(CASES.valid, 'postgres', `GRANT SELECT (email) ON public.accounts TO ${ROLE};`);
assert.equal(grantApplicationColumnRead.status, 0, grantApplicationColumnRead.stderr);
const applicationColumnReadableRole = invokeRoleAudit(CASES.valid);
assert.equal(applicationColumnReadableRole.status, 3,
  `column-level application SELECT must fail the role audit: ${applicationColumnReadableRole.stderr}\n${applicationColumnReadableRole.stdout}`);
assert.match(applicationColumnReadableRole.stdout, /application_relation_select_count=1/);
const revokeApplicationColumnRead = psql(CASES.valid, 'postgres', `REVOKE SELECT (email) ON public.accounts FROM ${ROLE};`);
assert.equal(revokeApplicationColumnRead.status, 0, revokeApplicationColumnRead.stderr);
recordScenario('column-level application table SELECT is rejected before release preflight');

const grantApplicationRead = psql(CASES.valid, 'postgres', `GRANT SELECT ON public.accounts TO ${ROLE};`);
assert.equal(grantApplicationRead.status, 0, grantApplicationRead.stderr);
const applicationReadableRole = invokeRoleAudit(CASES.valid);
assert.equal(applicationReadableRole.status, 3, `application-table SELECT must fail the role audit: ${applicationReadableRole.stderr}\n${applicationReadableRole.stdout}`);
assert.match(applicationReadableRole.stdout, /application_relation_select_count=1/);
const revokeApplicationRead = psql(CASES.valid, 'postgres', `REVOKE SELECT ON public.accounts FROM ${ROLE};`);
assert.equal(revokeApplicationRead.status, 0, revokeApplicationRead.stderr);
recordScenario('role with application-table SELECT is rejected before release preflight');

const createSecurityDefiner = psql(CASES.valid, 'postgres', `
  CREATE FUNCTION public.fixture_security_definer_probe() RETURNS text
  LANGUAGE sql SECURITY DEFINER AS $$ SELECT current_user::text $$;
`);
assert.equal(createSecurityDefiner.status, 0, createSecurityDefiner.stderr);
const securityDefinerRole = invokeRoleAudit(CASES.valid);
assert.equal(securityDefinerRole.status, 3,
  `executable security-definer functions must fail the least-privilege audit: ${securityDefinerRole.stderr}\n${securityDefinerRole.stdout}`);
assert.match(securityDefinerRole.stdout, /executable_security_definer_function_count=1/);
const dropSecurityDefiner = psql(CASES.valid, 'postgres', 'DROP FUNCTION public.fixture_security_definer_probe();');
assert.equal(dropSecurityDefiner.status, 0, dropSecurityDefiner.stderr);
recordScenario('publicly executable security-definer function is rejected by the read-only role audit');

const identityStopMessage = 'STOP: target database identity or read-only transaction does not match the approved values.';
function assertIdentityMismatchFailsClosed(label, overrides) {
  const result = invokePreflight(CASES.valid, overrides);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 3, `${label}: ${output}`);
  assert.ok(result.stdout.trim().split(/\r?\n/).includes(identityStopMessage),
    `${label} must emit the stable target-identity STOP message: ${output}`);
  assert.doesNotMatch(output, /Startup schema contract is complete|PASS:|migration (?:024|025|026) is/i,
    `${label} must stop before schema or migration results are reported: ${output}`);
}
assertIdentityMismatchFailsClosed('incorrect expected database identity fails closed', { expected_database: 'unexpected_target' });
assertIdentityMismatchFailsClosed('incorrect expected database role fails closed', { expected_role: 'unexpected_role' });
recordScenario('incorrect expected database and role identities fail closed');
assertIdentityMismatchFailsClosed('incorrect expected server address fails closed', { expected_server_address: '192.0.2.25' });
assertIdentityMismatchFailsClosed('incorrect expected server port fails closed', { expected_server_port: '5433' });
recordScenario('incorrect expected server address and port fail closed');

const revokeLedgerChecksum = psql(CASES.valid, 'postgres',
  `REVOKE SELECT (checksum) ON public.schema_migrations FROM ${ROLE};`);
assert.equal(revokeLedgerChecksum.status, 0, revokeLedgerChecksum.stderr);
const insufficientLedgerRead = invokePreflight(CASES.valid);
const regrantLedgerChecksum = psql(CASES.valid, 'postgres',
  `GRANT SELECT (checksum) ON public.schema_migrations TO ${ROLE};`);
assert.equal(regrantLedgerChecksum.status, 0, regrantLedgerChecksum.stderr);
assert.notEqual(insufficientLedgerRead.status, 0,
  'missing required migration-ledger column SELECT must fail before a report is produced');
assert.match(insufficientLedgerRead.stderr, /permission denied for table schema_migrations/);
recordScenario('missing migration-ledger column privilege fails closed without application-row access');

const grantWrite = psql(CASES.valid, 'postgres', `GRANT INSERT ON public.accounts TO ${ROLE};`);
assert.equal(grantWrite.status, 0, grantWrite.stderr);
const writableRole = invokePreflight(CASES.valid);
const revokeWrite = psql(CASES.valid, 'postgres', `REVOKE INSERT ON public.accounts FROM ${ROLE};`);
assert.equal(revokeWrite.status, 0, revokeWrite.stderr);
assert.equal(writableRole.status, 3, `role with write privilege must fail closed: ${writableRole.stderr}\n${writableRole.stdout}`);
assert.match(writableRole.stdout, /STOP: expected a dedicated non-admin read-only database role/);
recordScenario('role with an INSERT privilege fails closed');

for (const [mode, phrase] of [
  ['missingTable', 'student_ai_insights'],
  ['missingColumn', 'accounts.address'],
]) {
  const result = invokePreflight(CASES[mode]);
  assert.equal(result.status, 3, `${mode} must fail closed with psql exit 3: ${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, new RegExp(phrase.replace('.', '\\.')));
  assert.match(result.stdout, /STOP: one or more required tables or columns are missing/);
  recordScenario(`${mode} fails closed with a schema-only diagnostic`);
}

const incompatible = invokePreflight(CASES.incompatibleType);
assert.equal(incompatible.status, 3, `incompatible type must fail closed: ${incompatible.stderr}\n${incompatible.stdout}`);
assert.match(incompatible.stdout, /accounts.*current_learning_cycle_version.*integer.*text/s);
assert.match(incompatible.stdout, /STOP: one or more core column types do not match/);
recordScenario('incompatible core type fails closed');

const missingReceiptConstraint = invokePreflight(CASES.missingReceiptConstraint);
assert.equal(missingReceiptConstraint.status, 3,
  `receipt primary-key removal must fail closed: ${missingReceiptConstraint.stderr}\n${missingReceiptConstraint.stdout}`);
assert.match(missingReceiptConstraint.stdout, /STOP: migration 026 receipt constraints are missing or incompatible/);
recordScenario('missing receipt primary key fails closed');

assertReceiptConstraintMismatch({
  label: 'primary-key column order mismatch fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_pkey',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_pkey;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_pkey
    PRIMARY KEY (learning_cycle_version, student_id, save_commit_id_hash);`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_pkey;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_pkey
    PRIMARY KEY (student_id, learning_cycle_version, save_commit_id_hash);`,
});

assertReceiptConstraintMismatch({
  label: 'wrong unique-key composition fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_activity_event_unique',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_activity_event_unique;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_activity_event_unique
    UNIQUE (student_id, learning_cycle_version, activity_event_key);`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_activity_event_unique;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_activity_event_unique
    UNIQUE (student_id, activity_event_key);`,
});

assertReceiptConstraintMismatch({
  label: 'foreign-key target mismatch fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_student_id_fkey',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_student_id_fkey;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES public.teacher_class_assignments(id) ON DELETE CASCADE;`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_student_id_fkey;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES public.accounts(id) ON DELETE CASCADE;`,
});

assertReceiptConstraintMismatch({
  label: 'foreign-key column mapping mismatch fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_student_id_fkey',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_student_id_fkey;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_student_id_fkey
    FOREIGN KEY (learning_cycle_version) REFERENCES public.accounts(id) ON DELETE CASCADE;`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_student_id_fkey;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES public.accounts(id) ON DELETE CASCADE;`,
});

assertReceiptConstraintMismatch({
  label: 'foreign-key delete-action mismatch fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_student_id_fkey',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_student_id_fkey;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES public.accounts(id) ON DELETE SET NULL;`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_student_id_fkey;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES public.accounts(id) ON DELETE CASCADE;`,
});

assertReceiptConstraintMismatch({
  label: 'altered learning-cycle CHECK fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_learning_cycle_version_check',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_learning_cycle_version_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_learning_cycle_version_check
    CHECK (learning_cycle_version > 0);`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_learning_cycle_version_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_learning_cycle_version_check
    CHECK (learning_cycle_version >= 0);`,
});

assertReceiptConstraintMismatch({
  label: 'case-changed regular-expression literal fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_save_commit_id_hash_check',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_save_commit_id_hash_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_save_commit_id_hash_check
    CHECK (save_commit_id_hash ~ '^[0-9A-F]{64}$');`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_save_commit_id_hash_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_save_commit_id_hash_check
    CHECK (save_commit_id_hash ~ '^[0-9a-f]{64}$');`,
});

assertReceiptConstraintMismatch({
  label: 'whitespace-changed regular-expression literal fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_save_commit_id_hash_check',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_save_commit_id_hash_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_save_commit_id_hash_check
    CHECK (save_commit_id_hash ~ '^[0-9a-f]{ 64 }$');`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_save_commit_id_hash_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_save_commit_id_hash_check
    CHECK (save_commit_id_hash ~ '^[0-9a-f]{64}$');`,
});

assertReceiptConstraintMismatch({
  label: 'altered payload SHA-256 CHECK fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_payload_sha256_check',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_payload_sha256_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_payload_sha256_check
    CHECK (payload_sha256 ~ '^[0-9a-f]{63,64}$');`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_payload_sha256_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_payload_sha256_check
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$');`,
});

assertReceiptConstraintMismatch({
  label: 'altered response-status CHECK fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_response_status_check',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_response_status_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_response_status_check
    CHECK (response_status BETWEEN 201 AND 299);`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_response_status_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_response_status_check
    CHECK (response_status BETWEEN 200 AND 299);`,
});

assertReceiptConstraintMismatch({
  label: 'altered completion-consistency CHECK fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_completion_consistency',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_completion_consistency;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_completion_consistency
    CHECK ((response_body IS NULL) OR (completed_at IS NULL));`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_completion_consistency;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_completion_consistency
    CHECK ((response_body IS NULL) = (completed_at IS NULL));`,
});

assertReceiptConstraintMismatch({
  label: 'unexpected deferrable unique constraint fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_activity_event_unique',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_activity_event_unique;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_activity_event_unique
    UNIQUE (student_id, activity_event_key) DEFERRABLE INITIALLY DEFERRED;`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_activity_event_unique;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_activity_event_unique
    UNIQUE (student_id, activity_event_key);`,
});

assertReceiptConstraintMismatch({
  label: 'unvalidated CHECK constraint fails actual startup and release checks',
  constraintName: 'game_progress_save_commits_learning_cycle_version_check',
  mutationSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_learning_cycle_version_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_learning_cycle_version_check
    CHECK (learning_cycle_version >= 0) NOT VALID;`,
  restoreSql: `ALTER TABLE public.game_progress_save_commits DROP CONSTRAINT game_progress_save_commits_learning_cycle_version_check;
    ALTER TABLE public.game_progress_save_commits ADD CONSTRAINT game_progress_save_commits_learning_cycle_version_check
    CHECK (learning_cycle_version >= 0);`,
});

const gameStudentIdWidth = invokePreflight(CASES.incompatibleGameStudentIdWidth);
assert.equal(gameStudentIdWidth.status, 3, `incompatible game_student_id width must fail closed: ${gameStudentIdWidth.stderr}\n${gameStudentIdWidth.stdout}`);
assert.match(gameStudentIdWidth.stdout, /STOP: accounts\.game_student_id must be VARCHAR\(8\)/);
recordScenario('incompatible accounts.game_student_id width fails closed');

const malformed = invokePreflight(CASES.malformedLedger);
assert.equal(malformed.status, 3, `malformed migration metadata must fail closed: ${malformed.stderr}\n${malformed.stdout}`);
assert.match(malformed.stdout, /STOP: applied migration filename or checksum differs/);
recordScenario('malformed migration checksum fails closed');

const wrongFilename = invokePreflight(CASES.wrongFilenameLedger);
assert.equal(wrongFilename.status, 3, `inconsistent migration filename must fail closed: ${wrongFilename.stderr}\n${wrongFilename.stdout}`);
assert.match(wrongFilename.stdout, /STOP: applied migration filename or checksum differs/);
recordScenario('migration version with an inconsistent filename fails closed');

const missingLedger = invokePreflight(CASES.missingLedger);
assert.equal(missingLedger.status, 3, `missing migration ledger must fail closed: ${missingLedger.stderr}\n${missingLedger.stdout}`);
assert.match(missingLedger.stdout, /STOP: schema_migrations is absent/);
recordScenario('missing migration ledger fails closed');

const pendingStateQuery = `
  SELECT (SELECT count(*) FROM public.accounts)::text || '|' ||
         (SELECT count(*) FROM public.game_results)::text || '|' ||
         (SELECT count(*) FROM public.playtime_sessions)::text || '|' ||
         (SELECT count(*) FROM public.schema_migrations)::text || '|' ||
         (SELECT COALESCE(max(version), 0) FROM public.schema_migrations)::text;
`;
const pendingStateBefore = psql(CASES.pending024, 'postgres', pendingStateQuery);
assert.equal(pendingStateBefore.status, 0, pendingStateBefore.stderr);

const pending024 = invokePreflight(CASES.pending024);
const pending024Output = `${pending024.stdout}\n${pending024.stderr}`;
assert.equal(pending024.status, 3, `pending migration 024 must fail closed: ${pending024Output}`);
assert.match(pending024Output, /STOP: destructive migration 024 is pending/i);
assert.match(pending024Output, /separate impact review and approval are required/i);
assert.match(pending024Output, /does not query application rows or apply migrations/i);
assert.doesNotMatch(pending024Output, /synthetic-only-name|123456/);
assert.doesNotMatch(pending024Output, /permission denied/i, 'the restricted role must reach the explicit ledger stop without attempting application-table SELECT');

const pendingStateAfter = psql(CASES.pending024, 'postgres', pendingStateQuery);
assert.equal(pendingStateAfter.status, 0, pendingStateAfter.stderr);
assert.equal(pendingStateAfter.stdout.trim(), pendingStateBefore.stdout.trim(), 'pending-024 preflight must not change synthetic application rows or the migration ledger');
recordScenario('pending migration 024 stops from ledger metadata before application-row reads and applies no migration');

const preMigration026 = invokePreMigration026(CASES.preMigration026);
assert.equal(preMigration026.status, 0, `valid pre-026 schema must pass using the restricted role: ${preMigration026.stderr}\n${preMigration026.stdout}`);
assert.match(preMigration026.stdout, /Pre-migration startup contract is 17 tables and 269 columns/);
assert.match(preMigration026.stdout, /Migration 026 is the expected pending migration/);
assert.match(preMigration026.stdout, /PASS: pre-026 metadata prerequisites verified/);
assert.doesNotMatch(preMigration026.stderr, /permission denied for table/i);
recordScenario('pre-migration 026 baseline passes with exactly 17 tables, 269 columns, and metadata-only access');

const preMigrationStartup = invokeStartupReadiness(CASES.preMigration026);
assert.equal(preMigrationStartup.status, 0, preMigrationStartup.stderr);
assert.ok(preMigrationStartup.stdout.trim().split(/\r?\n/).includes('game_progress_save_commits'),
  `the current-main startup contract must reject the valid pre-026 schema until the separately approved migration is applied: ${preMigrationStartup.stdout}`);
recordScenario('current-main startup SQL blocks a valid pre-026 schema without changing its migration preflight result');

const addPartialReceipt = psql(CASES.partialReceipt026, 'postgres',
  'CREATE TABLE public.game_progress_save_commits_partial (id integer);');
assert.equal(addPartialReceipt.status, 0, addPartialReceipt.stderr);
const partialReceipt = invokePreMigration026(CASES.partialReceipt026);
const partialReceiptOutput = `${partialReceipt.stdout}\n${partialReceipt.stderr}`;
assert.equal(partialReceipt.status, 3, `partial receipt object must stop preflight: ${partialReceiptOutput}`);
assert.match(partialReceiptOutput, /receipt objects are present or partial/i);
assert.doesNotMatch(partialReceiptOutput, /permission denied for table/i);
const partialStartup = invokeStartupReadiness(CASES.partialReceipt026);
assert.equal(partialStartup.status, 0, partialStartup.stderr);
assert.ok(partialStartup.stdout.includes('game_progress_save_commits'),
  `startup readiness must report the absent canonical receipt relation: ${partialStartup.stdout}`);
recordScenario('partial migration-026 receipt objects are rejected using catalog-only access');

const migration026Applied = invokePreMigration026(CASES.migration026Applied);
const migration026AppliedOutput = `${migration026Applied.stdout}\n${migration026Applied.stderr}`;
assert.equal(migration026Applied.status, 3, `already-applied 026 must use the post-migration check: ${migration026AppliedOutput}`);
assert.match(migration026AppliedOutput, /migration 026 is already recorded/i);
recordScenario('pre-migration check refuses a database where migration 026 is already recorded');

const pre024StateBefore = psql(CASES.preMigration024Pending, 'postgres', pendingStateQuery);
assert.equal(pre024StateBefore.status, 0, pre024StateBefore.stderr);
const preMigration024Pending = invokePreMigration026(CASES.preMigration024Pending);
const preMigration024Output = `${preMigration024Pending.stdout}\n${preMigration024Pending.stderr}`;
assert.equal(preMigration024Pending.status, 3, `pending migration 024 must stop the pre-026 check: ${preMigration024Output}`);
assert.match(preMigration024Output, /STOP: destructive migration 024 is pending/i);
assert.match(preMigration024Output, /separate impact review and approval are required/i);
assert.doesNotMatch(preMigration024Output, /permission denied for table/i);
assert.doesNotMatch(preMigration024Output, /synthetic-only-name|123456/);
const pre024StateAfter = psql(CASES.preMigration024Pending, 'postgres', pendingStateQuery);
assert.equal(pre024StateAfter.status, 0, pre024StateAfter.stderr);
assert.equal(pre024StateAfter.stdout.trim(), pre024StateBefore.stdout.trim(), 'pre-026 024 stop must not change synthetic rows or the ledger');
recordScenario('pre-migration check stops on 024 before application-row reads or any migration');

const pending025Before = psql(CASES.pending025, 'postgres',
  'SELECT count(*)::text || \'|\' || COALESCE(max(version), 0)::text FROM public.schema_migrations;');
assert.equal(pending025Before.status, 0, pending025Before.stderr);
const pending025 = invokePreMigration026(CASES.pending025);
const pending025Output = `${pending025.stdout}\n${pending025.stderr}`;
assert.equal(pending025.status, 3, `pending migration 025 must stop preflight: ${pending025Output}`);
assert.match(pending025Output, /STOP: migration 025 is pending/i);
assert.doesNotMatch(pending025Output, /permission denied for table/i);
const pending025After = psql(CASES.pending025, 'postgres',
  'SELECT count(*)::text || \'|\' || COALESCE(max(version), 0)::text FROM public.schema_migrations;');
assert.equal(pending025After.status, 0, pending025After.stderr);
assert.equal(pending025After.stdout.trim(), pending025Before.stdout.trim(),
  'pending-025 preflight must neither change the ledger nor execute a migration');
recordScenario('migration 025 pending fails closed without changing the ledger or applying a migration');

assert.equal(passedScenarioCount, 41, 'all expected PostgreSQL major-version and release-preflight scenarios must execute');

const createSyntheticBackupProbe = psql(CASES.valid, 'postgres', `
  CREATE TABLE public.release_backup_synthetic_probe (marker text PRIMARY KEY);
  INSERT INTO public.release_backup_synthetic_probe(marker) VALUES ('synthetic-only-backup-probe');
`);
assert.equal(createSyntheticBackupProbe.status, 0, createSyntheticBackupProbe.stderr);
const createBackupRole = psql('postgres', 'postgres', `
  CREATE ROLE tq_prod_backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  GRANT CONNECT ON DATABASE ${CASES.valid} TO tq_prod_backup_reader;
`);
assert.equal(createBackupRole.status, 0, createBackupRole.stderr);
const grantBackupRole = psql(CASES.valid, 'postgres', `
  GRANT USAGE ON SCHEMA public TO tq_prod_backup_reader;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO tq_prod_backup_reader;
  GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO tq_prod_backup_reader;
`);
assert.equal(grantBackupRole.status, 0, grantBackupRole.stderr);
const backupRoleAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(backupRoleAudit.status, 0,
  `dedicated disposable backup role must pass its read-only catalog audit: ${backupRoleAudit.stderr}\n${backupRoleAudit.stdout}`);
assert.match(backupRoleAudit.stdout, /unreadable_relation_count=0/);
assert.match(backupRoleAudit.stdout, /unreadable_sequence_count=0/);
assert.match(backupRoleAudit.stdout, /relation_write_privilege_count=0/);
recordScenario('synthetic backup role has read-only access to every fixture relation and sequence');

const dump = dockerBinary([
  'exec', CONTAINER, 'pg_dump', '--host=127.0.0.1', '--port=5432',
  '--username=tq_prod_backup_reader', `--dbname=${CASES.valid}`,
  '--no-password', '--format=custom', '--compress=6', '--no-owner', '--no-privileges',
  '--lock-wait-timeout=5s',
]);
assert.equal(dump.status, 0, `synthetic pg_dump must succeed without external networking: ${String(dump.stderr || '')}`);
assert.ok(Buffer.isBuffer(dump.stdout) && dump.stdout.length > 0, 'custom-format synthetic archive must be nonempty');
const archiveSha256 = crypto.createHash('sha256').update(dump.stdout).digest('hex');
assert.match(archiveSha256, /^[a-f0-9]{64}$/);

const restoreDatabase = 'tq_restore_backup_test_ci';
const createRestoreRole = psql('postgres', 'postgres',
  'CREATE ROLE tq_restore_operator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;');
assert.equal(createRestoreRole.status, 0, createRestoreRole.stderr);
const createRestoreDatabase = docker([
  'exec', CONTAINER, 'createdb', '--host=127.0.0.1', '--port=5432', '--username=postgres',
  '--owner=tq_restore_operator', restoreDatabase,
]);
assert.equal(createRestoreDatabase.status, 0, createRestoreDatabase.stderr);
const stampRestoreDatabase = psql('postgres', 'postgres',
  `COMMENT ON DATABASE ${restoreDatabase} IS '${SENTINEL_PREFIX}${process.env.TQ_DISPOSABLE_DB_SENTINEL}';`);
assert.equal(stampRestoreDatabase.status, 0, stampRestoreDatabase.stderr);
const restoreTarget = psql(restoreDatabase, 'tq_restore_operator', `
  SELECT current_database() = '${restoreDatabase}'
     AND current_user = 'tq_restore_operator'
     AND host(inet_server_addr()) = '127.0.0.1'
     AND inet_server_port() = 5432
     AND NOT COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit
                       FROM pg_catalog.pg_roles WHERE rolname=current_user), true)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S'));
`);
assert.equal(restoreTarget.status, 0, restoreTarget.stderr);
assert.equal(restoreTarget.stdout.trim(), 't', 'restore target must be an empty loopback DB owned by a non-admin NOINHERIT role');
const restore = dockerBinary([
  'exec', '-i', CONTAINER, 'pg_restore', '--host=127.0.0.1', '--port=5432',
  '--username=tq_restore_operator', `--dbname=${restoreDatabase}`,
  '--no-password', '--format=custom', '--exit-on-error', '--single-transaction',
  '--no-owner', '--no-privileges',
], dump.stdout);
assert.equal(restore.status, 0, `synthetic pg_restore to empty loopback target must succeed: ${String(restore.stderr || '')}`);
const restoredProbe = psql(restoreDatabase, 'tq_restore_operator', `
  BEGIN READ ONLY;
  SELECT current_database() = '${restoreDatabase}'
     AND current_user = 'tq_restore_operator'
     AND (SELECT COUNT(*) FROM public.release_backup_synthetic_probe WHERE marker='synthetic-only-backup-probe') = 1
     AND (SELECT COUNT(*) FROM public.schema_migrations WHERE version BETWEEN 18 AND 26) = 9
     AND to_regclass('public.game_progress_save_commits') IS NOT NULL;
  ROLLBACK;
`);
assert.equal(restoredProbe.status, 0, restoredProbe.stderr);
assert.equal(restoredProbe.stdout.trim(), 't', 'restored synthetic data and migration metadata must be present');
recordScenario('custom archive restores transactionally into an empty isolated loopback database and retains synthetic data');

assert.equal(passedScenarioCount, 43, 'all expected PostgreSQL version, release-preflight, and backup scenarios must execute');
console.log(`Preflight integration result: ${passedScenarioCount}/${passedScenarioCount} disposable PostgreSQL scenarios passed.`);
