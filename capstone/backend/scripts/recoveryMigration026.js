'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  ADVISORY_LOCK_KEY,
  RELEASE_MIGRATIONS,
  assertTlsVerificationEnvironment,
  buildReleaseDatabaseConfig,
  createVerifiedPgTlsOptions,
  migrationChecksum,
} = require('../releaseMigrations');
const { assertStartupSchemaReady } = require('../database/startupSchemaReadiness');

const RECOVERY_MIGRATION = RELEASE_MIGRATIONS.find(({ version }) => version === 26);
const DEFAULT_MIGRATION_DIR = path.resolve(__dirname, '../migrations');
const PREFLIGHT_SQL_PATH = path.join(__dirname, 'release-migration-026-prerequisite-preflight.sql');
const ARTIFACT_FILES = Object.freeze([
  'releaseMigrations.js',
  'database/startupSchemaReadiness.js',
  'scripts/release-migration-026-prerequisite-preflight.sql',
  'scripts/run-approved-release-migrations.js',
  'scripts/recoveryMigration026.js',
  'scripts/run-approved-recovery-migration-026.js',
  'scripts/recovery-migration-026-runbook.md',
  ...RELEASE_MIGRATIONS.map(({ file }) => `migrations/${file}`),
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function computeRecoveryArtifactSha256(backendRoot = path.resolve(__dirname, '..')) {
  const root = path.resolve(backendRoot);
  const hash = crypto.createHash('sha256');
  for (const relativePath of ARTIFACT_FILES) {
    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('recovery artifact path is invalid');
    const bytes = fs.readFileSync(absolutePath);
    hash.update(relativePath, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(bytes.length), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(bytes);
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function computePreflightSqlSha256() {
  return sha256(fs.readFileSync(PREFLIGHT_SQL_PATH));
}

function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`required recovery approval input is missing: ${name}`);
  return value;
}

function reference(env, name) {
  const value = required(env, name);
  if (value.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new Error(`recovery approval reference is invalid: ${name}`);
  }
  return value;
}

function sha256Input(env, name) {
  const value = required(env, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256 hex digest`);
  return value;
}

function buildRecoveryApprovalPlan({
  env = process.env,
  sourceRevision,
  artifactSha256,
  artifactTreeClean,
} = {}) {
  const expectedManifest = [
    '018_website_sessions_and_audit_metadata.sql',
    '019_playtime_history_removal.sql',
    '020_add_auth_otp_challenge_security.sql',
    '021_canonical_milestones_and_activity_contract.sql',
    '022_game_telemetry_contract.sql',
    '023_quest_evidence_and_playtime_tombstones.sql',
    '024_remove_legacy_six_digit_students.sql',
    '025_add_game_result_question_traceability.sql',
    '026_game_progress_save_commit_idempotency.sql',
  ];
  if (RELEASE_MIGRATIONS.length !== expectedManifest.length
      || RELEASE_MIGRATIONS.some((migration, index) => migration.version !== index + 18
        || migration.file !== expectedManifest[index])) {
    throw new Error('recovery release migration manifest is not the reviewed 018–026 sequence');
  }
  if (env.RECOVERY_026_APPROVED !== 'true') throw new Error('migration 026 requires a separate explicit approval');
  const approvalReference = reference(env, 'RECOVERY_026_APPROVAL_REFERENCE');
  for (const name of [
    'RECOVERY_026_PREFLIGHT_OK',
    'RECOVERY_026_BACKUP_VERIFIED',
    'RECOVERY_026_RESTORE_VERIFIED',
    'RECOVERY_026_RUNTIME_PERMISSION_REVIEWED',
  ]) {
    if (env[name] !== 'true') throw new Error(`required recovery readiness attestation is missing: ${name}`);
  }
  const preflightReference = reference(env, 'RECOVERY_026_PREFLIGHT_REFERENCE');
  const backupReference = reference(env, 'RECOVERY_026_BACKUP_REFERENCE');
  const restoreReference = reference(env, 'RECOVERY_026_RESTORE_REFERENCE');
  const permissionReference = reference(env, 'RECOVERY_026_PERMISSION_REFERENCE');
  const preflightReportSha256 = sha256Input(env, 'RECOVERY_026_PREFLIGHT_REPORT_SHA256');
  const backupSha256 = sha256Input(env, 'RECOVERY_026_BACKUP_SHA256');
  const restoreReportSha256 = sha256Input(env, 'RECOVERY_026_RESTORE_REPORT_SHA256');

  if (env.RECOVERY_026_EXPECTED_PENDING_MIGRATIONS !== '26') {
    throw new Error('recovery path permits the exact pending migration list [26] only');
  }
  if (env.RELEASE_EXPECTED_PENDING_MIGRATIONS !== undefined
      && env.RELEASE_EXPECTED_PENDING_MIGRATIONS !== '26') {
    throw new Error('general release pending list conflicts with recovery migration 026 only');
  }
  for (const name of [
    'RELEASE_MIGRATION_024_APPROVED',
    'RELEASE_MIGRATION_024_CASCADE_REVIEWED',
    'RELEASE_MIGRATION_024_WRITES_QUIESCED',
  ]) {
    if (env[name] !== undefined && String(env[name]) !== '') {
      throw new Error('stale migration-024 approval input is prohibited in the recovery path');
    }
  }

  const expectedSourceRevision = required(env, 'RECOVERY_026_EXPECTED_SOURCE_SHA').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedSourceRevision)
      || String(sourceRevision ?? '').toLowerCase() !== expectedSourceRevision) {
    throw new Error('recovery source revision does not match the approved exact commit');
  }
  const expectedArtifactSha256 = sha256Input(env, 'RECOVERY_026_EXPECTED_ARTIFACT_SHA256');
  if (String(artifactSha256 ?? '').toLowerCase() !== expectedArtifactSha256) {
    throw new Error('recovery source/artifact digest does not match the approved artifact');
  }
  if (artifactTreeClean !== true) throw new Error('recovery-critical source files are modified or untracked');

  const expectedPreflightSqlSha256 = computePreflightSqlSha256();
  if (sha256Input(env, 'RECOVERY_026_PREFLIGHT_SHA256') !== expectedPreflightSqlSha256) {
    throw new Error('approved pre-026 preflight SQL digest does not match this source');
  }
  const expectedDatabase = required(env, 'RELEASE_EXPECTED_DATABASE');
  const expectedUser = required(env, 'RELEASE_EXPECTED_DB_USER');
  const expectedServerAddress = required(env, 'RELEASE_EXPECTED_SERVER_ADDRESS');
  const expectedServerPortText = required(env, 'RELEASE_EXPECTED_SERVER_PORT');
  if (!net.isIP(expectedServerAddress)
      || !/^[1-9]\d{0,4}$/.test(expectedServerPortText)
      || Number(expectedServerPortText) > 65535) {
    throw new Error('approved database server identity is invalid');
  }
  const runtimeRole = required(env, 'RECOVERY_026_RUNTIME_ROLE');
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(runtimeRole) || runtimeRole === expectedUser) {
    throw new Error('runtime role must be a distinct, valid least-privilege role');
  }

  return Object.freeze({
    approvalReference,
    preflightReference,
    preflightReportSha256,
    backupReference,
    backupSha256,
    restoreReference,
    restoreReportSha256,
    permissionReference,
    expectedSourceRevision,
    expectedArtifactSha256,
    expectedPendingVersions: Object.freeze([26]),
    expectedDatabase,
    expectedUser,
    expectedServerAddress,
    expectedServerPort: Number(expectedServerPortText),
    runtimeRole,
  });
}

function assertDatabaseConfig(config, expectedUser, expectedDatabase, requirePinnedCa) {
  if (!config || typeof config !== 'object'
      || Object.prototype.hasOwnProperty.call(config, 'connectionString')
      || config.host !== '127.0.0.1'
      || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
      || config.user !== expectedUser || config.database !== expectedDatabase
      || !config.password
      || config.ssl?.rejectUnauthorized !== true
      || config.ssl?.servername !== 'localhost'
      || typeof config.ssl?.ca !== 'string') {
    throw new Error('recovery connection must use explicit loopback fields and verified localhost TLS');
  }
  if (requirePinnedCa) {
    const pinnedTls = createVerifiedPgTlsOptions(config.ssl.ca);
    if (pinnedTls.rejectUnauthorized !== config.ssl.rejectUnauthorized
        || pinnedTls.servername !== config.ssl.servername
        || pinnedTls.ca !== config.ssl.ca) {
      throw new Error('recovery TLS configuration does not match the pinned production CA');
    }
  }
}

function migrationFile(migrationDir, migration) {
  const root = path.resolve(migrationDir);
  const filePath = path.resolve(root, migration.file);
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error('migration source path is invalid');
  return fs.readFileSync(filePath, 'utf8');
}

const IDENTITY_AND_ROLE_SQL = `
  SELECT current_database() AS database_name,
         current_user AS database_user,
         session_user AS session_user,
         host(inet_server_addr()) AS server_address,
         inet_server_port() AS server_port,
         current_setting('server_version_num')::integer AS server_version_num,
         current_setting('transaction_read_only') AS transaction_read_only,
         EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = $1::name) AS runtime_role_present,
         COALESCE((SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
                   FROM pg_catalog.pg_roles r WHERE r.rolname = $1::name), false) AS runtime_role_non_admin,
         COALESCE((SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
                   FROM pg_catalog.pg_roles r WHERE r.rolname = $1::name), false) AS runtime_role_has_no_memberships,
         current_user <> $1::name AS runtime_role_is_distinct,
         COALESCE((SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
                   FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) AS migrator_non_admin,
         COALESCE((SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
                   FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) AS migrator_has_no_memberships,
         NOT has_database_privilege(current_user, current_database(), 'CREATE') AS migrator_cannot_create_database,
         NOT has_database_privilege(current_user, current_database(), 'TEMP') AS migrator_cannot_create_temp,
         has_schema_privilege(current_user, 'public', 'USAGE') AS migrator_public_usage,
         has_schema_privilege(current_user, 'public', 'CREATE') AS migrator_public_create,
         NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
                     WHERE n.nspname <> 'public' AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
                       AND has_schema_privilege(current_user, n.oid, 'CREATE')) AS migrator_no_other_schema_create,
         has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') AS migrator_ledger_select,
         has_table_privilege(current_user, 'public.schema_migrations', 'INSERT') AS migrator_ledger_insert,
         NOT has_table_privilege(current_user, 'public.schema_migrations', 'UPDATE') AS migrator_ledger_no_update,
         NOT has_table_privilege(current_user, 'public.schema_migrations', 'DELETE') AS migrator_ledger_no_delete,
         has_column_privilege(current_user, 'public.accounts', 'id', 'REFERENCES') AS migrator_accounts_id_references,
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
             AND ((has_table_privilege(current_user, c.oid, 'INSERT') AND NOT (n.nspname='public' AND c.relname='schema_migrations'))
               OR has_table_privilege(current_user, c.oid, 'UPDATE')
               OR has_table_privilege(current_user, c.oid, 'DELETE')
               OR has_table_privilege(current_user, c.oid, 'TRUNCATE')
               OR has_table_privilege(current_user, c.oid, 'REFERENCES')
               OR has_table_privilege(current_user, c.oid, 'TRIGGER'))
         ) AS migrator_no_unapproved_table_writes,
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind = 'S' AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
             AND (has_sequence_privilege(current_user, c.oid, 'USAGE') OR has_sequence_privilege(current_user, c.oid, 'UPDATE'))
         ) AS migrator_no_sequence_writes
`;

const LEDGER_PRESENCE_SQL = "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_present";
const LEDGER_SHAPE_SQL = `
  WITH cols AS (
    SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull, a.attnum,
           EXISTS (SELECT 1 FROM pg_catalog.pg_attrdef d
                   WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum) AS has_default
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.schema_migrations'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  ), pk AS (
    SELECT count(*) AS count, bool_and(c.conkey = ARRAY[v.attnum]::smallint[]) AS version_only
    FROM pg_catalog.pg_constraint c CROSS JOIN cols v
    WHERE c.conrelid = 'public.schema_migrations'::regclass AND c.contype = 'p' AND v.attname = 'version'
  )
  SELECT count(*) = 4
     AND bool_and((attname = 'version' AND data_type = 'integer' AND attnotnull AND NOT has_default)
       OR (attname = 'filename' AND data_type = 'character varying(255)' AND attnotnull AND NOT has_default)
       OR (attname = 'checksum' AND data_type = 'character(64)' AND attnotnull AND NOT has_default)
       OR (attname = 'applied_at' AND data_type = 'timestamp with time zone' AND attnotnull AND has_default))
     AND (SELECT count = 1 AND version_only FROM pk) AS ledger_shape_ok
  FROM cols
`;
const LEDGER_ROWS_SQL = 'SELECT version, filename, checksum FROM public.schema_migrations WHERE version >= 18 ORDER BY version';
const RECEIPT_ABSENCE_SQL = `
  SELECT to_regclass('public.game_progress_save_commits') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relname LIKE 'game_progress_save_commits%')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conname IN (
       'game_progress_save_commits_pkey','game_progress_save_commits_activity_event_unique',
       'game_progress_save_commits_student_id_fkey','game_progress_save_commits_learning_cycle_version_check',
       'game_progress_save_commits_save_commit_id_hash_check','game_progress_save_commits_payload_sha256_check',
       'game_progress_save_commits_response_status_check','game_progress_save_commits_completion_consistency'))
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE 'game_progress_save_commits%')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                     WHERE n.nspname = 'public' AND t.typname = 'game_progress_save_commits')
     AS receipt_objects_absent
