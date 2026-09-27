const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bootstrapEmptyQaSchema } = require('./bootstrapEmptyQaSchema');

const qaEnv = {
  RAILWAY_ENVIRONMENT_NAME: 'qa-owner-testing',
  DATABASE_URL: 'postgres://qa-only.invalid/test',
};

test('QA schema bootstrap refuses every environment except qa-owner-testing before connecting', async () => {
  let clientCreated = false;

  await assert.rejects(
    bootstrapEmptyQaSchema({
      env: { ...qaEnv, RAILWAY_ENVIRONMENT_NAME: 'production' },
      Client: class {
        constructor() { clientCreated = true; }
      },
    }),
    /only allowed in qa-owner-testing/,
  );

  assert.equal(clientCreated, false);
});

test('QA schema bootstrap requires the Railway database reference', async () => {
  await assert.rejects(
    bootstrapEmptyQaSchema({
      env: { RAILWAY_ENVIRONMENT_NAME: 'qa-owner-testing' },
      Client: class {},
    }),
    /DATABASE_URL is required/,
  );
});

test('QA schema bootstrap stops before application schema setup if accounts are not empty', async () => {
  let schemaLoaded = false;

  await assert.rejects(
    bootstrapEmptyQaSchema({
      env: qaEnv,
      Client: class {
        async connect() {}
        async query(sql) {
          if (sql.startsWith('CREATE TABLE')) return { rows: [] };
          return { rows: [{ account_count: 1 }] };
        }
        async end() {}
      },
      loadServer: () => {
        schemaLoaded = true;
        return { schemaReady: Promise.resolve() };
      },
    }),
    /accounts table must be empty/,
  );

  assert.equal(schemaLoaded, false);
});

test('empty isolated QA database initializes the application schema and logs no credentials', async () => {
  const events = [];
  const logs = [];
  const queries = [];

  await bootstrapEmptyQaSchema({
    env: qaEnv,
    Client: class {
      async connect() { events.push('connected'); }
      async query(sql) {
        queries.push(sql);
        if (sql.startsWith('CREATE TABLE')) return { rows: [] };
        if (sql.includes('COUNT(*)')) return { rows: [{ account_count: 0 }] };
        return { rows: [{ database_name: 'qa_database' }] };
      }
      async end() { events.push('closed'); }
    },
    loadServer: () => {
      assert.deepEqual(events, ['connected', 'closed']);
      return { schemaReady: Promise.resolve().then(() => events.push('schema-ready')) };
    },
    logger: { log: (message) => logs.push(message) },
  });

  assert.equal(queries.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS public.accounts')), true);
  assert.equal(events.at(-1), 'schema-ready');
  assert.equal(logs.some((message) => message.includes('DATABASE_URL')), false);
  assert.equal(logs.some((message) => message.includes('qa_database') && message.includes('accounts=0')), true);
});
