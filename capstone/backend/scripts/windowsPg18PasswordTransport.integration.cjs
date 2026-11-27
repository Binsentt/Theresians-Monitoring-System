'use strict';

// CI-only, disposable Windows PostgreSQL 18 password transport integration.
// No production profile, credential, service file, URL, or Railway endpoint.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw Error('WINDOWS_ONLY');
const bin = process.env.TQ_PG18_BIN;
if (!bin || !path.isAbsolute(bin)) throw Error('PG18_BIN_REQUIRED');
const tools = Object.fromEntries(['initdb.exe', 'pg_ctl.exe', 'psql.exe']
  .map(name => [name, path.join(bin, name)]));
tools['Pg18SyntheticPasswordWorker.exe'] =
  process.env.TQ_PG18_WORKER || path.join(bin, 'Pg18SyntheticPasswordWorker.exe');
for (const tool of Object.values(tools)) {
  if (!fs.existsSync(tool)) throw Error('PG18_TOOL_MISSING');
}
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^PG[A-Z_]*$/i.test(key) || /^RAILWAY_/i.test(key) ||
      /^(DATABASE_URL|TQ_PG18_BIN|TQ_PG18_WORKER)$/i.test(key)) delete env[key];
}
env.PATH = bin + path.delimiter + (env.PATH || '');
env.PGCONNECT_TIMEOUT = '3';
env.PGSSLMODE = 'disable';
const parent = fs.realpathSync.native(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, 'tq-pg18-ci-'));
const data = path.join(root, 'cluster');
const marker = path.join(root, 'SYNTHETIC_ONLY.marker');
const log = path.join(root, 'server.log');
const owner = 'tq_transport_owner';
const reader = 'tq_transport_reader';
let port = 0;
let stage = 'create';
let failureStage = 'NONE';
let serverAttempted = false;
let cleanup = false;
let result = 'STOP';
let cause = 'NONE';
let verified = 0;
const secrets = [];

function run(file, args, label, options = {}) {
  stage = label;
  const value = spawnSync(file, args, {
    env: { ...env, ...(options.env || {}) },
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 15000,
    maxBuffer: 65536,
    input: options.input,
    stdio: options.ignoreOutput ? 'ignore' : 'pipe',
    windowsHide: true
  });
  if (value.error || value.signal || value.status === null) {
    throw Error(label + '_PROCESS_FAILED');
  }
  if (value.status !== (options.expectedStatus ?? 0)) {
    const detail = file === tools['psql.exe'] && value.status === 2 &&
      /10013|forbidden by its access permissions/i.test(value.stderr || '') ?
      '_SOCKET_10013' : '';
    throw Error(label + '_EXIT_' + value.status + detail);
  }
  if (!options.ignoreOutput &&
      ((value.stdout || '').length + (value.stderr || '').length > 32768)) {
    throw Error(label + '_OUTPUT_LIMIT');
  }
  return value;
}

function psql(sql, label, extraEnv = {}) {
  const value = run(tools['psql.exe'], [
    '-h', '127.0.0.1', '-p', String(port), '-U', owner, '-d', 'postgres',
    '-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql
  ], label, { env: extraEnv });
  return value.stdout.trim();
}

function worker(mode, role, passfile, secret, expectedStatus = 0) {
  const value = run(tools['Pg18SyntheticPasswordWorker.exe'],
    [mode, role, String(port)], mode + '-' + role, {
      env: passfile ? { PGPASSFILE: passfile } : {},
      input: secret === undefined ? undefined : secret + '\n',
      expectedStatus,
      timeout: 15000
    });
  for (const candidate of secrets) {
    if (candidate && ((value.stdout || '').includes(candidate) ||
        (value.stderr || '').includes(candidate))) throw Error('SECRET_ECHOED');
  }
  return value.stdout.trim().split(/\r?\n/);
}

function passfile(name, role, password) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `127.0.0.1:${port}:postgres:${role}:${password}\n`,
    { flag: 'wx', encoding: 'utf8' });
  return file;
}

