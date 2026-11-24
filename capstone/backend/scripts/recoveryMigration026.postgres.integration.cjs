'use strict';

// End-to-end recovery-executor verification. This harness is runnable only
// inside the two no-network PostgreSQL containers prepared by the CI workflow.
// It clones one sentinel-marked synthetic pre-026 fixture and drops only its
// own sentinel-marked databases and cluster-local test roles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ADVISORY_LOCK_KEY,
  RELEASE_MIGRATIONS,
  migrationChecksum,
} = require('../releaseMigrations');
const {
  computeRecoveryArtifactSha256,
  computePreflightSqlSha256,
  runRecoveryMigration026,
} = require('./recoveryMigration026');

const TEMPLATE_DATABASE = 'tq_preflight_pre_026_test_ci';
const MIGRATOR_ROLE = 'tq_recovery026_migrator_ci';
const RUNTIME_ROLE = 'tq_recovery026_runtime_ci';
const SCENARIOS = Object.freeze([
  'success', 'sql_failure', 'ledger_failure', 'partial_receipt',
  'missing_024', 'missing_025', 'wrong_checksum', 'commit_unknown',
]);
const DATABASES = Object.freeze(SCENARIOS.map((scenario) =>
  `tq_recovery026_${scenario}_pg${process.env.TQ_EXPECTED_POSTGRES_MAJOR}_test_ci`));
const SENTINEL_PREFIX = 'tq-disposable-ci:';
const EXPECTED_SCENARIOS = 12;
let passedScenarios = 0;
const createdDatabases = new Set();
const createdRoles = new Set();
const RECEIPT_INDEX_SQL = `
    SELECT x.indexrelid::regclass::text AS index_name, x.indisunique, x.indisvalid
    FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = 'public.game_progress_save_commits'::regclass
    ORDER BY i.relname
  `;

function buildScenarioDatabaseNames(postgresMajor) {
  const major = String(postgresMajor ?? '');
  check(['16', '18'].includes(major), 'explicit-postgres-major-required');
  return SCENARIOS.map((scenario) => `tq_recovery026_${scenario}_pg${major}_test_ci`);
}

function assertScenarioDatabaseNames(databaseNames, postgresMajor) {
  const expected = buildScenarioDatabaseNames(postgresMajor);
  check(Array.isArray(databaseNames)
    && databaseNames.length === expected.length
    && databaseNames.every((name, index) => name === expected[index]),
  'recovery-database-name-not-allowlisted');
}

const clientErrorDiagnostics = [];
let cleanupInProgress = false;

function createPgClient(config) {
  const { Client } = require('pg');
  const client = new Client(config);
  const configuredDatabase = String(config.database || '');
  const database = /^tq_[a-z0-9_]+$/.test(configuredDatabase) ? configuredDatabase : 'other';
  client.on('error', (error) => {
    const code = /^[0-9A-Z]{5}$/.test(String(error?.code || '')) ? error.code : 'unknown';
    clientErrorDiagnostics.push({
      database,
      code,
      phase: cleanupInProgress ? 'cleanup' : 'scenario',
    });
  });
  return client;
}

function partitionReceiptConstraintRows(rows) {
  check(Array.isArray(rows), 'receipt-constraint-result-invalid');
  return {
    contractRows: rows.filter((row) => row.contype !== 'n'),
    notNullRows: rows.filter((row) => row.contype === 'n'),
  };
}

function assertReceiptConstraintCount(rows, expectedCount) {
  check(Array.isArray(rows) && rows.length === expectedCount, 'receipt-constraint-count-mismatch');
}

function assertExactReceiptNotNullColumns(columnNames) {
  const expected = [
    'activity_event_key', 'created_at', 'learning_cycle_version', 'payload_sha256',
    'response_status', 'save_commit_id_hash', 'student_id',
  ];
  const actual = Array.isArray(columnNames) ? [...columnNames].sort() : [];
  check(JSON.stringify(actual) === JSON.stringify(expected), 'receipt-not-null-column-contract-mismatch');
}

function sanitizedReceiptCatalogFailure(stage, error) {
  const allowedStages = ['constraint', 'nullability', 'index', 'ledger'];
  check(allowedStages.includes(stage), 'receipt-catalog-stage-invalid');
  const code = /^[0-9A-Z]{5}$/.test(String(error?.code || '')) ? error.code : 'unknown';
  const failure = new Error('receipt contract catalog query failed');
  failure.safeCode = `receipt-${stage}-query-failed-${code}`;
  return failure;
}

