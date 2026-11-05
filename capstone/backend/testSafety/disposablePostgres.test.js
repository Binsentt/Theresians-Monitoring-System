'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertDisposablePostgresUrl,
  assertDisposablePostgresDatabase,
} = require('./disposablePostgres');

const databaseName = 'tq_backend_test_ci';
const connectionString = `postgresql://postgres@127.0.0.1:5432/${databaseName}`;
const sentinel = 'a'.repeat(48);
const env = { NODE_ENV: 'test', CI: 'true', TQ_DISPOSABLE_DB_SENTINEL: sentinel };

test('accepts a loopback URL only with an exact allowlisted database and run marker', () => {
  assert.deepEqual(
    assertDisposablePostgresUrl({ connectionString, expectedDatabaseName: databaseName, env }),
    { databaseName, expectedComment: `tq-disposable-ci:${sentinel}` },
  );
});

test('rejects missing marker, non-CI execution, remote hosts, wrong databases, and URL overrides', () => {
  const targets = [
    { connectionString, expectedDatabaseName: databaseName, env: { ...env, TQ_DISPOSABLE_DB_SENTINEL: '' } },
    { connectionString, expectedDatabaseName: databaseName, env: { ...env, CI: 'false' } },
    { connectionString: `postgresql://postgres@shared.example.test/${databaseName}`, expectedDatabaseName: databaseName, env },
    { connectionString, expectedDatabaseName: 'tq_backend_test_ci_shadow', env },
    { connectionString: `${connectionString}?host=shared.example.test`, expectedDatabaseName: databaseName, env },
    { connectionString: 'https://127.0.0.1/tq_backend_test_ci', expectedDatabaseName: databaseName, env },
  ];
  for (const target of targets) assert.throws(() => assertDisposablePostgresUrl(target));
});

test('connected database name and exact run marker are required before setup proceeds', async () => {
  let queryCount = 0;
  const safeClient = {
    async query() {
      queryCount += 1;
      return { rows: [{ database_name: databaseName, database_comment: `tq-disposable-ci:${sentinel}` }] };
    },
  };
  assert.equal(await assertDisposablePostgresDatabase({ client: safeClient, connectionString, expectedDatabaseName: databaseName, env }), true);
  assert.equal(queryCount, 1);

  for (const unsafeRow of [
    { database_name: 'postgres', database_comment: `tq-disposable-ci:${sentinel}` },
    { database_name: databaseName, database_comment: 'reusable test database' },
    { database_name: databaseName, database_comment: null },
  ]) {
    await assert.rejects(assertDisposablePostgresDatabase({
      client: { async query() { return { rows: [unsafeRow] }; } },
      connectionString,
      expectedDatabaseName: databaseName,
      env,
    }));
  }
});

test('unsafe URL is rejected before any database query', async () => {
  let queryCount = 0;
  await assert.rejects(assertDisposablePostgresDatabase({
    client: { async query() { queryCount += 1; return { rows: [] }; } },
    connectionString: `postgresql://postgres@shared.example.test/${databaseName}`,
    expectedDatabaseName: databaseName,
    env,
  }));
  assert.equal(queryCount, 0);
});
