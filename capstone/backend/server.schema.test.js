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
  const recordedContractEntries = recordedContract.match(/\('[a-z_]+', '[a-z_]+'\)/g) || [];

  assert.equal(Object.keys(REQUIRED_SCHEMA).length, 17);
  assert.equal(entries.length, 265);
  assert.equal(recordedContractEntries.length, entries.length);
  for (const entry of entries) assert.ok(preflight.includes(entry), `preflight is missing ${entry}`);
});