`;
const RUNTIME_PERMISSION_SQL = `
  SELECT has_table_privilege($1::name, 'public.game_progress_save_commits', 'SELECT') AS runtime_can_select,
         has_table_privilege($1::name, 'public.game_progress_save_commits', 'INSERT') AS runtime_can_insert,
         has_table_privilege($1::name, 'public.game_progress_save_commits', 'UPDATE') AS runtime_can_update,
         NOT has_table_privilege($1::name, 'public.game_progress_save_commits', 'DELETE') AS runtime_cannot_delete,
         NOT has_table_privilege($1::name, 'public.game_progress_save_commits', 'TRUNCATE') AS runtime_cannot_truncate,
         NOT has_table_privilege($1::name, 'public.game_progress_save_commits', 'REFERENCES') AS runtime_cannot_reference,
         NOT has_table_privilege($1::name, 'public.game_progress_save_commits', 'TRIGGER') AS runtime_cannot_trigger,
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_class c
           CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
           WHERE c.oid = 'public.game_progress_save_commits'::regclass AND acl.grantee = 0
         ) AS no_public_receipt_privileges,
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_class c
           CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
           WHERE c.oid = 'public.game_progress_save_commits'::regclass
             AND acl.grantee <> c.relowner
             AND acl.grantee <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1::name)
         ) AS no_other_receipt_grantees,
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_class c
           CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
           WHERE c.oid = 'public.game_progress_save_commits'::regclass
             AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1::name)
             AND (acl.privilege_type NOT IN ('SELECT','INSERT','UPDATE') OR acl.is_grantable)
         ) AS runtime_grants_are_minimal
