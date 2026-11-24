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

function invokeBackupReleaseState(database, role = 'postgres', overrides = {}) {
  return psql(database, role, fs.readFileSync(
    require('node:path').join(__dirname, 'backup-release-state-preflight.sql'),
    'utf8',
  ), {
    expected_database: database,
    expected_role: role,
    expected_server_address: '127.0.0.1',
    expected_server_port: '5432',
    ...overrides,
  });
}

function backupLedgerShapeDiagnostics(database) {
  const result = psql(database, 'postgres', `
    BEGIN READ ONLY;
    SET LOCAL statement_timeout = '10s';
    SET LOCAL lock_timeout = '2s';
    SET LOCAL search_path = pg_catalog;
    SELECT jsonb_build_object(
      'relation', (
        SELECT jsonb_build_object('kind', relation.relkind::text, 'persistence', relation.relpersistence::text)
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = 'schema_migrations'
      ),
      'columns', (
        SELECT jsonb_agg(jsonb_build_object(
          'name', attribute.attname,
          'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
          'notNull', attribute.attnotnull
        ) ORDER BY attribute.attnum)
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.schema_migrations'::regclass
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ),
      'appliedAtDefault', (
        SELECT pg_catalog.pg_get_expr(default_record.adbin, default_record.adrelid)
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_attrdef AS default_record
          ON default_record.adrelid = attribute.attrelid AND default_record.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.schema_migrations'::regclass
          AND attribute.attname = 'applied_at'
      ),
      'constraints', (
        SELECT jsonb_agg(jsonb_build_object(
          'name', constraint_record.conname,
          'type', constraint_record.contype::text,
          'columns', constraint_record.conkey::text,
          'deferrable', constraint_record.condeferrable,
          'deferred', constraint_record.condeferred,
          'validated', constraint_record.convalidated
        ) ORDER BY constraint_record.conname)
        FROM pg_catalog.pg_constraint AS constraint_record
        WHERE constraint_record.conrelid = 'public.schema_migrations'::regclass
      ),
      'indexes', (
        SELECT jsonb_agg(jsonb_build_object(
          'name', index_relation.relname,
          'unique', index_record.indisunique,
          'primary', index_record.indisprimary,
          'immediate', index_record.indimmediate,
          'valid', index_record.indisvalid,
          'ready', index_record.indisready,
          'live', index_record.indislive,
          'keyCount', index_record.indnkeyatts,
          'attributeCount', index_record.indnatts,
          'accessMethod', access_method.amname,
          'keyColumns', (
            SELECT jsonb_agg(attribute_record.attname::text ORDER BY key_record.ordinality)
            FROM unnest(index_record.indkey) WITH ORDINALITY AS key_record(attnum, ordinality)
            JOIN pg_catalog.pg_attribute AS attribute_record
              ON attribute_record.attrelid = index_record.indrelid
             AND attribute_record.attnum = key_record.attnum
            WHERE key_record.ordinality <= index_record.indnkeyatts
          )
        ) ORDER BY index_relation.relname)
        FROM pg_catalog.pg_index AS index_record
        JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
        JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
        WHERE index_record.indrelid = 'public.schema_migrations'::regclass
      )
    )::text;
    ROLLBACK;
  `);
  const detail = result.status === 0
    ? String(result.stdout || '').trim()
    : `queryStatus=${result.status} queryError=${String(result.stderr || '').trim().replaceAll('\n', ' ').replaceAll('\r', ' ')}`;
  console.error(`BACKUP_LEDGER_SHAPE_DIAGNOSTICS ${detail}`);
}

function parseBackupReleaseState(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0 && /BACKUP_TARGET_IDENTITY=FAIL/.test(output)) return 'IDENTITY_FAIL';
  assert.match(output, /^BACKUP_TARGET_IDENTITY=PASS$/m, output);
  const ledgerShape = output.match(/^BACKUP_LEDGER_SHAPE=(PASS|UNVERIFIED)$/m);
  if (ledgerShape) {
    assert.equal(ledgerShape[1], 'PASS', `backup migration ledger shape is not verified: ${output}`);
  } else {
    assert.match(output, /^BACKUP_RELEASE_READINESS=UNVERIFIED(?:\||$)/m,
      `ledger-shape status may be absent only when the ledger itself is absent: ${output}`);
  }
  const row = output.match(/^BACKUP_RELEASE_READINESS=(PRE_MIGRATION_026|POST_MIGRATION_026|UNVERIFIED)\|BACKUP_METADATA_FINGERPRINT=([a-f0-9]{32}|UNAVAILABLE)\|BACKUP_DATABASE_SIZE_BYTES=(\d+)$/m);
  assert.ok(row, `backup release-state metadata row missing: ${output}`);
  return { readiness: row[1], fingerprint: row[2], databaseSizeBytes: Number(row[3]) };
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
  const preflightOutput = `${preflight.stdout}\n${preflight.stderr}`;
  assert.match(preflightOutput, /STOP: migration 026 receipt constraints are missing or incompatible/,
    `${label} must report the receipt-constraint STOP; stdout: ${preflight.stdout}; stderr: ${preflight.stderr}`);

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
  -- PostgreSQL 18 exposes NOT NULL as contype 'n'; count the eight structural constraints only.
  SELECT (SELECT count(*) FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.game_progress_save_commits'::regclass
            AND attnum > 0 AND NOT attisdropped)::text || '|' ||
         (SELECT count(*) FROM pg_catalog.pg_constraint
          WHERE conrelid = 'public.game_progress_save_commits'::regclass
            AND contype <> 'n')::text;
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
const restoredPublicTempAudit = invokeRoleAudit(CASES.valid);
assert.equal(restoredPublicTempAudit.status, 0,
  `role audit must pass after PUBLIC TEMP is revoked: ${restoredPublicTempAudit.stderr}\n${restoredPublicTempAudit.stdout}`);
assert.match(restoredPublicTempAudit.stdout, /PASS: target identity, read-only limits, and preflight-only privileges verified/);
recordScenario('inherited PUBLIC TEMP is rejected and the valid audit is restored after revoke');

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
// The table-wide SELECT negative case may remove all column ACLs; restore only the allowed columns.
const restoreLedgerColumnRead = psql(CASES.valid, 'postgres',
  `GRANT SELECT (version, filename, checksum) ON public.schema_migrations TO ${ROLE};`);
assert.equal(restoreLedgerColumnRead.status, 0, restoreLedgerColumnRead.stderr);
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

const preBackupStateResult = invokeBackupReleaseState(CASES.preMigration026);
assert.equal(preBackupStateResult.status, 0, preBackupStateResult.stderr);
if (/^BACKUP_LEDGER_SHAPE=UNVERIFIED$/m.test(`${preBackupStateResult.stdout}\n${preBackupStateResult.stderr}`)) {
  backupLedgerShapeDiagnostics(CASES.preMigration026);
}
const preBackupState = parseBackupReleaseState(preBackupStateResult);
assert.equal(preBackupState.readiness, 'PRE_MIGRATION_026',
  `valid synthetic pre-026 fixture must be classified as ready: ${preBackupStateResult.stdout}\n${preBackupStateResult.stderr}`);
assert.match(preBackupState.fingerprint, /^[a-f0-9]{32}$/);
assert.ok(preBackupState.databaseSizeBytes > 0);
const preBackupStateRepeat = parseBackupReleaseState(invokeBackupReleaseState(CASES.preMigration026));
assert.deepEqual(preBackupStateRepeat, preBackupState, 'metadata-only fingerprint must remain stable without schema/data changes');
recordScenario('read-only backup classifier recognizes stable exact pre-026 migration history');

const postBackupStateResult = invokeBackupReleaseState(CASES.migration026Applied);
assert.equal(postBackupStateResult.status, 0, postBackupStateResult.stderr);
const postBackupState = parseBackupReleaseState(postBackupStateResult);
assert.equal(postBackupState.readiness, 'POST_MIGRATION_026');
recordScenario('read-only backup classifier recognizes complete post-026 receipt schema and ledger');

