const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { RELEASE_MIGRATIONS, migrationChecksum } = require('../releaseMigrations');
const {
  buildRecoveryApprovalPlan,
  runRecoveryMigration026,
} = require('./recoveryMigration026');
const {
  assertScenarioDatabaseNames,
  buildScenarioDatabaseNames,
} = require('./recoveryMigration026.postgres.integration.cjs');

const MIGRATION_DIR = path.join(__dirname, '../migrations');
const SOURCE_SHA = 'a'.repeat(40);
const ARTIFACT_SHA256 = 'b'.repeat(64);
const PREFLIGHT_SQL = path.join(__dirname, 'release-migration-026-prerequisite-preflight.sql');
const TEST_DATABASE_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 55432,
  user: 'tq_release_migrator',
  password: 'synthetic-secret-sentinel',
  database: 'tq_synthetic_recovery',
  ssl: { ca: 'synthetic verified CA', rejectUnauthorized: true, servername: 'localhost' },
});

function approvalEnv(overrides = {}) {
  return {
    RECOVERY_026_APPROVED: 'true',
    RECOVERY_026_APPROVAL_REFERENCE: 'CHG-RECOVERY-026-01',
    RECOVERY_026_PREFLIGHT_OK: 'true',
    RECOVERY_026_PREFLIGHT_REFERENCE: 'PREFLIGHT-01',
    RECOVERY_026_PREFLIGHT_SHA256: require('node:crypto').createHash('sha256').update(fs.readFileSync(PREFLIGHT_SQL)).digest('hex'),
    RECOVERY_026_PREFLIGHT_REPORT_SHA256: 'c'.repeat(64),
    RECOVERY_026_BACKUP_VERIFIED: 'true',
    RECOVERY_026_BACKUP_REFERENCE: 'BACKUP-01',
    RECOVERY_026_BACKUP_SHA256: 'd'.repeat(64),
    RECOVERY_026_RESTORE_VERIFIED: 'true',
    RECOVERY_026_RESTORE_REFERENCE: 'RESTORE-01',
    RECOVERY_026_RESTORE_REPORT_SHA256: 'e'.repeat(64),
    RECOVERY_026_RUNTIME_PERMISSION_REVIEWED: 'true',
    RECOVERY_026_PERMISSION_REFERENCE: 'PERMISSIONS-01',
    RECOVERY_026_EXPECTED_PENDING_MIGRATIONS: '26',
    RECOVERY_026_EXPECTED_SOURCE_SHA: SOURCE_SHA,
    RECOVERY_026_EXPECTED_ARTIFACT_SHA256: ARTIFACT_SHA256,
    RECOVERY_026_RUNTIME_ROLE: 'theresians_app_runtime',
    RELEASE_EXPECTED_DATABASE: 'tq_synthetic_recovery',
    RELEASE_EXPECTED_DB_USER: 'tq_release_migrator',
    RELEASE_EXPECTED_SERVER_ADDRESS: '127.0.0.1',
    RELEASE_EXPECTED_SERVER_PORT: '55432',
    ...overrides,
  };
}

function validLedgerRows() {
  return RELEASE_MIGRATIONS.filter(({ version }) => version >= 18 && version <= 25).map((migration) => {
    const checksum = migrationChecksum(fs.readFileSync(path.join(MIGRATION_DIR, migration.file), 'utf8'));
    return {
      version: migration.version,
      filename: migration.file,
      checksum: migration.version === 25 ? checksum.toUpperCase() : checksum,
    };
  });
}

