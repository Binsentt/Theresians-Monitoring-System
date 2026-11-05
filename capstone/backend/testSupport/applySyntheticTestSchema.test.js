const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSyntheticDatabase, createSyntheticAccountsSchema } = require('./applySyntheticTestSchema');

const setSafeTestEnvironment = () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    CI: process.env.CI,
    TQ_DISPOSABLE_DB_SENTINEL: process.env.TQ_DISPOSABLE_DB_SENTINEL,
  };
  process.env.NODE_ENV = 'test';
  process.env.CI = 'true';
  process.env.TQ_DISPOSABLE_DB_SENTINEL = 'a'.repeat(48);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
};

test('synthetic schema guard rejects missing CI marker before querying PostgreSQL', async () => {
  const restore = setSafeTestEnvironment();
  delete process.env.TQ_DISPOSABLE_DB_SENTINEL;
  const calls = [];
  try {
    await assert.rejects(
      assertSyntheticDatabase({ query: async (...args) => { calls.push(args); } }, 'postgresql://postgres@127.0.0.1:5432/tq_backend_test_ci'),
      /run-marked loopback tq_\*_test_ci database/,
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('synthetic schema guard rejects non-loopback targets before querying PostgreSQL', async () => {
  const restore = setSafeTestEnvironment();
  const calls = [];
  try {
    await assert.rejects(
      assertSyntheticDatabase({ query: async (...args) => { calls.push(args); } }, 'postgresql://postgres@example.invalid:5432/tq_backend_test_ci'),
      /run-marked loopback tq_\*_test_ci database/,
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('synthetic schema guard rejects connection URL overrides before querying PostgreSQL', async () => {
  const restore = setSafeTestEnvironment();
  const calls = [];
  try {
    await assert.rejects(
      assertSyntheticDatabase(
        { query: async (...args) => { calls.push(args); } },
        'postgresql://postgres@127.0.0.1:5432/tq_backend_test_ci?host=shared.example.test',
      ),
      /run-marked loopback tq_\*_test_ci database/,
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('synthetic schema guard rejects database markers from another CI run', async () => {
  const restore = setSafeTestEnvironment();
  const calls = [];
  try {
    await assert.rejects(
      assertSyntheticDatabase({
        query: async (...args) => {
          calls.push(args);
          return { rows: [{ database_name: 'tq_backend_test_ci', database_comment: 'tq-disposable-ci:' + 'b'.repeat(48) }] };
        },
      }, 'postgresql://postgres@127.0.0.1:5432/tq_backend_test_ci'),
      /database run marker does not match this CI run/,
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /pg_catalog\.pg_database/);
  } finally {
    restore();
  }
});

test('synthetic schema guard accepts only the current run marker for the current database', async () => {
  const restore = setSafeTestEnvironment();
  const sentinel = process.env.TQ_DISPOSABLE_DB_SENTINEL;
  try {
    const result = await assertSyntheticDatabase({
      query: async () => ({ rows: [{ database_name: 'tq_backend_test_ci', database_comment: `tq-disposable-ci:${sentinel}` }] }),
    }, 'postgresql://postgres@127.0.0.1:5432/tq_backend_test_ci');
    assert.equal(result, undefined);
  } finally {
    restore();
  }
});

test('synthetic account fixture creates the canonical baseline columns only after the run marker passes', async () => {
  const restore = setSafeTestEnvironment();
  const sentinel = process.env.TQ_DISPOSABLE_DB_SENTINEL;
  const calls = [];
  try {
    await createSyntheticAccountsSchema({
      query: async (sql) => {
        calls.push(String(sql));
        if (String(sql).includes('pg_catalog.pg_database')) {
          return { rows: [{ database_name: 'tq_backend_test_ci', database_comment: `tq-disposable-ci:${sentinel}` }] };
        }
        return { rows: [] };
      },
    }, 'postgresql://postgres@127.0.0.1:5432/tq_backend_test_ci');

    const markerQuery = calls.findIndex((sql) => sql.includes('pg_catalog.pg_database'));
    const accountDdl = calls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS public.accounts'));
    assert.ok(markerQuery >= 0 && accountDdl > markerQuery, 'the run marker is checked before fixture DDL');
    for (const column of [
      'mobile_number VARCHAR(20)', 'otp_code VARCHAR(10)', 'created_at TIMESTAMPTZ',
      'address VARCHAR(255)', 'birthday DATE', 'gender VARCHAR(20)', "status VARCHAR(20)",
    ]) assert.ok(calls[accountDdl].includes(column), `canonical fixture includes ${column}`);
    assert.match(calls[accountDdl], /email VARCHAR\(100\) NOT NULL/);
    assert.match(calls[accountDdl], /CONSTRAINT accounts_email_key UNIQUE \(email\)/);
  } finally {
    restore();
  }
});