const partialBackupStateResult = invokeBackupReleaseState(CASES.partialReceipt026);
assert.equal(partialBackupStateResult.status, 0, partialBackupStateResult.stderr);
assert.equal(parseBackupReleaseState(partialBackupStateResult).readiness, 'UNVERIFIED');
recordScenario('partial receipt objects remain recoverable but release readiness is unverified');

const orphanConstraint = psql(CASES.preMigration026, 'postgres',
  'ALTER TABLE public.activity_logs ADD CONSTRAINT game_progress_save_commits_pkey CHECK (true);');
assert.equal(orphanConstraint.status, 0, orphanConstraint.stderr);
const orphanConstraintState = parseBackupReleaseState(invokeBackupReleaseState(CASES.preMigration026));
assert.equal(orphanConstraintState.readiness, 'UNVERIFIED');
const dropOrphanConstraint = psql(CASES.preMigration026, 'postgres',
  'ALTER TABLE public.activity_logs DROP CONSTRAINT game_progress_save_commits_pkey;');
assert.equal(dropOrphanConstraint.status, 0, dropOrphanConstraint.stderr);
recordScenario('orphaned migration-026 constraint prevents pre-migration readiness classification');

const orphanTrigger = psql(CASES.preMigration026, 'postgres', `
  CREATE FUNCTION public.tq_orphan_receipt_probe() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
  CREATE TRIGGER game_progress_save_commits_orphan_trigger
    BEFORE INSERT ON public.activity_logs FOR EACH ROW
    EXECUTE FUNCTION public.tq_orphan_receipt_probe();
`);
assert.equal(orphanTrigger.status, 0, orphanTrigger.stderr);
const orphanTriggerState = parseBackupReleaseState(invokeBackupReleaseState(CASES.preMigration026));
assert.equal(orphanTriggerState.readiness, 'UNVERIFIED');
const dropOrphanTrigger = psql(CASES.preMigration026, 'postgres', `
  DROP TRIGGER game_progress_save_commits_orphan_trigger ON public.activity_logs;
  DROP FUNCTION public.tq_orphan_receipt_probe();
`);
assert.equal(dropOrphanTrigger.status, 0, dropOrphanTrigger.stderr);
recordScenario('orphaned migration-026 trigger prevents pre-migration readiness classification');

const orphanType = psql(CASES.preMigration026, 'postgres',
  "CREATE TYPE public.game_progress_save_commits AS ENUM ('probe');");
assert.equal(orphanType.status, 0, orphanType.stderr);
const orphanTypeState = parseBackupReleaseState(invokeBackupReleaseState(CASES.preMigration026));
assert.equal(orphanTypeState.readiness, 'UNVERIFIED');
const dropOrphanType = psql(CASES.preMigration026, 'postgres', 'DROP TYPE public.game_progress_save_commits;');
assert.equal(dropOrphanType.status, 0, dropOrphanType.stderr);
recordScenario('orphaned migration-026 type prevents pre-migration readiness classification');

const pending024BackupStateResult = invokeBackupReleaseState(CASES.preMigration024Pending);
assert.equal(pending024BackupStateResult.status, 0, pending024BackupStateResult.stderr);
assert.equal(parseBackupReleaseState(pending024BackupStateResult).readiness, 'UNVERIFIED');
recordScenario('pending migration 024 is classified unverified without blocking archive recovery');

const malformedBackupStateResult = invokeBackupReleaseState(CASES.malformedLedger);
assert.equal(malformedBackupStateResult.status, 0, malformedBackupStateResult.stderr);
assert.equal(parseBackupReleaseState(malformedBackupStateResult).readiness, 'UNVERIFIED');
recordScenario('altered historical checksum is classified unverified without changing the ledger');

const missingLedgerBackupStateResult = invokeBackupReleaseState(CASES.missingLedger);
assert.equal(missingLedgerBackupStateResult.status, 0, missingLedgerBackupStateResult.stderr);
assert.equal(parseBackupReleaseState(missingLedgerBackupStateResult).readiness, 'UNVERIFIED');
recordScenario('missing migration ledger is unverified but returns only aggregate size metadata');

const wrongIdentityStateResult = invokeBackupReleaseState(CASES.preMigration026, 'postgres', { expected_database: 'tq_wrong_identity_test_ci' });
assert.equal(wrongIdentityStateResult.status, 3, `${wrongIdentityStateResult.stderr}\n${wrongIdentityStateResult.stdout}`);
assert.equal(parseBackupReleaseState(wrongIdentityStateResult), 'IDENTITY_FAIL');
const wrongRoleStateResult = invokeBackupReleaseState(CASES.preMigration026, ROLE, { expected_role: 'tq_wrong_role_test_ci' });
assert.equal(wrongRoleStateResult.status, 3, `${wrongRoleStateResult.stderr}\n${wrongRoleStateResult.stdout}`);
assert.equal(parseBackupReleaseState(wrongRoleStateResult), 'IDENTITY_FAIL');
recordScenario('backup-state classifier exits nonzero for database or role identity mismatches');

const preRestoreDatabase = 'tq_restore_backup_pre026_test_ci';
assert.match(preRestoreDatabase, /^tq_restore_[a-z0-9_]+_test_ci$/);
const createRestoreRole = psql('postgres', 'postgres',
  'CREATE ROLE tq_restore_operator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;');
assert.equal(createRestoreRole.status, 0, createRestoreRole.stderr);
const createPreRestoreDatabase = docker([
  'exec', CONTAINER, 'createdb', '--host=127.0.0.1', '--port=5432', '--username=postgres',
  '--owner=tq_restore_operator', preRestoreDatabase,
]);
assert.equal(createPreRestoreDatabase.status, 0, createPreRestoreDatabase.stderr);
const stampPreRestoreDatabase = psql('postgres', 'postgres',
  `COMMENT ON DATABASE ${preRestoreDatabase} IS '${SENTINEL_PREFIX}${process.env.TQ_DISPOSABLE_DB_SENTINEL}';`);
assert.equal(stampPreRestoreDatabase.status, 0, stampPreRestoreDatabase.stderr);
const verifyPreRestoreSentinel = docker([
  'exec', CONTAINER, 'psql', '--host=127.0.0.1', '--port=5432', '--username=postgres', `--dbname=${preRestoreDatabase}`,
  '--no-psqlrc', '--tuples-only', '--no-align',
  '--command=SELECT shobj_description(oid, \'pg_database\') FROM pg_database WHERE datname = current_database();',
]);
assert.equal(verifyPreRestoreSentinel.status, 0, verifyPreRestoreSentinel.stderr);
assert.equal(verifyPreRestoreSentinel.stdout.trim(), `${SENTINEL_PREFIX}${process.env.TQ_DISPOSABLE_DB_SENTINEL}`,
  'the new pre-026 restore database must be marked with this run’s disposable-database sentinel');
const preRestoreTarget = psql(preRestoreDatabase, 'tq_restore_operator', `
  SELECT current_database() = '${preRestoreDatabase}'
     AND current_user = 'tq_restore_operator'
     AND host(inet_server_addr()) = '127.0.0.1'
     AND inet_server_port() = 5432
     AND NOT COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit
                       FROM pg_catalog.pg_roles WHERE rolname=current_user), true)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S'));
`);
assert.equal(preRestoreTarget.status, 0, preRestoreTarget.stderr);
assert.equal(preRestoreTarget.stdout.trim(), 't', 'pre-026 archive target must be empty and loopback-only');
const preSourceState = parseBackupReleaseState(invokeBackupReleaseState(CASES.preMigration026));
const preDump = dockerBinary([
  'exec', CONTAINER, 'pg_dump', '--host=127.0.0.1', '--port=5432', '--username=postgres',
  `--dbname=${CASES.preMigration026}`, '--no-password', '--format=custom', '--compress=6', '--no-owner',
  '--no-privileges', '--no-tablespaces', '--lock-wait-timeout=5s',
]);
assert.equal(preDump.status, 0, `synthetic pre-026 pg_dump failed: ${String(preDump.stderr || '')}`);
assert.ok(Buffer.isBuffer(preDump.stdout) && preDump.stdout.length > 0);
const preArchiveDigest = crypto.createHash('sha256').update(preDump.stdout).digest('hex');
assert.match(preArchiveDigest, /^[a-f0-9]{64}$/);
const preRestore = dockerBinary([
  'exec', '-i', CONTAINER, 'pg_restore', '--host=127.0.0.1', '--port=5432',
  '--username=tq_restore_operator', `--dbname=${preRestoreDatabase}`, '--no-password', '--format=custom',
  '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--no-tablespaces',
], preDump.stdout);
assert.equal(preRestore.status, 0, `synthetic pre-026 archive restore failed: ${String(preRestore.stderr || '')}`);
const preRestoredState = parseBackupReleaseState(invokeBackupReleaseState(preRestoreDatabase, 'tq_restore_operator'));
assert.equal(preRestoredState.readiness, 'PRE_MIGRATION_026', 'pre-026 restore must not fail for absent migration 026');
assert.equal(preRestoredState.fingerprint, preSourceState.fingerprint, 'pre-026 source and restored metadata fingerprints must match');
recordScenario('synthetic PostgreSQL archive restores pre-026 into a fresh loopback target with matching catalog fingerprint');

