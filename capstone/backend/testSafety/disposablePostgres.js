'use strict';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_DATABASES = new Set([
  'tq_backend_test_ci',
  'tq_game_metrics_test_ci',
  'tq_auth_recovery_test_ci',
  'tq_archived_progress_test_ci',
  'tq_screen_time_test_ci',
  'tq_student_id_migration_test_ci',
  'tq_website_session_migration_test_ci',
  'tq_parent_route_test_ci',
]);
const SENTINEL_PATTERN = /^[a-f0-9]{48}$/;

function assertDisposablePostgresUrl({ connectionString, expectedDatabaseName, env = process.env }) {
  if (env.NODE_ENV !== 'test' || env.CI !== 'true') {
    throw new Error('Destructive PostgreSQL tests require CI=true and NODE_ENV=test.');
  }
  const sentinel = String(env.TQ_DISPOSABLE_DB_SENTINEL || '');
  if (!SENTINEL_PATTERN.test(sentinel)) {
    throw new Error('A run-specific disposable PostgreSQL sentinel is required.');
  }
  if (!DISPOSABLE_DATABASES.has(expectedDatabaseName)) {
    throw new Error('The expected PostgreSQL database is not on the disposable test allowlist.');
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch (_error) {
    throw new Error('The PostgreSQL test connection URL is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Destructive PostgreSQL tests require the PostgreSQL protocol.');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Destructive PostgreSQL tests require a loopback database host.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('PostgreSQL test URLs may not override the host or database with query parameters.');
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  } catch (_error) {
    throw new Error('The PostgreSQL test database name is invalid.');
  }
  if (databaseName !== expectedDatabaseName) {
    throw new Error('The PostgreSQL URL does not identify the expected disposable test database.');
  }

  return { databaseName, expectedComment: `tq-disposable-ci:${sentinel}` };
}

async function assertDisposablePostgresDatabase({ client, connectionString, expectedDatabaseName, env = process.env }) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A connected PostgreSQL client or pool is required.');
  }
  const target = assertDisposablePostgresUrl({ connectionString, expectedDatabaseName, env });
  const result = await client.query(
    `SELECT current_database() AS database_name,
            shobj_description(db.oid, 'pg_database') AS database_comment
     FROM pg_database db
     WHERE db.datname = current_database()`,
  );
  const row = result.rows?.[0];
  if (!row || row.database_name !== target.databaseName) {
    throw new Error('Connected PostgreSQL database identity does not match the expected disposable test database.');
  }
  if (row.database_comment !== target.expectedComment) {
    throw new Error('Connected PostgreSQL database is missing this run’s disposable safety marker.');
  }
  return true;
}

module.exports = { assertDisposablePostgresUrl, assertDisposablePostgresDatabase };
