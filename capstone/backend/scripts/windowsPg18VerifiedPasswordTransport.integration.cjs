'use strict';

// Real PostgreSQL 18 TLS + PQchangePassword integration using synthetic roles only.
// This test cannot select, read, or connect to any Railway/production target.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('WINDOWS_ONLY');
const bin = process.env.TQ_PG18_BIN;
const openssl = process.env.TQ_OPENSSL;
let worker = null;
const workerSource = process.env.TQ_PG18_WORKER_SOURCE;
const csc = process.env.TQ_CSC || (process.env.SystemRoot &&
  path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'));
const requiredTestTools = [
  ['PG18_INITDB', bin && path.join(bin, 'initdb.exe')],
  ['PG18_PG_CTL', bin && path.join(bin, 'pg_ctl.exe')],
  ['PG18_PSQL', bin && path.join(bin, 'psql.exe')],
  ['WORKER_SOURCE', workerSource],
  ['C_COMPILER', csc]
];
for (const [label, file] of requiredTestTools) {
  if (!file) throw new Error('VERIFIED_TEST_TOOL_UNSET_' + label);
  if (!path.isAbsolute(file)) throw new Error('VERIFIED_TEST_TOOL_NOT_ABSOLUTE_' + label);
  if (!fs.existsSync(file)) throw new Error('VERIFIED_TEST_TOOL_FILE_MISSING_' + label);
}
if (!openssl) throw new Error('VERIFIED_TEST_TOOL_UNSET_OPENSSL');
const opensslByPath = path.isAbsolute(openssl);
if (!opensslByPath && path.win32.basename(openssl).toLowerCase() !== 'openssl.exe') {
  throw new Error('VERIFIED_TEST_TOOL_NOT_ALLOWED_OPENSSL_COMMAND');
}

const baseEnv = {};
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE']) {
  if (process.env[key]) baseEnv[key] = process.env[key];
}
const opensslProbe = spawnSync(openssl, ['version'], {
  cwd: process.cwd(),
  env: baseEnv,
  encoding: 'utf8',
  timeout: 5000,
  maxBuffer: 8192,
  windowsHide: true
});
if (opensslProbe.error) {
  const code = opensslProbe.error.code && /^[A-Za-z0-9_]+$/.test(opensslProbe.error.code)
    ? opensslProbe.error.code.toUpperCase() : 'OTHER';
  throw new Error('VERIFIED_OPENSSL_START_FAILED_' + code);
}
if (opensslProbe.signal || opensslProbe.status === null) {
  throw new Error('VERIFIED_OPENSSL_START_FAILED_TIMEOUT');
}
if (opensslProbe.status !== 0 || !/^OpenSSL\s/i.test(opensslProbe.stdout || '')) {
  throw new Error('VERIFIED_OPENSSL_VERSION_CHECK_FAILED');
}

baseEnv.PATH = bin + path.delimiter + (opensslByPath ? path.dirname(openssl) + path.delimiter : '') + (baseEnv.PATH || '');

const parent = fs.realpathSync.native(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, 'tq-pg18-verified-sync-'));
const data = path.join(root, 'cluster');
const marker = path.join(root, 'SYNTHETIC_ONLY.marker');
const serverLog = path.join(root, 'server.log');
const owner = 'tq_transport_owner';
const reader = 'tq_release_preflight_reader';
const secrets = [];
const completedChecks = new Set();
const processDiagnostics = [];
let port = 0;
let workerSecretSequence = 0;
let attemptedStart = false;
let success = false;
let cleanup = false;
let stage = 'create';
let primaryStage = 'NONE';
let primaryFailure = 'NONE';
let primaryLastCompletedOperation = 'NONE';
let lastCompletedOperation = 'NONE';
let cleanupStage = 'NONE';
let cleanupFailure = 'NONE';

function mark(name) { completedChecks.add(name); }

