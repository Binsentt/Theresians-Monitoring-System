const fs = require('node:fs');
const path = require('node:path');
const {
  ADVISORY_LOCK_KEY,
  RELEASE_MIGRATIONS,
  applyReleaseMigrations,
  buildReleaseDatabaseConfig,
  migrationChecksum,
} = require('../releaseMigrations');

const DEFAULT_MIGRATION_DIR = path.resolve(__dirname, '../migrations');
const MIN_RELEASE_VERSION = 18;

function requiredValue(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error('required release approval input is missing: ' + name);
  return value;
}

function parseVersionList(raw) {
  if (String(raw).trim().toLowerCase() === 'none') return [];
  const parts = String(raw).split(',').map((part) => part.trim());
  if (!parts.length || parts.some((part) => !/^(0|[1-9]\d*)$/.test(part))) {
    throw new Error('RELEASE_EXPECTED_PENDING_MIGRATIONS must be a sorted comma-separated version list or none');
  }
  const versions = parts.map(Number);
  if (new Set(versions).size !== versions.length
      || versions.some((version, index) => index > 0 && version <= versions[index - 1])) {
    throw new Error('RELEASE_EXPECTED_PENDING_MIGRATIONS must be strictly increasing with no duplicates');
  }
  return versions;
}

function parseExpectedCount(env, name) {
  const value = requiredValue(env, name);
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(name + ' must be a nonnegative integer from the approved preflight');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(name + ' exceeds the safe integer range');
  return count;
}