const unexpectedMigration = psql(CASES.preMigration026, 'postgres',
  "INSERT INTO public.schema_migrations(version, filename, checksum) VALUES (27, '027_unexpected.sql', repeat('0', 64));");
assert.equal(unexpectedMigration.status, 0, unexpectedMigration.stderr);
const unexpectedBackupStateResult = invokeBackupReleaseState(CASES.preMigration026);
assert.equal(unexpectedBackupStateResult.status, 0, unexpectedBackupStateResult.stderr);
assert.equal(parseBackupReleaseState(unexpectedBackupStateResult).readiness, 'UNVERIFIED');
recordScenario('unexpected migration version is preserved and classified unverified');

assert.equal(passedScenarioCount, 53,
  'all expected disposable backup-state classification and pre-026 restore scenarios must execute');

const missingBackupRoleAudit = invokeBackupRoleAudit(CASES.valid);
assert.ok(Number.isInteger(missingBackupRoleAudit.status) && missingBackupRoleAudit.status !== 0,
  'a missing dedicated backup role must fail before the backup procedure can connect');
assert.match(missingBackupRoleAudit.stderr, /role .*tq_prod_backup_reader.* does not exist/i);
recordScenario('missing dedicated backup role fails closed before any archive attempt');

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
const adminRoleSubstitution = psql(CASES.valid, 'postgres', fs.readFileSync(
  require('node:path').join(__dirname, 'backup-role-preflight.sql'), 'utf8'), {
  expected_database: CASES.valid,
  expected_role: 'tq_prod_backup_reader',
  expected_server_address: '127.0.0.1',
  expected_server_port: '5432',
});
assert.equal(adminRoleSubstitution.status, 3,
  `an administrator connection must not satisfy the dedicated backup-role identity gate: ${adminRoleSubstitution.stderr}\n${adminRoleSubstitution.stdout}`);
assert.match(adminRoleSubstitution.stdout, /STOP: backup role, data-read coverage, target, or dump completeness prerequisites failed/i);
recordScenario('administrator credential substitution is rejected by the backup-role identity gate');
const grantBackupRole = psql(CASES.valid, 'postgres', `
  GRANT USAGE ON SCHEMA public TO tq_prod_backup_reader;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO tq_prod_backup_reader;
  GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO tq_prod_backup_reader;
`);
assert.equal(grantBackupRole.status, 0, grantBackupRole.stderr);
const publicLargeObjectCreatorAccess = psql(CASES.valid, 'postgres', `
  SELECT has_function_privilege('tq_prod_backup_reader', 'pg_catalog.lo_creat(integer)', 'EXECUTE')
     AND has_function_privilege('tq_prod_backup_reader', 'pg_catalog.lo_create(oid)', 'EXECUTE')
     AND has_function_privilege('tq_prod_backup_reader', 'pg_catalog.lo_from_bytea(oid,bytea)', 'EXECUTE');
`);
assert.equal(publicLargeObjectCreatorAccess.status, 0, publicLargeObjectCreatorAccess.stderr);
assert.equal(publicLargeObjectCreatorAccess.stdout.trim(), 't',
  'the synthetic baseline must expose the default effective PUBLIC EXECUTE grants');
const publicLargeObjectCreation = psql(CASES.valid, 'tq_prod_backup_reader', 'SELECT lo_create(0);');
assert.equal(publicLargeObjectCreation.status, 0,
  `a NOINHERIT table-reader can create its own LO through PUBLIC EXECUTE on the primary fixture: ${publicLargeObjectCreation.stderr}`);
const publicCreatedLargeObjectOid = publicLargeObjectCreation.stdout.trim();
assert.match(publicCreatedLargeObjectOid, /^\d+$/);
const verifyPublicLargeObjectOwner = psql(CASES.valid, 'postgres', `
  SELECT lomowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='tq_prod_backup_reader')
  FROM pg_catalog.pg_largeobject_metadata WHERE oid=${publicCreatedLargeObjectOid};
`);
assert.equal(verifyPublicLargeObjectOwner.status, 0, verifyPublicLargeObjectOwner.stderr);
assert.equal(verifyPublicLargeObjectOwner.stdout.trim(), 't', 'the callable creator assigns ownership to the backup role');
const cleanupPublicLargeObject = psql(CASES.valid, 'postgres', `SELECT lo_unlink(${publicCreatedLargeObjectOid});`);
assert.equal(cleanupPublicLargeObject.status, 0, cleanupPublicLargeObject.stderr);
const publicCreatorRoleAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(publicCreatorRoleAudit.status, 3,
  `effective PUBLIC creator execution must fail the backup-role audit: ${publicCreatorRoleAudit.stderr}\n${publicCreatorRoleAudit.stdout}`);
assert.match(publicCreatorRoleAudit.stdout, /executable_large_object_creation_function_count=3/);
recordScenario('public EXECUTE on large-object creation functions is rejected after proving actual LO creation');

const enableReadOnlyRoleDefault = psql(CASES.valid, 'postgres',
  'ALTER ROLE tq_prod_backup_reader SET default_transaction_read_only = on;');
assert.equal(enableReadOnlyRoleDefault.status, 0, enableReadOnlyRoleDefault.stderr);
const overrideReadOnlyRoleDefault = psql(CASES.valid, 'tq_prod_backup_reader', `
  SET default_transaction_read_only = off;
  SELECT lo_create(0);
`);
assert.equal(overrideReadOnlyRoleDefault.status, 0,
  `a role-level read-only default must not be mistaken for an enforced no-write control: ${overrideReadOnlyRoleDefault.stderr}`);
const overriddenLargeObjectOid = overrideReadOnlyRoleDefault.stdout.trim();
assert.match(overriddenLargeObjectOid, /^\d+$/);
const cleanupOverriddenLargeObject = psql(CASES.valid, 'postgres', `SELECT lo_unlink(${overriddenLargeObjectOid});`);
assert.equal(cleanupOverriddenLargeObject.status, 0, cleanupOverriddenLargeObject.stderr);
const resetReadOnlyRoleDefault = psql(CASES.valid, 'postgres',
  'ALTER ROLE tq_prod_backup_reader RESET default_transaction_read_only;');
assert.equal(resetReadOnlyRoleDefault.status, 0, resetReadOnlyRoleDefault.stderr);
recordScenario('role-level default_transaction_read_only can be overridden and is not a role write prohibition');

const revokePublicLargeObjectCreators = psql(CASES.valid, 'postgres', `
  REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid),
    pg_catalog.lo_from_bytea(oid,bytea) FROM PUBLIC;
`);
assert.equal(revokePublicLargeObjectCreators.status, 0, revokePublicLargeObjectCreators.stderr);
for (const creatorSql of [
  'SELECT lo_creat(-1);',
  'SELECT lo_create(0);',
  "SELECT lo_from_bytea(0, decode('73796e746865746963', 'hex'));",
]) {
  const deniedCreator = psql(CASES.valid, 'tq_prod_backup_reader', creatorSql);
  assert.equal(deniedCreator.status, 3,
    `backup role must not execute revoked LO creator ${creatorSql}: ${deniedCreator.stderr}\n${deniedCreator.stdout}`);
}
const backupRoleAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(backupRoleAudit.status, 0,
  `disposable role with audited read grants and LO creators revoked must pass: ${backupRoleAudit.stderr}\n${backupRoleAudit.stdout}`);
