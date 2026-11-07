const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_SCHEMA,
  SCHEMA_READINESS_SQL,
  assertStartupSchemaReady,
} = require('./database/startupSchemaReadiness');

test('startup schema readiness issues one SELECT-only catalog check for the complete schema contract', async () => {
  const calls = [];
  await assertStartupSchemaReady({
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^\s*WITH\b/i);
  assert.match(calls[0].sql, /pg_catalog\.pg_(?:namespace|class|attribute)/);
  assert.match(calls[0].sql, /pg_catalog\.pg_constraint/);
  assert.match(calls[0].sql, /game_progress_save_commits_activity_event_unique/);
  assert.match(calls[0].sql, /game_progress_save_commits_student_id_fkey/);
  assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  assert.deepEqual(JSON.parse(calls[0].params[0]), Object.entries(REQUIRED_SCHEMA).map(([table_name, columns]) => ({ table_name, columns })));
  assert.equal(calls[0].sql, SCHEMA_READINESS_SQL);
});

test('missing required schema returns a controlled readiness error without attempting repair', async () => {
  const calls = [];
  await assert.rejects(
    assertStartupSchemaReady({
      async query(sql) {
        calls.push(String(sql));
        return { rows: [{ missing_object: 'accounts' }, { missing_object: 'game_results.question_id' }] };
      },
    }),
    /database schema is not ready: accounts, game_results\.question_id; apply separately approved schema migrations/,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\s*WITH\b/i);
  assert.doesNotMatch(calls[0], /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
});

test('catalog-check failures stop readiness without exposing repair fallbacks', async () => {
  await assert.rejects(
    assertStartupSchemaReady({ query: async () => { throw new Error('fixture connection error'); } }),
    /^Error: read-only database schema compatibility check failed$/,
  );
});

test('operator migration preflight mirrors the runtime table and column contract', () => {
  const preflight = fs.readFileSync(
    path.join(__dirname, 'scripts', 'release-migration-preflight.sql'),
    'utf8',
  );
  const entries = Object.entries(REQUIRED_SCHEMA).flatMap(([table, columns]) => (
    columns.map((column) => `('${table}', '${column}')`)
  ));
  const contractStart = preflight.indexOf('-- Compare the runtime startup contract');
  const contractEnd = preflight.indexOf('SELECT c.conrelid::regclass::text AS table_name,', contractStart);
  const recordedSection = preflight.slice(contractStart, contractEnd);
  const valuesStart = recordedSection.indexOf('  VALUES') + '  VALUES'.length;
  const valuesEnd = recordedSection.indexOf('), schema_contract AS', valuesStart);
  const recordedContract = recordedSection.slice(valuesStart, valuesEnd);
  const recordedContractEntries = recordedContract.match(/\('[a-z0-9_]+', '[a-z0-9_]+'\)/g) || [];

  assert.equal(Object.keys(REQUIRED_SCHEMA).length, 18);
  assert.equal(entries.length, 278);
  assert.equal(recordedContractEntries.length, entries.length);
  for (const entry of entries) assert.ok(preflight.includes(entry), `preflight is missing ${entry}`);
  assert.deepEqual(REQUIRED_SCHEMA.game_progress_save_commits, [
    'activity_event_key', 'completed_at', 'created_at', 'learning_cycle_version',
    'payload_sha256', 'response_body', 'response_status', 'save_commit_id_hash', 'student_id',
  ]);
  assert.match(preflight, /^\\set ON_ERROR_STOP on/m);
  assert.doesNotMatch(preflight, /\\quit\s+\d/);
  assert.match(preflight, /\('accounts', 'game_student_id', 'character varying'\)/);
  assert.match(preflight, /game_student_id must be VARCHAR\(8\)/);
});

test('save receipt table and all fields are required before the server can report schema readiness', async () => {
  const calls = [];
  await assert.rejects(
    assertStartupSchemaReady({
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        return { rows: [{ missing_object: 'game_progress_save_commits' }] };
      },
    }),
    /database schema is not ready: game_progress_save_commits;/,
  );
  const payload = JSON.parse(calls[0].params[0]);
  assert.deepEqual(payload.find((entry) => entry.table_name === 'game_progress_save_commits')?.columns,
    REQUIRED_SCHEMA.game_progress_save_commits);
});

test('save receipt primary, event uniqueness, foreign key, and integrity checks are part of readiness', async () => {
  const expectedConstraints = [
    'game_progress_save_commits_pkey',
    'game_progress_save_commits_activity_event_unique',
    'game_progress_save_commits_student_id_fkey',
    'game_progress_save_commits_learning_cycle_version_check',
    'game_progress_save_commits_save_commit_id_hash_check',
    'game_progress_save_commits_payload_sha256_check',
    'game_progress_save_commits_response_status_check',
    'game_progress_save_commits_completion_consistency',
  ];
  for (const constraintName of expectedConstraints) {
    assert.match(SCHEMA_READINESS_SQL, new RegExp(constraintName));
  }
  await assert.rejects(
    assertStartupSchemaReady({
      async query() {
        return { rows: [{ missing_object: 'game_progress_save_commits.game_progress_save_commits_pkey' }] };
      },
    }),
    /game_progress_save_commits\.game_progress_save_commits_pkey/,
  );
});

test('playtime soft-delete fields used by live routes are required at startup', () => {
  const expectedTypes = {
    deleted_at: 'timestamp with time zone',
    deleted_by: 'integer',
    deletion_operation_id: 'uuid',
    deletion_reason: 'character varying',
  };
  const preflight = fs.readFileSync(path.join(__dirname, 'scripts', 'release-migration-preflight.sql'), 'utf8');
  for (const [column, type] of Object.entries(expectedTypes)) {
    assert.ok(REQUIRED_SCHEMA.playtime_sessions.includes(column), `${column} must be part of startup readiness`);
    assert.ok(preflight.includes(`('playtime_sessions', '${column}', '${type}')`),
      `preflight must validate the migration-defined type for ${column}`);
  }
});
