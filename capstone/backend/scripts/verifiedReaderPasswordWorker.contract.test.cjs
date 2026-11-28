'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const workerPath = path.join(__dirname, 'VerifiedReaderPasswordWorker.cs');
const integrationPath = path.join(__dirname, 'windowsPg18VerifiedPasswordTransport.integration.cjs');
const readWorker = () => fs.readFileSync(workerPath, 'utf8');

test('production worker pins the admin service and fixed reader target', () => {
  const source = readWorker();
  assert.match(source, /#if TQ_SYNTHETIC[\s\S]*?#else[\s\S]*?tq_admin_identity[\s\S]*?railway[\s\S]*?tq_release_preflight_reader[\s\S]*?#endif/);
  assert.match(source, /connect_timeout=10/);
  assert.doesNotMatch(source, /sslmode\s*=\s*disable/i);
  assert.doesNotMatch(source, /10\.218\.248\.163/);
  assert.match(source, /TQ_EXPECTED_PG_SERVER_ADDRESS/);
});

test('production connection requires verified TLS and exact identity before password input', () => {
  const source = readWorker();
  assert.match(source, /PQsslInUse/);
  assert.match(source, /PQhost/);
  assert.match(source, /inet_server_addr/);
  assert.match(source, /inet_server_port/);
  assert.match(source, /rolname=current_user AND r\.rolsuper/);
  assert.match(source, /EXPECTED_TARGET_ANCHOR=FAIL/);
  assert.match(source, /sslmode/);
  const main = source.slice(source.indexOf('public static int Main'));
  assert.ok(main.indexOf('ValidateConnectionIdentity(conn') < main.indexOf('ReadSecretFromPassfile('));
  assert.ok(main.indexOf('EXPECTED_TARGET_ANCHOR=FAIL') < main.indexOf('PQconnectdb('));
  assert.match(source, /default_transaction_read_only=on/);
  assert.match(source, /READ_ONLY_OR_BOUNDS=PASS/);
  assert.match(source, /SESSION_READONLY_RESTORE=PASS/);
});

test('one PQchangePassword call is guarded by SCRAM, bounds, and role snapshot checks', () => {
  const source = readWorker();
  assert.equal((source.match(/PQchangePassword\(/g) || []).length, 2, 'one declaration and one invocation');
  assert.match(source, /password_encryption/);
  assert.match(source, /statement_timeout/);
  assert.match(source, /lock_timeout/);
  assert.ok(source.indexOf('PASSWORD_CHANGE_ATTEMPTED=TRUE') < source.indexOf('PQchangePassword(conn, roleToChange'));
  assert.match(source, /RoleSnapshot/);
  assert.match(source, /WHERE m\.roleid=r\.oid/);
  assert.match(source, /SCRAM-SHA-256/);
});

test('password source is a distinct exact passfile tuple and its byte buffers are cleared', () => {
  const source = readWorker();
  assert.match(source, /TQ_READER_PASSFILE_SOURCE/);
  assert.match(source, /ReadSecretFromPassfile/);
  assert.match(source, /localhost/);
  assert.match(source, /tq_release_preflight_reader/);
  assert.match(source, /fields\[4\]/);
  assert.match(source, /Array\.Clear\(raw, 0, raw\.Length\)/);
  assert.match(source, /Array\.Clear\(secret, 0, secret\.Length\)/);
  assert.doesNotMatch(source, /Console\.Read(Line|Key)|ReadAllText\(.*PASS/i);
});

test('worker emits fixed status markers and never writes secret buffers or verifier values', () => {
  const source = readWorker();
  assert.doesNotMatch(source, /Console\.(Write|WriteLine)\([^\n]*\+\s*(secret|secretPointer|secretBytes|verifier|errorMessage)\b/i);
  assert.doesNotMatch(source, /PQerrorMessage\(/);
  assert.match(source, /SYNC=PASS/);
  assert.match(source, /READ_ONLY_OR_BOUNDS=PASS/);
  assert.match(source, /SESSION_READONLY_RESTORE=PASS/);
});

test('passfile parser zeroes each temporary field buffer before clearing and reusing it', () => {
  const source = readWorker();
  assert.match(source, /AddPassfileFieldAndClear\(fields, field\)/);
  assert.match(source, /for \(int index = 0; index < field\.Count; index\+\+\)\s*field\[index\] = 0;\s*field\.Clear\(\);/);
});

test('synthetic integration reports a fixed missing-tool code without echoing paths', { skip: process.platform !== 'win32' }, () => {
  const sentinel = path.join(os.tmpdir(), 'tq-test-tool-path-must-not-be-logged');
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    TQ_PG18_BIN: sentinel,
    TQ_OPENSSL: sentinel,
    TQ_PG18_WORKER_SOURCE: sentinel,
    TQ_CSC: sentinel
  });
  const result = spawnSync(process.execPath, [integrationPath], {
    env,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
    windowsHide: true
  });
  const output = (result.stdout || '') + (result.stderr || '');

  assert.equal(result.status, 1, 'missing synthetic tool must stop before setup');
  assert.match(output, /VERIFIED_TEST_TOOL_FILE_MISSING_PG18_INITDB/);
  assert.equal(output.includes(sentinel), false, 'diagnostic must not expose filesystem paths');
});

test('synthetic integration rejects a missing verified OpenSSL executable path', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-openssl-missing-path-test-'));
  try {
    const bin = path.join(tempRoot, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['initdb.exe', 'pg_ctl.exe', 'psql.exe']) {
      fs.writeFileSync(path.join(bin, name), 'synthetic placeholder', { flag: 'wx' });
    }
    const missingOpenSsl = path.join(tempRoot, 'missing', 'openssl.exe');
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      TQ_PG18_BIN: bin,
      TQ_OPENSSL: 'openssl.exe',
      TQ_OPENSSL_VERIFIED_PATH: missingOpenSsl,
      TQ_PG18_WORKER_SOURCE: workerPath,
      TQ_CSC: process.execPath
    });
    const result = spawnSync(process.execPath, [integrationPath], {
      env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65536,
      windowsHide: true
    });
    const output = (result.stdout || '') + (result.stderr || '');

    assert.equal(result.status, 1, 'missing verified executable must stop before setup');
    assert.match(output, /VERIFIED_OPENSSL_PATH_INVALID/);
    assert.equal(output.includes(tempRoot), false, 'diagnostic must not expose temporary paths');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Node resolves the PowerShell-validated OpenSSL token to the exact PATH executable', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-openssl-resolution-test-'));
  try {
    const bin = path.join(tempRoot, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['initdb.exe', 'pg_ctl.exe', 'psql.exe']) {
      fs.writeFileSync(path.join(bin, name), 'synthetic placeholder', { flag: 'wx' });
    }
    const opensslPath = path.join(bin, 'openssl.exe');
    const sourcePath = path.join(tempRoot, 'not-openssl.cs');
    const source = 'using System; public static class Program { public static void Main() { Console.WriteLine("SYNTHETIC_NOT_OPENSSL"); } }';
    fs.writeFileSync(sourcePath, source, { flag: 'wx', encoding: 'utf8' });
    const compiler = process.env.TQ_CSC || (process.env.SystemRoot &&
      path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'));
    assert.ok(compiler && path.isAbsolute(compiler) && fs.existsSync(compiler), 'Windows C# compiler must be available');
    const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/out:' + opensslPath, sourcePath], {
      cwd: tempRoot,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 32768,
      windowsHide: true
    });
    assert.equal(compiled.error, undefined, 'synthetic native executable compilation must complete');
    assert.equal(compiled.status, 0, 'synthetic native executable compilation must succeed');
    assert.ok(fs.existsSync(opensslPath), 'synthetic executable must exist at the pinned path');
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      PATH: bin + path.delimiter + (process.env.PATH || ''),
      TQ_PG18_BIN: bin,
      TQ_OPENSSL: 'OpenSSL.EXE',
      TQ_OPENSSL_VERIFIED_PATH: opensslPath,
      TQ_PG18_WORKER_SOURCE: workerPath,
      TQ_CSC: compiler
    });
    const result = spawnSync(process.execPath, [integrationPath], {
      env,
      encoding: 'utf8',
      timeout: 7000,
      maxBuffer: 65536,
      windowsHide: true
    });
    const output = (result.stdout || '') + (result.stderr || '');

    assert.equal(result.status, 1, 'non-OpenSSL executable must stop before database setup');
    assert.match(output, /VERIFIED_OPENSSL_VERSION_CHECK_FAILED/,
      'the child process must reach the exact validated executable and reject its output');
    assert.equal(output.includes(tempRoot), false, 'diagnostic must not expose temporary paths');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('the actual workflow-resolved OpenSSL survives its PowerShell-to-Node handoff', {
  skip: process.platform !== 'win32' || !process.env.TQ_OPENSSL_VERIFIED_PATH || !process.env.TQ_OPENSSL
}, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-openssl-handoff-test-'));
  try {
    const bin = path.join(tempRoot, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['initdb.exe', 'pg_ctl.exe', 'psql.exe']) {
      fs.writeFileSync(path.join(bin, name), 'synthetic placeholder', { flag: 'wx' });
    }
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE',
      'TQ_OPENSSL', 'TQ_OPENSSL_VERIFIED_PATH']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      TQ_PG18_BIN: bin,
      TQ_PG18_WORKER_SOURCE: workerPath,
      TQ_CSC: process.execPath
    });
    const result = spawnSync(process.execPath, [integrationPath], {
      env,
      encoding: 'utf8',
      timeout: 7000,
      maxBuffer: 65536,
      windowsHide: true
    });
    const output = (result.stdout || '') + (result.stderr || '');

    assert.equal(result.status, 1, 'synthetic PostgreSQL stub must stop after successful OpenSSL launch');
    assert.match(output, /PG18_INITDB_BOUNDED_PROCESS_FAILURE_ENOENT/,
      'actual workflow token and validated path must reach Node before disposable database setup');
    assert.equal(output.includes(tempRoot), false, 'diagnostics must not expose temporary paths');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('synthetic integration rejects untrusted relative OpenSSL paths with an executable basename', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-openssl-relative-path-test-'));
  try {
    const bin = path.join(tempRoot, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['initdb.exe', 'pg_ctl.exe', 'psql.exe']) {
      fs.writeFileSync(path.join(bin, name), 'synthetic placeholder', { flag: 'wx' });
    }
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      TQ_PG18_BIN: bin,
      TQ_OPENSSL: path.win32.join('untrusted', 'openssl.exe'),
      TQ_OPENSSL_VERIFIED_PATH: path.join(bin, 'openssl.exe'),
      TQ_PG18_WORKER_SOURCE: workerPath,
      TQ_CSC: process.execPath
    });
    const result = spawnSync(process.execPath, [integrationPath], {
      env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65536,
      windowsHide: true
    });
    const output = (result.stdout || '') + (result.stderr || '');

    assert.equal(result.status, 1, 'relative executable path must stop before setup');
    assert.match(output, /VERIFIED_TEST_TOOL_NOT_ALLOWED_OPENSSL_COMMAND/);
    assert.equal(output.includes(tempRoot), false, 'diagnostic must not expose temporary paths');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Windows workflow passes only the validated OpenSSL executable through the Node handoff', () => {
  const workflowPath = path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'windows-reader-pqchange-pg18.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');

  assert.match(workflow, /System32[\\/]where\.exe/);
  assert.match(workflow, /whereOutput = @\(& \$whereExe openssl\.exe/);
  assert.match(workflow, /VERIFIED_OPENSSL_RESOLUTION_FAILED/);
  assert.match(workflow, /\$env:TQ_OPENSSL\s*=\s*'openssl\.exe'/);
  assert.match(workflow, /\$env:TQ_OPENSSL_VERIFIED_PATH\s*=\s*\$opensslPath/);
  assert.doesNotMatch(workflow, /\$opensslCommand\.(?:Name|Source)/);
  assert.match(workflow, /\[IO\.Path\]::IsPathRooted\(\$opensslPath\)/);
  assert.match(workflow, /\[IO\.Path\]::GetFileName\(\$opensslPath\) -ine 'openssl\.exe'/);
  const resolvedPathIndex = workflow.indexOf('$env:TQ_OPENSSL_VERIFIED_PATH = $opensslPath');
  const fixedTokenIndex = workflow.indexOf("$env:TQ_OPENSSL = 'openssl.exe'");
  const integrationIndex = workflow.indexOf('node capstone/backend/scripts/windowsPg18VerifiedPasswordTransport.integration.cjs');
  assert.ok(resolvedPathIndex >= 0 && resolvedPathIndex < integrationIndex);
  assert.ok(fixedTokenIndex >= 0 && fixedTokenIndex < integrationIndex);
});