function check(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

function record(code) {
  passedScenarios += 1;
  console.log(`PASS: ${code}`);
}

function quoteIdentifier(value) {
  check(/^[a-z][a-z0-9_]{0,62}$/.test(value), 'invalid-fixture-identifier');
  return `"${value}"`;
}

function assertIsolatedCiEnvironment() {
  check(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true', 'github-ci-required');
  check(process.env.NODE_ENV === 'test', 'test-node-environment-required');
  check(['16', '18'].includes(process.env.TQ_EXPECTED_POSTGRES_MAJOR), 'explicit-postgres-major-required');
  check(/^[a-f0-9]{48}$/.test(process.env.TQ_DISPOSABLE_DB_SENTINEL || ''), 'disposable-sentinel-required');
  check(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || ''), 'github-source-sha-required');
  const prohibited = [
    'DATABASE_URL', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGSSLMODE',
    'RAILWAY_TOKEN', 'RAILWAY_API_TOKEN', 'NODE_TLS_REJECT_UNAUTHORIZED',
  ];
  check(prohibited.every((name) => !Object.prototype.hasOwnProperty.call(process.env, name)),
    'ambient-database-or-railway-credential-environment-prohibited');
  assertScenarioDatabaseNames(DATABASES, process.env.TQ_EXPECTED_POSTGRES_MAJOR);
}

function connectionConfig(database, user = 'postgres') {
  return {
    host: '127.0.0.1',
    port: 5432,
    user,
    database,
    ssl: false,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    application_name: 'tq-recovery026-disposable-integration',
  };
}

async function withClient(config, callback) {
  const client = createPgClient(config);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function verifyDisposableServer(admin, sourceState) {
  check(sourceState.artifactTreeClean === true, 'recovery-artifact-tree-not-clean');
  check(sourceState.sourceRevision === process.env.GITHUB_SHA, 'checked-out-source-sha-mismatch');
  const server = await admin.query(`
    SELECT current_database() AS database_name, current_user AS role_name,
           host(inet_server_addr()) AS server_address, inet_server_port() AS server_port,
           current_setting('server_version_num')::integer AS server_version_num
  `);
  const row = server.rows[0];
  check(row.database_name === 'postgres' && row.role_name === 'postgres', 'unexpected-ci-control-database-identity');
  check(row.server_address === '127.0.0.1' && Number(row.server_port) === 5432, 'unexpected-ci-postgres-endpoint');
  check(Math.floor(Number(row.server_version_num) / 10000) === Number(process.env.TQ_EXPECTED_POSTGRES_MAJOR),
    'postgres-image-version-mismatch');
  const template = await withClient(connectionConfig(TEMPLATE_DATABASE), async (client) => {
    const result = await client.query(`
      SELECT current_database() AS database_name,
             shobj_description(d.oid, 'pg_database') AS marker
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    `);
    return result.rows[0];
  });
  check(template.database_name === TEMPLATE_DATABASE
    && template.marker === `${SENTINEL_PREFIX}${process.env.TQ_DISPOSABLE_DB_SENTINEL}`,
  'pre-026-template-sentinel-mismatch');
}

async function createTestRoles(admin) {
  const existing = await admin.query(
    'SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])',
    [[MIGRATOR_ROLE, RUNTIME_ROLE]],
  );
  check(existing.rows.length === 0, 'recovery-test-role-already-exists');
  for (const role of [MIGRATOR_ROLE, RUNTIME_ROLE]) {
    await admin.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    createdRoles.add(role);
  }
}

async function prepareScenario(admin, database, scenario) {
  const existing = await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [database]);
  check(existing.rows.length === 0, 'recovery-test-database-already-exists');
  await admin.query(`CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE ${quoteIdentifier(TEMPLATE_DATABASE)}`);
  createdDatabases.add(database);
  await admin.query(
    `COMMENT ON DATABASE ${quoteIdentifier(database)} IS $comment$${SENTINEL_PREFIX}${process.env.TQ_DISPOSABLE_DB_SENTINEL}$comment$`,
  );
  await admin.query(`REVOKE TEMP ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(MIGRATOR_ROLE)}, ${quoteIdentifier(RUNTIME_ROLE)}`);

  await withClient(connectionConfig(database), async (client) => {
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(MIGRATOR_ROLE)}`);
    await client.query(`GRANT SELECT, INSERT ON TABLE public.schema_migrations TO ${quoteIdentifier(MIGRATOR_ROLE)}`);
    await client.query(`GRANT REFERENCES (id) ON TABLE public.accounts TO ${quoteIdentifier(MIGRATOR_ROLE)}`);
    await client.query(
      "INSERT INTO public.accounts (id, name, role, game_student_id) VALUES (910026, 'synthetic-recovery-test', 'student', '123456')",
    );
    if (scenario === 'partial_receipt') {
      await client.query('CREATE TABLE public.game_progress_save_commits_partial (id integer PRIMARY KEY)');
    } else if (scenario === 'missing_024') {
      await client.query('DELETE FROM public.schema_migrations WHERE version = 24');
    } else if (scenario === 'missing_025') {
      await client.query('DELETE FROM public.schema_migrations WHERE version = 25');
    } else if (scenario === 'wrong_checksum') {
      await client.query("UPDATE public.schema_migrations SET checksum = repeat('0', 64) WHERE version = 25");
    } else if (scenario === 'ledger_failure') {
      await client.query(`
        CREATE FUNCTION public.fail_synthetic_recovery_026_ledger_insert() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        BEGIN
          IF NEW.version = 26 THEN RAISE EXCEPTION 'synthetic ledger insert failure'; END IF;
          RETURN NEW;
        END
        $body$;
        CREATE TRIGGER fail_synthetic_recovery_026_ledger_insert
          BEFORE INSERT ON public.schema_migrations
          FOR EACH ROW EXECUTE FUNCTION public.fail_synthetic_recovery_026_ledger_insert();
      `);
    }
  });
}

function syntheticApprovalEnv(database, sourceRevision, artifactSha256) {
  const zeros = '0'.repeat(64);
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    NODE_ENV: 'test',
    TQ_DISPOSABLE_DB_SENTINEL: process.env.TQ_DISPOSABLE_DB_SENTINEL,
    RECOVERY_026_APPROVED: 'true',
    RECOVERY_026_APPROVAL_REFERENCE: 'SYNTHETIC-CI-ONLY',
    RECOVERY_026_PREFLIGHT_OK: 'true',
    RECOVERY_026_PREFLIGHT_REFERENCE: 'SYNTHETIC-PREFLIGHT',
    RECOVERY_026_PREFLIGHT_SHA256: computePreflightSqlSha256(),
    RECOVERY_026_PREFLIGHT_REPORT_SHA256: zeros,
    RECOVERY_026_BACKUP_VERIFIED: 'true',
    RECOVERY_026_BACKUP_REFERENCE: 'SYNTHETIC-BACKUP-FLAG-NOT-A-BACKUP',
    RECOVERY_026_BACKUP_SHA256: zeros,
    RECOVERY_026_RESTORE_VERIFIED: 'true',
    RECOVERY_026_RESTORE_REFERENCE: 'SYNTHETIC-RESTORE-FLAG-NOT-A-RESTORE',
    RECOVERY_026_RESTORE_REPORT_SHA256: zeros,
    RECOVERY_026_RUNTIME_PERMISSION_REVIEWED: 'true',
    RECOVERY_026_PERMISSION_REFERENCE: 'SYNTHETIC-PERMISSION-REVIEW',
    RECOVERY_026_EXPECTED_PENDING_MIGRATIONS: '26',
    RECOVERY_026_EXPECTED_SOURCE_SHA: sourceRevision,
    RECOVERY_026_EXPECTED_ARTIFACT_SHA256: artifactSha256,
    RECOVERY_026_RUNTIME_ROLE: RUNTIME_ROLE,
    RELEASE_EXPECTED_DATABASE: database,
    RELEASE_EXPECTED_DB_USER: MIGRATOR_ROLE,
    RELEASE_EXPECTED_SERVER_ADDRESS: '127.0.0.1',
    RELEASE_EXPECTED_SERVER_PORT: '5432',
  };
}

function appDatabaseConfig(database) {
  return {
    host: '127.0.0.1',
    port: 5432,
    user: MIGRATOR_ROLE,
    password: 'synthetic-ci-only-placeholder',
    database,
    ssl: { ca: 'synthetic-isolated-ci-only', rejectUnauthorized: true, servername: 'localhost' },
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    application_name: 'tq-recovery026-disposable-integration',
  };
}

const RECOVERY_PREFLIGHT_QUERY_LABELS = Object.freeze([
  'ledger-presence',
  'identity-and-role',
  'ledger-shape',
  'ledger-rows',
  'receipt-absence',
]);

function preflightQueryLabel(queryCount) {
  // Three executor queries (timeouts and advisory lock) precede readPreflight.
  return RECOVERY_PREFLIGHT_QUERY_LABELS[Number(queryCount) - 4] || 'unknown';
}

function summarizeIdentityFailures(row, config, expectedPostgresMajor) {
  const checks = {
    database_name: row?.database_name === config.database,
    database_user: row?.database_user === config.user,
    session_user: row?.session_user === config.user,
    server_address: String(row?.server_address) === '127.0.0.1',
    server_port: Number(row?.server_port) === Number(config.port),
    server_version_major: Math.floor(Number(row?.server_version_num) / 10000) === Number(expectedPostgresMajor),
    transaction_read_only: row?.transaction_read_only === 'off',
    runtime_role_present: row?.runtime_role_present === true,
    runtime_role_non_admin: row?.runtime_role_non_admin === true,
    runtime_role_has_no_memberships: row?.runtime_role_has_no_memberships === true,
    runtime_role_is_distinct: row?.runtime_role_is_distinct === true,
    migrator_non_admin: row?.migrator_non_admin === true,
    migrator_has_no_memberships: row?.migrator_has_no_memberships === true,
    migrator_cannot_create_database: row?.migrator_cannot_create_database === true,
    migrator_cannot_create_temp: row?.migrator_cannot_create_temp === true,
    migrator_public_usage: row?.migrator_public_usage === true,
    migrator_public_create: row?.migrator_public_create === true,
    migrator_no_other_schema_create: row?.migrator_no_other_schema_create === true,
    migrator_ledger_select: row?.migrator_ledger_select === true,
    migrator_ledger_insert: row?.migrator_ledger_insert === true,
    migrator_ledger_no_update: row?.migrator_ledger_no_update === true,
    migrator_ledger_no_delete: row?.migrator_ledger_no_delete === true,
    migrator_accounts_id_references: row?.migrator_accounts_id_references === true,
    migrator_no_unapproved_table_writes: row?.migrator_no_unapproved_table_writes === true,
    migrator_no_sequence_writes: row?.migrator_no_sequence_writes === true,
  };
  return Object.entries(checks).filter(([, passed]) => passed !== true).map(([name]) => name);
}

async function executeRecovery(database, sourceState, artifactSha256, hooks = {}) {
  const state = { database, factoryCalls: 0, queries: [], lastQueryStatus: null, identityFailures: null, receiptObjectsAbsent: null };
  try {
    const result = await runRecoveryMigration026({
      env: syntheticApprovalEnv(database, sourceState.sourceRevision, artifactSha256),
      sourceRevision: sourceState.sourceRevision,
      artifactSha256,
      artifactTreeClean: sourceState.artifactTreeClean,
      databaseConfig: appDatabaseConfig(database),
      ...(process.env.TQ_EXPECTED_POSTGRES_MAJOR === '16' ? { testExpectedPostgresMajor: 16 } : {}),
      clientFactory: async (config) => {
        state.factoryCalls += 1;
        const client = createPgClient({
          ...config,
          // This client is confined to the workflow's no-network, tmpfs-backed
          // PostgreSQL container; production never takes the injected-client path.
          ssl: false,
        });
        const originalQuery = client.query.bind(client);
        client.query = async (sql, params = []) => {
          const text = String(sql);
          state.queries.push(text);
          state.lastQueryStatus = 'started';
          const result = await originalQuery(sql, params);
          state.lastQueryStatus = 'completed';
          if (text.includes('server_version_num') && text.includes('runtime_role_non_admin')) {
            state.identityFailures = summarizeIdentityFailures(
              result.rows?.[0],
              config,
              Number(process.env.TQ_EXPECTED_POSTGRES_MAJOR),
            );
          }
          if (text.includes('receipt_objects_absent')) {
            state.receiptObjectsAbsent = result.rows?.[0]?.receipt_objects_absent === true;
          }
          if (hooks.afterQuery) await hooks.afterQuery(text, client, result);
          return result;
        };
        return client;
      },
    });
    return { result, factoryCalls: state.factoryCalls, queries: state.queries };
  } catch (error) {
    error.integrationState = state;
    throw error;
  }
}

async function queryAdmin(database, sql, params = []) {
  return withClient(connectionConfig(database), (client) => client.query(sql, params));
}

async function inspectReceiptAbsenceComponents(database) {
  check(DATABASES.includes(database), 'receipt-diagnostic-database-not-allowlisted');
  const result = await queryAdmin(database, `
    SELECT to_regclass('public.game_progress_save_commits') IS NULL AS table_absent,
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname LIKE 'game_progress_save_commits%'
           ) AS relations_absent,
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conname IN (
               'game_progress_save_commits_pkey','game_progress_save_commits_activity_event_unique',
               'game_progress_save_commits_student_id_fkey','game_progress_save_commits_learning_cycle_version_check',
               'game_progress_save_commits_save_commit_id_hash_check','game_progress_save_commits_payload_sha256_check',
               'game_progress_save_commits_response_status_check','game_progress_save_commits_completion_consistency'
             )
           ) AS constraints_absent,
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE 'game_progress_save_commits%'
           ) AS triggers_absent,
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'public' AND t.typname = 'game_progress_save_commits'
           ) AS type_absent
  `);
  return result.rows?.[0] || null;
}

async function queryReceiptCatalog(database, stage, sql) {
  try {
    return await queryAdmin(database, sql);
  } catch (error) {
    throw sanitizedReceiptCatalogFailure(stage, error);
  }
}

async function assertNoApplied026(database) {
  const result = await queryAdmin(database, `
    SELECT to_regclass('public.game_progress_save_commits') AS receipt_table,
           (SELECT count(*) FROM public.schema_migrations WHERE version = 26)::integer AS ledger_count
  `);
  check(result.rows[0].receipt_table === null && result.rows[0].ledger_count === 0,
    'failed-migration-left-receipt-schema-or-ledger-row');
}

async function assertReceiptContract(database) {
  const result = await queryReceiptCatalog(database, 'constraint', `
    SELECT conname, contype, convalidated, pg_catalog.pg_get_constraintdef(oid) AS definition
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.game_progress_save_commits'::regclass
    ORDER BY conname
  `);
  const { contractRows, notNullRows } = partitionReceiptConstraintRows(result.rows);
  const constraints = new Map(contractRows.map((row) => [row.conname, row]));
  const expected = new Map([
    ['game_progress_save_commits_pkey', 'p'],
    ['game_progress_save_commits_activity_event_unique', 'u'],
    ['game_progress_save_commits_student_id_fkey', 'f'],
    ['game_progress_save_commits_learning_cycle_version_check', 'c'],
    ['game_progress_save_commits_save_commit_id_hash_check', 'c'],
    ['game_progress_save_commits_payload_sha256_check', 'c'],
    ['game_progress_save_commits_response_status_check', 'c'],
    ['game_progress_save_commits_completion_consistency', 'c'],
  ]);
  assertReceiptConstraintCount(contractRows, expected.size);
  check(constraints.size === expected.size, 'receipt-constraint-count-mismatch');
  for (const [name, type] of expected) {
    check(constraints.has(name) && constraints.get(name).contype === type && constraints.get(name).convalidated,
      `receipt-constraint-invalid-${name}`);
  }
  const definitions = Object.fromEntries([...constraints].map(([name, row]) => [name, row.definition.toLowerCase()]));
  check(definitions.game_progress_save_commits_pkey.includes('(student_id, learning_cycle_version, save_commit_id_hash)'),
    'receipt-primary-key-definition-mismatch');
  check(definitions.game_progress_save_commits_activity_event_unique.includes('(student_id, activity_event_key)'),
    'receipt-activity-unique-definition-mismatch');
  check(definitions.game_progress_save_commits_student_id_fkey.includes('references accounts(id) on delete cascade'),
    'receipt-student-foreign-key-definition-mismatch');
  check(definitions.game_progress_save_commits_learning_cycle_version_check.includes('learning_cycle_version >= 0'),
    'receipt-cycle-check-definition-mismatch');
  check(definitions.game_progress_save_commits_save_commit_id_hash_check.includes("save_commit_id_hash ~ '^[0-9a-f]{64}$'"),
    'receipt-id-hash-check-definition-mismatch');
  check(definitions.game_progress_save_commits_payload_sha256_check.includes("payload_sha256 ~ '^[0-9a-f]{64}$'"),
    'receipt-payload-hash-check-definition-mismatch');
  check(definitions.game_progress_save_commits_response_status_check.includes('response_status >= 200')
    && definitions.game_progress_save_commits_response_status_check.includes('response_status <= 299'),
  'receipt-status-check-definition-mismatch');
  check(definitions.game_progress_save_commits_completion_consistency.includes('(response_body is null) = (completed_at is null)'),
    'receipt-completion-check-definition-mismatch');

  const nullability = await queryReceiptCatalog(database, 'nullability', `
    SELECT attname
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.game_progress_save_commits'::regclass
      AND attnum > 0 AND NOT attisdropped AND attnotnull
    ORDER BY attname
  `);
  assertExactReceiptNotNullColumns(nullability.rows.map((row) => row.attname));
  const expectedNotNullCatalogRows = Number(process.env.TQ_EXPECTED_POSTGRES_MAJOR) >= 18 ? 7 : 0;
  check(notNullRows.length === expectedNotNullCatalogRows
    && notNullRows.every((row) => row.convalidated === true),
  'receipt-not-null-catalog-representation-mismatch');

  const indexes = await queryReceiptCatalog(database, 'index', RECEIPT_INDEX_SQL);
  const indexNames = indexes.rows.map((row) => row.index_name.split('.').pop().replaceAll('"', '')).sort();
  check(indexNames.length === 2
    && indexNames.includes('game_progress_save_commits_pkey')
    && indexNames.includes('game_progress_save_commits_activity_event_unique')
    && indexes.rows.every((row) => row.indisunique && row.indisvalid),
  'receipt-index-contract-mismatch');

  const migration = RELEASE_MIGRATIONS.find(({ version }) => version === 26);
  const migrationSql = fs.readFileSync(path.join(__dirname, '../migrations', migration.file), 'utf8');
  const ledger = await queryReceiptCatalog(database, 'ledger',
    'SELECT version, filename, checksum FROM public.schema_migrations WHERE version = 26');
  check(ledger.rows.length === 1
    && Number(ledger.rows[0].version) === 26
    && ledger.rows[0].filename === migration.file
    && String(ledger.rows[0].checksum).trim().toLowerCase() === migrationChecksum(migrationSql),
  'receipt-ledger-entry-mismatch');
}

async function assertRuntimeGrantPlan(database) {
  const privileges = await queryAdmin(database, `
    SELECT has_table_privilege($1, 'public.game_progress_save_commits', 'SELECT') AS can_select,
           has_table_privilege($1, 'public.game_progress_save_commits', 'INSERT') AS can_insert,
           has_table_privilege($1, 'public.game_progress_save_commits', 'UPDATE') AS can_update,
           has_table_privilege($1, 'public.game_progress_save_commits', 'DELETE') AS can_delete,
           has_table_privilege($1, 'public.game_progress_save_commits', 'TRUNCATE') AS can_truncate,
           has_table_privilege($1, 'public.game_progress_save_commits', 'REFERENCES') AS can_reference,
           has_table_privilege($1, 'public.game_progress_save_commits', 'TRIGGER') AS can_trigger
  `, [RUNTIME_ROLE]);
  check(JSON.stringify(privileges.rows[0]) === JSON.stringify({
    can_select: true, can_insert: true, can_update: true,
    can_delete: false, can_truncate: false, can_reference: false, can_trigger: false,
  }), 'runtime-role-effective-privileges-mismatch');
  const acl = await queryAdmin(database, `
    SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
           acl.privilege_type, acl.is_grantable
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
    WHERE c.oid = 'public.game_progress_save_commits'::regclass
      AND acl.grantee <> c.relowner
    ORDER BY grantee, acl.privilege_type
  `);
  check(acl.rows.length === 3
    && acl.rows.every((row) => row.grantee === RUNTIME_ROLE && row.is_grantable === false)
    && new Set(acl.rows.map((row) => row.privilege_type)).size === 3
    && ['SELECT', 'INSERT', 'UPDATE'].every((privilege) => acl.rows.some((row) => row.privilege_type === privilege)),
  'runtime-role-acl-not-exactly-reviewed-minimum');
}

async function expectPreflightRejection(database, sourceState, artifactSha256, expectedCode) {
  let factoryCalls = 0;
  const queries = [];
  await assert.rejects(runRecoveryMigration026({
    env: syntheticApprovalEnv(database, sourceState.sourceRevision, artifactSha256),
    sourceRevision: sourceState.sourceRevision,
    artifactSha256,
    artifactTreeClean: sourceState.artifactTreeClean,
    databaseConfig: appDatabaseConfig(database),
    ...(process.env.TQ_EXPECTED_POSTGRES_MAJOR === '16' ? { testExpectedPostgresMajor: 16 } : {}),
    clientFactory: async (config) => {
      factoryCalls += 1;
      const client = createPgClient({ ...config, ssl: false });
      const query = client.query.bind(client);
      client.query = async (sql, params = []) => {
        queries.push(String(sql));
        return query(sql, params);
      };
      return client;
    },
  }), (error) => error.category === expectedCode);
  check(factoryCalls === 1, `${expectedCode}-connection-count-mismatch`);
  check(!queries.some((sql) => sql.trim() === 'BEGIN ISOLATION LEVEL SERIALIZABLE'),
    `${expectedCode}-entered-transaction-before-preflight`);
  check(!queries.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')),
    `${expectedCode}-executed-migration-before-preflight`);
}

async function verifySyntheticAccountUnmodified(database) {
  const oldMigrationRow = await queryAdmin(database,
    "SELECT count(*)::integer AS count FROM public.accounts WHERE id = 910026 AND role = 'student' AND game_student_id = '123456'");
  check(oldMigrationRow.rows[0].count === 1, 'synthetic-six-digit-account-was-modified');
}

async function verifyNoMigrationOrLedger(database) {
  await assertNoApplied026(database);
  await verifySyntheticAccountUnmodified(database);
}

async function runScenarios(admin, sourceState, artifactSha256) {
  const names = Object.fromEntries(SCENARIOS.map((scenario, index) => [scenario, DATABASES[index]]));
  for (const scenario of SCENARIOS) await prepareScenario(admin, names[scenario], scenario);

  const successfulDb = names.success;
  const lockMonitor = createPgClient(connectionConfig(successfulDb));
  await lockMonitor.connect();
  let lockObservedHeld = false;
  const success = await executeRecovery(successfulDb, sourceState, artifactSha256, {
    afterQuery: async (sql) => {
      if (sql.trim() === 'SELECT pg_advisory_lock($1)' && !lockObservedHeld) {
        const probe = await lockMonitor.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
        check(probe.rows[0].acquired === false, 'advisory-lock-not-held-during-recovery');
        lockObservedHeld = true;
      }
    },
  });
  check(success.result.appliedVersions.length === 1 && success.result.appliedVersions[0] === 26,
    'successful-recovery-version-set-mismatch');
  check(success.factoryCalls === 1 && lockObservedHeld, 'successful-recovery-client-or-lock-count-mismatch');
  check(success.queries.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')).length === 1,
    'recovery-migration-026-execution-count-mismatch');
  check(!success.queries.some((sql) => sql.includes('legacy_six_digit_students') || sql.includes('DELETE FROM public.accounts')),
    'recovery-path-attempted-migration-024-sql');
  record('actual migration 026 SQL applied once and committed with its ledger row');
  const reacquireResult = await lockMonitor.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
  const reacquired = reacquireResult.rows[0].acquired;
  if (reacquired) await lockMonitor.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  await lockMonitor.end();
  check(reacquired === true, 'advisory-lock-not-released-after-recovery');
  record('advisory lock was held during execution and released afterward');
  await assertReceiptContract(successfulDb);
  record('receipt schema, all eight constraints, exact indexes, and ledger checksum verified');
  await assertRuntimeGrantPlan(successfulDb);
  record('runtime role has exactly SELECT, INSERT, UPDATE and no other receipt-table grants');
  await verifySyntheticAccountUnmodified(successfulDb);
  record('synthetic six-digit account survived; migration 024 was not executed');

  const sqlFailureDb = names.sql_failure;
  const blocker = createPgClient(connectionConfig(sqlFailureDb));
  await blocker.connect();
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE public.accounts IN ACCESS EXCLUSIVE MODE');
  let sqlFailure;
  try {
    await executeRecovery(sqlFailureDb, sourceState, artifactSha256);
  } catch (error) {
    sqlFailure = error;
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
  }
  check(sqlFailure?.category === 'migration-sql'
    && sqlFailure.integrationState?.factoryCalls === 1
    && sqlFailure.integrationState.queries.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')).length === 1
    && sqlFailure.integrationState.queries.some((sql) => sql.trim() === 'ROLLBACK')
    && !sqlFailure.integrationState.queries.some((sql) => sql.trim() === 'COMMIT'),
  'migration-sql-timeout-error-or-rollback-contract-mismatch');
  await verifyNoMigrationOrLedger(sqlFailureDb);
  record('real PostgreSQL lock-timeout during migration SQL rolled back table and ledger');

  let ledgerFailure;
  try {
    await executeRecovery(names.ledger_failure, sourceState, artifactSha256);
  } catch (error) {
    ledgerFailure = error;
  }
  check(ledgerFailure?.category === 'ledger-insert'
    && ledgerFailure.integrationState?.factoryCalls === 1
    && ledgerFailure.integrationState.queries.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')).length === 1
    && ledgerFailure.integrationState.queries.some((sql) => sql.trim() === 'ROLLBACK')
    && !ledgerFailure.integrationState.queries.some((sql) => sql.trim() === 'COMMIT'),
  'ledger-insert-error-or-rollback-contract-mismatch');
  await verifyNoMigrationOrLedger(names.ledger_failure);
  record('real ledger-insert trigger failure rolled back table and ledger');

  await expectPreflightRejection(names.partial_receipt, sourceState, artifactSha256, 'preflight');
  const partial = await queryAdmin(names.partial_receipt,
    "SELECT to_regclass('public.game_progress_save_commits_partial') IS NOT NULL AS partial_present");
  check(partial.rows[0].partial_present, 'partial-receipt-fixture-was-not-preserved');
  record('partial receipt object rejected before BEGIN or migration execution');

  await expectPreflightRejection(names.missing_024, sourceState, artifactSha256, 'preflight');
  await verifyNoMigrationOrLedger(names.missing_024);
  record('missing migration 024 ledger row rejected before migration execution');

  await expectPreflightRejection(names.missing_025, sourceState, artifactSha256, 'preflight');
  await verifyNoMigrationOrLedger(names.missing_025);
  record('missing migration 025 ledger row rejected before migration execution');

  await expectPreflightRejection(names.wrong_checksum, sourceState, artifactSha256, 'preflight');
  await verifyNoMigrationOrLedger(names.wrong_checksum);
  record('incorrect historical checksum rejected before migration execution');

  let unknownCommit;
  try {
    await executeRecovery(names.commit_unknown, sourceState, artifactSha256, {
      afterQuery: (sql) => {
        if (sql.trim() === 'COMMIT') throw new Error('synthetic commit response lost after server commit');
      },
    });
  } catch (error) {
    unknownCommit = error;
  }
  check(unknownCommit?.category === 'commit-outcome-unknown'
    && unknownCommit.integrationState?.factoryCalls === 1
    && unknownCommit.integrationState.queries.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')).length === 1
    && unknownCommit.integrationState.queries.some((sql) => sql.trim() === 'COMMIT')
    && !unknownCommit.integrationState.queries.some((sql) => sql.trim() === 'ROLLBACK'),
    'lost-commit-response-not-classified-or-retried');
  const committedState = await queryAdmin(names.commit_unknown, `
    SELECT to_regclass('public.game_progress_save_commits') IS NOT NULL AS receipt_present,
           (SELECT count(*) FROM public.schema_migrations WHERE version = 26)::integer AS ledger_count
  `);
  check(committedState.rows[0].receipt_present && committedState.rows[0].ledger_count === 1,
    'synthetic-lost-commit-did-not-retain-server-committed-state');
  record('lost COMMIT response reports outcome unknown, retains committed state, and does not retry');
}

async function cleanup(admin) {
  const marker = `${SENTINEL_PREFIX}${process.env.TQ_DISPOSABLE_DB_SENTINEL}`;
  const failures = [];
  for (const database of [...createdDatabases].reverse()) {
    try {
      const result = await admin.query(
        "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname = $1",
        [database],
      );
      if (result.rows[0]?.marker !== marker) throw new Error('database sentinel mismatch');
      const termination = await admin.query(
        'SELECT pg_terminate_backend(pid) AS terminated FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database],
      );
      if (termination.rows.some((row) => row.terminated === true)) {
        failures.push('residual-client-connections-terminated');
      }
      await admin.query(`DROP DATABASE ${quoteIdentifier(database)}`);
    } catch (_error) {
      failures.push('database-cleanup-failed');
    }
  }
  for (const role of [...createdRoles].reverse()) {
    try {
      await admin.query(`DROP ROLE ${quoteIdentifier(role)}`);
    } catch (_error) {
      failures.push('role-cleanup-failed');
    }
  }
  return failures;
}

async function main() {
  assertIsolatedCiEnvironment();
  // The workflow verifies HEAD and a clean checkout before starting this
  // container; the mounted repository is read-only here.
  const sourceState = { sourceRevision: process.env.GITHUB_SHA, artifactTreeClean: true };
  const artifactSha256 = computeRecoveryArtifactSha256(path.resolve(__dirname, '..'));
  check(/^[a-f0-9]{64}$/.test(artifactSha256), 'recovery-artifact-hash-invalid');
  const admin = createPgClient(connectionConfig('postgres'));
  await admin.connect();
  let primaryFailure;
  try {
    await verifyDisposableServer(admin, sourceState);
    await createTestRoles(admin);
    await runScenarios(admin, sourceState, artifactSha256);
    check(passedScenarios === EXPECTED_SCENARIOS, 'recovery-postgres-scenario-count-mismatch');
  } catch (error) {
    primaryFailure = error;
  }
  if (!primaryFailure && clientErrorDiagnostics.some((event) => event.phase === 'scenario')) {
    primaryFailure = { safeCode: 'scenario-client-error-event' };
  }
  cleanupInProgress = true;
  let cleanupFailures = [];
  try {
    cleanupFailures = await cleanup(admin);
  } catch (_error) {
    cleanupFailures.push('synthetic-cleanup-failed');
  }
  try {
    await admin.end();
  } catch (_error) {
    cleanupFailures.push('admin-client-close-failed');
  }
  for (const event of clientErrorDiagnostics) {
    console.error(`CLIENT_EVENT: phase=${event.phase} database=${event.database} sqlstate=${event.code}`);
  }
  if (primaryFailure?.category === 'preflight') {
    const state = primaryFailure.integrationState || {};
    const query = preflightQueryLabel(state.queries?.length || 0);
    console.error(`PREFLIGHT_STAGE: query=${query} status=${state.lastQueryStatus || 'unknown'}`);
    if (query === 'identity-and-role' && state.lastQueryStatus === 'completed') {
      const failed = state.identityFailures;
      console.error(`PREFLIGHT_IDENTITY: failed=${Array.isArray(failed) ? (failed.join(',') || 'none') : 'not-captured'}`);
    }
    if (query === 'receipt-absence' && state.lastQueryStatus === 'completed' && state.receiptObjectsAbsent === false) {
      try {
        const components = await inspectReceiptAbsenceComponents(state.database);
        const flag = (value) => value === true ? 'true' : value === false ? 'false' : 'unknown';
        console.error(`PREFLIGHT_RECEIPT: table_absent=${flag(components?.table_absent)} relations_absent=${flag(components?.relations_absent)} constraints_absent=${flag(components?.constraints_absent)} triggers_absent=${flag(components?.triggers_absent)} type_absent=${flag(components?.type_absent)}`);
      } catch (_error) {
        console.error('PREFLIGHT_RECEIPT: inspection=failed');
      }
    }
  }
  if (primaryFailure) {
    console.error(`FAIL: recovery PostgreSQL ${process.env.TQ_EXPECTED_POSTGRES_MAJOR} integration (${primaryFailure.safeCode || primaryFailure.category || primaryFailure.name || 'scenario-failed'}).`);
    if (cleanupFailures.length) console.error(`FAIL: synthetic cleanup (${cleanupFailures.join(',')}).`);
    process.exitCode = 1;
    return;
  }
  if (cleanupFailures.length) {
    console.error(`FAIL: synthetic cleanup (${cleanupFailures.join(',')}).`);
    process.exitCode = 1;
    return;
  }
  console.log(`Recovery migration 026 PostgreSQL ${process.env.TQ_EXPECTED_POSTGRES_MAJOR} result: ${passedScenarios}/${EXPECTED_SCENARIOS} passed; synthetic databases and roles removed.`);
}

if (require.main === module) {
  main().catch((_error) => {
    for (const event of clientErrorDiagnostics) {
      console.error(`CLIENT_EVENT: phase=${event.phase} database=${event.database} sqlstate=${event.code}`);
    }
    console.error('FAIL: recovery PostgreSQL integration setup or cleanup did not complete.');
    process.exitCode = 1;
  });
}

module.exports = {
  assertScenarioDatabaseNames,
  buildScenarioDatabaseNames,
  partitionReceiptConstraintRows,
  assertReceiptConstraintCount,
  assertExactReceiptNotNullColumns,
  sanitizedReceiptCatalogFailure,
  RECEIPT_INDEX_SQL,
  preflightQueryLabel,
  summarizeIdentityFailures,
};