function run(file, args, label, options = {}) {
  stage = label;
  const startedAt = Date.now();
  const result = spawnSync(file, args, {
    cwd: root,
    env: { ...baseEnv, ...(options.env || {}) },
    encoding: 'utf8',
    input: options.input,
    stdio: options.stdio,
    timeout: options.timeout || 15000,
    maxBuffer: 65536,
    windowsHide: true
  });
  const safeLabel = label.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  const diagnostic = {
    stage: safeLabel,
    elapsedMs: Date.now() - startedAt,
    exitCode: result.status === null ? 'NULL' : String(result.status),
    signal: result.signal || 'NONE',
    errorCode: result.error && result.error.code ? String(result.error.code).replace(/[^A-Z0-9_]/gi, '_').toUpperCase() : 'NONE'
  };
  processDiagnostics.push(diagnostic);
  if (result.error || result.signal || result.status === null) {
    throw new Error(safeLabel + '_BOUNDED_PROCESS_FAILURE_' + diagnostic.errorCode);
  }
  for (const secret of secrets) {
    if (secret && ((result.stdout || '').includes(secret) || (result.stderr || '').includes(secret))) {
      throw new Error('SYNTHETIC_SECRET_ECHOED');
    }
  }
  if (options.expectedStatus !== undefined && result.status !== options.expectedStatus) {
    throw new Error(safeLabel + '_UNEXPECTED_EXIT_' + result.status);
  }
  if (options.expectedStatus === undefined && result.status !== 0) {
    throw new Error(safeLabel + '_UNEXPECTED_EXIT_' + result.status);
  }
  lastCompletedOperation = safeLabel;
  return result;
}

function compileWorker(exe, synthetic) {
  const args = ['/nologo', '/target:exe', '/out:' + exe];
  if (synthetic) args.push('/define:TQ_SYNTHETIC');
  args.push(workerSource);
  run(csc, args, synthetic ? 'compile-synthetic-worker' : 'compile-production-worker', {
    timeout: 30000, env: { PATH: path.dirname(csc) + path.delimiter + (baseEnv.PATH || '') }
  });
  return exe;
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return selected;
}

