const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bootstrapQaSchemaIfNeeded } = require('./qaReleaseSchema');

const qaEnv = {
  RAILWAY_ENVIRONMENT_NAME: 'qa-owner-testing',
  DATABASE_URL: 'postgres://qa-only.invalid/test',
};

test('QA schema bootstrap is a no-op outside the exact QA environment', async () => {
  let clientCreated = false;
  let bootstrapCalled = false;

  const result = await bootstrapQaSchemaIfNeeded({
    env: { ...qaEnv, RAILWAY_ENVIRONMENT_NAME: 'production' },
    Client: class { constructor() { clientCreated = true; } },
    bootstrap: async () => { bootstrapCalled = true; },
  });

  assert.equal(result.bootstrapped, false);
  assert.equal(clientCreated, false);
  assert.equal(bootstrapCalled, false);
});

test('QA schema bootstrap initializes only when the release migration ledger is absent or empty', async () => {
  let bootstrapCalls = 0;
  const result = await bootstrapQaSchemaIfNeeded({
    env: qaEnv,
    Client: class {
      async connect() {}
      async query(sql) {
        if (sql.includes('to_regclass')) return { rows: [{ migration_table: null }] };
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      async end() {}
    },
    bootstrap: async () => { bootstrapCalls += 1; },
  });

  assert.equal(result.bootstrapped, true);
  assert.equal(bootstrapCalls, 1);
});

test('QA schema bootstrap is skipped after migrations exist, preserving QA fixtures on redeploy', async () => {
  let bootstrapCalls = 0;
  const result = await bootstrapQaSchemaIfNeeded({
    env: qaEnv,
    Client: class {
      async connect() {}
      async query(sql) {
        if (sql.includes('to_regclass')) return { rows: [{ migration_table: 'schema_migrations' }] };
        return { rows: [{ latest_version: 24 }] };
      }
      async end() {}
    },
    bootstrap: async () => { bootstrapCalls += 1; },
  });

  assert.equal(result.bootstrapped, false);
  assert.equal(result.latestVersion, 24);
  assert.equal(bootstrapCalls, 0);
});
