const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { migrationChecksum } = require('../releaseMigrations');
const {
  buildApprovalPlan,
  parseVersionList,
  runApprovedReleaseMigrations,
} = require('./run-approved-release-migrations');

function tempMigrationDir(t, migrationRows) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-release-gate-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const migration of migrationRows) {
    fs.writeFileSync(path.join(directory, migration.file), '-- fixture migration ' + migration.version + '\n');
  }
  return directory;
}

function approvalEnv(pending, overrides = {}) {
  return {
    RELEASE_MIGRATIONS_APPROVED: 'true',
    RELEASE_APPROVAL_REFERENCE: 'CHG-1234',
    RELEASE_EXPECTED_DATABASE: 'tq_operator_fixture',
    RELEASE_EXPECTED_DB_USER: 'release_operator',
    RELEASE_EXPECTED_SERVER_ADDRESS: '127.0.0.1',
    RELEASE_EXPECTED_SERVER_PORT: '5432',
    RELEASE_EXPECTED_PENDING_MIGRATIONS: pending,
    ...overrides,
  };
}

function fakeClient({ identity, ledgerRows, ledgerPresent = true, migration024Counts } = {}) {
  const calls = [];
  const client = {
    connected: false,
    ended: false,
    async connect() {
      this.connected = true;
    },
    async end() {
      this.ended = true;
    },
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes('current_database()')) return { rows: [identity] };
      if (text.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ ledger_present: ledgerPresent }] };
      }
      if (text.includes("to_regclass('public.accounts')")) {
        return { rows: [{
          accounts_present: true,
          game_results_present: true,
          playtime_sessions_present: true,
        }] };
      }
      if (text.includes('WITH candidates AS')) {
        return { rows: [migration024Counts ?? {
          account_count: '0',
          game_results_count: '0',
          playtime_sessions_count: '0',
        }] };
      }
      if (text.includes('SELECT version, filename, checksum FROM public.schema_migrations')) {
        return { rows: ledgerRows ?? [] };
      }
      if (text.includes('SELECT version, checksum FROM public.schema_migrations')) {
        const requested = new Set((params[0] ?? []).map(Number));
        return { rows: (ledgerRows ?? [])
          .filter((row) => requested.has(Number(row.version)))
          .map(({ version, checksum }) => ({ version, checksum })) };
      }
      return { rows: [] };
    },
  };
  return { client, calls };
}

function matchingIdentity() {
  return {
    database_name: 'tq_operator_fixture',
    database_user: 'release_operator',
    server_address: '127.0.0.1',
    server_port: 5432,
  };
}

async function runFixture(t, {
  versions = [18],
  pending = '18',
  envOverrides = {},
  identity = matchingIdentity(),
  ledgerPresent = true,
  ledgerRows = [],
  migration024Counts,
} = {}) {
  const migrations = versions.map((version) => ({
    version,
    file: String(version).padStart(3, '0') + '_fixture.sql',
  }));
  const migrationDir = tempMigrationDir(t, migrations);
  const { client, calls } = fakeClient({
    identity,
    ledgerRows,
    ledgerPresent,
    migration024Counts,
  });
  const result = await runApprovedReleaseMigrations({
    env: approvalEnv(pending, envOverrides),
    databaseConfig: { host: 'fixture.invalid', database: 'never-used-by-mock' },
    migrationDir,
    migrations,
    clientFactory: async () => client,
  });
  return { result, calls, client, migrationDir, migrations };
}

test('requires an explicit approval reference and refuses to connect without the gate', async () => {
  let factoryCalled = false;
  await assert.rejects(
    runApprovedReleaseMigrations({
      env: { ...approvalEnv('18'), RELEASE_MIGRATIONS_APPROVED: 'false' },
      databaseConfig: { host: 'fixture.invalid' },
      clientFactory: async () => {
        factoryCalled = true;
        throw new Error('must not connect');
      },
    }),
    /separate operator approval/i,
  );
  assert.equal(factoryCalled, false);
  assert.throws(
    () => buildApprovalPlan({ ...approvalEnv('18'), RELEASE_APPROVAL_REFERENCE: '' }, [{ version: 18 }]),
    /RELEASE_APPROVAL_REFERENCE/,
  );
});

test('rejects an unexpected database identity before applying SQL', async (t) => {
  const dir = tempMigrationDir(t, [{ version: 18, file: '018_fixture.sql' }]);
  const { client, calls } = fakeClient({
    identity: { ...matchingIdentity(), database_name: 'wrong_database' },
    ledgerRows: [],
  });
  await assert.rejects(
    runApprovedReleaseMigrations({
      env: approvalEnv('18'),
      databaseConfig: { host: 'fixture.invalid' },
      migrationDir: dir,
      migrations: [{ version: 18, file: '018_fixture.sql' }],
      clientFactory: async () => client,
    }),
    /identity does not match/i,
  );
  assert.equal(calls.some((call) => call.sql.includes('-- fixture migration 18')), false);
  assert.equal(client.ended, true);
});