assert.match(backupRoleAudit.stdout, /unreadable_relation_count=0/);
assert.match(backupRoleAudit.stdout, /unreadable_sequence_count=0/);
assert.match(backupRoleAudit.stdout, /unreadable_large_object_count=0/);
assert.match(backupRoleAudit.stdout, /relation_write_privilege_count=0/);
assert.match(backupRoleAudit.stdout, /relation_maintenance_privilege_count=0/);
assert.match(backupRoleAudit.stdout, /parameter_set_privilege_count=0/);
assert.match(backupRoleAudit.stdout, /parameter_alter_system_privilege_count=0/);
assert.match(backupRoleAudit.stdout, /executable_large_object_creation_function_count=0/);
assert.match(backupRoleAudit.stdout, /executable_large_object_server_file_function_count=0/);
assert.match(backupRoleAudit.stdout, /executable_security_definer_function_count=0/);
assert.match(backupRoleAudit.stdout, /executable_untrusted_function_count=0/);
assert.match(backupRoleAudit.stdout,
  /OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED:/,
  'the catalog audit must preserve its explicit unknown-function-side-effect gate');
recordScenario('synthetic role has clean catalog counts while overall nonwriting status remains unverified');
recordScenario('backup role cannot create large objects after mutator EXECUTE is revoked');

const grantSystemSchemaCreate = psql(CASES.valid, 'postgres',
  'GRANT CREATE ON SCHEMA pg_catalog TO tq_prod_backup_reader;');
assert.equal(grantSystemSchemaCreate.status, 0, grantSystemSchemaCreate.stderr);
const systemSchemaCreateAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(systemSchemaCreateAudit.status, 3,
  `CREATE on a system schema must fail the backup-role audit: ${systemSchemaCreateAudit.stderr}\n${systemSchemaCreateAudit.stdout}`);
assert.match(systemSchemaCreateAudit.stdout, /schema_create_privilege_count=1/);
const revokeSystemSchemaCreate = psql(CASES.valid, 'postgres',
  'REVOKE CREATE ON SCHEMA pg_catalog FROM tq_prod_backup_reader;');
assert.equal(revokeSystemSchemaCreate.status, 0, revokeSystemSchemaCreate.stderr);
const postSystemSchemaCreateAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(postSystemSchemaCreateAudit.status, 0,
  `revoking synthetic system-schema CREATE should restore audit readiness: ${postSystemSchemaCreateAudit.stderr}\n${postSystemSchemaCreateAudit.stdout}`);
recordScenario('CREATE privilege on pg_catalog is rejected by backup-role audit');

const backupRoleServerVersion = psql(CASES.valid, 'postgres', "SELECT current_setting('server_version_num');");
assert.equal(backupRoleServerVersion.status, 0, backupRoleServerVersion.stderr);
const serverVersionNumber = Number(backupRoleServerVersion.stdout.trim());
assert.ok(Number.isInteger(serverVersionNumber) && serverVersionNumber >= 160000,
  `backup-role privilege harness requires PostgreSQL 16 or newer, got ${backupRoleServerVersion.stdout.trim()}`);
if (serverVersionNumber >= 170000) {
  const createMaintenanceMaterializedView = psql(CASES.valid, 'postgres', `
    CREATE MATERIALIZED VIEW public.fixture_backup_maintain AS
      SELECT 'synthetic-maintenance-proof'::text AS marker WITH NO DATA;
    GRANT SELECT, MAINTAIN ON TABLE public.fixture_backup_maintain TO tq_prod_backup_reader;
  `);
  assert.equal(createMaintenanceMaterializedView.status, 0, createMaintenanceMaterializedView.stderr);
  const maintainRoleAudit = invokeBackupRoleAudit(CASES.valid);
  assert.equal(maintainRoleAudit.status, 3,
    `effective MAINTAIN must fail the backup-role audit: ${maintainRoleAudit.stderr}\n${maintainRoleAudit.stdout}`);
  assert.match(maintainRoleAudit.stdout, /relation_maintenance_privilege_count=1/);
  const refreshWithMaintain = psql(CASES.valid, 'tq_prod_backup_reader',
    'REFRESH MATERIALIZED VIEW public.fixture_backup_maintain;');
  assert.equal(refreshWithMaintain.status, 0,
    `the synthetic MAINTAIN grant should permit materialized-view refresh: ${refreshWithMaintain.stderr}`);
  const verifyRefreshedMaterializedView = psql(CASES.valid, 'postgres',
    "SELECT marker FROM public.fixture_backup_maintain;");
  assert.equal(verifyRefreshedMaterializedView.status, 0, verifyRefreshedMaterializedView.stderr);
  assert.equal(verifyRefreshedMaterializedView.stdout.trim(), 'synthetic-maintenance-proof');
  const removeMaintenanceMaterializedView = psql(CASES.valid, 'postgres',
    'DROP MATERIALIZED VIEW public.fixture_backup_maintain;');
  assert.equal(removeMaintenanceMaterializedView.status, 0, removeMaintenanceMaterializedView.stderr);
  const postMaintainRoleAudit = invokeBackupRoleAudit(CASES.valid);
  assert.equal(postMaintainRoleAudit.status, 0,
    `removing synthetic MAINTAIN permission should restore audit readiness: ${postMaintainRoleAudit.stderr}\n${postMaintainRoleAudit.stdout}`);
  recordScenario('MAINTAIN privilege is rejected on supported PostgreSQL versions');
} else {
  assert.match(backupRoleAudit.stdout, /relation_maintenance_privilege_count=0/,
    'PostgreSQL 16 should keep the version-gated MAINTAIN check harmless');
  recordScenario('MAINTAIN privilege check is version-safe on PostgreSQL 16');
}

const createLoCompatProbe = psql(CASES.valid, 'postgres', 'SELECT lo_create(0);');
assert.equal(createLoCompatProbe.status, 0, createLoCompatProbe.stderr);
const loCompatProbeOid = createLoCompatProbe.stdout.trim();
assert.match(loCompatProbeOid, /^\d+$/);
const populateLoCompatProbe = psql(CASES.valid, 'postgres',
  `SELECT lo_put(${loCompatProbeOid}, 0, decode('7374617274', 'hex'));`);
assert.equal(populateLoCompatProbe.status, 0, populateLoCompatProbe.stderr);
const grantLoCompatRead = psql(CASES.valid, 'postgres',
  `GRANT SELECT ON LARGE OBJECT ${loCompatProbeOid} TO tq_prod_backup_reader;`);
assert.equal(grantLoCompatRead.status, 0, grantLoCompatRead.stderr);
const grantLoCompatSetDirect = psql(CASES.valid, 'postgres',
  'GRANT SET ON PARAMETER lo_compat_privileges TO tq_prod_backup_reader;');
assert.equal(grantLoCompatSetDirect.status, 0, grantLoCompatSetDirect.stderr);
const directLoCompatAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(directLoCompatAudit.status, 3,
  `a direct lo_compat_privileges SET grant must fail the backup-role audit: ${directLoCompatAudit.stderr}\n${directLoCompatAudit.stdout}`);
assert.match(directLoCompatAudit.stdout, /parameter_set_privilege_count=1/);
const directLoCompatWrite = psql(CASES.valid, 'tq_prod_backup_reader', `
  SET lo_compat_privileges = on;
  SELECT lo_put(${loCompatProbeOid}, 0, decode('646972656374', 'hex'));
`);
assert.equal(directLoCompatWrite.status, 0,
  `direct SET on the large-object compatibility GUC should demonstrate the synthetic ACL bypass: ${directLoCompatWrite.stderr}`);
const revokeLoCompatSetDirect = psql(CASES.valid, 'postgres',
  'REVOKE SET ON PARAMETER lo_compat_privileges FROM tq_prod_backup_reader;');