function fakeClient({ ledgerRows = validLedgerRows(), identityOverrides = {}, receiptObjectsAbsent = true, failures = {} } = {}) {
  const calls = [];
  let ledgerHas026 = false;
  const client = {
    connected: false,
    ended: false,
    async connect() {
      calls.push({ kind: 'connect' });
      if (failures.connect) throw new Error('synthetic connection failure containing credential sentinel');
      this.connected = true;
    },
    async end() {
      calls.push({ kind: 'end' });
      this.ended = true;
      if (failures.end) throw new Error('synthetic end failure containing credential sentinel');
    },
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ kind: 'query', sql: text, params });
      if (failures.lock && text.includes('pg_advisory_lock($1)')) throw new Error('synthetic advisory lock failure');
      if (failures.unlock && text.includes('pg_advisory_unlock($1)')) throw new Error('synthetic unlock failure');
      if (failures.rollback && text.trim() === 'ROLLBACK') throw new Error('synthetic rollback failure');
      if (failures.identity && text.includes('current_database() AS database_name')) throw new Error('synthetic identity query failure');
      if (text.includes('current_database() AS database_name')) {
        return { rows: [{
          database_name: 'tq_synthetic_recovery',
          database_user: 'tq_release_migrator',
          session_user: 'tq_release_migrator',
          server_address: '127.0.0.1',
          server_port: 55432,
          server_version_num: 180001,
          transaction_read_only: 'off',
          runtime_role_present: true,
          runtime_role_non_admin: true,
          runtime_role_has_no_memberships: true,
          runtime_role_is_distinct: true,
          migrator_non_admin: true,
          migrator_has_no_memberships: true,
          migrator_cannot_create_database: true,
          migrator_cannot_create_temp: true,
          migrator_public_usage: true,
          migrator_public_create: true,
          migrator_no_other_schema_create: true,
          migrator_ledger_select: true,
          migrator_ledger_insert: true,
          migrator_ledger_no_update: true,
          migrator_ledger_no_delete: true,
          migrator_accounts_id_references: true,
          migrator_no_unapproved_table_writes: true,
          migrator_no_sequence_writes: true,
          runtime_role_present: true,
          ...identityOverrides,
        }] };
      }
      if (text.includes("to_regclass('public.schema_migrations')")) return { rows: [{ ledger_present: true }] };
      if (text.includes('ledger_shape_ok')) return { rows: [{ ledger_shape_ok: true }] };
      if (text.includes('FROM public.schema_migrations WHERE version >= 18')) {
        if (!ledgerHas026) return { rows: ledgerRows };
        const migration026 = RELEASE_MIGRATIONS.find(({ version }) => version === 26);
        return { rows: [...ledgerRows, {
          version: 26,
          filename: migration026.file,
          checksum: migrationChecksum(fs.readFileSync(path.join(MIGRATION_DIR, migration026.file), 'utf8')),
        }] };
      }
      if (text.includes('receipt_objects_absent')) return { rows: [{ receipt_objects_absent: receiptObjectsAbsent }] };
      if (text.includes('WITH required_columns AS')) {
        if (failures.postSchema) return { rows: [{ missing_object: 'game_progress_save_commits' }] };
        return { rows: [] };
      }
      if (text.includes('runtime_can_select')) {
        if (failures.postPermissions) return { rows: [{ runtime_can_select: true, runtime_can_insert: true, runtime_can_update: false,
          runtime_cannot_delete: true, runtime_cannot_truncate: true, runtime_cannot_reference: true, runtime_cannot_trigger: true,
          no_public_receipt_privileges: true, no_other_receipt_grantees: true, runtime_grants_are_minimal: true }] };
        return { rows: [{ runtime_can_select: true, runtime_can_insert: true, runtime_can_update: true,
          runtime_cannot_delete: true, runtime_cannot_truncate: true, runtime_cannot_reference: true, runtime_cannot_trigger: true,
          no_public_receipt_privileges: true, no_other_receipt_grantees: true, runtime_grants_are_minimal: true }] };
      }
      if (text.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')) {
        if (failures.migration) throw new Error('synthetic SQL failure with secret sentinel');
        return { rows: [] };
      }
      if (text.includes('INSERT INTO public.schema_migrations')) {
        if (failures.ledgerInsert) throw new Error('synthetic ledger insert failure with secret sentinel');
        ledgerHas026 = true;
        return { rows: [] };
      }
      if (text.trim() === 'COMMIT') {
        if (failures.commit) throw new Error('synthetic lost connection after COMMIT sent');
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { client, calls };
}

async function runFixture(options = {}) {
  const { client, calls } = fakeClient(options);
  let factoryCalls = 0;
  const result = await runRecoveryMigration026({
    env: approvalEnv(options.envOverrides),
    sourceRevision: SOURCE_SHA,
    artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true,
    migrationDir: MIGRATION_DIR,
    databaseConfig: TEST_DATABASE_CONFIG,
    clientFactory: async () => {
      factoryCalls += 1;
      return client;
    },
  });
  return { result, calls, client, factoryCalls };
}

