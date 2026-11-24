const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  applyReleaseMigrations,
  buildReleaseDatabaseConfig,
  createVerifiedPgTlsOptions,
  migrationChecksum,
  RELEASE_MIGRATIONS,
} = require('./releaseMigrations');
const { runApprovedReleaseMigrations } = require('./scripts/run-approved-release-migrations');

function findOpenSsl() {
  const candidates = [
    process.env.OPENSSL_BIN,
    'openssl',
    ...(process.platform === 'win32' ? [
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    ] : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('OpenSSL CLI is required for synthetic TLS fixtures');
}

function makeTlsFixtures(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-release-tls-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const openssl = findOpenSsl();
  const run = (args) => {
    const result = spawnSync(openssl, args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, 'synthetic OpenSSL fixture command failed');
  };
  const generateCa = (stem) => {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-keyout', `${stem}.key`, '-out', `${stem}.pem`, '-subj', '/CN=root-ca',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    return fs.readFileSync(path.join(directory, `${stem}.pem`));
  };
  const caPem = generateCa('test-ca');
  const wrongCaPem = generateCa('wrong-ca');
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key',
    '-out', 'server.csr', '-subj', '/CN=localhost']);
  fs.writeFileSync(path.join(directory, 'server.ext'), [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:localhost',
    '',
  ].join('\n'));
  run(['x509', '-req', '-in', 'server.csr', '-CA', 'test-ca.pem', '-CAkey', 'test-ca.key',
    '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-sha256', '-extfile', 'server.ext']);
  return {
    directory,
    caPem,
    wrongCaPem,
    serverPem: fs.readFileSync(path.join(directory, 'server.pem')),
    serverKey: fs.readFileSync(path.join(directory, 'server.key')),
  };
}

function fingerprint256(pem) {
  return new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toUpperCase();
}