assert.equal(revokeLoCompatSetDirect.status, 0, revokeLoCompatSetDirect.stderr);
const grantLoCompatSetPublic = psql(CASES.valid, 'postgres',
  'GRANT SET ON PARAMETER lo_compat_privileges TO PUBLIC;');
assert.equal(grantLoCompatSetPublic.status, 0, grantLoCompatSetPublic.stderr);
const publicLoCompatAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(publicLoCompatAudit.status, 3,
  `a PUBLIC lo_compat_privileges SET grant must fail the backup-role audit: ${publicLoCompatAudit.stderr}\n${publicLoCompatAudit.stdout}`);
assert.match(publicLoCompatAudit.stdout, /parameter_set_privilege_count=1/);
const publicLoCompatWrite = psql(CASES.valid, 'tq_prod_backup_reader', `
  SET lo_compat_privileges = on;
  SELECT lo_put(${loCompatProbeOid}, 0, decode('7075626c6963', 'hex'));
`);
assert.equal(publicLoCompatWrite.status, 0,
  `PUBLIC SET on the large-object compatibility GUC should demonstrate the synthetic ACL bypass: ${publicLoCompatWrite.stderr}`);
const revokeLoCompatSetPublic = psql(CASES.valid, 'postgres',
  'REVOKE SET ON PARAMETER lo_compat_privileges FROM PUBLIC;');
assert.equal(revokeLoCompatSetPublic.status, 0, revokeLoCompatSetPublic.stderr);
const removeLoCompatProbe = psql(CASES.valid, 'postgres', `SELECT lo_unlink(${loCompatProbeOid});`);
assert.equal(removeLoCompatProbe.status, 0, removeLoCompatProbe.stderr);
assert.equal(removeLoCompatProbe.stdout.trim(), '1');
const postLoCompatAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(postLoCompatAudit.status, 0,
  `revoking synthetic compatibility grants should restore audit readiness: ${postLoCompatAudit.stderr}\n${postLoCompatAudit.stdout}`);
recordScenario('lo_compat_privileges SET grant bypass is rejected after a synthetic large-object write');

const publicAlterSystemGrant = psql(CASES.valid, 'postgres',
  'GRANT ALTER SYSTEM ON PARAMETER work_mem TO PUBLIC;');
assert.equal(publicAlterSystemGrant.status, 0, publicAlterSystemGrant.stderr);
const publicAlterSystemAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(publicAlterSystemAudit.status, 3,
  `PUBLIC ALTER SYSTEM must fail the backup-role audit: ${publicAlterSystemAudit.stderr}\n${publicAlterSystemAudit.stdout}`);
assert.match(publicAlterSystemAudit.stdout, /parameter_alter_system_privilege_count=1/);
const publicAlterSystemWrite = psql(CASES.valid, 'tq_prod_backup_reader',
  "ALTER SYSTEM SET work_mem = '64MB';");
assert.equal(publicAlterSystemWrite.status, 0,
  `PUBLIC ALTER SYSTEM grant should permit the synthetic config write: ${publicAlterSystemWrite.stderr}`);
const resetPublicAlterSystem = psql(CASES.valid, 'postgres',
  'ALTER SYSTEM RESET work_mem; SELECT pg_reload_conf();');
assert.equal(resetPublicAlterSystem.status, 0, resetPublicAlterSystem.stderr);
const revokePublicAlterSystem = psql(CASES.valid, 'postgres',
  'REVOKE ALTER SYSTEM ON PARAMETER work_mem FROM PUBLIC;');
assert.equal(revokePublicAlterSystem.status, 0, revokePublicAlterSystem.stderr);
const postPublicAlterSystemAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(postPublicAlterSystemAudit.status, 0,
  `revoking synthetic PUBLIC ALTER SYSTEM should restore audit readiness: ${postPublicAlterSystemAudit.stderr}\n${postPublicAlterSystemAudit.stdout}`);
recordScenario('PUBLIC ALTER SYSTEM parameter grant is rejected after a synthetic configuration write');

const directAlterSystemGrant = psql(CASES.valid, 'postgres',
  'GRANT ALTER SYSTEM ON PARAMETER work_mem TO tq_prod_backup_reader;');
assert.equal(directAlterSystemGrant.status, 0, directAlterSystemGrant.stderr);
const directAlterSystemAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(directAlterSystemAudit.status, 3,
  `direct ALTER SYSTEM must fail the backup-role audit: ${directAlterSystemAudit.stderr}\n${directAlterSystemAudit.stdout}`);
assert.match(directAlterSystemAudit.stdout, /parameter_alter_system_privilege_count=1/);
const directAlterSystemWrite = psql(CASES.valid, 'tq_prod_backup_reader',
  "ALTER SYSTEM SET work_mem = '64MB';");
assert.equal(directAlterSystemWrite.status, 0,
  `direct ALTER SYSTEM grant should permit the synthetic config write: ${directAlterSystemWrite.stderr}`);
const resetDirectAlterSystem = psql(CASES.valid, 'postgres',
  'ALTER SYSTEM RESET work_mem; SELECT pg_reload_conf();');
assert.equal(resetDirectAlterSystem.status, 0, resetDirectAlterSystem.stderr);
const revokeDirectAlterSystem = psql(CASES.valid, 'postgres',
  'REVOKE ALTER SYSTEM ON PARAMETER work_mem FROM tq_prod_backup_reader;');
assert.equal(revokeDirectAlterSystem.status, 0, revokeDirectAlterSystem.stderr);
const postDirectAlterSystemAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(postDirectAlterSystemAudit.status, 0,
  `revoking synthetic direct ALTER SYSTEM should restore audit readiness: ${postDirectAlterSystemAudit.stderr}\n${postDirectAlterSystemAudit.stdout}`);
recordScenario('direct ALTER SYSTEM parameter grant is rejected after a synthetic configuration write');

const grantDirectLargeObjectCreator = psql(CASES.valid, 'postgres',
  'GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO tq_prod_backup_reader;');
assert.equal(grantDirectLargeObjectCreator.status, 0, grantDirectLargeObjectCreator.stderr);
const directLargeObjectCreation = psql(CASES.valid, 'tq_prod_backup_reader', 'SELECT lo_create(0);');
assert.equal(directLargeObjectCreation.status, 0,
  `an explicit creator EXECUTE grant must create an LO owned by the backup role: ${directLargeObjectCreation.stderr}`);
const directCreatedLargeObjectOid = directLargeObjectCreation.stdout.trim();
assert.match(directCreatedLargeObjectOid, /^\d+$/);
const directCreatorRoleAudit = invokeBackupRoleAudit(CASES.valid);
const cleanupDirectLargeObject = psql(CASES.valid, 'postgres',
  `SELECT lo_unlink(${directCreatedLargeObjectOid});`);
assert.equal(cleanupDirectLargeObject.status, 0, cleanupDirectLargeObject.stderr);
const revokeDirectLargeObjectCreator = psql(CASES.valid, 'postgres',
  'REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM tq_prod_backup_reader;');
assert.equal(revokeDirectLargeObjectCreator.status, 0, revokeDirectLargeObjectCreator.stderr);
assert.equal(directCreatorRoleAudit.status, 3,
  `direct creator EXECUTE must fail the backup-role audit: ${directCreatorRoleAudit.stderr}\n${directCreatorRoleAudit.stdout}`);
assert.match(directCreatorRoleAudit.stdout, /executable_large_object_creation_function_count=1/);
const postDirectCreatorRoleAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(postDirectCreatorRoleAudit.status, 0,
  `removing the direct creator grant should restore the synthetic read-only role: ${postDirectCreatorRoleAudit.stderr}\n${postDirectCreatorRoleAudit.stdout}`);
recordScenario('direct EXECUTE on a large-object creator is rejected after proving actual LO creation');

const serverLargeObjectFileFunctions = `
  pg_catalog.lo_import(text), pg_catalog.lo_import(text, oid),
  pg_catalog.lo_export(oid, text)
`;
const grantPublicLargeObjectFileFunctions = psql(CASES.valid, 'postgres',
  `GRANT EXECUTE ON FUNCTION ${serverLargeObjectFileFunctions} TO PUBLIC;`);
