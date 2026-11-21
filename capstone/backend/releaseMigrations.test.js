const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { applyReleaseMigrations, migrationChecksum, RELEASE_MIGRATIONS } = require('./releaseMigrations');

const EXPECTED_CANONICAL_MIGRATION_CHECKSUMS = Object.freeze({
  18: 'f64e6e0de7abdf873fdb1bc93739d2704e4b16ed5bc428c991c7507407ea5668',
  19: 'b76fa5f58daae29dbcf2120b4c9ff533eda3c41dc3f21efdab93b207fb8b2f4f',
  20: '6e2cf94b9a8acdcee728e8a0283a95580fc7e63f6622dcb5890415f4b9e715af',
  21: '3b5ff42ba45a158df434b92b95e935c608fc0a236516d8135d6d0329963beac6',
  22: '5a45ef2133bc0d69fe117f7164eeb9af65eb16bcf6f4a1215804bd14919e3c76',
  23: '2df0959d48efd554a8e7403ebbf331bfdfb6971b2d66e43a6ae267c02642f12d',
  24: '2595a35fe97699376b611f21cc19aa4b7e26d495463fe7585bf7e1c96370e111',
  25: '2a1b904056274c73903cfb713703c6db8e6c2ea37f9c8fd1863f9a3004e42e68',
  26: '334f7b73ddc1c8d6ddcdafd547181f75fbeac85df713d4ba73995fb9c4d23b12',
});

test('migration checksums normalize CRLF and lone CR to the canonical LF content', () => {
  const lfSql = 'CREATE TABLE example (id INTEGER);\nINSERT INTO example VALUES (1);\n';
  const crlfSql = lfSql.replace(/\n/g, '\r\n');
  const loneCrSql = lfSql.replace(/\n/g, '\r');

  assert.equal(migrationChecksum(crlfSql), migrationChecksum(lfSql));
  assert.equal(migrationChecksum(loneCrSql), migrationChecksum(lfSql));
  assert.notEqual(migrationChecksum(lfSql.replace('VALUES (1)', 'VALUES (2)')), migrationChecksum(lfSql));
});

test('migrations 018-026 retain canonical LF checksums from the preflight manifest', () => {
  const preflight = fs.readFileSync(path.join(__dirname, 'scripts', 'release-migration-preflight.sql'), 'utf8');
  const preflightEntries = new Map(
    [...preflight.matchAll(/\((\d+),\s*'([^']+)',\s*'([a-f0-9]{64})'\)/gi)].map(([, version, file, checksum]) => [
      Number(version),
      { file, checksum: checksum.toLowerCase() },
    ]),
  );
  const migrations = RELEASE_MIGRATIONS.filter(({ version }) => version >= 18 && version <= 26);

  assert.deepEqual(migrations.map(({ version }) => version), Object.keys(EXPECTED_CANONICAL_MIGRATION_CHECKSUMS).map(Number));

  for (const migration of migrations) {
    const expectedChecksum = EXPECTED_CANONICAL_MIGRATION_CHECKSUMS[migration.version];
    const manifestEntry = preflightEntries.get(migration.version);
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', migration.file), 'utf8');
    const canonicalLfSql = sql.replace(/\r\n?/g, '\n');

    assert.ok(manifestEntry, `preflight manifest must contain migration ${migration.version}`);
    assert.equal(manifestEntry.file, migration.file);
    assert.equal(manifestEntry.checksum, expectedChecksum);
    assert.equal(migrationChecksum(canonicalLfSql), expectedChecksum, `LF checksum changed for migration ${migration.version}`);
    assert.equal(migrationChecksum(sql), expectedChecksum, `checkout line endings changed migration ${migration.version} checksum`);
    assert.equal(migrationChecksum(canonicalLfSql.replace(/\n/g, '\r\n')), expectedChecksum);
    assert.equal(migrationChecksum(canonicalLfSql.replace(/\n/g, '\r')), expectedChecksum);
  }
});

test('release manifest includes migration 026 for game progress save commit idempotency', () => {
  assert.deepEqual(RELEASE_MIGRATIONS.at(-1), { version: 26, file: '026_game_progress_save_commit_idempotency.sql' });
});

test('save commit receipt migration is additive and enforces scoped idempotency constraints', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '026_game_progress_save_commit_idempotency.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.game_progress_save_commits/i);
  assert.match(sql, /student_id INTEGER NOT NULL[\s\S]*REFERENCES public\.accounts\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /learning_cycle_version INTEGER NOT NULL/i);
  assert.match(sql, /PRIMARY KEY \(student_id, learning_cycle_version, save_commit_id_hash\)/i);
  assert.match(sql, /payload_sha256 TEXT NOT NULL/i);
  assert.match(sql, /activity_event_key TEXT NOT NULL/i);
  assert.match(sql, /response_body JSONB/i);
  assert.match(sql, /UNIQUE \(student_id, activity_event_key\)/i);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE FROM|UPDATE public\.(student_game_progress|activity_logs))\b/i);
});