function verifyCertificateChain(openssl, directory, caFile) {
  return spawnSync(openssl, ['verify', '-purpose', 'sslserver', '-CAfile', caFile, 'server.pem'], {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('release TLS options pin a synthetic CA and enforce localhost identity offline', (t) => {
  const fixtures = makeTlsFixtures(t);
  const expected = fingerprint256(fixtures.caPem);
  const trustedOptions = createVerifiedPgTlsOptions(fixtures.caPem, { expectedFingerprint: expected });

  assert.equal(trustedOptions.rejectUnauthorized, true);
  assert.equal(trustedOptions.servername, 'localhost');
  assert.equal(trustedOptions.ca.includes('BEGIN CERTIFICATE'), true);
  const serverCertificate = new crypto.X509Certificate(fixtures.serverPem);
  assert.equal(serverCertificate.checkHost('localhost'), 'localhost');
  assert.equal(serverCertificate.checkHost('wrong.example'), undefined);
  const validChain = verifyCertificateChain(findOpenSsl(), fixtures.directory, 'test-ca.pem');
  assert.equal(validChain.status, 0, validChain.stderr);
  const wrongOptions = createVerifiedPgTlsOptions(fixtures.wrongCaPem, {
    expectedFingerprint: fingerprint256(fixtures.wrongCaPem),
  });
  assert.equal(wrongOptions.rejectUnauthorized, true);
  const wrongChain = verifyCertificateChain(findOpenSsl(), fixtures.directory, 'wrong-ca.pem');
  assert.notEqual(wrongChain.status, 0);
  assert.throws(() => createVerifiedPgTlsOptions('not a certificate', { expectedFingerprint: expected }));
  assert.throws(() => createVerifiedPgTlsOptions(`${fixtures.caPem.toString()}${fixtures.caPem.toString()}`, {
    expectedFingerprint: expected,
  }), /exactly one/i);
  assert.throws(() => createVerifiedPgTlsOptions(`${fixtures.caPem.toString()}unexpected`, {
    expectedFingerprint: expected,
  }), /exactly one/i);
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse(new crypto.X509Certificate(fixtures.caPem).validTo) + 1000;
    assert.throws(() => createVerifiedPgTlsOptions(fixtures.caPem, { expectedFingerprint: expected }), /currently valid/i);
  } finally {
    Date.now = originalNow;
  }
  assert.throws(() => createVerifiedPgTlsOptions(fixtures.caPem, {
    expectedFingerprint: '00'.repeat(32),
  }), /fingerprint/i);
  assert.throws(() => createVerifiedPgTlsOptions(fixtures.caPem, {
    expectedFingerprint: expected,
    servername: '127.0.0.1',
  }), /localhost/i);
});

test('controlled release config rejects connection-string overrides and requires explicit verified tunnel TLS', () => {
  const secret = 'synthetic-password-do-not-log';
  assert.throws(() => buildReleaseDatabaseConfig({
    DATABASE_URL: 'postgres://synthetic.invalid/db?sslmode=disable',
    PGPASSWORD: secret,
  }), (error) => !error.message.includes(secret) && /DATABASE_URL/i.test(error.message));
  assert.throws(() => buildReleaseDatabaseConfig({
    PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'release_test', PGDATABASE: 'test',
    PGPASSWORD: secret, RELEASE_DB_TLS_SERVER_NAME: 'localhost',
  }), (error) => !error.message.includes(secret) && /trust file/i.test(error.message));
  assert.throws(() => buildReleaseDatabaseConfig({
    PGHOST: 'remote.example', PGPORT: '55432', PGUSER: 'release_test', PGDATABASE: 'test',
    PGPASSWORD: secret, RELEASE_DB_CA_FILE: 'C:\\synthetic\\root.crt',
    RELEASE_DB_TLS_SERVER_NAME: 'localhost',
  }), (error) => !error.message.includes(secret) && /loopback/i.test(error.message));
  assert.throws(() => buildReleaseDatabaseConfig({
    PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'release_test', PGDATABASE: 'test',
    PGPASSWORD: secret, RELEASE_DB_CA_FILE: 'C:\\synthetic\\root.crt',
    RELEASE_DB_TLS_SERVER_NAME: 'localhost', PGSSLMODE: 'disable',
  }), (error) => !error.message.includes(secret) && /ssl override/i.test(error.message));
  assert.throws(() => buildReleaseDatabaseConfig({
    PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'release_test', PGDATABASE: 'test',
    PGPASSWORD: secret, RELEASE_DB_CA_FILE: 'C:\\synthetic\\root.crt',
    RELEASE_DB_TLS_SERVER_NAME: 'localhost', PGSSLNEGOTIATION: 'direct',
  }), (error) => !error.message.includes(secret) && /ssl override/i.test(error.message));
  assert.throws(() => buildReleaseDatabaseConfig({
    PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'release_test', PGDATABASE: 'test',
    PGPASSWORD: secret, RELEASE_DB_CA_FILE: 'C:\\missing\\root.crt',
    RELEASE_DB_TLS_SERVER_NAME: 'localhost',
  }), (error) => !error.message.includes(secret) && /unavailable or unsafe/i.test(error.message));
  assert.throws(() => buildReleaseDatabaseConfig({
    PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'release_test', PGDATABASE: 'test',
    PGPASSWORD: secret, RELEASE_DB_CA_FILE: 'C:\\synthetic\\root.crt',
    RELEASE_DB_TLS_SERVER_NAME: 'localhost', NODE_TLS_REJECT_UNAUTHORIZED: '0',
  }), (error) => !error.message.includes(secret) && /certificate verification/i.test(error.message));
});

test('controlled release runner rejects the process-wide TLS verification bypass before connecting', async () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await assert.rejects(runApprovedReleaseMigrations({
      env: {
        RELEASE_MIGRATIONS_APPROVED: 'true',
        RELEASE_APPROVAL_REFERENCE: 'CHG-SYNTHETIC',
        RELEASE_EXPECTED_DATABASE: 'tq_synthetic_release',
        RELEASE_EXPECTED_DB_USER: 'tq_release_operator',
        RELEASE_EXPECTED_SERVER_ADDRESS: '127.0.0.1',
        RELEASE_EXPECTED_SERVER_PORT: '55432',
        RELEASE_EXPECTED_PENDING_MIGRATIONS: '18',
      },
      databaseConfig: {
        host: '127.0.0.1', port: 55432, user: 'tq_release_operator',
        password: 'synthetic-secret', database: 'tq_synthetic_release',
        ssl: { ca: 'synthetic CA', rejectUnauthorized: true, servername: 'localhost' },
      },
      migrations: [{ version: 18, file: '018_synthetic.sql' }],
    }), /certificate verification/i);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

test('release configuration refuses an unpinned synthetic CA even with otherwise complete tunnel inputs', (t) => {
  const fixtures = makeTlsFixtures(t);
  assert.throws(() => buildReleaseDatabaseConfig({
    PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'release_test', PGDATABASE: 'test',
    PGPASSWORD: 'synthetic-password-sentinel',
    RELEASE_DB_CA_FILE: path.join(fixtures.directory, 'test-ca.pem'),
    RELEASE_DB_TLS_SERVER_NAME: 'localhost',
  }), (error) => !error.message.includes('synthetic-password-sentinel') && /fingerprint/i.test(error.message));
});

test('migration checksums normalize LF variants and match canonical manifests for migrations 018-026', () => {
  const lfSql = 'SELECT 1;\nSELECT 2;\n';
  assert.equal(migrationChecksum(lfSql.replace(/\n/g, '\r\n')), migrationChecksum(lfSql));
  assert.equal(migrationChecksum(lfSql.replace(/\n/g, '\r')), migrationChecksum(lfSql));

  const expectedChecksums = new Map([
    [18, 'f64e6e0de7abdf873fdb1bc93739d2704e4b16ed5bc428c991c7507407ea5668'],
    [19, 'b76fa5f58daae29dbcf2120b4c9ff533eda3c41dc3f21efdab93b207fb8b2f4f'],
    [20, '6e2cf94b9a8acdcee728e8a0283a95580fc7e63f6622dcb5890415f4b9e715af'],
    [21, '3b5ff42ba45a158df434b92b95e935c608fc0a236516d8135d6d0329963beac6'],
    [22, '5a45ef2133bc0d69fe117f7164eeb9af65eb16bcf6f4a1215804bd14919e3c76'],
    [23, '2df0959d48efd554a8e7403ebbf331bfdfb6971b2d66e43a6ae267c02642f12d'],
    [24, '2595a35fe97699376b611f21cc19aa4b7e26d495463fe7585bf7e1c96370e111'],
    [25, '2a1b904056274c73903cfb713703c6db8e6c2ea37f9c8fd1863f9a3004e42e68'],
    [26, '334f7b73ddc1c8d6ddcdafd547181f75fbeac85df713d4ba73995fb9c4d23b12'],
  ]);
  const migrations = RELEASE_MIGRATIONS.filter(({ version }) => version >= 18 && version <= 26);
  assert.equal(migrations.length, expectedChecksums.size);
  const preflightSql = fs.readFileSync(path.join(__dirname, 'scripts/release-migration-026-prerequisite-preflight.sql'), 'utf8');
  const postflightSql = fs.readFileSync(path.join(__dirname, 'scripts/release-migration-preflight.sql'), 'utf8');
  const manifestRows = (sql) => [...sql.matchAll(/\((\d+),\s*'([^']+)',\s*'([a-f0-9]{64})'\)/g)]
    .map(([, version, file, checksum]) => ({ version: Number(version), file, checksum }));
  const preflightManifest = manifestRows(preflightSql);
  const postflightManifest = manifestRows(postflightSql);
  for (const migration of migrations) {
    const sourceSql = fs.readFileSync(path.join(__dirname, 'migrations', migration.file), 'utf8');
    const sql = sourceSql.replace(/\r\n?/g, '\n');
    const expected = expectedChecksums.get(migration.version);
    assert.equal(migrationChecksum(sql), expected,
      `migration ${migration.version} must retain its canonical LF checksum`);
    assert.equal(migrationChecksum(sql.replace(/\n/g, '\r\n')), expected,
      `migration ${migration.version} CRLF checkout must retain its canonical checksum`);
    assert.equal(migrationChecksum(sql.replace(/\n/g, '\r')), expected,
      `migration ${migration.version} CR checkout must retain its canonical checksum`);
    assert.notEqual(migrationChecksum(`${sql}\n-- synthetic modification`), expected,
      `migration ${migration.version} modified SQL must change its checksum`);
    assert.ok(preflightManifest.some((row) => row.version === migration.version
      && row.file === migration.file && row.checksum === expected),
    `pre-026 manifest must match migration ${migration.version}`);
    assert.ok(postflightManifest.some((row) => row.version === migration.version
      && row.file === migration.file && row.checksum === expected),
    `post-migration manifest must match migration ${migration.version}`);
  }
  assert.equal(preflightManifest.length, 9, 'pre-026 manifest must list exactly migrations 018-026');
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
  const calls = [];
  const migrationSql = fs.readFileSync(path.join(__dirname, 'migrations', '018_website_sessions_and_audit_metadata.sql'), 'utf8');
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
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
  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_lock')), 'checksum validation must happen under the advisory lock');
  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_unlock')), 'the advisory lock must be released after mismatch');
  assert.ok(calls.some(({ sql }) => sql.includes('SELECT version, checksum')), 'the stored checksum must be inspected');
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO public.schema_migrations')), false,
    'a mismatch must not append a ledger row');
  assert.equal(calls.some(({ sql }) => sql === migrationSql), false,
    'a mismatch must reject before the specific migration SQL executes');
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
