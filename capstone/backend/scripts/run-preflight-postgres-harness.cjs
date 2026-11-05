'use strict';

// This integration check is intentionally restricted to the PostgreSQL
// container created by backend-network-isolated.yml. It never accepts a URL
// or an arbitrary database name, and it refuses to run outside GitHub CI.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { REQUIRED_SCHEMA } = require('../database/startupSchemaReadiness');
const { RELEASE_MIGRATIONS, migrationChecksum } = require('../releaseMigrations');
const fs = require('node:fs');

const CONTAINER = 'tq-backend-test-postgres';
const ROLE = 'tq_preflight_reader';
const SENTINEL_PREFIX = 'tq-disposable-ci:';
const CASES = Object.freeze({
  valid: 'tq_preflight_valid_test_ci',
  missingLedger: 'tq_preflight_missing_ledger_test_ci',
  missingTable: 'tq_preflight_missing_table_test_ci',
  missingColumn: 'tq_preflight_missing_column_test_ci',
  incompatibleType: 'tq_preflight_incompatible_type_test_ci',
  malformedLedger: 'tq_preflight_malformed_ledger_test_ci',
  pending024: 'tq_preflight_pending_024_test_ci',
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
  assert.equal(inspect.stdout.trim(), 'none|true|null', 'PostgreSQL must be network-isolated, read-only-rootfs, and have no published ports');

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
    ['playtime_sessions.deleted_by', 'integer'],
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
  if (!['pending024', 'missingLedger'].includes(mode)) {
    statements.push(...RELEASE_MIGRATIONS.map(({ version, file }) => {
      const checksum = mode === 'malformedLedger' && version === 18
        ? '0'.repeat(64)
        : migrationChecksum(fs.readFileSync(require('node:path').join(__dirname, '../migrations', file), 'utf8'));
      return `INSERT INTO public.schema_migrations (version, filename, checksum) VALUES (${version}, '${file}', '${checksum}');`;
    }));
  } else if (mode === 'pending024') {
    statements.push(...RELEASE_MIGRATIONS.filter(({ version }) => version < 24).map(({ version, file }) => {
      const checksum = migrationChecksum(fs.readFileSync(require('node:path').join(__dirname, '../migrations', file), 'utf8'));
      return `INSERT INTO public.schema_migrations (version, filename, checksum) VALUES (${version}, '${file}', '${checksum}');`;
    }));
  }
  statements.push(`GRANT USAGE ON SCHEMA public TO ${ROLE}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE};`);
  return statements.join('\n');
}

function invokePreflight(database, overrides = {}) {
  return psql(database, ROLE, fs.readFileSync(require('node:path').join(__dirname, 'release-migration-preflight.sql'), 'utf8'), {
    expected_database: database,
    expected_role: ROLE,
    expected_server_address: '127.0.0.1',
    expected_server_port: '5432',
    ...overrides,
  });
}

assertCiContainer();
const createRole = psql('postgres', 'postgres', `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`);
assert.equal(createRole.status, 0, createRole.stderr);
for (const [mode, database] of Object.entries(CASES)) {
  const grantConnect = psql('postgres', 'postgres', `GRANT CONNECT ON DATABASE ${database} TO ${ROLE};`);
  assert.equal(grantConnect.status, 0, grantConnect.stderr);
  const fixture = psql(database, 'postgres', fixtureSql(mode));
  assert.equal(fixture.status, 0, `${mode} fixture setup failed: ${fixture.stderr}`);
}

const valid = invokePreflight(CASES.valid);
assert.equal(valid.status, 0, `valid disposable schema must pass: ${valid.stderr}\n${valid.stdout}`);
assert.match(valid.stdout, /Startup schema contract is complete: 17 tables and 265 required columns are present/);
console.log('PASS: compatible 17-table/265-column schema and migration ledger');

const wrongTarget = invokePreflight(CASES.valid, { expected_database: 'unexpected_target' });
assert.equal(wrongTarget.status, 3, `wrong target fingerprint must fail closed: ${wrongTarget.stderr}\n${wrongTarget.stdout}`);
assert.match(wrongTarget.stdout, /STOP: target database identity or read-only transaction/);
console.log('PASS: incorrect expected database identity fails closed');

const grantWrite = psql(CASES.valid, 'postgres', `GRANT INSERT ON public.accounts TO ${ROLE};`);
assert.equal(grantWrite.status, 0, grantWrite.stderr);
const writableRole = invokePreflight(CASES.valid);
const revokeWrite = psql(CASES.valid, 'postgres', `REVOKE INSERT ON public.accounts FROM ${ROLE};`);
assert.equal(revokeWrite.status, 0, revokeWrite.stderr);
assert.equal(writableRole.status, 3, `role with write privilege must fail closed: ${writableRole.stderr}\n${writableRole.stdout}`);
assert.match(writableRole.stdout, /STOP: expected a dedicated non-admin read-only database role/);
console.log('PASS: role with an INSERT privilege fails closed');

for (const [mode, phrase] of [
  ['missingTable', 'student_ai_insights'],
  ['missingColumn', 'accounts.address'],
]) {
  const result = invokePreflight(CASES[mode]);
  assert.equal(result.status, 3, `${mode} must fail closed with psql exit 3: ${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, new RegExp(phrase.replace('.', '\\.')));
  assert.match(result.stdout, /STOP: one or more required tables or columns are missing/);
  console.log(`PASS: ${mode} fails closed with a schema-only diagnostic`);
}

const incompatible = invokePreflight(CASES.incompatibleType);
assert.equal(incompatible.status, 3, `incompatible type must fail closed: ${incompatible.stderr}\n${incompatible.stdout}`);
assert.match(incompatible.stdout, /accounts.*current_learning_cycle_version.*integer.*text/s);
assert.match(incompatible.stdout, /STOP: one or more core column types do not match/);
console.log('PASS: incompatible core type fails closed');

const malformed = invokePreflight(CASES.malformedLedger);
assert.equal(malformed.status, 3, `malformed migration metadata must fail closed: ${malformed.stderr}\n${malformed.stdout}`);
assert.match(malformed.stdout, /STOP: applied migration filename or checksum differs/);
console.log('PASS: malformed migration checksum fails closed');

const missingLedger = invokePreflight(CASES.missingLedger);
assert.equal(missingLedger.status, 3, `missing migration ledger must fail closed: ${missingLedger.stderr}\n${missingLedger.stdout}`);
assert.match(missingLedger.stdout, /STOP: schema_migrations is absent/);
console.log('PASS: missing migration ledger fails closed');

const pending024 = invokePreflight(CASES.pending024);
assert.equal(pending024.status, 4, `pending migration 024 must report impact then stop: ${pending024.stderr}\n${pending024.stdout}`);
assert.match(pending024.stdout, /Migration 024 direct count-only impact follows/);
assert.match(pending024.stdout, /fixture_progress_student_fk/);
assert.match(pending024.stdout, /STOP: migration 024 is pending/);
assert.doesNotMatch(pending024.stdout, /synthetic-only-name|123456/);
console.log('PASS: migration 024 emits aggregate impact, discloses no fixture values, then stops');

console.log('Preflight integration result: 9/9 disposable PostgreSQL scenarios passed.');