test('recovery approval binds to exact source/artifact and requires every reviewed readiness attestation', () => {
  const plan = buildRecoveryApprovalPlan({
    env: approvalEnv(),
    sourceRevision: SOURCE_SHA,
    artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true,
  });
  assert.deepEqual(plan.expectedPendingVersions, [26]);
  assert.equal(plan.runtimeRole, 'theresians_app_runtime');
  for (const overrides of [
    { RECOVERY_026_BACKUP_VERIFIED: 'false' },
    { RECOVERY_026_RESTORE_VERIFIED: 'false' },
    { RECOVERY_026_PREFLIGHT_OK: 'false' },
    { RECOVERY_026_RUNTIME_PERMISSION_REVIEWED: 'false' },
    { RECOVERY_026_APPROVED: 'false' },
    { RECOVERY_026_EXPECTED_SOURCE_SHA: 'd'.repeat(40) },
    { RECOVERY_026_EXPECTED_ARTIFACT_SHA256: 'e'.repeat(64) },
    { RECOVERY_026_EXPECTED_PENDING_MIGRATIONS: '24' },
    { RELEASE_EXPECTED_PENDING_MIGRATIONS: '24' },
    { RELEASE_MIGRATION_024_APPROVED: 'true' },
    { RECOVERY_026_PREFLIGHT_REPORT_SHA256: 'invalid' },
    { RECOVERY_026_BACKUP_SHA256: '' },
    { RECOVERY_026_RESTORE_REPORT_SHA256: '' },
  ]) {
    assert.throws(() => buildRecoveryApprovalPlan({
      env: approvalEnv(overrides),
      sourceRevision: SOURCE_SHA,
      artifactSha256: ARTIFACT_SHA256,
      artifactTreeClean: true,
    }));
  }
  assert.throws(() => buildRecoveryApprovalPlan({
    env: approvalEnv(),
    sourceRevision: SOURCE_SHA,
    artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: false,
  }), /(modified|untracked)/i);
  assert.throws(() => buildRecoveryApprovalPlan({
    env: approvalEnv({ RECOVERY_026_PREFLIGHT_SHA256: 'f'.repeat(64) }),
    sourceRevision: SOURCE_SHA,
    artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true,
  }), /pre-026 preflight SQL digest/i);
});