assert.equal(grantPublicLargeObjectFileFunctions.status, 0, grantPublicLargeObjectFileFunctions.stderr);
const publicLargeObjectFileFunctionAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(publicLargeObjectFileFunctionAudit.status, 3,
  `PUBLIC server-side LO file access must fail closed: ${publicLargeObjectFileFunctionAudit.stderr}\n${publicLargeObjectFileFunctionAudit.stdout}`);
assert.match(publicLargeObjectFileFunctionAudit.stdout, /executable_large_object_server_file_function_count=3/);
const revokePublicLargeObjectFileFunctions = psql(CASES.valid, 'postgres',
  `REVOKE EXECUTE ON FUNCTION ${serverLargeObjectFileFunctions} FROM PUBLIC;`);
assert.equal(revokePublicLargeObjectFileFunctions.status, 0, revokePublicLargeObjectFileFunctions.stderr);
recordScenario('PUBLIC EXECUTE on server-side large-object file functions is rejected');

const grantDirectLargeObjectFileFunctions = psql(CASES.valid, 'postgres',
  `GRANT EXECUTE ON FUNCTION ${serverLargeObjectFileFunctions} TO tq_prod_backup_reader;`);
assert.equal(grantDirectLargeObjectFileFunctions.status, 0, grantDirectLargeObjectFileFunctions.stderr);
const directLargeObjectFileFunctionAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(directLargeObjectFileFunctionAudit.status, 3,
  `direct server-side LO file access must fail closed: ${directLargeObjectFileFunctionAudit.stderr}\n${directLargeObjectFileFunctionAudit.stdout}`);
assert.match(directLargeObjectFileFunctionAudit.stdout, /executable_large_object_server_file_function_count=3/);
const revokeDirectLargeObjectFileFunctions = psql(CASES.valid, 'postgres',
  `REVOKE EXECUTE ON FUNCTION ${serverLargeObjectFileFunctions} FROM tq_prod_backup_reader;`);
assert.equal(revokeDirectLargeObjectFileFunctions.status, 0, revokeDirectLargeObjectFileFunctions.stderr);
recordScenario('direct EXECUTE on server-side large-object file functions is rejected');

const enableBackupProbeRls = psql(CASES.valid, 'postgres',
  'ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;');
assert.equal(enableBackupProbeRls.status, 0, enableBackupProbeRls.stderr);
const rlsRoleAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(rlsRoleAudit.status, 3,
  `an RLS-enabled relation must fail the full-backup role audit: ${rlsRoleAudit.stderr}\n${rlsRoleAudit.stdout}`);
assert.match(rlsRoleAudit.stdout, /row_security_relation_count=1/);
const disableBackupProbeRls = psql(CASES.valid, 'postgres',
  'ALTER TABLE public.accounts DISABLE ROW LEVEL SECURITY;');
assert.equal(disableBackupProbeRls.status, 0, disableBackupProbeRls.stderr);
const postRlsRoleAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(postRlsRoleAudit.status, 0,
  `the full-backup role audit should pass after removing synthetic RLS: ${postRlsRoleAudit.stderr}\n${postRlsRoleAudit.stdout}`);
recordScenario('RLS-enabled relation is rejected by backup-role audit');

const createPublicSecurityDefiner = psql(CASES.valid, 'postgres', `
  CREATE FUNCTION public.fixture_backup_security_definer() RETURNS integer
  LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
`);
assert.equal(createPublicSecurityDefiner.status, 0, createPublicSecurityDefiner.stderr);
const publicSecurityDefinerAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(publicSecurityDefinerAudit.status, 3,
  `publicly executable SECURITY DEFINER function must fail the backup-role audit: ${publicSecurityDefinerAudit.stderr}\n${publicSecurityDefinerAudit.stdout}`);
assert.match(publicSecurityDefinerAudit.stdout, /executable_security_definer_function_count=1/);
recordScenario('executable SECURITY DEFINER function is rejected by backup-role audit');

const revokePublicSecurityDefiner = psql(CASES.valid, 'postgres',
  'REVOKE EXECUTE ON FUNCTION public.fixture_backup_security_definer() FROM PUBLIC;');
assert.equal(revokePublicSecurityDefiner.status, 0, revokePublicSecurityDefiner.stderr);
const grantDirectSecurityDefiner = psql(CASES.valid, 'postgres',
  'GRANT EXECUTE ON FUNCTION public.fixture_backup_security_definer() TO tq_prod_backup_reader;');
assert.equal(grantDirectSecurityDefiner.status, 0, grantDirectSecurityDefiner.stderr);
const directSecurityDefinerAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(directSecurityDefinerAudit.status, 3,
  `explicit EXECUTE to the backup role must fail even without PUBLIC access: ${directSecurityDefinerAudit.stderr}\n${directSecurityDefinerAudit.stdout}`);
assert.match(directSecurityDefinerAudit.stdout, /executable_security_definer_function_count=1/);
const revokeDirectSecurityDefiner = psql(CASES.valid, 'postgres',
  'REVOKE EXECUTE ON FUNCTION public.fixture_backup_security_definer() FROM tq_prod_backup_reader;');
assert.equal(revokeDirectSecurityDefiner.status, 0, revokeDirectSecurityDefiner.stderr);
const dropPublicSecurityDefiner = psql(CASES.valid, 'postgres',
  'DROP FUNCTION public.fixture_backup_security_definer();');
assert.equal(dropPublicSecurityDefiner.status, 0, dropPublicSecurityDefiner.stderr);
recordScenario('explicit SECURITY DEFINER grant to backup role is rejected');

const createUntrustedFunction = psql(CASES.valid, 'postgres', `
  CREATE FUNCTION public.fixture_backup_untrusted() RETURNS integer
  AS 'intentionally_missing_test_library', 'intentionally_missing_test_symbol' LANGUAGE C;
`);
assert.equal(createUntrustedFunction.status, 0, createUntrustedFunction.stderr);
const untrustedFunctionAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(untrustedFunctionAudit.status, 3,
  `callable untrusted-language functions must fail the backup-role audit: ${untrustedFunctionAudit.stderr}\n${untrustedFunctionAudit.stdout}`);
assert.match(untrustedFunctionAudit.stdout, /executable_untrusted_function_count=1/);
const dropUntrustedFunction = psql(CASES.valid, 'postgres',
  'DROP FUNCTION public.fixture_backup_untrusted();');
assert.equal(dropUntrustedFunction.status, 0, dropUntrustedFunction.stderr);
recordScenario('callable untrusted-language function is rejected by backup-role audit');

const createOwnedUserRoutine = psql(CASES.valid, 'postgres', `
  CREATE FUNCTION public.fixture_backup_owned_routine() RETURNS integer
  LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;
  GRANT CREATE ON SCHEMA public TO tq_prod_backup_reader;
  ALTER FUNCTION public.fixture_backup_owned_routine() OWNER TO tq_prod_backup_reader;
  REVOKE CREATE ON SCHEMA public FROM tq_prod_backup_reader;
`);
assert.equal(createOwnedUserRoutine.status, 0, createOwnedUserRoutine.stderr);
const ownedUserRoutineAudit = invokeBackupRoleAudit(CASES.valid);
const removeOwnedUserRoutine = psql(CASES.valid, 'postgres',
  'DROP FUNCTION public.fixture_backup_owned_routine();');
assert.equal(removeOwnedUserRoutine.status, 0, removeOwnedUserRoutine.stderr);
assert.equal(ownedUserRoutineAudit.status, 3,
  `backup role ownership of a user routine must fail closed: ${ownedUserRoutineAudit.stderr}\n${ownedUserRoutineAudit.stdout}`);
assert.match(ownedUserRoutineAudit.stdout, /owned_user_routine_count=1/);
recordScenario('backup role ownership of a user routine is rejected');

