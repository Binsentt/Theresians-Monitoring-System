const assert = require('node:assert/strict');
const test = require('node:test');

const { applyReleaseMigrations } = require('./releaseMigrations');

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
  const client = {
    async query(sql) {
      if (String(sql).includes('SELECT version, checksum')) return { rows: [{ version: 18, checksum: 'unexpected' }] };
      return { rows: [] };
    },
  };

  await assert.rejects(
    applyReleaseMigrations({
      client,
      migrationDir: __dirname + '/migrations',
      migrations: [{ version: 18, file: '018_website_sessions_and_audit_metadata.sql' }],
    }),
    /checksum mismatch/i,
  );
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