test('recovery runner executes migration 026 only after exact ledger and receipt-object checks', async () => {
  const { result, calls, client } = await runFixture();
  assert.deepEqual(result.appliedVersions, [26]);
  assert.equal(client.ended, true);
  const migrationCalls = calls.filter((call) => call.kind === 'query' && call.sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits'));
  assert.equal(migrationCalls.length, 1);
  assert.equal(calls.some((call) => call.kind === 'query' && call.sql.includes('024_remove_legacy')), false);
  assert.equal(calls.filter((call) => call.kind === 'query' && call.sql.startsWith('GRANT ')
    && call.sql.includes('game_progress_save_commits')).length, 1);
  assert.match(calls.find((call) => call.kind === 'query' && call.sql.startsWith('GRANT ')).sql,
    /^GRANT SELECT, INSERT, UPDATE ON TABLE public\.game_progress_save_commits TO "theresians_app_runtime"$/);
  assert.ok(calls.findIndex((call) => call.kind === 'query' && call.sql.trim() === 'BEGIN')
    < calls.findIndex((call) => call.kind === 'query' && call.sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')));
  assert.ok(calls.findIndex((call) => call.kind === 'query' && call.sql.includes('INSERT INTO public.schema_migrations'))
    < calls.findIndex((call) => call.kind === 'query' && call.sql.trim() === 'COMMIT'));
});

test('every failed preflight gate prevents migration SQL and still closes the client safely', async () => {
  for (const options of [
    { identityOverrides: { database_name: 'wrong_database' } },
    { identityOverrides: { migrator_non_admin: false } },
    { identityOverrides: { migrator_public_create: false } },
    { identityOverrides: { runtime_role_has_no_memberships: false } },
    { identityOverrides: { server_version_num: 160000 } },
    { identityOverrides: { migrator_no_unapproved_table_writes: false } },
    { identityOverrides: { migrator_no_sequence_writes: false } },
    { ledgerRows: validLedgerRows().filter((row) => row.version !== 24) },
    { ledgerRows: validLedgerRows().filter((row) => row.version !== 25) },
    { ledgerRows: [...validLedgerRows(), validLedgerRows()[0]] },
    { ledgerRows: [...validLedgerRows(), { version: 27, filename: '027_unexpected.sql', checksum: 'f'.repeat(64) }] },
    { ledgerRows: validLedgerRows().map((row) => row.version === 25 ? { ...row, checksum: 'f'.repeat(64) } : row) },
    { ledgerRows: validLedgerRows().map((row) => row.version === 25 ? { ...row, filename: '025_wrong.sql' } : row) },
  ]) {
    const { calls, client } = fakeClient(options);
    await assert.rejects(runRecoveryMigration026({
      env: approvalEnv(),
      sourceRevision: SOURCE_SHA,
      artifactSha256: ARTIFACT_SHA256,
      artifactTreeClean: true,
      migrationDir: MIGRATION_DIR,
      databaseConfig: TEST_DATABASE_CONFIG,
      clientFactory: async () => client,
    }), (error) => error.category === 'preflight');
    assert.equal(calls.some((call) => call.kind === 'query' && call.sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')), false);
    assert.equal(client.ended, true);
  }
});

test('partial receipt objects stop before BEGIN and migration execution', async () => {
  const { client, calls } = fakeClient({ receiptObjectsAbsent: false });
  await assert.rejects(runRecoveryMigration026({
    env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true, migrationDir: MIGRATION_DIR, databaseConfig: TEST_DATABASE_CONFIG, clientFactory: async () => client,
  }), (error) => error.category === 'preflight');
  assert.equal(calls.some((call) => call.kind === 'query' && call.sql.trim() === 'BEGIN ISOLATION LEVEL SERIALIZABLE'), false);
  assert.equal(calls.some((call) => call.kind === 'query' && call.sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')), false);
});

test('migration and ledger insertion share one transaction; failures roll back without retry', async () => {
  for (const failures of [{ migration: true }, { ledgerInsert: true }, { postSchema: true }]) {
    const { calls, client } = fakeClient({ failures });
    await assert.rejects(runRecoveryMigration026({
      env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
      artifactTreeClean: true, migrationDir: MIGRATION_DIR, databaseConfig: TEST_DATABASE_CONFIG, clientFactory: async () => client,
    }));
    assert.equal(calls.filter((call) => call.kind === 'query' && call.sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')).length, 1);
    assert.equal(calls.some((call) => call.kind === 'query' && call.sql.trim() === 'COMMIT'), false);
    assert.equal(calls.some((call) => call.kind === 'query' && call.sql.trim() === 'ROLLBACK'), true);
    assert.equal(client.ended, true);
  }
});

test('commit response loss is marked outcome-unknown and cleanup errors do not replace primary failure', async () => {
  const { calls, client } = fakeClient({ failures: { commit: true, rollback: true, unlock: true, end: true } });
  await assert.rejects(runRecoveryMigration026({
    env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true, migrationDir: MIGRATION_DIR, databaseConfig: TEST_DATABASE_CONFIG, clientFactory: async () => client,
  }), (error) => {
    assert.equal(error.category, 'commit-outcome-unknown');
    assert.ok(error.cleanupFailures.length >= 2);
    assert.doesNotMatch(error.message, /credential sentinel|secret sentinel/);
    return true;
  });
  assert.equal(calls.filter((call) => call.kind === 'query' && call.sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')).length, 1);
});

test('advisory lock failure and missing approvals never execute migration SQL', async () => {
  const blocked = await runRecoveryMigration026({
    env: approvalEnv({ RECOVERY_026_BACKUP_VERIFIED: 'false' }),
    sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256, artifactTreeClean: true,
    databaseConfig: TEST_DATABASE_CONFIG,
    clientFactory: async () => { throw new Error('client must not be created'); },
  }).catch((error) => error);
  assert.match(blocked.message, /backup/i);
  const { calls, client } = fakeClient({ failures: { lock: true } });
  await assert.rejects(runRecoveryMigration026({
    env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true, migrationDir: MIGRATION_DIR, databaseConfig: TEST_DATABASE_CONFIG, clientFactory: async () => client,
  }));
  assert.equal(calls.some((call) => call.kind === 'query' && call.sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')), false);
});

test('connection failure is sanitized and the allocated client is closed without retry', async () => {
  const { calls, client } = fakeClient({ failures: { connect: true, end: true } });
  await assert.rejects(runRecoveryMigration026({
    env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true, migrationDir: MIGRATION_DIR, databaseConfig: TEST_DATABASE_CONFIG,
    clientFactory: async () => client,
  }), (error) => {
    assert.equal(error.category, 'connect');
    assert.deepEqual(error.cleanupFailures, ['connection-close-failed']);
    assert.doesNotMatch(error.message, /credential sentinel|synthetic/i);
    return true;
  });
  assert.equal(client.ended, true);
  assert.equal(calls.filter((call) => call.kind === 'query').length, 0);
});

test('unverified TLS configuration is rejected before a client can be created', async () => {
  let clientFactoryCalls = 0;
  await assert.rejects(runRecoveryMigration026({
    env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true, migrationDir: MIGRATION_DIR,
    databaseConfig: { ...TEST_DATABASE_CONFIG, ssl: { ...TEST_DATABASE_CONFIG.ssl, rejectUnauthorized: false } },
    clientFactory: async () => { clientFactoryCalls += 1; throw new Error('must not connect'); },
  }), /verified localhost TLS/i);
  assert.equal(clientFactoryCalls, 0);
});

test('PostgreSQL 16 executor override is unavailable outside the isolated GitHub integration harness', async () => {
  let clientFactoryCalls = 0;
  await assert.rejects(runRecoveryMigration026({
    env: approvalEnv(),
    sourceRevision: SOURCE_SHA,
    artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true,
    migrationDir: MIGRATION_DIR,
    databaseConfig: TEST_DATABASE_CONFIG,
    testExpectedPostgresMajor: 16,
    clientFactory: async () => {
      clientFactoryCalls += 1;
      throw new Error('client must not be created');
    },
  }), /PostgreSQL 16 is restricted to the sentinel-marked GitHub integration database/i);
  assert.equal(clientFactoryCalls, 0);
});

test('recovery PostgreSQL scenario database allowlist covers every canonical PG16/PG18 name and rejects variants', () => {
  for (const major of ['16', '18']) {
    const names = buildScenarioDatabaseNames(major);
    assert.equal(names.length, 8);
    assert.doesNotThrow(() => assertScenarioDatabaseNames(names, major));
    assert.throws(() => assertScenarioDatabaseNames(names.slice(1), major), /recovery-database-name-not-allowlisted/);
    assert.throws(() => assertScenarioDatabaseNames(
      names.map((name, index) => index === 0 ? `${name}_unexpected` : name),
      major,
    ), /recovery-database-name-not-allowlisted/);
  }
  assert.throws(() => buildScenarioDatabaseNames('17'), /explicit-postgres-major-required/);
});

test('recovery real-client path rejects the process-wide TLS verification bypass before loading pg', async () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await assert.rejects(runRecoveryMigration026({
      env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
      artifactTreeClean: true, migrationDir: MIGRATION_DIR, databaseConfig: TEST_DATABASE_CONFIG,
    }), /certificate verification is disabled/i);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

test('a real-client path rejects malformed CA input before requiring pg', async () => {
  await assert.rejects(runRecoveryMigration026({
    env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true, migrationDir: MIGRATION_DIR, databaseConfig: TEST_DATABASE_CONFIG,
  }), /exactly one PEM certificate/i);
});

test('primary SQL failure remains primary when rollback and client cleanup also fail', async () => {
  const { calls, client } = fakeClient({ failures: { migration: true, rollback: true, unlock: true, end: true } });
  await assert.rejects(runRecoveryMigration026({
    env: approvalEnv(), sourceRevision: SOURCE_SHA, artifactSha256: ARTIFACT_SHA256,
    artifactTreeClean: true, migrationDir: MIGRATION_DIR, databaseConfig: TEST_DATABASE_CONFIG,
    clientFactory: async () => client,
  }), (error) => {
    assert.equal(error.category, 'migration-sql');
    assert.deepEqual(error.cleanupFailures, ['rollback-failed', 'advisory-unlock-failed', 'connection-close-failed']);
    assert.doesNotMatch(error.message, /synthetic|secret|credential/i);
    return true;
  });
  assert.equal(calls.filter((call) => call.kind === 'query' && call.sql.includes('CREATE TABLE IF NOT EXISTS public.game_progress_save_commits')).length, 1);
});

test('runner diagnostics do not emit or embed credentials and CLI never logs supplied input', () => {
  const cli = fs.readFileSync(path.join(__dirname, 'run-approved-recovery-migration-026.js'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, 'recoveryMigration026.js'), 'utf8');
  assert.doesNotMatch(cli, /console\.(?:log|error)\([^\n]*(?:password|token|process\.env|error\.message)/i);
  assert.match(cli, /PGPASSWORD.*process environment/i);
  assert.match(cli, /Recovery migration stopped \(\$\{category\}\)/);
  assert.doesNotMatch(cli, /console\.error\(error\)/i);
  const identitySql = runner.match(/const IDENTITY_AND_ROLE_SQL = `([\s\S]*?)`;/)?.[1];
  assert.ok(identitySql, 'the identity query must remain explicit and reviewable');
  assert.match(identitySql, /\$1::name/);
  assert.doesNotMatch(identitySql.replaceAll('$1', ''), /\$\d+/,
    'the prepared query must not reference an unbound parameter');
  assert.doesNotMatch(runner, /rejectUnauthorized\s*:\s*false/i);
});

test('recovery artifact hash covers the approved scripts and migration sources', () => {
  const { computeRecoveryArtifactSha256 } = require('./recoveryMigration026');
  const first = computeRecoveryArtifactSha256(path.resolve(__dirname, '..'));
  const second = computeRecoveryArtifactSha256(path.resolve(__dirname, '..'));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});