test('stops safely when the migration ledger is missing', async (t) => {
  const dir = tempMigrationDir(t, [{ version: 18, file: '018_fixture.sql' }]);
  const { client, calls } = fakeClient({
    identity: matchingIdentity(),
    ledgerPresent: false,
  });
  await assert.rejects(
    runApprovedReleaseMigrations({
      env: approvalEnv('18'),
      databaseConfig: { host: 'fixture.invalid' },
      migrationDir: dir,
      migrations: [{ version: 18, file: '018_fixture.sql' }],
      clientFactory: async () => client,
    }),
    /ledger is missing/i,
  );
  assert.equal(calls.some((call) => call.sql.includes('-- fixture migration 18')), false);
});

test('requires the pending migration list to match exactly before applying', async (t) => {
  const dir = tempMigrationDir(t, [{ version: 18, file: '018_fixture.sql' }]);
  const { client, calls } = fakeClient({ identity: matchingIdentity(), ledgerRows: [] });
  await assert.rejects(
    runApprovedReleaseMigrations({
      env: approvalEnv('none'),
      databaseConfig: { host: 'fixture.invalid' },
      migrationDir: dir,
      migrations: [{ version: 18, file: '018_fixture.sql' }],
      clientFactory: async () => client,
    }),
    /pending migration list changed/i,
  );
  assert.equal(calls.some((call) => call.sql.includes('-- fixture migration 18')), false);
});

test('checks applied migration filenames and source checksums before applying pending versions', async (t) => {
  const migrations = [
    { version: 18, file: '018_fixture.sql' },
    { version: 19, file: '019_fixture.sql' },
  ];
  const dir = tempMigrationDir(t, migrations);
  const checksum = migrationChecksum(fs.readFileSync(path.join(dir, migrations[0].file), 'utf8'));
  const { client, calls } = fakeClient({
    identity: matchingIdentity(),
    ledgerRows: [{ version: 18, filename: migrations[0].file, checksum: 'wrong-checksum' }],
  });
  await assert.rejects(
    runApprovedReleaseMigrations({
      env: approvalEnv('19'),
      databaseConfig: { host: 'fixture.invalid' },
      migrationDir: dir,
      migrations,
      clientFactory: async () => client,
    }),
    /checksum does not match/i,
  );
  assert.notEqual(checksum, 'wrong-checksum');
  assert.equal(calls.some((call) => call.sql.includes('-- fixture migration 19')), false);
});

test('applies only the approved pending migration versions after target and ledger verification', async (t) => {
  const migrations = [
    { version: 18, file: '018_fixture.sql' },
    { version: 19, file: '019_fixture.sql' },
  ];
  const dir = tempMigrationDir(t, migrations);
  const checksum18 = migrationChecksum(fs.readFileSync(path.join(dir, migrations[0].file), 'utf8'));
  const { client, calls } = fakeClient({
    identity: matchingIdentity(),
    ledgerRows: [{ version: 18, filename: migrations[0].file, checksum: checksum18 }],
  });
  const result = await runApprovedReleaseMigrations({
    env: approvalEnv('19'),
    databaseConfig: { host: 'fixture.invalid' },
    migrationDir: dir,
    migrations,
    clientFactory: async () => client,
  });
  assert.deepEqual(result.appliedVersions, [19]);
  assert.equal(calls.filter((call) => call.sql.includes('-- fixture migration 19')).length, 1);
  assert.equal(calls.some((call) => call.sql.includes('-- fixture migration 18')), false);
  assert.equal(calls.filter((call) => call.sql.includes('pg_advisory_lock')).length, 2);
  assert.equal(calls.filter((call) => call.sql.includes('pg_advisory_unlock')).length, 2);
  assert.equal(client.ended, true);
});

test('migration 024 cannot run without explicit approval, cascade review, and write-quiescence attestation', async (t) => {
  const dir = tempMigrationDir(t, [{ version: 24, file: '024_fixture.sql' }]);
  const { client, calls } = fakeClient({ identity: matchingIdentity(), ledgerRows: [] });
  await assert.rejects(
    runApprovedReleaseMigrations({
      env: approvalEnv('24', {
        RELEASE_EXPECTED_024_ACCOUNT_COUNT: '0',
        RELEASE_EXPECTED_024_GAME_RESULTS_COUNT: '0',
        RELEASE_EXPECTED_024_PLAYTIME_SESSIONS_COUNT: '0',
      }),
      databaseConfig: { host: 'fixture.invalid' },
      migrationDir: dir,
      migrations: [{ version: 24, file: '024_fixture.sql' }],
      clientFactory: async () => client,
    }),
    /migration 024 requires separate approval/i,
  );
  assert.equal(client.connected, false);
  assert.equal(calls.length, 0);
});

