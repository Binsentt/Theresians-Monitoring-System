const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { applySyntheticTestSchema, assertSyntheticDatabase, createSyntheticAccountsSchema } = require('./testSupport/applySyntheticTestSchema');
const { assertStartupSchemaReady } = require('./database/startupSchemaReadiness');

const databaseUrl = process.env.STARTUP_SAFETY_TEST_DATABASE_URL || '';
const isSafeDatabaseUrl = (value) => {
  try {
    const parsed = new URL(value);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
      && /^tq_startup_safety_test_[a-z0-9_]+$/i.test(name);
  } catch {
    return false;
  }
};

if (!isSafeDatabaseUrl(databaseUrl)) {
  test('startup safety PostgreSQL integration', {
    skip: 'STARTUP_SAFETY_TEST_DATABASE_URL must target a loopback tq_startup_safety_test_* database',
  }, () => {});
} else {
  test('application startup is read-only and rejects incomplete schema on disposable PostgreSQL', async (t) => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.CI, 'true');
    const admin = new Pool({ connectionString: databaseUrl });
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalDbSsl = process.env.DB_SSL;
    const dbModulePath = require.resolve('./database/db');
    const serverModulePath = require.resolve('./server');
    let role = null;
    let readOnlyPool = null;
    t.after(async () => {
      const cachedPool = require.cache[dbModulePath]?.exports;
      await readOnlyPool?.end().catch(() => {});
      if (cachedPool && cachedPool !== readOnlyPool) await cachedPool.end().catch(() => {});
      delete require.cache[serverModulePath];
      delete require.cache[dbModulePath];
      if (role) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await admin.end().catch(() => {});
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalDbSsl === undefined) delete process.env.DB_SSL;
      else process.env.DB_SSL = originalDbSsl;
    });

    await assertSyntheticDatabase(admin, databaseUrl);
    const adminConfig = new URL(databaseUrl);
    const databaseName = decodeURIComponent(adminConfig.pathname.replace(/^\//, ''));
    const existingTables = await admin.query(`
      SELECT COUNT(*)::integer AS count
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    `);
    assert.equal(existingTables.rows[0].count, 0, 'startup safety database must be fresh and disposable');

    process.env.DATABASE_URL = databaseUrl;
    process.env.DB_SSL = 'false';
    delete require.cache[serverModulePath];
    delete require.cache[dbModulePath];
    const incompleteServer = require('./server');
    const incompletePool = require('./database/db');
    try {
      await assert.rejects(incompleteServer.schemaReady, /database schema is not ready: accounts/);
    } finally {
      await incompletePool.end();
      delete require.cache[serverModulePath];
      delete require.cache[dbModulePath];
    }

    await assert.rejects(assertStartupSchemaReady(admin), /database schema is not ready: accounts/);

    await createSyntheticAccountsSchema(admin, databaseUrl);
    await applySyntheticTestSchema(admin, databaseUrl);

    await admin.query(`INSERT INTO public.accounts
      (name, email, password, role, parent_id, game_student_id, is_archived,
       session_version, current_learning_cycle_version)
      VALUES ('Synthetic Parent', 'parent@example.test', 'unused', 'parent', NULL, NULL, NULL, NULL, 0),
             ('Synthetic Legacy Student', 'student@example.test', 'unused', 'student', NULL, '123456', false, 0, 0)`);
    await admin.query(`INSERT INTO public.folders (name, trashed_at, deleted_at)
      VALUES ('Synthetic trashed folder', TIMESTAMPTZ '2026-01-01 00:00:00+00', NULL)`);
    await admin.query(`INSERT INTO public.learning_files
      (title, file_name, file_url, grade_level, file_type, subject, source, trashed_at,
       deleted_at, generation_status, publish_status, published)
      VALUES ('Synthetic file', 'synthetic.pdf', '/synthetic.pdf', 'Grade 1', 'lesson',
              'Mathematics', 'test', TIMESTAMPTZ '2026-01-01 00:00:00+00', NULL, NULL, NULL, false)`);

    role = `tq_startup_readonly_${process.pid}`;
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO ${role}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);

    const readOnlyUrl = new URL(databaseUrl);
    readOnlyUrl.username = role;
    readOnlyUrl.password = '';
    process.env.DATABASE_URL = readOnlyUrl.toString();
    process.env.DB_SSL = 'false';
    delete require.cache[serverModulePath];
    delete require.cache[dbModulePath];
    const { app, schemaReady } = require('./server');
    readOnlyPool = require('./database/db');

    await schemaReady;
    const readOnlySetting = await readOnlyPool.query('SHOW transaction_read_only');
    assert.equal(readOnlySetting.rows[0].transaction_read_only, 'on');
    assert.equal(typeof app.listen, 'function');

    const unchanged = await admin.query(`
      SELECT
        (SELECT parent_id FROM public.accounts WHERE role = 'parent' LIMIT 1) AS parent_id,
        (SELECT is_archived::text FROM public.accounts WHERE role = 'parent' LIMIT 1) AS parent_archived,
        (SELECT session_version::text FROM public.accounts WHERE role = 'parent' LIMIT 1) AS parent_session_version,
        (SELECT game_student_id FROM public.accounts WHERE role = 'student' LIMIT 1) AS legacy_student_code,
        (SELECT deleted_at::text FROM public.folders WHERE name = 'Synthetic trashed folder') AS folder_deleted_at,
        (SELECT generation_status FROM public.learning_files WHERE file_name = 'synthetic.pdf') AS generation_status,
        (SELECT publish_status FROM public.learning_files WHERE file_name = 'synthetic.pdf') AS publish_status,
        (SELECT deleted_at::text FROM public.learning_files WHERE file_name = 'synthetic.pdf') AS file_deleted_at
    `);
    assert.deepEqual(unchanged.rows[0], {
      parent_id: null,
      parent_archived: null,
      parent_session_version: null,
      legacy_student_code: '123456',
      folder_deleted_at: null,
      generation_status: null,
      publish_status: null,
      file_deleted_at: null,
    });
  });
}