function exactPidIdentity() {
  const lines = fs.readFileSync(path.join(data, 'postmaster.pid'), 'utf8')
    .trim().split(/\r?\n/);
  assert.ok(lines.length >= 6, 'PID_FILE_INCOMPLETE');
  const normalize = value => path.resolve(value.replace(/\//g, '\\'))
    .replace(/[\\/]+$/, '').toLowerCase();
  assert.equal(normalize(lines[1]), normalize(data), 'PID_DATA_MISMATCH');
  assert.equal(Number(lines[3]), port, 'PID_PORT_MISMATCH');
  assert.equal(lines[5], '127.0.0.1', 'PID_LISTEN_MISMATCH');
  assert.ok(Number.isSafeInteger(Number(lines[0])) && Number(lines[0]) > 0,
    'PID_INVALID');
  process.kill(Number(lines[0]), 0);
}

function safeToRemove() {
  if (path.dirname(root).toLowerCase() !== parent.toLowerCase() ||
      !path.basename(root).startsWith('tq-pg18-ci-') ||
      fs.readFileSync(marker, 'utf8') !== 'TQ_PG18_TRANSPORT_SYNTHETIC_ONLY') {
    return false;
  }
  function noLinks(dir) {
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink() ||
          (entry.isDirectory() && !noLinks(file))) return false;
    }
    return true;
  }
  return noLinks(root);
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close(error =>
    error ? reject(error) : resolve()));
  return selected;
}