test('migration 024 aborts if direct count-only impact changed since the approved preflight', async (t) => {
  const dir = tempMigrationDir(t, [{ version: 24, file: '024_fixture.sql' }]);
  const { client, calls } = fakeClient({
    identity: matchingIdentity(),
    ledgerRows: [],
    migration024Counts: {
      account_count: '2',
      game_results_count: '3',
      playtime_sessions_count: '4',
    },
  });
  await assert.rejects(
    runApprovedReleaseMigrations({
      env: approvalEnv('24', {
        RELEASE_MIGRATION_024_APPROVED: 'true',
        RELEASE_MIGRATION_024_CASCADE_REVIEWED: 'true',
        RELEASE_MIGRATION_024_WRITES_QUIESCED: 'true',
        RELEASE_EXPECTED_024_ACCOUNT_COUNT: '1',
        RELEASE_EXPECTED_024_GAME_RESULTS_COUNT: '3',
        RELEASE_EXPECTED_024_PLAYTIME_SESSIONS_COUNT: '4',
      }),
      databaseConfig: { host: 'fixture.invalid' },
      migrationDir: dir,
      migrations: [{ version: 24, file: '024_fixture.sql' }],
      clientFactory: async () => client,
    }),
    /counts changed since the approved preflight/i,
  );
  assert.equal(calls.some((call) => call.sql.includes('-- fixture migration 24')), false);
});

test('parses only sorted unique migration version lists', () => {
  assert.deepEqual(parseVersionList('18,24,26'), [18, 24, 26]);
  assert.deepEqual(parseVersionList('none'), []);
  assert.throws(() => parseVersionList('18,18'), /strictly increasing/i);
  assert.throws(() => parseVersionList('24,18'), /strictly increasing/i);
  assert.throws(() => parseVersionList('18;24'), /comma-separated/i);
});

test('Railway ordinary deploy config no longer invokes the migration command', () => {
  const railwayConfig = fs.readFileSync(path.resolve(__dirname, '../../railway.toml'), 'utf8');
  assert.doesNotMatch(railwayConfig, /preDeployCommand|migrate:release|RELEASE_MIGRATIONS_APPROVED/i);
  assert.match(railwayConfig, /startCommand = "npm --prefix backend start"/);
  const runner = fs.readFileSync(path.join(__dirname, '../releaseMigrations.js'), 'utf8');
  assert.match(runner, /run-approved-release-migrations/);
});

test('preflight SQL opens a read-only transaction and contains only SELECT inspection commands', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'release-migration-preflight.sql'), 'utf8');
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.match(sql, /SET LOCAL statement_timeout\s*=\s*'10s'/i);
  assert.match(sql, /SET LOCAL lock_timeout\s*=\s*'2s'/i);
  assert.match(sql, /ROLLBACK;/i);
  assert.match(sql, /to_regclass/i);
  assert.match(sql, /COUNT\(\*\)/i);
  assert.match(sql, /expected_database/);
  assert.match(sql, /expected_role/);
  assert.match(sql, /expected_server_address/);
  assert.match(sql, /expected_server_port/);
  assert.match(sql, /pg_auth_members/);
  assert.match(sql, /has_sequence_privilege/);
  assert.match(sql, /^\\set ON_ERROR_STOP on/m);
  assert.doesNotMatch(sql, /\\quit\s+\d/);
  assert.match(sql, /SELECT 'preflight stopped:/);
  assert.doesNotMatch(sql, /game_progress_save_commits/);
  assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/im);

  const pending024Check = sql.indexOf('AS migration_024_pending \\gset');
  assert.notEqual(pending024Check, -1, 'preflight must inspect migration 024 status from the validated ledger');
  const pending024Branch = sql.slice(pending024Check);
  assert.match(pending024Branch, /STOP: destructive migration 024 is pending/i);
  assert.match(pending024Branch, /separate impact review and approval/i);
  assert.doesNotMatch(
    pending024Branch,
    /\b(?:FROM|JOIN)\s+public\.(?:accounts|game_results|playtime_sessions|activity_logs|student_game_progress|student_ai_insights|student_quest_milestones)\b/i,
    'pending 024 must stop before any application-row query',
  );
  assert.doesNotMatch(pending024Branch, /\\gexec/i, 'pending 024 must not run dynamic SQL');
});

test('preflight column metadata checks use catalogs visible without application-table SELECT', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'release-migration-preflight.sql'), 'utf8');
  assert.doesNotMatch(sql, /information_schema\.columns/i);
  assert.match(sql, /pg_catalog\.pg_namespace/i);
  assert.match(sql, /pg_catalog\.pg_class/i);
  assert.match(sql, /pg_catalog\.pg_attribute/i);
  assert.match(sql, /pg_catalog\.pg_type/i);
  assert.match(sql, /pg_catalog\.format_type\s*\(/i);
  assert.match(sql, /attnum\s*>\s*0[\s\S]*?attisdropped/i);
  assert.match(sql, /game_student_id[\s\S]*?character varying\(8\)/i);
});

test('the supported release CLI stops before connecting when approval is absent', () => {
  const script = path.resolve(__dirname, 'run-release-migrations.js');
  const result = spawnSync(process.execPath, [script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RELEASE_MIGRATIONS_APPROVED=true/);
  assert.doesNotMatch(result.stderr, /connect|database URL/i);
});