const createWriteBypassRole = psql(CASES.valid, 'postgres', `
  CREATE ROLE tq_backup_write_bypass_ci NOLOGIN;
  GRANT INSERT ON public.accounts TO tq_backup_write_bypass_ci;
  GRANT tq_backup_write_bypass_ci TO tq_prod_backup_reader;
`);
assert.equal(createWriteBypassRole.status, 0, createWriteBypassRole.stderr);
const setWriteBypassRole = psql(CASES.valid, 'tq_prod_backup_reader', `
  SET ROLE tq_backup_write_bypass_ci;
  SELECT has_table_privilege(current_user, 'public.accounts', 'INSERT');
`);
assert.equal(setWriteBypassRole.status, 0, setWriteBypassRole.stderr);
assert.equal(setWriteBypassRole.stdout.trim(), 't');
const membershipRoleAudit = invokeBackupRoleAudit(CASES.valid);
assert.equal(membershipRoleAudit.status, 3,
  `NOINHERIT membership that can be activated by SET ROLE must fail: ${membershipRoleAudit.stderr}\n${membershipRoleAudit.stdout}`);
assert.match(membershipRoleAudit.stdout, /role_membership_count=1/);
const revokeWriteBypassRole = psql(CASES.valid, 'postgres', `
  REVOKE tq_backup_write_bypass_ci FROM tq_prod_backup_reader;
  REVOKE INSERT ON public.accounts FROM tq_backup_write_bypass_ci;
  DROP ROLE tq_backup_write_bypass_ci;
`);
assert.equal(revokeWriteBypassRole.status, 0, revokeWriteBypassRole.stderr);
recordScenario('NOINHERIT backup role membership bypass is rejected');

const createBackupOwnedLargeObject = psql(CASES.valid, 'postgres', 'SELECT lo_create(0);');
assert.equal(createBackupOwnedLargeObject.status, 0, createBackupOwnedLargeObject.stderr);
const backupOwnedLargeObjectOid = createBackupOwnedLargeObject.stdout.trim();
assert.match(backupOwnedLargeObjectOid, /^\d+$/);
const transferLargeObjectOwnership = psql(CASES.valid, 'postgres',
  `ALTER LARGE OBJECT ${backupOwnedLargeObjectOid} OWNER TO tq_prod_backup_reader;`);
assert.equal(transferLargeObjectOwnership.status, 0, transferLargeObjectOwnership.stderr);
const ownedLargeObjectRoleAudit = invokeBackupRoleAudit(CASES.valid);
const removeBackupOwnedLargeObject = psql(CASES.valid, 'tq_prod_backup_reader',
  `SELECT lo_unlink(${backupOwnedLargeObjectOid});`);
assert.equal(removeBackupOwnedLargeObject.status, 0, removeBackupOwnedLargeObject.stderr);
assert.equal(removeBackupOwnedLargeObject.stdout.trim(), '1', 'the synthetic owner can unlink its own large object');
assert.equal(ownedLargeObjectRoleAudit.status, 3,
  `backup role ownership of a large object must fail closed: ${ownedLargeObjectRoleAudit.stderr}\n${ownedLargeObjectRoleAudit.stdout}`);
assert.match(ownedLargeObjectRoleAudit.stdout, /large_object_write_privilege_count=1/);
recordScenario('backup role ownership of a synthetic large object is rejected');

const createLargeObject = psql(CASES.valid, 'postgres', 'SELECT lo_create(0);');
assert.equal(createLargeObject.status, 0, createLargeObject.stderr);
const largeObjectOid = createLargeObject.stdout.trim();
assert.match(largeObjectOid, /^\d+$/, 'synthetic large object creation must return one OID');
const populateSyntheticLargeObject = psql(CASES.valid, 'postgres',
  `SELECT lo_put(${largeObjectOid}, 0, decode('73796e746865746963', 'hex'));`);
assert.equal(populateSyntheticLargeObject.status, 0, populateSyntheticLargeObject.stderr);
const missingLargeObjectRead = invokeBackupRoleAudit(CASES.valid);
assert.equal(missingLargeObjectRead.status, 3,
  `backup role without large-object SELECT must fail closed: ${missingLargeObjectRead.stderr}\n${missingLargeObjectRead.stdout}`);
assert.match(missingLargeObjectRead.stdout, /unreadable_large_object_count=1/);
recordScenario('backup role is rejected when one synthetic large object is unreadable');

const grantLargeObjectRead = psql(CASES.valid, 'postgres',
  `GRANT SELECT ON LARGE OBJECT ${largeObjectOid} TO tq_prod_backup_reader;`);
assert.equal(grantLargeObjectRead.status, 0, grantLargeObjectRead.stderr);
const readableLargeObject = invokeBackupRoleAudit(CASES.valid);
assert.equal(readableLargeObject.status, 0,
  `backup role with read-only large-object SELECT must pass: ${readableLargeObject.stderr}\n${readableLargeObject.stdout}`);
assert.match(readableLargeObject.stdout, /unreadable_large_object_count=0/);
assert.match(readableLargeObject.stdout, /large_object_write_privilege_count=0/);
const readSyntheticLargeObject = psql(CASES.valid, 'tq_prod_backup_reader',
  `SELECT encode(lo_get(${largeObjectOid}), 'hex');`);
assert.equal(readSyntheticLargeObject.status, 0, readSyntheticLargeObject.stderr);
assert.equal(readSyntheticLargeObject.stdout.trim(), '73796e746865746963', 'SELECT-only LO retrieval must work');
const deniedLargeObjectUpdate = psql(CASES.valid, 'tq_prod_backup_reader',
  `SELECT lo_put(${largeObjectOid}, 0, decode('78', 'hex'));`);
assert.equal(deniedLargeObjectUpdate.status, 3,
  `SELECT-only role cannot update an LO: ${deniedLargeObjectUpdate.stderr}\n${deniedLargeObjectUpdate.stdout}`);
const deniedLargeObjectWriteOpen = psql(CASES.valid, 'tq_prod_backup_reader', `
  BEGIN;
  SELECT lo_open(${largeObjectOid}, 131072);
  ROLLBACK;
`);
assert.equal(deniedLargeObjectWriteOpen.status, 3,
  `SELECT-only role cannot open an LO with INV_WRITE: ${deniedLargeObjectWriteOpen.stderr}\n${deniedLargeObjectWriteOpen.stdout}`);
recordScenario('large-object write descriptor requires UPDATE privilege');
const deniedLargeObjectUnlink = psql(CASES.valid, 'tq_prod_backup_reader',
  `SELECT lo_unlink(${largeObjectOid});`);
assert.equal(deniedLargeObjectUnlink.status, 3,
  `non-owner cannot unlink another role's LO: ${deniedLargeObjectUnlink.stderr}\n${deniedLargeObjectUnlink.stdout}`);
recordScenario('large-object reads remain available after creator restrictions');

const grantLargeObjectUpdate = psql(CASES.valid, 'postgres',
  `GRANT UPDATE ON LARGE OBJECT ${largeObjectOid} TO tq_prod_backup_reader;`);
assert.equal(grantLargeObjectUpdate.status, 0, grantLargeObjectUpdate.stderr);
const writableLargeObject = invokeBackupRoleAudit(CASES.valid);
assert.equal(writableLargeObject.status, 3,
  `backup role with large-object UPDATE must fail closed: ${writableLargeObject.stderr}\n${writableLargeObject.stdout}`);
assert.match(writableLargeObject.stdout, /large_object_write_privilege_count=1/);
const writableLargeObjectApis = psql(CASES.valid, 'tq_prod_backup_reader', `
  BEGIN;
  SELECT lo_open(${largeObjectOid}, 131072) AS fixture_lo_fd \gset
  SELECT lowrite(:fixture_lo_fd, decode('78', 'hex'));
  SELECT lo_truncate(:fixture_lo_fd, 8);
  SELECT lo_truncate64(:fixture_lo_fd, 9);
  ROLLBACK;
`);
assert.equal(writableLargeObjectApis.status, 0,
  `UPDATE on the synthetic LO should permit the write and truncation interfaces inside a rollback-only transaction: ${writableLargeObjectApis.stderr}\n${writableLargeObjectApis.stdout}`);
const largeObjectAfterRollback = psql(CASES.valid, 'tq_prod_backup_reader',
  `SELECT encode(lo_get(${largeObjectOid}), 'hex');`);
