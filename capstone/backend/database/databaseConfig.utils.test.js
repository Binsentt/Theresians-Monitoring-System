const assert = require('node:assert/strict');
const { test } = require('node:test');

const { buildDatabaseConfig } = require('./databaseConfig.utils');

test('local database config uses environment-provided credentials', () => {
  const config = buildDatabaseConfig({
    PGHOST: 'db.local',
    PGUSER: 'app_user',
    PGPASSWORD: 'from-env',
    PGDATABASE: 'theresian_local',
    PGPORT: '15432',
  });

  assert.deepEqual(config, {
    host: 'db.local',
    user: 'app_user',
    password: 'from-env',
    database: 'theresian_local',
    port: 15432,
  });
});

test('local database config does not bundle a password fallback', () => {
  const config = buildDatabaseConfig({});

  assert.equal(config.password, '');
});

test('database URL config preserves the existing SSL flag behavior', () => {
  const config = buildDatabaseConfig({
    DATABASE_URL: 'postgres://example',
    DB_SSL: 'true',
  });

  assert.deepEqual(config, {
    connectionString: 'postgres://example',
    ssl: { rejectUnauthorized: false },
  });
});
