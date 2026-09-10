const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('pg');

const migrationPath = path.join(__dirname, '018_website_sessions_and_audit_metadata.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const migrationTestUrl = process.env.WEBSITE_SESSION_MIGRATION_TEST_DATABASE_URL || '';

const requireDisposableDatabase = () => {
  const parsed = new URL(migrationTestUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname), 'migration test must use local PostgreSQL');
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  assert.match(databaseName, /^tq_website_session_migration_test_[a-z0-9_]+$/);
  return databaseName;
};

test('018 is an additive, transactional migration for audit metadata and website sessions', () => {
  assert.match(migration, /^\s*BEGIN;/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS before_metadata JSONB/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS after_metadata JSONB/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.website_sessions/i);
  assert.match(migration, /credential_hash CHAR\(64\) NOT NULL UNIQUE/i);
  assert.match(migration, /REFERENCES public\.accounts\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /website_sessions_account_presence_index/i);
  assert.match(migration, /website_sessions_expiry_index/i);
  assert.match(migration, /COMMIT;\s*$/i);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE/i);
});

test('018 supports fresh install, prior-schema upgrade, repeat application, and record preservation', {
  skip: migrationTestUrl ? false : 'WEBSITE_SESSION_MIGRATION_TEST_DATABASE_URL is required for the disposable local PostgreSQL test',
}, async () => {
  requireDisposableDatabase();
  const client = new Client({ connectionString: migrationTestUrl });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS public.website_sessions, public.admin_audit_logs, public.accounts CASCADE');
    await client.query(`CREATE TABLE public.accounts (
      id SERIAL PRIMARY KEY,
      role VARCHAR(50) NOT NULL,
      is_archived BOOLEAN NOT NULL DEFAULT false
    )`);
    await client.query(`CREATE TABLE public.admin_audit_logs (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
      action VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
    await client.query("INSERT INTO public.accounts (role) VALUES ('admin'), ('teacher')");
    await client.query("INSERT INTO public.admin_audit_logs (admin_id, action) VALUES (1, 'preserve-me')");

    await client.query(migration);
    await client.query(migration);

    const audit = await client.query('SELECT action, before_metadata, after_metadata FROM public.admin_audit_logs ORDER BY id');
    assert.deepEqual(audit.rows, [{ action: 'preserve-me', before_metadata: null, after_metadata: null }]);

    const insert = await client.query(
      `INSERT INTO public.website_sessions (account_id, credential_hash, expires_at)
       VALUES (2, $1, CURRENT_TIMESTAMP + INTERVAL '30 days')
       RETURNING id`,
      ['a'.repeat(64)]
    );
    assert.equal(insert.rows.length, 1);
    await assert.rejects(
      () => client.query(
        `INSERT INTO public.website_sessions (account_id, credential_hash, expires_at)
         VALUES (2, $1, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
        ['a'.repeat(64)]
      ),
      (error) => error?.code === '23505'
    );

    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'website_sessions'
       ORDER BY indexname`
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname), [
      'website_sessions_account_presence_index',
      'website_sessions_expiry_index',
      'website_sessions_pkey',
      'website_sessions_credential_hash_key',
    ].sort());

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.admin_audit_logs (admin_id, action, before_metadata, after_metadata)
       VALUES (1, 'rolled-back-mutation', '{"before":true}'::jsonb, '{"after":true}'::jsonb)`
    );
    await client.query(
      `INSERT INTO public.website_sessions (account_id, credential_hash, expires_at)
       VALUES (2, $1, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      ['b'.repeat(64)]
    );
    await client.query('ROLLBACK');
    const rolledBack = await client.query("SELECT COUNT(*)::integer AS count FROM public.admin_audit_logs WHERE action = 'rolled-back-mutation'");
    assert.deepEqual(rolledBack.rows, [{ count: 0 }]);
    const rolledBackSession = await client.query('SELECT COUNT(*)::integer AS count FROM public.website_sessions WHERE credential_hash = $1', ['b'.repeat(64)]);
    assert.deepEqual(rolledBackSession.rows, [{ count: 0 }]);

    const secondClient = new Client({ connectionString: migrationTestUrl });
    await secondClient.connect();
    try {
      await Promise.all([
        client.query(
          `INSERT INTO public.website_sessions (account_id, credential_hash, expires_at)
           VALUES (2, $1, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
          ['c'.repeat(64)]
        ),
        secondClient.query(
          `INSERT INTO public.website_sessions (account_id, credential_hash, expires_at)
           VALUES (2, $1, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
          ['d'.repeat(64)]
        ),
      ]);
      const concurrent = await secondClient.query(
        `SELECT COUNT(*)::integer AS count
         FROM public.website_sessions
         WHERE account_id = 2 AND credential_hash IN ($1, $2)`,
        ['c'.repeat(64), 'd'.repeat(64)]
      );
      assert.deepEqual(concurrent.rows, [{ count: 2 }]);

      const restartRead = await secondClient.query('SELECT COUNT(*)::integer AS count FROM public.website_sessions WHERE account_id = 2');
      assert.equal(restartRead.rows[0].count >= 3, true, 'a new database connection must see persisted session rows');
    } finally {
      await secondClient.end();
    }
  } finally {
    await client.query('DROP TABLE IF EXISTS public.website_sessions, public.admin_audit_logs, public.accounts CASCADE');
    await client.end();
  }
});