assert.equal(largeObjectAfterRollback.status, 0, largeObjectAfterRollback.stderr);
assert.equal(largeObjectAfterRollback.stdout.trim(), '73796e746865746963',
  'large-object write/truncate capability probe must leave the synthetic object unchanged after rollback');
recordScenario('lowrite and both truncate APIs are transactionally rolled back');
const revokeLargeObjectUpdate = psql(CASES.valid, 'postgres',
  `REVOKE UPDATE ON LARGE OBJECT ${largeObjectOid} FROM tq_prod_backup_reader;`);
assert.equal(revokeLargeObjectUpdate.status, 0, revokeLargeObjectUpdate.stderr);
recordScenario('backup role is rejected when it can update a synthetic large object');

const dump = dockerBinary([
  'exec', CONTAINER, 'pg_dump', '--host=127.0.0.1', '--port=5432',
  '--username=tq_prod_backup_reader', `--dbname=${CASES.valid}`,
  '--no-password', '--format=custom', '--compress=6', '--no-owner', '--no-privileges',
  '--no-tablespaces', '--lock-wait-timeout=5s',
]);
assert.equal(dump.status, 0, `synthetic pg_dump must succeed without external networking: ${String(dump.stderr || '')}`);
assert.ok(Buffer.isBuffer(dump.stdout) && dump.stdout.length > 0, 'custom-format synthetic archive must be nonempty');
const archiveSha256 = crypto.createHash('sha256').update(dump.stdout).digest('hex');
assert.match(archiveSha256, /^[a-f0-9]{64}$/);
const sourceLargeObjectCount = psql(CASES.valid, 'postgres',
  'SELECT COUNT(*)::text FROM pg_catalog.pg_largeobject_metadata;');
assert.equal(sourceLargeObjectCount.status, 0, sourceLargeObjectCount.stderr);
assert.equal(sourceLargeObjectCount.stdout.trim(), '1', 'synthetic source must contain the approved large object');

const restoreDatabase = 'tq_restore_backup_test_ci';
const createRestoreDatabase = docker([
  'exec', CONTAINER, 'createdb', '--host=127.0.0.1', '--port=5432', '--username=postgres',
  '--owner=tq_restore_operator', restoreDatabase,
]);
assert.equal(createRestoreDatabase.status, 0, createRestoreDatabase.stderr);
const stampRestoreDatabase = psql('postgres', 'postgres',
  `COMMENT ON DATABASE ${restoreDatabase} IS '${SENTINEL_PREFIX}${process.env.TQ_DISPOSABLE_DB_SENTINEL}';`);
assert.equal(stampRestoreDatabase.status, 0, stampRestoreDatabase.stderr);
const restoreTargetSql = `
  SELECT current_database() = '${restoreDatabase}'
     AND current_user = 'tq_restore_operator'
     AND host(inet_server_addr()) = '127.0.0.1'
     AND inet_server_port() = 5432
     AND NOT COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit
                       FROM pg_catalog.pg_roles WHERE rolname=current_user), true)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S'))
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata);
`;
const restoreTarget = psql(restoreDatabase, 'tq_restore_operator', restoreTargetSql);
assert.equal(restoreTarget.status, 0, restoreTarget.stderr);
assert.equal(restoreTarget.stdout.trim(), 't', 'restore target must be an empty loopback DB owned by a non-admin NOINHERIT role');
const truncatedArchive = Buffer.from(dump.stdout.subarray(0, Math.floor(dump.stdout.length / 2)));
assert.ok(truncatedArchive.length > 0 && truncatedArchive.length < dump.stdout.length,
  'the truncated archive fixture must be a nonempty strict prefix of the real custom-format archive');
const truncatedRestore = dockerBinary([
  'exec', '-i', CONTAINER, 'pg_restore', '--host=127.0.0.1', '--port=5432',
  '--username=tq_restore_operator', `--dbname=${restoreDatabase}`,
  '--no-password', '--format=custom', '--exit-on-error', '--single-transaction',
  '--no-owner', '--no-privileges', '--no-tablespaces',
], truncatedArchive);
assert.ok(Number.isInteger(truncatedRestore.status) && truncatedRestore.status !== 0,
  `truncated custom-format archive must be rejected with a nonzero process exit: ${String(truncatedRestore.stderr || '')}`);
const targetAfterTruncatedRestore = psql(restoreDatabase, 'tq_restore_operator', restoreTargetSql);
assert.equal(targetAfterTruncatedRestore.status, 0, targetAfterTruncatedRestore.stderr);
assert.equal(targetAfterTruncatedRestore.stdout.trim(), 't',
  'transactional rejection of a truncated archive must leave no restored schema, rows, or large objects');
recordScenario('truncated custom-format archive must be rejected transactionally without leaving restore objects');
const targetLargeObject = psql(restoreDatabase, 'postgres', 'SELECT lo_create(0);');
assert.equal(targetLargeObject.status, 0, targetLargeObject.stderr);
const targetLargeObjectOid = targetLargeObject.stdout.trim();
assert.match(targetLargeObjectOid, /^\d+$/, 'target large object creation must return one OID');
const nonemptyLargeObjectTarget = psql(restoreDatabase, 'tq_restore_operator', restoreTargetSql);
assert.equal(nonemptyLargeObjectTarget.status, 0, nonemptyLargeObjectTarget.stderr);
assert.equal(nonemptyLargeObjectTarget.stdout.trim(), 'f',
  'restore target with a pre-existing large object must be rejected as nonempty');
const removeTargetLargeObject = psql(restoreDatabase, 'postgres',
  `SELECT lo_unlink(${targetLargeObjectOid});`);
assert.equal(removeTargetLargeObject.status, 0, removeTargetLargeObject.stderr);
recordScenario('isolated restore target rejects a pre-existing synthetic large object');
const restoreBackupArchive = dockerBinary([
  'exec', '-i', CONTAINER, 'pg_restore', '--host=127.0.0.1', '--port=5432',
  '--username=tq_restore_operator', `--dbname=${restoreDatabase}`,
  '--no-password', '--format=custom', '--exit-on-error', '--single-transaction',
  '--no-owner', '--no-privileges', '--no-tablespaces',
], dump.stdout);
assert.equal(restoreBackupArchive.status, 0, `synthetic pg_restore to empty loopback target must succeed: ${String(restoreBackupArchive.stderr || '')}`);
const restoredProbe = psql(restoreDatabase, 'tq_restore_operator', `
  BEGIN READ ONLY;
  SELECT current_database() = '${restoreDatabase}'
     AND current_user = 'tq_restore_operator'
     AND (SELECT COUNT(*) FROM public.release_backup_synthetic_probe WHERE marker='synthetic-only-backup-probe') = 1
     AND (SELECT COUNT(*) FROM public.schema_migrations WHERE version BETWEEN 18 AND 26) = 9
     AND (SELECT COUNT(*) FROM pg_catalog.pg_largeobject_metadata) = 1
     AND to_regclass('public.game_progress_save_commits') IS NOT NULL;
  ROLLBACK;
`);
assert.equal(restoredProbe.status, 0, restoredProbe.stderr);
assert.equal(restoredProbe.stdout.trim(), 't', 'restored synthetic data and migration metadata must be present');
const postSourceState = parseBackupReleaseState(invokeBackupReleaseState(CASES.valid, 'tq_prod_backup_reader'));
const postRestoredState = parseBackupReleaseState(invokeBackupReleaseState(restoreDatabase, 'tq_restore_operator'));
assert.equal(postSourceState.readiness, 'POST_MIGRATION_026');
assert.equal(postRestoredState.readiness, postSourceState.readiness);
assert.equal(postRestoredState.fingerprint, postSourceState.fingerprint,
  'post-026 source and restored database catalog fingerprints must match without comparing application rows');
recordScenario('custom archive restores transactionally into an empty isolated loopback database with matching metadata');

assert.equal(passedScenarioCount, 83, 'all expected disposable PostgreSQL preflight and backup scenarios must execute');
console.log(`Preflight integration result: ${passedScenarioCount}/${passedScenarioCount} disposable PostgreSQL scenarios passed.`);