`;

function assertIdentityAndRoles(row, plan) {
  if (!row
      || row.database_name !== plan.expectedDatabase
      || row.database_user !== plan.expectedUser
      || row.session_user !== plan.expectedUser
      || String(row.server_address) !== plan.expectedServerAddress
      || Number(row.server_port) !== plan.expectedServerPort
      || Math.floor(Number(row.server_version_num) / 10000) !== 18
      || row.transaction_read_only !== 'off'
      || row.runtime_role_present !== true
      || row.runtime_role_non_admin !== true
      || row.runtime_role_has_no_memberships !== true
      || row.runtime_role_is_distinct !== true
      || row.migrator_non_admin !== true
      || row.migrator_has_no_memberships !== true
      || row.migrator_cannot_create_database !== true
      || row.migrator_cannot_create_temp !== true
      || row.migrator_public_usage !== true
      || row.migrator_public_create !== true
      || row.migrator_no_other_schema_create !== true
      || row.migrator_ledger_select !== true
      || row.migrator_ledger_insert !== true
      || row.migrator_ledger_no_update !== true
      || row.migrator_ledger_no_delete !== true
      || row.migrator_accounts_id_references !== true
      || row.migrator_no_unapproved_table_writes !== true
      || row.migrator_no_sequence_writes !== true) {
    throw new Error('database, PostgreSQL version, or least-privilege role identity check failed');
  }
}

function assertLedgerRows(rows, migrationDir) {
  const expected = RELEASE_MIGRATIONS.filter(({ version }) => version >= 18 && version <= 25);
  const byVersion = new Map();
  for (const row of rows ?? []) {
    const version = Number(row.version);
    if (!Number.isInteger(version) || byVersion.has(version)) {
      throw new Error('migration ledger contains an invalid or duplicate release version');
    }
    const registered = RELEASE_MIGRATIONS.find((migration) => migration.version === version);
    if (!registered || registered.version > 25) {
      throw new Error('migration ledger contains an unknown, pending, or unexpected release version');
    }
    const checksum = migrationChecksum(migrationFile(migrationDir, registered));
    if (row.filename !== registered.file || String(row.checksum).trim().toLowerCase() !== checksum) {
      throw new Error('migration ledger filename or checksum does not match the reviewed source');
    }
    byVersion.set(version, row);
  }
  if (byVersion.size !== expected.length || expected.some(({ version }) => !byVersion.has(version))) {
    throw new Error('migrations 018 through 025, including 024 and 025, must already be applied');
  }
}

async function readPreflight(client, plan, migrationDir) {
  const ledgerPresence = await client.query(LEDGER_PRESENCE_SQL);
  if (ledgerPresence.rows?.[0]?.ledger_present !== true) throw new Error('migration ledger is missing');
  const identity = await client.query(IDENTITY_AND_ROLE_SQL, [plan.runtimeRole]);
  assertIdentityAndRoles(identity.rows?.[0], plan);
  const ledgerShape = await client.query(LEDGER_SHAPE_SQL);
  if (ledgerShape.rows?.[0]?.ledger_shape_ok !== true) throw new Error('migration ledger schema is unexpected');
  const ledger = await client.query(LEDGER_ROWS_SQL);
  assertLedgerRows(ledger.rows, migrationDir);

  const receipt = await client.query(RECEIPT_ABSENCE_SQL);
  if (receipt.rows?.[0]?.receipt_objects_absent !== true) {
    throw new Error('migration-026 receipt objects are present or partially present');
  }
}

function quoteRole(role) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(role)) throw new Error('runtime role identifier is invalid');
  return `"${role}"`;
}

async function assertRuntimePermissions(client, plan) {
  const result = await client.query(RUNTIME_PERMISSION_SQL, [plan.runtimeRole]);
  const row = result.rows?.[0];
  if (!row || row.runtime_can_select !== true || row.runtime_can_insert !== true
      || row.runtime_can_update !== true || row.runtime_cannot_delete !== true
      || row.runtime_cannot_truncate !== true || row.runtime_cannot_reference !== true
      || row.runtime_cannot_trigger !== true || row.no_public_receipt_privileges !== true
      || row.no_other_receipt_grantees !== true || row.runtime_grants_are_minimal !== true) {
    throw new Error('runtime role receipt-table permissions do not match the reviewed minimum');
  }
}

class RecoveryMigrationError extends Error {
  constructor(category) {
    super(`recovery migration stopped (${category}); do not retry without verifying the database ledger and schema`);
    this.name = 'RecoveryMigrationError';
    this.category = category;
    this.cleanupFailures = [];
  }
}

async function runRecoveryMigration026({
  env = process.env,
  sourceRevision,
  artifactSha256,
  artifactTreeClean,
  migrationDir = DEFAULT_MIGRATION_DIR,
  databaseConfig,
  clientFactory,
} = {}) {
  const plan = buildRecoveryApprovalPlan({ env, sourceRevision, artifactSha256, artifactTreeClean });
  if (typeof clientFactory !== 'function') assertTlsVerificationEnvironment(env);
  const selectedConfig = databaseConfig || buildReleaseDatabaseConfig(env);
  assertDatabaseConfig(selectedConfig, plan.expectedUser, plan.expectedDatabase, typeof clientFactory !== 'function');
  if (typeof clientFactory !== 'function') {
    // Only the dedicated CLI uses the real driver path; injected clients exist for isolated unit tests.
    const { Client } = require('pg');
    clientFactory = (config) => new Client(config);
  }

  const migrationSql = migrationFile(migrationDir, RECOVERY_MIGRATION);
  const migrationSha256 = migrationChecksum(migrationSql);
  const migration = RELEASE_MIGRATIONS.find(({ version }) => version === 26);
  if (!migration || migration.file !== '026_game_progress_save_commit_idempotency.sql') {
    throw new Error('the recovery migration manifest is unexpected');
  }

  let client;
  let clientCreated = false;
  let lockAcquired = false;
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let stage = 'connect';
  let primaryError = null;
  const cleanupFailures = [];
  let result;
  try {
    client = await clientFactory(selectedConfig);
    clientCreated = true;
    await client.connect();
    stage = 'timeouts';
    await client.query("SET statement_timeout = '15000ms'");
    await client.query("SET lock_timeout = '2000ms'");
    stage = 'advisory-lock';
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    lockAcquired = true;

    stage = 'preflight';
    await readPreflight(client, plan, migrationDir);

    stage = 'begin';
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");

    stage = 'transaction-preflight';
    await readPreflight(client, plan, migrationDir);
    stage = 'migration-sql';
    await client.query(migrationSql);
    stage = 'runtime-grant';
    await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE public.game_progress_save_commits TO ${quoteRole(plan.runtimeRole)}`);
    stage = 'ledger-insert';
    await client.query(
      'INSERT INTO public.schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
      [26, migration.file, migrationSha256],
    );
    stage = 'post-schema-verification';
    try {
      await assertStartupSchemaReady(client);
    } catch (_error) {
      throw new Error('post-migration startup schema contract failed');
    }
    await assertRuntimePermissions(client, plan);
    const finalLedger = await client.query(LEDGER_ROWS_SQL);
    const finalExpected = RELEASE_MIGRATIONS.filter(({ version }) => version >= 18 && version <= 26);
    const finalByVersion = new Map((finalLedger.rows ?? []).map((row) => [Number(row.version), row]));
    if (finalByVersion.size !== finalExpected.length
        || finalExpected.some(({ version, file }) => {
          const row = finalByVersion.get(version);
          return !row || row.filename !== file
            || String(row.checksum).trim().toLowerCase() !== migrationChecksum(migrationFile(migrationDir, { version, file }));
        })) {
      throw new Error('post-migration ledger verification failed');
    }

    stage = 'commit';
    commitAttempted = true;
    await client.query('COMMIT');
    commitCompleted = true;
    transactionOpen = false;
    result = { appliedVersions: [26], approvalReference: plan.approvalReference };
  } catch (_error) {
    const category = commitAttempted ? 'commit-outcome-unknown' : stage;
    primaryError = new RecoveryMigrationError(category);
    if (transactionOpen && !commitAttempted) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (_rollbackError) {
        cleanupFailures.push('rollback-failed');
      }
    }
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      } catch (_unlockError) {
        cleanupFailures.push('advisory-unlock-failed');
      }
    }
    if (clientCreated) {
      try {
        await client.end();
      } catch (_endError) {
        cleanupFailures.push('connection-close-failed');
      }
    }
  }

  if (primaryError) {
    primaryError.cleanupFailures = cleanupFailures;
    throw primaryError;
  }
  if (cleanupFailures.length) {
    const category = commitCompleted ? 'commit-succeeded-cleanup-failed' : 'cleanup-failed';
    const error = new RecoveryMigrationError(category);
    error.cleanupFailures = cleanupFailures;
    throw error;
  }
  return result;
}

module.exports = {
  ARTIFACT_FILES,
  buildRecoveryApprovalPlan,
  computeRecoveryArtifactSha256,
  computePreflightSqlSha256,
  runRecoveryMigration026,
};