function checkPidIdentity() {
  const pidFile = path.join(data, 'postmaster.pid');
  const lines = fs.readFileSync(pidFile, 'utf8').trim().split(/\r?\n/);
  assert.ok(lines.length >= 6, 'PG18_PID_FILE_INCOMPLETE');
  const normalize = value => path.resolve(value.replace(/\//g, '\\')).replace(/[\\/]+$/, '').toLowerCase();
  assert.equal(normalize(lines[1]), normalize(data), 'PG18_DATA_DIRECTORY_MISMATCH');
  assert.equal(Number(lines[3]), port, 'PG18_PORT_MISMATCH');
  assert.equal(lines[5], '127.0.0.1', 'PG18_LISTEN_ADDRESS_MISMATCH');
  assert.ok(Number.isSafeInteger(Number(lines[0])) && Number(lines[0]) > 0, 'PG18_PID_INVALID');
  process.kill(Number(lines[0]), 0);
}

function assertPgStopped(label) {
  const result = run(path.join(bin, 'pg_ctl.exe'), ['-D', data, 'status'], label, {
    timeout: 7000, expectedStatus: 3
  });
  assert.ok(!fs.existsSync(path.join(data, 'postmaster.pid')), 'PG18_PID_FILE_REMAINS_AFTER_STOP');
  return result;
}

function passfile(name, host, database, role, secret) {
  const escape = value => value.replace(/([\\:])/g, '\\$1');
  const file = path.join(root, name);
  fs.writeFileSync(file, `${escape(host)}:${port}:${escape(database)}:${escape(role)}:${escape(secret)}\n`,
    { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  return file;
}

function writeServiceFile(host, hostaddr, rootCert) {
  const rootPath = rootCert.replace(/\\/g, '/');
  const config = `[tq_synthetic_admin]\nhost=${host}\nhostaddr=${hostaddr}\nport=${port}\ndbname=postgres\nuser=${owner}\nsslmode=verify-full\nsslrootcert=${rootPath}\n` +
    `[tq_synthetic_reader]\nhost=localhost\nhostaddr=127.0.0.1\nport=${port}\ndbname=postgres\nuser=${reader}\nsslmode=verify-full\nsslrootcert=${rootPath}\n`;
  fs.writeFileSync(path.join(root, 'pg_service.conf'), config, { flag: fs.existsSync(path.join(root, 'pg_service.conf')) ? 'w' : 'wx', encoding: 'utf8' });
}

function workerCall(mode, secret, expectedStatus = 0, passfilePath = path.join(root, 'admin.pgpass'), serviceFile = path.join(root, 'pg_service.conf')) {
  if (secret) secrets.push(secret);
  const sourceRole = mode === 'bootstrap-admin' ? owner : reader;
  const sourcePassfile = passfile('worker-secret-source-' + (++workerSecretSequence) + '.pgpass',
    'localhost', 'postgres', sourceRole, secret);
  return run(worker, [String(port), mode], 'verified-worker-' + mode, {
    env: { PGSERVICEFILE: serviceFile, PGPASSFILE: passfilePath, TQ_READER_PASSFILE_SOURCE: sourcePassfile },
    timeout: 20000,
    expectedStatus
  });
}

function psql(sql, label, service = 'tq_synthetic_admin', passfilePath = path.join(root, 'admin.pgpass'), expectedStatus = 0) {
  return run(path.join(bin, 'psql.exe'), [
    '--dbname', 'service=' + service, '-X', '-q', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql
  ], label, { env: { PGSERVICEFILE: path.join(root, 'pg_service.conf'), PGPASSFILE: passfilePath }, expectedStatus });
}

function assertWorkerStage(output, markers) {
  for (const markerValue of markers) assert.ok(output.includes(markerValue), 'WORKER_STAGE_MISSING');
}

function safeToRemove() {
  if (path.dirname(root).toLowerCase() !== parent.toLowerCase() ||
      !path.basename(root).startsWith('tq-pg18-verified-sync-') ||
      fs.readFileSync(marker, 'utf8') !== 'TQ_PG18_VERIFIED_SYNC_SYNTHETIC_ONLY') return false;
  function noReparse(directory) {
    if (fs.lstatSync(directory).isSymbolicLink()) return false;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (entry.isDirectory() && !noReparse(child))) return false;
    }
    return true;
  }
  return noReparse(root);
}

async function main() {
  try {
    fs.writeFileSync(marker, 'TQ_PG18_VERIFIED_SYNC_SYNTHETIC_ONLY', { flag: 'wx' });
    const syntheticWorker = compileWorker(path.join(root, 'VerifiedReaderPasswordWorker.synthetic.exe'), true);
    const productionWorker = compileWorker(path.join(root, 'VerifiedReaderPasswordWorker.production.exe'), false);
    const anchorMissing = run(productionWorker, [], 'production-worker-missing-anchor', {
      env: {}, timeout: 5000, expectedStatus: 12
    });
    assertWorkerStage(anchorMissing.stdout, ['EXPECTED_TARGET_ANCHOR=FAIL']);
    mark('PRODUCTION_WORKER_REJECTS_MISSING_TARGET_ANCHOR');
    const anchorMalformed = run(productionWorker, [], 'production-worker-malformed-anchor', {
      env: { TQ_EXPECTED_PG_SERVER_ADDRESS: 'localhost' }, timeout: 5000, expectedStatus: 12
    });
    assertWorkerStage(anchorMalformed.stdout, ['EXPECTED_TARGET_ANCHOR=FAIL']);
    mark('PRODUCTION_WORKER_REJECTS_MALFORMED_TARGET_ANCHOR');
    worker = syntheticWorker;
    port = await freeLoopbackPort();
    const opensslArgs = (args, label) => run(openssl, args, label, { timeout: 30000 });
    opensslArgs(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', path.join(root, 'root.key'), '-out', path.join(root, 'root.crt'),
      '-subj', '/CN=TQ-Synthetic-Root', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], 'synthetic-root-create');
    opensslArgs(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'server.key'),
      '-out', path.join(root, 'server.csr'), '-subj', '/CN=localhost'], 'synthetic-server-csr');
    fs.writeFileSync(path.join(root, 'server.ext'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n',
      { flag: 'wx', encoding: 'ascii' });
    opensslArgs(['x509', '-req', '-in', path.join(root, 'server.csr'), '-CA', path.join(root, 'root.crt'),
      '-CAkey', path.join(root, 'root.key'), '-CAcreateserial', '-out', path.join(root, 'server.crt'),
      '-days', '2', '-sha256', '-extfile', path.join(root, 'server.ext')], 'synthetic-server-cert-sign');
    opensslArgs(['verify', '-CAfile', path.join(root, 'root.crt'), '-verify_hostname', 'localhost',
      path.join(root, 'server.crt')], 'synthetic-cert-chain-verify');
    mark('SYNTHETIC_CERT_CHAIN');

    run(path.join(bin, 'initdb.exe'), ['-D', data, '-U', owner, '-A', 'trust', '--encoding=UTF8',
      '--locale=C', '--no-instructions'], 'pg18-initdb', { timeout: 120000 });
    assert.equal(fs.readFileSync(path.join(data, 'PG_VERSION'), 'utf8').trim(), '18', 'PG18_MAJOR_MISMATCH');
    assertPgStopped('pg18-not-running-before-start');
    fs.copyFileSync(path.join(root, 'server.crt'), path.join(data, 'server.crt'));
    fs.copyFileSync(path.join(root, 'server.key'), path.join(data, 'server.key'));
    fs.appendFileSync(path.join(data, 'postgresql.conf'),
      `\nlisten_addresses='127.0.0.1'\nport=${port}\nssl=on\nssl_cert_file='server.crt'\nssl_key_file='server.key'\npassword_encryption='scram-sha-256'\nlog_statement=none\nlog_min_error_statement=panic\n`);
    fs.writeFileSync(path.join(data, 'pg_hba.conf'),
      `local all all trust\nhost all ${owner} 127.0.0.1/32 trust\nhost all ${reader} 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 reject\nhost all all ::/0 reject\n`,
      { encoding: 'ascii' });
    lastCompletedOperation = 'PG18_CONFIGURED_LOOPBACK_TLS';

    attemptedStart = true;
    run(path.join(bin, 'pg_ctl.exe'), ['-D', data, '-s', '-l', serverLog, '-w', '-t', '30', 'start'],
      'pg18-start', { timeout: 45000, stdio: ['ignore', 'ignore', 'ignore'] });
    assert.equal(fs.existsSync(path.join(data, 'postmaster.pid')), true, 'PG18_PID_FILE_MISSING_AFTER_START');
    checkPidIdentity();
    mark('PG18_LOOPBACK_READY');
    writeServiceFile('localhost', '127.0.0.1', path.join(root, 'root.crt'));

    const adminSecret = crypto.randomBytes(32).toString('hex') + ':Owner\\Synthetic';
    const oldReaderSecret = crypto.randomBytes(32).toString('hex');
    const newReaderSecret = crypto.randomBytes(32).toString('hex') + ':Reader\\Synthetic';
    secrets.push(adminSecret, oldReaderSecret, newReaderSecret);
    passfile('admin.pgpass', 'localhost', 'postgres', owner, adminSecret);

    const bootstrap = workerCall('bootstrap-admin', adminSecret);
    assertWorkerStage(bootstrap.stdout, ['TARGET_IDENTITY=PASS', 'SCRAM_VERIFIER=PASS', 'BOOTSTRAP=PASS']);
    mark('SYNTHETIC_ADMIN_SCRAM_AUTH');
    psql(`CREATE ROLE ${reader} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
      'synthetic-reader-create');
    const oldSetup = workerCall('sync', oldReaderSecret);
    assertWorkerStage(oldSetup.stdout, ['TARGET_IDENTITY=PASS', 'READER_ROLE_CONTRACT=PASS',
      'PASSWORD_SYNC_OPERATION=PASS', 'ROLE_PROPERTIES_UNCHANGED=PASS', 'SCRAM_VERIFIER=PASS', 'SYNC=PASS']);
    mark('INITIAL_READER_PASSWORD_SETUP');
    const oldReaderPass = passfile('reader-old.pgpass', 'localhost', 'postgres', reader, oldReaderSecret);
    const newReaderPass = passfile('reader-new.pgpass', 'localhost', 'postgres', reader, newReaderSecret);
    const wrongAdminPass = passfile('admin-wrong-host.pgpass', '127.0.0.1', 'postgres', owner, adminSecret);
    const wrongDbPass = passfile('admin-wrong-db.pgpass', 'localhost', 'template1', owner, adminSecret);

    fs.writeFileSync(path.join(data, 'pg_hba.conf'),
      `local all all trust\nhost all ${owner} 127.0.0.1/32 scram-sha-256\nhost all ${reader} 127.0.0.1/32 scram-sha-256\nhost all all 127.0.0.1/32 reject\nhost all all ::/0 reject\n`,
      { encoding: 'ascii' });
    run(path.join(bin, 'pg_ctl.exe'), ['-D', data, 'reload'], 'pg18-hba-reload');

    // Prove the production worker fails closed on wrong CA, wrong TLS name, and wrong database.
    const badRoot = path.join(root, 'wrong-root.crt');
    opensslArgs(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', path.join(root, 'wrong-root.key'), '-out', badRoot,
      '-subj', '/CN=TQ-Wrong-Root', '-addext', 'basicConstraints=critical,CA:TRUE'], 'wrong-root-create');
    writeServiceFile('localhost', '127.0.0.1', badRoot);
    const badCa = workerCall('sync', newReaderSecret, 20);
    assertWorkerStage(badCa.stdout, ['AUTH_OR_TLS=FAIL']);
    assert.ok(!badCa.stdout.includes('PASSWORD_CHANGE_ATTEMPTED=TRUE'), 'WRONG_CA_REACHED_PASSWORD_CHANGE');
    mark('WRONG_CA_REJECTED');

    writeServiceFile('127.0.0.1', '127.0.0.1', path.join(root, 'root.crt'));
    const badHostname = workerCall('sync', newReaderSecret, 20, wrongAdminPass);
    assertWorkerStage(badHostname.stdout, ['AUTH_OR_TLS=FAIL']);
    assert.ok(!badHostname.stdout.includes('PASSWORD_CHANGE_ATTEMPTED=TRUE'), 'WRONG_HOST_REACHED_PASSWORD_CHANGE');
    mark('WRONG_HOST_REJECTED');

    writeServiceFile('localhost', '127.0.0.1', path.join(root, 'root.crt'));
    const wrongDbService = path.join(root, 'pg_service-wrong-db.conf');
    fs.writeFileSync(wrongDbService, `[tq_synthetic_admin]\nhost=localhost\nhostaddr=127.0.0.1\nport=${port}\ndbname=template1\nuser=${owner}\nsslmode=verify-full\nsslrootcert=${path.join(root, 'root.crt').replace(/\\/g, '/')}\n`, { flag: 'wx', encoding: 'utf8' });
    const wrongDatabase = workerCall('sync', newReaderSecret, 21, wrongDbPass, wrongDbService);
    assert.ok(wrongDatabase.stdout.includes('TARGET_IDENTITY=FAIL'), 'WRONG_DATABASE_NOT_CLASSIFIED');
    assert.ok(!wrongDatabase.stdout.includes('PASSWORD_CHANGE_ATTEMPTED=TRUE'), 'WRONG_DATABASE_REACHED_PASSWORD_CHANGE');
    mark('WRONG_DATABASE_REJECTED');

    const valid = workerCall('sync', newReaderSecret);
    assertWorkerStage(valid.stdout, ['AUTH_OR_TLS=PASS', 'TARGET_IDENTITY=PASS',
      'READER_ROLE_CONTRACT=PASS', 'READ_ONLY_OR_BOUNDS=PASS', 'SCRAM_OR_BOUNDS=PASS', 'PASSWORD_SYNC_OPERATION=PASS',
      'SESSION_READONLY_RESTORE=PASS', 'PASSWORD_CHANGE_ATTEMPTED=TRUE',
      'ROLE_PROPERTIES_UNCHANGED=PASS', 'SCRAM_VERIFIER=PASS', 'SYNC=PASS']);
    mark('TLS_VERIFY_FULL_AND_PQCHANGE');

    const scram = psql(`SELECT (rolpassword LIKE 'SCRAM-SHA-256$%')::text FROM pg_catalog.pg_authid WHERE rolname='${reader}';`,
      'scram-verifier-readback');
    assert.equal(scram.stdout.trim(), 'true', 'SCRAM_VERIFIER_MISSING');
    mark('SCRAM_VERIFIER_FORMAT');
    const attrs = psql(`SELECT (rolcanlogin AND NOT rolsuper AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=oid))::text FROM pg_catalog.pg_roles WHERE rolname='${reader}';`,
      'reader-attribute-readback');
    assert.equal(attrs.stdout.trim(), 'true', 'READER_ATTRIBUTES_CHANGED');
    mark('ROLE_PROPERTIES_UNCHANGED');
    const readerAuth = psql('SELECT current_user=\'tq_release_preflight_reader\' AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid() AND ssl);',
      'new-reader-auth', 'tq_synthetic_reader', newReaderPass);
    assert.equal(readerAuth.stdout.trim(), 't', 'NEW_SYNTHETIC_READER_AUTH_FAILED');
    mark('NEW_READER_AUTH');
    psql('SELECT current_user=\'tq_release_preflight_reader\';', 'old-reader-reject',
      'tq_synthetic_reader', oldReaderPass, 2);
    mark('OLD_READER_PASSWORD_REJECTED');
    success = true;
  } catch (error) {
    primaryStage = stage || 'UNKNOWN';
    primaryLastCompletedOperation = lastCompletedOperation;
    primaryFailure = /^[A-Za-z0-9_-]+$/.test(error.message)
      ? error.message.toUpperCase().replace(/-/g, '_')
      : 'ASSERTION_FAILED';
  } finally {
    try {
      if (attemptedStart) {
        const pidExists = fs.existsSync(path.join(data, 'postmaster.pid'));
        if (pidExists) {
          checkPidIdentity();
          run(path.join(bin, 'pg_ctl.exe'), ['-D', data, '-w', '-t', '15', '-m', 'fast', 'stop'],
            'pg18-stop', { timeout: 20000 });
        }
        assertPgStopped('pg18-confirm-stopped');
      }
      cleanupStage = stage;
      if (!safeToRemove()) throw new Error('SAFE_CLEANUP_OWNERSHIP_FAILED');
      fs.rmSync(root, { recursive: true, force: false });
      cleanup = !fs.existsSync(root);
      if (!cleanup) cleanupFailure = 'SYNTHETIC_DIRECTORY_REMAINS';
    } catch {
      cleanup = false;
      success = false;
      cleanupStage = stage || 'UNKNOWN';
      cleanupFailure = 'CLEANUP_OR_STOP_VERIFICATION_FAILED';
    }
  }
  if (primaryFailure === 'NONE' && !cleanup) {
    primaryStage = 'CLEANUP';
    primaryFailure = cleanupFailure;
  }
  success = primaryFailure === 'NONE' && cleanup;
  console.log('PG18_TLS_PASSWORD_TRANSPORT=' + (success ? 'PASS' : 'STOP'));
  console.log('PRIMARY_STAGE=' + primaryStage);
  console.log('PRIMARY_FAILURE=' + primaryFailure);
  console.log('PRIMARY_LAST_COMPLETED_OPERATION=' + primaryLastCompletedOperation);
  console.log('CLEANUP_STAGE=' + cleanupStage);
  console.log('CLEANUP_FAILURE=' + cleanupFailure);
  for (const item of processDiagnostics) {
    console.log('PROCESS_' + item.stage + '=elapsedMs:' + item.elapsedMs + ',exitCode:' + item.exitCode +
      ',signal:' + item.signal + ',errorCode:' + item.errorCode);
  }
  for (const name of [...completedChecks].sort()) console.log('CHECK_' + name + '=PASS');
  console.log('CLEANUP=' + (cleanup ? 'PASS' : 'FAIL'));
  console.log('PRODUCTION_CONNECTIONS=0');
  if (!success || !cleanup) process.exitCode = 1;
}

main().catch(() => {
  console.log('PG18_TLS_PASSWORD_TRANSPORT=STOP');
  console.log('FAILURE_CODE=TOP_LEVEL_FAILURE');
  console.log('PRODUCTION_CONNECTIONS=0');
  process.exitCode = 1;
});