function readMigrationSql(migrationDir, migration) {
  const filePath = path.resolve(migrationDir, migration.file);
  const expectedDir = path.resolve(migrationDir);
  if (!filePath.startsWith(expectedDir + path.sep)) {
    throw new Error('migration path escapes migration directory');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function buildApprovalPlan(env, migrations) {
  if (env.RELEASE_MIGRATIONS_APPROVED !== 'true') {
    throw new Error('set RELEASE_MIGRATIONS_APPROVED=true only after separate operator approval');
  }

  const approvalReference = requiredValue(env, 'RELEASE_APPROVAL_REFERENCE');
  if (approvalReference.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(approvalReference)) {
    throw new Error('RELEASE_APPROVAL_REFERENCE must be a short ticket or approval identifier');
  }

  const expectedDatabase = requiredValue(env, 'RELEASE_EXPECTED_DATABASE');
  const expectedUser = requiredValue(env, 'RELEASE_EXPECTED_DB_USER');
  const expectedServerAddress = requiredValue(env, 'RELEASE_EXPECTED_SERVER_ADDRESS');
  const portText = requiredValue(env, 'RELEASE_EXPECTED_SERVER_PORT');
  if (!/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) {
    throw new Error('RELEASE_EXPECTED_SERVER_PORT must be a valid TCP port');
  }

  const expectedVersions = parseVersionList(
    requiredValue(env, 'RELEASE_EXPECTED_PENDING_MIGRATIONS'),
  );
  const registeredVersions = new Set(migrations.map(({ version }) => version));
  if (expectedVersions.some((version) => !registeredVersions.has(version))) {
    throw new Error('the approved pending migration list contains a version not registered in this source revision');
  }

  const migration024Pending = expectedVersions.includes(24);
  if (migration024Pending) {
    for (const name of [
      'RELEASE_MIGRATION_024_APPROVED',
      'RELEASE_MIGRATION_024_CASCADE_REVIEWED',
      'RELEASE_MIGRATION_024_WRITES_QUIESCED',
    ]) {
      if (env[name] !== 'true') {
        throw new Error('migration 024 requires separate approval, cascade review, and a write-quiescence attestation');
      }
    }
  } else if (env.RELEASE_MIGRATION_024_APPROVED === 'true') {
    throw new Error('stale migration-024 approval supplied, but version 24 is not in the approved pending list');
  }

  return {
    approvalReference,
    expectedDatabase,
    expectedUser,
    expectedServerAddress,
    expectedServerPort: Number(portText),
    expectedVersions,
    migration024Counts: migration024Pending ? {
      accounts: parseExpectedCount(env, 'RELEASE_EXPECTED_024_ACCOUNT_COUNT'),
      gameResults: parseExpectedCount(env, 'RELEASE_EXPECTED_024_GAME_RESULTS_COUNT'),
      playtimeSessions: parseExpectedCount(env, 'RELEASE_EXPECTED_024_PLAYTIME_SESSIONS_COUNT'),
    } : null,
  };
}

function assertSameTarget(actual, plan) {
  if (!actual
      || actual.database_name !== plan.expectedDatabase
      || actual.database_user !== plan.expectedUser
      || String(actual.server_address) !== plan.expectedServerAddress
      || Number(actual.server_port) !== plan.expectedServerPort) {
    throw new Error('connected database identity does not match the approved target; no migration was run');
  }
}

function assertExactVersions(actual, expected) {
  if (actual.length !== expected.length
      || actual.some((version, index) => version !== expected[index])) {
    throw new Error('pending migration list changed since approval; no migration was run');
  }
}

async function assertMigration024Impact({ client, plan }) {
  const relations = await client.query(
    "SELECT to_regclass('public.accounts') IS NOT NULL AS accounts_present, "
      + "to_regclass('public.game_results') IS NOT NULL AS game_results_present, "
      + "to_regclass('public.playtime_sessions') IS NOT NULL AS playtime_sessions_present",
  );
  const row = relations.rows?.[0];
  if (!row?.accounts_present || !row?.game_results_present || !row?.playtime_sessions_present) {
    throw new Error('migration 024 prerequisite table is missing; no migration was run');
  }

  const countSql = [
    'WITH candidates AS (',
    '  SELECT id FROM public.accounts',
    "  WHERE LOWER(role) = 'student'",
    "    AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'",
    ')',
    'SELECT',
    '  (SELECT COUNT(*) FROM candidates) AS account_count,',
    '  (SELECT COUNT(*) FROM public.game_results AS gr',
    '   JOIN candidates AS c ON c.id = gr.resolved_student_id) AS game_results_count,',
    '  (SELECT COUNT(*) FROM public.playtime_sessions AS ps',
    '   JOIN candidates AS c ON c.id = ps.student_id) AS playtime_sessions_count',
  ].join('\n');
  const result = await client.query(countSql);
  const counts = result.rows?.[0];
  if (!counts
      || Number(counts.account_count) !== plan.migration024Counts.accounts
      || Number(counts.game_results_count) !== plan.migration024Counts.gameResults
      || Number(counts.playtime_sessions_count) !== plan.migration024Counts.playtimeSessions) {
    throw new Error('migration 024 counts changed since the approved preflight; no migration was run');
  }
}

async function runApprovedReleaseMigrations({
  env = process.env,
  databaseConfig = buildReleaseDatabaseConfig(env),
  migrationDir = DEFAULT_MIGRATION_DIR,
  migrations = RELEASE_MIGRATIONS,
  clientFactory,
} = {}) {
  const plan = buildApprovalPlan(env, migrations);
  if (!databaseConfig) {
    throw new Error('DATABASE_URL or PostgreSQL connection settings are required');
  }

  let client;
  if (clientFactory) {
    client = await clientFactory(databaseConfig);
  } else {
    const { Client } = require('pg');
    client = new Client(databaseConfig);
  }

  let connected = false;
  let lockAcquired = false;
  let primaryError = null;
  try {
    await client.connect();
    connected = true;
    await client.query("SET statement_timeout = '15000ms'");
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    lockAcquired = true;

    const identitySql = [
      'SELECT current_database() AS database_name,',
      '       current_user AS database_user,',
      '       inet_server_addr()::text AS server_address,',
      '       inet_server_port() AS server_port',
    ].join('\n');
    const identityResult = await client.query(identitySql);
    assertSameTarget(identityResult.rows?.[0], plan);

    const ledgerPresence = await client.query(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_present",
    );
    if (!ledgerPresence.rows?.[0]?.ledger_present) {
      throw new Error('schema_migrations ledger is missing; no migration was run');
    }

    const registeredByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
    const ledgerResult = await client.query(
      'SELECT version, filename, checksum FROM public.schema_migrations WHERE version >= $1 ORDER BY version',
      [MIN_RELEASE_VERSION],
    );
    const ledgerByVersion = new Map();
    for (const row of ledgerResult.rows ?? []) {
      const version = Number(row.version);
      const migration = registeredByVersion.get(version);
      if (!migration || ledgerByVersion.has(version)) {
        throw new Error('database ledger contains an unknown or duplicate release migration version; no migration was run');
      }
      if (row.filename !== migration.file) {
        throw new Error('database migration filename does not match this source revision; no migration was run');
      }
      const checksum = migrationChecksum(readMigrationSql(migrationDir, migration));
      if (String(row.checksum).trim() !== checksum) {
        throw new Error('database migration checksum does not match this source revision; no migration was run');
      }
      ledgerByVersion.set(version, row);
    }

    const pending = migrations.filter(({ version }) => !ledgerByVersion.has(version));
    const actualVersions = pending.map(({ version }) => version);
    assertExactVersions(actualVersions, plan.expectedVersions);

    if (pending.length === 0) {
      return { approvalReference: plan.approvalReference, appliedVersions: [] };
    }

    if (pending.some(({ version }) => version === 24)) {
      await assertMigration024Impact({ client, plan });
    }

    // applyReleaseMigrations uses the same session advisory lock. PostgreSQL
    // session locks are reentrant; its unlock releases its own acquisition,
    // and this outer acquisition stays held through preflight and execution.
    await applyReleaseMigrations({ client, migrationDir, migrations: pending });
    return {
      approvalReference: plan.approvalReference,
      appliedVersions: pending.map(({ version }) => version),
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (connected) {
      try {
        await client.end();
      } catch (error) {
        cleanupError = cleanupError ?? error;
      }
    }
    if (!primaryError && cleanupError) {
      throw new Error('migration connection cleanup failed; inspect migration ledger before retrying');
    }
  }
}

module.exports = {
  assertExactVersions,
  assertSameTarget,
  buildApprovalPlan,
  parseVersionList,
  runApprovedReleaseMigrations,
};

if (require.main === module) {
  runApprovedReleaseMigrations()
    .then(({ appliedVersions }) => {
      if (appliedVersions.length === 0) {
        console.log('No pending release migrations matched the approved plan.');
      } else {
        console.log('Approved release migration versions completed: ' + appliedVersions.join(', '));
      }
    })
    .catch((error) => {
      console.error('Release migration gate stopped: ' + error.message);
      process.exitCode = 1;
    });
}