async function main() {
  try {
    fs.writeFileSync(marker, 'TQ_PG18_TRANSPORT_SYNTHETIC_ONLY',
      { flag: 'wx' });
    port = await freeLoopbackPort();
    run(tools['initdb.exe'], [
      '-D', data, '-U', owner, '-A', 'trust', '--encoding=UTF8',
      '--locale=C', '--no-instructions'
    ], 'initdb', { timeout: 120000, ignoreOutput: true });
    assert.equal(fs.readFileSync(path.join(data, 'PG_VERSION'), 'utf8').trim(),
      '18', 'MAJOR_VERSION_MISMATCH');
    fs.appendFileSync(path.join(data, 'postgresql.conf'),
      '\nlog_statement=none\nlog_min_error_statement=panic\n');
    const hba = method =>
      `host all ${reader} 127.0.0.1/32 scram-sha-256\n` +
      `host all ${owner} 127.0.0.1/32 ${method}\n` +
      'host all all 0.0.0.0/0 reject\n' +
      'host all all ::/0 reject\n';
    fs.writeFileSync(path.join(data, 'pg_hba.conf'), hba('trust'));
    serverAttempted = true;
    run(tools['pg_ctl.exe'], [
      '-D', data, '-l', log, '-o',
      `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c ssl=off`,
      '-s', '-w', '-t', '30', 'start'
    ], 'pgctl-start', { timeout: 45000, ignoreOutput: true });
    exactPidIdentity();
    const expected = path.resolve(data).replace(/\\/g, '/')
      .toLowerCase().replace(/'/g, "''");
    assert.equal(psql(
      `SELECT current_database()='postgres' AND current_user='${owner}' ` +
      `AND session_user='${owner}' AND host(inet_server_addr())='127.0.0.1' ` +
      `AND inet_server_port()=${port} ` +
      "AND current_setting('server_version_num')::int BETWEEN 180000 AND 189999 " +
      `AND lower(replace(current_setting('data_directory'),chr(92),'/'))='${expected}';`,
      'admin-cluster-identity'), 't', 'ADMIN_CLUSTER_IDENTITY_MISMATCH');
    verified++;
    psql(`CREATE ROLE ${reader} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB ` +
      'NOCREATEROLE NOREPLICATION NOBYPASSRLS;', 'create-reader');
    assert.equal(psql(
      `SELECT rolcanlogin AND NOT rolsuper AND NOT rolinherit AND ` +
      `NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND ` +
      `NOT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='${reader}';`,
      'reader-role-contract'), 't', 'READER_ROLE_CONTRACT_MISMATCH');
    // The bootstrap owner password is retained only in memory and a
    // synthetic disposable passfile; never in arguments, output, or logs.
    const ownerSecret = crypto.randomBytes(32).toString('hex');
    secrets.push(ownerSecret);
    assert.ok(worker('bootstrap-owner', owner, null, ownerSecret)
      .includes('PQ_CHANGE_PASSWORD=PASS'), 'OWNER_PASSWORD_BOOTSTRAP_FAILED');
    const oldSecret = crypto.randomBytes(32).toString('hex');
    secrets.push(oldSecret);
    assert.ok(worker('bootstrap-reader', owner, null, oldSecret)
      .includes('PQ_CHANGE_PASSWORD=PASS'), 'READER_PASSWORD_BOOTSTRAP_FAILED');
    const ownerPass = passfile('owner.pgpass', owner, ownerSecret);
    const oldPass = passfile('reader-old.pgpass', reader, oldSecret);
    const before = psql('SELECT pg_conf_load_time()::text;',
      'configuration-time-before');
    fs.writeFileSync(path.join(data, 'pg_hba.conf'), hba('scram-sha-256'));
    run(tools['pg_ctl.exe'], ['-D', data, 'reload'], 'pgctl-reload',
      { ignoreOutput: true });
    let loaded = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const after = psql('SELECT pg_conf_load_time()::text;',
          'configuration-time-after', { PGPASSFILE: ownerPass });
        if (after && after !== before) { loaded = true; break; }
      } catch { /* bounded synthetic reload wait */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(loaded, 'HBA_RELOAD_NOT_CONFIRMED');
    assert.deepEqual(worker('admin', owner, ownerPass, undefined),
      ['AUTH=PASS', 'CORE_IDENTITY=PASS'], 'ADMIN_SCRAM_AUTH_FAILED');
    verified++;
    const oldLines = worker('reader', reader, oldPass, undefined);
    assert.deepEqual(oldLines.slice(0, 2),
      ['AUTH=PASS', 'CORE_IDENTITY=PASS'], 'INITIAL_READER_AUTH_FAILED');
    assert.equal(oldLines[2], 'READER_DATA_DIRECTORY=PERMISSION_DENIED',
      'READER_GUC_DIAGNOSTIC_UNEXPECTED');
    verified++;
    const newSecret = crypto.randomBytes(32).toString('hex');
    secrets.push(newSecret);
    assert.ok(worker('change', owner, ownerPass, newSecret)
      .includes('PQ_CHANGE_PASSWORD=PASS'), 'PQ_CHANGE_PASSWORD_FAILED');
    verified++;
    const newPass = passfile('reader-new.pgpass', reader, newSecret);
    assert.deepEqual(worker('reader', reader, newPass, undefined).slice(0, 2),
      ['AUTH=PASS', 'CORE_IDENTITY=PASS'], 'NEW_READER_AUTH_FAILED');
    verified++;
    assert.deepEqual(worker('reader', reader, oldPass, undefined, 20),
      ['AUTH=FAIL'], 'OLD_READER_PASSWORD_ACCEPTED');
    verified++;
    assert.equal(psql(
      `SELECT count(*)=2 AND bool_and(rolpassword LIKE 'SCRAM-SHA-256$%') ` +
      `FROM pg_catalog.pg_authid WHERE rolname IN ('${owner}','${reader}');`,
      'scram-format', { PGPASSFILE: ownerPass }), 't',
    'SCRAM_VERIFIER_FORMAT_FAILED');
    verified++;
    result = 'PASS';
  } catch (error) {
    failureStage = stage;
    cause = /^[A-Z0-9_]+$/.test(error.message) ? error.message :
      /^[a-z0-9-]+_(PROCESS_FAILED|EXIT_\d+(_SOCKET_10013)?|OUTPUT_LIMIT)$/.test(error.message) ?
        error.message.toUpperCase().replaceAll('-', '_') : 'SANITIZED_FAILURE';
  } finally {
    try {
      if (serverAttempted && fs.existsSync(path.join(data, 'postmaster.pid'))) {
        exactPidIdentity();
        run(tools['pg_ctl.exe'], ['-D', data, '-w', '-t', '15', '-m', 'fast',
          'stop'], 'pgctl-stop', { timeout: 20000, ignoreOutput: true });
        assert.ok(!fs.existsSync(path.join(data, 'postmaster.pid')),
          'SERVER_STILL_RUNNING');
      }
      if (!safeToRemove()) throw Error('CLEANUP_OWNERSHIP_FAILED');
      fs.rmSync(root, { recursive: true, force: false });
      cleanup = !fs.existsSync(root);
    } catch {
      cleanup = false;
      result = 'STOP';
    }
  }
  console.log('SYNTHETIC_CHECKS_COMPLETED=' + verified + '/7');
  console.log('STOP_STAGE=' + failureStage);
  console.log('SANITIZED_CAUSE=' + cause);
  console.log('CLEANUP=' + (cleanup ? 'PASS' : 'FAIL'));
  console.log('PRODUCTION_CONNECTIONS=0');
  console.log('PG18_PASSWORD_TRANSPORT=' + result);
  if (result !== 'PASS' || !cleanup || verified !== 7) process.exitCode = 1;
}

main().catch(() => {
  console.log('PG18_PASSWORD_TRANSPORT=STOP');
  process.exitCode = 1;
});
