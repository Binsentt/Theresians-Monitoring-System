'use strict';

// Executes the real C# operator gates with a callback that never opens a socket.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const source = path.join(__dirname, 'VerifiedReaderPasswordOperator.cs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const utc = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function protect(files) {
  // Each child's explicit DACL must be installed before its parent's
  // non-inheritable DACL removes the child's original inherited permissions.
  const ordered = [...new Set(files)].sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length);
  const input = Buffer.from(JSON.stringify(ordered), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$index=-1; $kind='UNSET'; $stage='DECODE'
try {
  $files=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')))
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach($p in $files) {
    $index++; $stage='TYPE'
    $directory=[IO.Directory]::Exists($p)
    if($directory) {$kind='DIRECTORY'; $acl=New-Object Security.AccessControl.DirectorySecurity}
    else {$kind='FILE'; $acl=New-Object Security.AccessControl.FileSecurity}
    $stage='BUILD'
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
      $id=New-Object Security.Principal.SecurityIdentifier($s)
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','Allow')
      $acl.AddAccessRule($rule)
    }
    $stage='APPLY'
    if($directory) {[IO.Directory]::SetAccessControl($p,$acl)} else {[IO.File]::SetAccessControl($p,$acl)}
    $stage='READBACK'
    if($directory) {$read=[IO.Directory]::GetAccessControl($p)} else {$read=[IO.File]::GetAccessControl($p)}
    if(-not $read.AreAccessRulesProtected -or $read.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value) {
      throw 'FIXTURE_DACL_READBACK'
    }
  }
  [Console]::WriteLine('FIXTURE_ACL=PASS:COUNT='+$files.Count)
} catch {
  [Console]::WriteLine('FIXTURE_ACL=FAIL:INDEX='+$index+':TYPE='+$kind+':STAGE='+$stage)
  exit 1
}`;
  const result = run(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const failure = (result.stdout || '').split(/\r?\n/).find(line =>
    /^FIXTURE_ACL=FAIL:INDEX=-?\d+:TYPE=(?:UNSET|DIRECTORY|FILE):STAGE=(?:DECODE|TYPE|BUILD|APPLY|READBACK)$/.test(line));
  assert.equal(result.status, 0, failure || 'FIXTURE_ACL=FAIL:PROCESS');
}

function aclSnapshot(files) {
  const input = Buffer.from(JSON.stringify(files), 'utf8').toString('base64');
  const script = `$files=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))); foreach($p in $files) { if([IO.Directory]::Exists($p)) {$acl=[IO.Directory]::GetAccessControl($p)} else {$acl=[IO.File]::GetAccessControl($p)}; [Console]::WriteLine([IO.Path]::GetFileName($p)+' PROTECTED='+$acl.AreAccessRulesProtected) }`;
  return run(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]).stdout;
}

function widenAcl(file) {
  const input = Buffer.from(file, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')); $acl=[IO.File]::GetAccessControl($p); $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'))); [IO.File]::SetAccessControl($p,$acl)`;
  assert.equal(run(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]).status, 0);
}