test('question traceability migration is nullable, referential, and performs no historical guess or backfill', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '025_add_game_result_question_traceability.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS question_id INTEGER/i);
  assert.match(sql, /FOREIGN KEY \(question_id, question_set_id\)/i);
  assert.match(sql, /REFERENCES public\.questions\(id, learning_file_id\)/i);
  assert.match(sql, /ON DELETE RESTRICT/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_game_results_question_id/i);
  assert.doesNotMatch(sql, /UPDATE\s+public\.game_results/i);
});

test('legacy Student cleanup migration only targets exact six-digit Student IDs and removes dependent runtime data', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '024_remove_legacy_six_digit_students.sql'), 'utf8');
  assert.match(sql, /LOWER\(role\) = 'student'/);
  assert.match(sql, /game_student_id[\s\S]*\^\[0-9\]\{6\}\$/);
  assert.match(sql, /DELETE FROM public\.game_results/);
  assert.match(sql, /DELETE FROM public\.playtime_sessions/);
  assert.match(sql, /DELETE FROM public\.accounts/);
  assert.doesNotMatch(sql, /\^\[0-9\]\{8\}\$/);
});

test('release migrations apply in order under an advisory lock and record checksums', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('SELECT version, checksum')) return { rows: [] };
      return { rows: [] };
    },
  };

  await applyReleaseMigrations({
    client,
    migrationDir: __dirname + '/migrations',
    migrations: [
      { version: 18, file: '018_website_sessions_and_audit_metadata.sql' },
      { version: 19, file: '019_playtime_history_removal.sql' },
      { version: 20, file: '020_add_auth_otp_challenge_security.sql' },
    ],
  });

  assert.match(calls.find(({ sql }) => sql.includes('pg_advisory_lock')).sql, /pg_advisory_lock/);
  assert.match(calls.at(-1).sql, /pg_advisory_unlock/);
  const migrationCalls = calls.filter(({ sql }) => /admin_audit_logs|playtime_sessions|otp_code_hash/.test(sql));
  assert.equal(migrationCalls.length, 3);
  assert.match(migrationCalls[0].sql, /admin_audit_logs|website_sessions/);
  assert.match(migrationCalls[1].sql, /playtime_sessions/);
  assert.match(migrationCalls[2].sql, /accounts/);
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO public.schema_migrations')).length, 3);
});

test('release migrations reject a checksum mismatch instead of silently reapplying a changed file', async () => {
  const migration = { version: 18, file: '018_website_sessions_and_audit_metadata.sql' };
  const migrationSql = fs.readFileSync(path.join(__dirname, 'migrations', migration.file), 'utf8');
  const correctChecksum = migrationChecksum(migrationSql);
  const incorrectChecksum = `${correctChecksum[0] === '0' ? '1' : '0'}${correctChecksum.slice(1)}`;
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (String(sql).includes('SELECT version, checksum')) return { rows: [{ version: 18, checksum: incorrectChecksum }] };
      return { rows: [] };
    },
  };

  await assert.rejects(
    applyReleaseMigrations({
      client,
      migrationDir: __dirname + '/migrations',
      migrations: [migration],
    }),
    /checksum mismatch/i,
  );
  assert.equal(calls.includes(migrationSql), false, 'a checksum mismatch must not execute migration SQL');
  assert.equal(calls.some((sql) => sql.includes('INSERT INTO public.schema_migrations')), false);
  assert.match(calls.at(-1), /pg_advisory_unlock/);
});

test('release migration failure propagates and always releases the advisory lock', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (String(sql).includes('SELECT version, checksum')) return { rows: [] };
      if (String(sql).includes('admin_audit_logs')) throw new Error('synthetic migration failure');
      return { rows: [] };
    },
  };

  await assert.rejects(
    applyReleaseMigrations({
      client,
      migrationDir: __dirname + '/migrations',
      migrations: [{ version: 18, file: '018_website_sessions_and_audit_metadata.sql' }],
    }),
    /synthetic migration failure/,
  );
  assert.match(calls.at(-1), /pg_advisory_unlock/);
  assert.equal(calls.filter((sql) => sql.includes('INSERT INTO public.schema_migrations')).length, 0);
});
