const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('pg');

const migrationPath = path.join(__dirname, '017_widen_game_student_id_to_eight.sql');
const migrationTestUrl = process.env.STUDENT_ID_MIGRATION_TEST_DATABASE_URL || '';

const requireDisposableDatabase = () => {
  const parsed = new URL(migrationTestUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  assert.match(
    databaseName,
    /^tq_student_id_migration_test_[a-z0-9_]+$/,
    'migration test must use a dedicated tq_student_id_migration_test_* database'
  );
  return databaseName;
};

const expectPostgresError = async (callback, code) => {
  await assert.rejects(callback, (error) => error && error.code === code);
};

test('017 widens only accounts.game_student_id while preserving legacy values and constraints', {
  skip: migrationTestUrl ? false : 'STUDENT_ID_MIGRATION_TEST_DATABASE_URL is required for the disposable PostgreSQL test',
}, async () => {
  requireDisposableDatabase();
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.match(migration, /^\s*ALTER TABLE public\.accounts\s+ALTER COLUMN game_student_id TYPE VARCHAR\(8\);\s*$/is);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT|DELETE|DROP|CREATE)\b/i);

  const client = new Client({ connectionString: migrationTestUrl });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS public.accounts, public.unrelated_student_id_migration_guard CASCADE');
    await client.query('CREATE TABLE public.accounts (id SERIAL PRIMARY KEY, game_student_id VARCHAR(6) NULL)');
    await client.query('CREATE UNIQUE INDEX accounts_game_student_id_key ON public.accounts(game_student_id) WHERE game_student_id IS NOT NULL');
    await client.query('CREATE TABLE public.unrelated_student_id_migration_guard (id INTEGER PRIMARY KEY)');
    await client.query("INSERT INTO public.accounts (game_student_id) VALUES ('001234'), (NULL)");
    await client.query('INSERT INTO public.unrelated_student_id_migration_guard (id) VALUES (1)');

    await client.query(migration);

    const column = await client.query(
      `SELECT character_maximum_length, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'game_student_id'`
    );
    assert.deepEqual(column.rows, [{ character_maximum_length: 8, is_nullable: 'YES' }]);

    const legacy = await client.query("SELECT game_student_id FROM public.accounts WHERE game_student_id = '001234'");
    assert.deepEqual(legacy.rows, [{ game_student_id: '001234' }]);

    await client.query("INSERT INTO public.accounts (game_student_id) VALUES ('00123456'), (NULL)");
    await expectPostgresError(
      () => client.query("INSERT INTO public.accounts (game_student_id) VALUES ('00123456')"),
      '23505'
    );
    await expectPostgresError(
      () => client.query("INSERT INTO public.accounts (game_student_id) VALUES ('123456789')"),
      '22001'
    );

    const uniqueIndex = await client.query(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'accounts' AND indexname = 'accounts_game_student_id_key'`
    );
    assert.equal(uniqueIndex.rows.length, 1);
    assert.match(uniqueIndex.rows[0].indexdef, /UNIQUE INDEX/);
    assert.match(uniqueIndex.rows[0].indexdef, /WHERE \(game_student_id IS NOT NULL\)/);

    const unrelated = await client.query('SELECT id FROM public.unrelated_student_id_migration_guard');
    assert.deepEqual(unrelated.rows, [{ id: 1 }]);
  } finally {
    await client.query('DROP TABLE IF EXISTS public.accounts, public.unrelated_student_id_migration_guard CASCADE');
    await client.end();
  }
});
