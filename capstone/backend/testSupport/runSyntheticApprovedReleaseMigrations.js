'use strict';

const { Client } = require('pg');
const { RELEASE_MIGRATIONS } = require('../releaseMigrations');
const { runApprovedReleaseMigrations } = require('../scripts/run-approved-release-migrations');
const {
  assertDisposablePostgresDatabase,
  assertDisposablePostgresUrl,
} = require('../testSafety/disposablePostgres');

async function runSyntheticApprovedReleaseMigrations({
  connectionString,
  expectedDatabaseName,
  migrations = RELEASE_MIGRATIONS,
}) {
  assertDisposablePostgresUrl({ connectionString, expectedDatabaseName });
  const client = new Client({ connectionString });
  await client.connect();
  let identity;
  let pendingVersions;
  let migration024Counts = null;
  try {
    await assertDisposablePostgresDatabase({ client, connectionString, expectedDatabaseName });
    const identityResult = await client.query(`
      SELECT current_database() AS database_name,
             current_user AS database_user,
             host(inet_server_addr()) AS server_address,
             inet_server_port() AS server_port
    `);
    identity = identityResult.rows?.[0];
    if (!identity) throw new Error('Synthetic release migration fixture could not verify its database identity.');

    const ledger = await client.query(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_present",
    );
    if (!ledger.rows?.[0]?.ledger_present) {
      throw new Error('Synthetic release migration fixture requires an explicitly prepared migration ledger.');
    }
    const applied = await client.query(
      'SELECT version FROM public.schema_migrations WHERE version = ANY($1::integer[])',
      [migrations.map(({ version }) => version)],
    );
    const appliedVersions = new Set((applied.rows ?? []).map(({ version }) => Number(version)));
    pendingVersions = migrations
      .filter(({ version }) => !appliedVersions.has(version))
      .map(({ version }) => version);

    if (pendingVersions.includes(24)) {
      const impact = await client.query([
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
      ].join('\n'));
      migration024Counts = impact.rows?.[0];
      if (!migration024Counts) throw new Error('Synthetic migration-024 aggregate fixture is unavailable.');
    }
  } finally {
    await client.end();
  }

  const env = {
    RELEASE_MIGRATIONS_APPROVED: 'true',
    RELEASE_APPROVAL_REFERENCE: 'SYNTHETIC-CI-TEST',
    RELEASE_EXPECTED_DATABASE: identity.database_name,
    RELEASE_EXPECTED_DB_USER: identity.database_user,
    RELEASE_EXPECTED_SERVER_ADDRESS: identity.server_address,
    RELEASE_EXPECTED_SERVER_PORT: String(identity.server_port),
    RELEASE_EXPECTED_PENDING_MIGRATIONS: pendingVersions.length ? pendingVersions.join(',') : 'none',
  };
  if (migration024Counts) {
    Object.assign(env, {
      RELEASE_MIGRATION_024_APPROVED: 'true',
      RELEASE_MIGRATION_024_CASCADE_REVIEWED: 'true',
      RELEASE_MIGRATION_024_WRITES_QUIESCED: 'true',
      RELEASE_EXPECTED_024_ACCOUNT_COUNT: String(migration024Counts.account_count),
      RELEASE_EXPECTED_024_GAME_RESULTS_COUNT: String(migration024Counts.game_results_count),
      RELEASE_EXPECTED_024_PLAYTIME_SESSIONS_COUNT: String(migration024Counts.playtime_sessions_count),
    });
  }

  return runApprovedReleaseMigrations({
    env,
    databaseConfig: { connectionString },
    migrations,
  });
}

module.exports = { runSyntheticApprovedReleaseMigrations };