function fixture(options = {}) {
  assert.ok(fs.existsSync(source), 'the real operator gate is missing');
  const root = fs.mkdtempSync(path.join(options.root || os.tmpdir(), 'tq-operator-gates-'));
  const repo = path.join(root, 'source');
  const scripts = path.join(repo, 'capstone', 'backend', 'scripts');
  const privateDir = path.join(root, 'private');
  const native = path.join(root, 'native');
  const output = path.join(root, 'executable');
  const journal = path.join(privateDir, 'journal');
  for (const directory of [scripts, privateDir, native, output, journal]) fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(source, path.join(scripts, 'VerifiedReaderPasswordOperator.cs'));
  const workerSource = options.workerSource || path.join(__dirname, 'VerifiedReaderPasswordWorker.cs');
  fs.copyFileSync(workerSource, path.join(scripts, 'VerifiedReaderPasswordWorker.cs'));
  const supervisor = path.join(scripts, 'productionReaderPasswordOperator.cjs');
  fs.writeFileSync(supervisor, fs.existsSync(path.join(__dirname, 'productionReaderPasswordOperator.cjs'))
    ? fs.readFileSync(path.join(__dirname, 'productionReaderPasswordOperator.cjs')) : '// synthetic supervisor source fixture\n');
  const git = process.env.TQ_GIT || path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe');
  for (const args of [['init', '--quiet', repo], ['-C', repo, 'add', '.'],
    ['-C', repo, '-c', 'user.name=Gate test', '-c', 'user.email=gate@example.invalid', 'commit', '--quiet', '-m', 'synthetic fixture']]) {
    assert.equal(run(git, args).status, 0, 'fixture git setup failed');
  }
  const commit = run(git, ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();
  const harness = path.join(root, 'GateHarness.cs');
  fs.writeFileSync(harness, 'using System; using System.Threading; internal static class GateHarness { static int Main(string[] args) { return VerifiedReaderPasswordOperator.Run(args, delegate(int local, int server, string address) { Console.WriteLine("CALLBACK=1"); int delay; if(Int32.TryParse(Environment.GetEnvironmentVariable("TQ_TEST_CALLBACK_HOLD_MS"), out delay)) Thread.Sleep(delay); return 0; }); } }');
  const exe = path.join(output, 'gate.exe');
  const csc = options.csc || process.env.TQ_CSC || path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compile = run(csc, options.realWorker
    ? ['/nologo', '/target:exe', '/define:TQ_SYNTHETIC,TQ_OPERATOR', '/out:' + exe, source, workerSource]
    : ['/nologo', '/target:exe', '/define:TQ_SYNTHETIC', '/out:' + exe, source, harness]);
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const nativeSource = options.bin || process.env.TQ_PG18_BIN || path.join(process.env.ProgramFiles, 'PostgreSQL', '18', 'bin');
  assert.ok(fs.existsSync(path.join(nativeSource, 'libpq.dll')), 'PostgreSQL 18 libpq is required; this test never connects');
  for (const name of fs.readdirSync(nativeSource).filter(name => /\.dll$/i.test(name))) {
    fs.copyFileSync(path.join(nativeSource, name), path.join(native, name.toLowerCase()));
  }
  const ca = path.join(privateDir, 'root.crt');
  // Ephemeral synthetic certificate and key remain inside this temporary fixture.
  if (options.ca) fs.copyFileSync(options.ca, ca);
  else {
    const openssl = process.env.TQ_OPENSSL_VERIFIED_PATH || path.join(process.env.ProgramFiles, 'Git', 'mingw64', 'bin', 'openssl.exe');
    const generated = run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=Operator synthetic test root', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', path.join(root, 'synthetic.key'), '-out', ca]);
    assert.equal(generated.status, 0, 'synthetic root generation failed');
  }
  const adminService = path.join(privateDir, 'pg_admin_service.conf');
  const readerService = path.join(privateDir, 'pg_service.conf');
  const adminPassfile = path.join(privateDir, 'pg_admin_passfile.conf');
  const readerPassfile = path.join(privateDir, 'pgpass.conf');
  const port = options.port || 55433;
  const service = (alias, role) => `[${alias}]\nhost=localhost\nhostaddr=127.0.0.1\nport=${port}\ndbname=postgres\nuser=${role}\nsslmode=verify-full\nsslrootcert=${ca.replace(/\\/g, '/')}\n`;
  fs.writeFileSync(adminService, service('tq_synthetic_admin', 'tq_transport_owner'));
  fs.writeFileSync(readerService, service('tq_synthetic_reader', 'tq_release_preflight_reader'));
  if (options.adminPass) fs.copyFileSync(options.adminPass, adminPassfile);
  else fs.writeFileSync(adminPassfile, `localhost:${port}:postgres:tq_transport_owner:synthetic-only-current\n`);
  if (options.readerPass) fs.copyFileSync(options.readerPass, readerPassfile);
  else fs.writeFileSync(readerPassfile, `localhost:${port}:postgres:tq_release_preflight_reader:synthetic-only-desired\n`);
  const authorization = path.join(privateDir, 'authorization.txt');
  const fields = {
    formatVersion: '1', operation: 'reader-password-sync', operationId: crypto.randomUUID(),
    issuedUtc: utc(Date.now() - 1000), expiresUtc: utc(Date.now() + 300000), sourceCommit: commit,
    repositoryRoot: repo, tunnelPort: String(port), serverPort: String(port), targetServerAddress: '127.0.0.1',
    adminServiceFile: adminService, adminServiceSha256: hash(adminService),
    adminPassfile, adminPassfileSha256: hash(adminPassfile), readerServiceFile: readerService,
    readerServiceSha256: hash(readerService), readerPassfile, readerPassfileSha256: hash(readerPassfile),
    rootCaFile: ca, rootCaSha256: hash(ca), executableSha256: hash(exe),
    gateSourceSha256: hash(source), workerSourceSha256: hash(path.join(scripts, 'VerifiedReaderPasswordWorker.cs')),
    supervisorSourceSha256: hash(supervisor),
    gitExecutable: git, gitSha256: hash(git), nativeDirectory: native, journalDirectory: journal
  };
  for (const name of fs.readdirSync(native)) fields['native.' + name] = hash(path.join(native, name));
  fs.writeFileSync(authorization, 'placeholder');
  const secured = [privateDir, output, native, journal, exe, ...fs.readdirSync(privateDir).filter(name => name !== 'journal').map(name => path.join(privateDir, name)),
    ...fs.readdirSync(native).map(name => path.join(native, name))];
  protect(secured);
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name];
  function write(overrides = {}, suffix = '') {
    fs.writeFileSync(authorization, Object.entries({ ...fields, ...overrides }).map(([key, value]) => key + '=' + value).join('\n') + '\n' + suffix);
    return hash(authorization);
  }
  function invoke(overrides = {}, options = {}) {
    const authHash = write(overrides, options.suffix || '');
    return run(exe, [authorization, options.authHash || authHash, repo, options.sourceCommit || commit], { timeout: 60000, env: { ...env, ...(options.env || {}) } });
  }
  return { root, repo, scripts, privateDir, native, journal, exe, authorization, fields, env, write, invoke };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('WINDOWS_ONLY');
  assert.ok(fs.existsSync(source), 'the real operator gate is missing');
  const f = fixture();
  let passed = false;
  try {
    const denied = (label, category, overrides = {}, options = {}) => {
      const result = f.invoke(overrides, options);
      assert.equal(result.status, 31, label + ': must refuse before callback: ' + result.stdout);
      assert.ok(result.stdout.includes('OPERATOR_GATE=FAIL:' + category + '\r\n'), label + ': wrong gate: ' + result.stdout);
      assert.ok(!result.stdout.includes('CALLBACK=1'), label + ': callback must not run');
      assert.ok(!fs.existsSync(path.join(f.journal, 'operation.consumed')), label + ': validation must precede claim');
    };
    denied('independent authorization hash', 'FILE_HASH', {}, { authHash: '0'.repeat(64) });
    denied('expired authorization', 'AUTH_TIME', { issuedUtc: utc(Date.now() - 120000), expiresUtc: utc(Date.now() - 1000) });
    denied('future authorization', 'AUTH_TIME', { issuedUtc: utc(Date.now() + 60000) });
    denied('authorization over one hour', 'AUTH_TIME', { expiresUtc: utc(Date.now() + 3700000) });
    denied('independent source pin', 'SOURCE_PIN', {}, { sourceCommit: '0'.repeat(40) });
    denied('duplicate field', 'AUTH_KEYS', {}, { suffix: 'operation=reader-password-sync\n' });
    denied('unknown field', 'AUTH_KEYS', {}, { suffix: 'skipAcl=true\n' });
    denied('unsafe role-independent target', 'SYNTHETIC_TARGET', { targetServerAddress: '127.0.0.2' });
    denied('executable provenance', 'FILE_HASH', { executableSha256: '0'.repeat(64) });
    denied('worker source provenance', 'SOURCE_HASH', { workerSourceSha256: '0'.repeat(64) });
    denied('supervisor source provenance', 'SOURCE_HASH', { supervisorSourceSha256: '0'.repeat(64) });
    denied('native provenance', 'FILE_HASH', { 'native.libpq.dll': '0'.repeat(64) });
    denied('ambient PostgreSQL override', 'AMBIENT_CONNECTION', {}, { env: { PGSSLMODE: 'disable' } });
    fs.writeFileSync(path.join(f.repo, 'unexpected.txt'), 'dirty');
    denied('untracked source change', 'SOURCE_CLEAN');
    fs.unlinkSync(path.join(f.repo, 'unexpected.txt'));
    const service = f.fields.adminServiceFile;
    const saved = fs.readFileSync(service);
    fs.writeFileSync(service, saved.toString().replace('sslmode=verify-full', 'sslmode=require'));
    denied('pinned but unsafe TLS setting', 'SERVICE_TARGET_TLS', { adminServiceSha256: hash(service) });
    fs.writeFileSync(service, saved);
    const pass = f.fields.readerPassfile;
    const savedPass = fs.readFileSync(pass);
    fs.writeFileSync(pass, '*:55433:postgres:tq_release_preflight_reader:synthetic\n');
    denied('pinned wildcard passfile', 'PASSFILE_TUPLE', { readerPassfileSha256: hash(pass) });
    fs.writeFileSync(pass, savedPass);
    widenAcl(pass);
    denied('reader secret broadly readable ACL', 'PRIVATE_ACL_RULE');
    protect([pass]);
    fs.copyFileSync(path.join(f.native, 'libpq.dll'), path.join(f.native, 'unreviewed.dll'));
    denied('extra native DLL', 'NATIVE_MANIFEST');
    fs.unlinkSync(path.join(f.native, 'unreviewed.dll'));
    assert.equal(run(f.fields.gitExecutable, ['-C', f.repo, 'config', 'filter.synthetic.clean', 'cmd /c exit 99']).status, 0);
    denied('Git clean filter command configuration', 'SOURCE_FILTERS');
    assert.equal(run(f.fields.gitExecutable, ['-C', f.repo, 'config', '--remove-section', 'filter.synthetic']).status, 0);
    assert.equal(run(f.fields.gitExecutable, ['-C', f.repo, 'update-index', '--add', '--cacheinfo', '160000', f.fields.sourceCommit, 'synthetic-submodule']).status, 0);
    denied('Git submodule entry', 'SOURCE_SUBMODULE');
    assert.equal(run(f.fields.gitExecutable, ['-C', f.repo, 'update-index', '--force-remove', 'synthetic-submodule']).status, 0);
    const authHash = f.write();
    const firstProcess = spawn(f.exe, [f.authorization, authHash, f.repo, f.fields.sourceCommit], {
      env: { ...f.env, TQ_TEST_CALLBACK_HOLD_MS: '1500' }, windowsHide: true
    });
    let output = '';
    const finished = new Promise((resolve, reject) => {
      firstProcess.once('error', reject);
      firstProcess.once('close', (code, signal) => resolve({ status: code, signal }));
    });
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('bounded callback start missing: ' + output)), 15000);
      firstProcess.stdout.on('data', data => { output += data; if (output.includes('CALLBACK=1')) { clearTimeout(deadline); resolve(); } });
      firstProcess.once('exit', () => { clearTimeout(deadline); if (!output.includes('CALLBACK=1')) reject(new Error('callback refused: ' + output)); });
    });
    const concurrent = run(f.exe, [f.authorization, authHash, f.repo, f.fields.sourceCommit], { env: f.env });
    assert.equal(concurrent.status, 31, 'concurrent invocation must refuse');
    assert.ok(!concurrent.stdout.includes('CALLBACK=1'));
    const first = await finished;
    first.stdout = output; first.stderr = '';
    assert.equal(first.status, 0, 'valid real gates must invoke callback: ' + first.stdout + first.stderr +
      (first.status === 0 ? '' : aclSnapshot([f.privateDir, f.authorization, path.dirname(f.exe), f.exe, f.journal, f.native, ...fs.readdirSync(f.privateDir).filter(name => name !== 'journal').map(name => path.join(f.privateDir, name))])));
    assert.equal((first.stdout.match(/CALLBACK=1/g) || []).length, 1);
    const journal = fs.readFileSync(path.join(f.journal, 'operation.consumed'), 'utf8');
    assert.ok(journal.includes('CLAIMED') && journal.includes('COMPLETED=0'));
    const replay = f.invoke({ operationId: crypto.randomUUID() });
    assert.equal(replay.status, 31, 'new authorization ID cannot bypass consumed operation');
    assert.ok(!replay.stdout.includes('CALLBACK=1'));
    assert.ok(first.stdout.includes('OPERATOR_RESULT=PASS'));
    passed = true;
  } finally {
    // The only removed directory is this exact test-created temporary fixture.
    if (passed) fs.rmSync(f.root, { recursive: true, force: true });
  }
  const aborted = fixture();
  let cleaned = false;
  try {
    const authHash = aborted.write();
    const child = spawn(aborted.exe, [aborted.authorization, authHash, aborted.repo, aborted.fields.sourceCommit], {
      env: { ...aborted.env, TQ_TEST_CALLBACK_HOLD_MS: '30000' }, windowsHide: true
    });
    let output = '';
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill(); reject(new Error('bounded aborted callback start missing')); }, 15000);
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('CALLBACK=1')) { clearTimeout(deadline); child.kill(); resolve(); }
      });
      child.once('exit', () => { clearTimeout(deadline); if (!output.includes('CALLBACK=1')) reject(new Error('aborted callback refused: ' + output)); });
    });
    await closed;
    const journal = fs.readFileSync(path.join(aborted.journal, 'operation.consumed'), 'utf8');
    assert.ok(journal.includes('STATE=OUTCOME_UNKNOWN') && !journal.includes('COMPLETED='));
    assert.ok(!output.includes('OPERATOR_RESULT=PASS'));
    const replay = aborted.invoke({ operationId: crypto.randomUUID() });
    assert.equal(replay.status, 31, 'killed callback consumes authorization across operation IDs');
    assert.ok(replay.stdout.includes('OPERATOR_GATE=FAIL:OPERATION_CONSUMED'));
    assert.ok(!replay.stdout.includes('CALLBACK=1'));
    cleaned = true;
  } finally {
    if (cleaned) fs.rmSync(aborted.root, { recursive: true, force: true });
  }
  console.log('OPERATOR_GATE_CONTRACT=PASS');
}

if (require.main === module) {
  if (process.platform === 'win32' && process.env.TQ_OPERATOR_GATE_TESTS_REQUIRED === '1') {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
  } else require('node:test').test('Windows protected operator gate integration', { skip: 'explicit Windows gate job required' }, () => {});
}
module.exports = { hash, sha, utc, protect, fixture,
  createOperatorFixture: options => fixture({ ...options, realWorker: true }) };
