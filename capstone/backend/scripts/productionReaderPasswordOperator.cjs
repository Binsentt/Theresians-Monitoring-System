'use strict';

// Reviewed operator supervisor. Authorization and all protected-input checks run
// in VerifiedReaderPasswordOperator BEFORE libpq connects or reads the secret.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

function cleanEnvironment(source = process.env) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'USERPROFILE']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

function runBounded(executable, args, { timeoutMs = 60000, cwd = path.dirname(executable) } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('TIMEOUT_INVALID');
  return new Promise(resolve => {
    let child;
    let count = 0; let stdout = ''; let invalid = false; let timedOut = false; let settled = false; let stopping = false;
    let terminationTimer; let deadline;
    const finish = (exitCode, terminated) => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(terminationTimer);
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const outputComplete = !invalid && count <= 16384 && terminated;
      // Values and output are never returned to callers or forwarded to logs.
      const completed = outputComplete && !timedOut && exitCode === 0 &&
        lines.filter(line => line === 'SYNC=PASS').length === 1 &&
        lines.filter(line => line === 'OPERATOR_RESULT=PASS').length === 1 &&
        !lines.some(line => /=(FAIL|STOP|UNKNOWN)$/.test(line));
      resolve({ exitCode, terminated, timedOut, outputComplete, completed,
        identityVerified: completed && lines.includes('TARGET_IDENTITY=PASS'),
        passwordSynchronized: completed && lines.includes('PASSWORD_SYNC_OPERATION=PASS'),
        rolePropertiesPreserved: completed && lines.includes('ROLE_PROPERTIES_UNCHANGED=PASS') });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(terminationTimer);
      try { child.kill('SIGKILL'); } catch {}
      // Never wait indefinitely for inherited output handles after process exit.
      terminationTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy();
        child.unref(); finish(null, false);
      }, 3000);
    };
    try {
      child = spawn(executable, args, { cwd, env: cleanEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', bytes => {
        count += bytes.length;
        if (count > 16384) { invalid = true; stop(); return; }
        stdout += bytes.toString('ascii');
      });
      child.stderr.on('data', bytes => { if (bytes.length) invalid = true; count += bytes.length; if (count > 16384) stop(); });
      child.on('error', () => { invalid = true; if (!child.pid) finish(null, true); else stop(); });
      child.on('exit', code => {
        // Only the finite alphabet of fixed diagnostic records is accepted.
        if (stdout.split(/\r?\n/).filter(Boolean).some(line => !/^[A-Z_]+=[A-Z0-9_]+$/.test(line))) invalid = true;
        // close follows drained pipes normally; a descendant retaining handles
        // cannot extend this collection window beyond one second.
        clearTimeout(terminationTimer);
        terminationTimer = setTimeout(() => { invalid = true; child.stdout.destroy(); child.stderr.destroy(); finish(code, true); }, 1000);
      });
      child.on('close', code => {
        if (stdout.split(/\r?\n/).filter(Boolean).some(line => !/^[A-Z_]+=[A-Z0-9_]+$/.test(line))) invalid = true;
        finish(code, true);
      });
      deadline = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    } catch { invalid = true; finish(null, true); }
  });
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function assertExecutableReady(executable) {
  if (process.platform !== 'win32' || !path.isAbsolute(executable)) throw new Error('EXECUTABLE_PLATFORM');
  const directory = path.dirname(executable);
  if (fs.readdirSync(directory).some(name => /\.dll$/i.test(name)) ||
      ['.config', '.manifest', '.local'].some(suffix => fs.existsSync(executable + suffix))) throw new Error('EXECUTABLE_REDIRECTION');
  // Check the containing directory BEFORE the CLR can consume adjacent config.
  // This subprocess reads ACL metadata only, emits no paths/identities and is
  // bounded independently of the operator. Use .NET, without module autoload.
  const encodedPath = Buffer.from(executable, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($sid,'S-1-5-18','S-1-5-32-544');$cursor=$p;while($cursor){if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 3};$cursor=[IO.Path]::GetDirectoryName($cursor)};foreach($target in @($p,[IO.Path]::GetDirectoryName($p))){if([IO.Directory]::Exists($target)){$acl=[IO.Directory]::GetAccessControl($target)}else{$acl=[IO.File]::GetAccessControl($target)};if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid){exit 3};$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$seen=@{};foreach($r in $rules){$id=$r.IdentityReference.Value;if($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $id -notin $allowed -or $seen.ContainsKey($id)){exit 3};$seen[$id]=$true};if($rules.Count -ne 3){exit 3}};[Console]::Out.WriteLine('PASS')`;
  const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: cleanEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096 });
  if (result.error || result.signal || result.status !== 0 || result.stdout.trim() !== 'PASS' || result.stderr) throw new Error('EXECUTABLE_ACL');
}

async function main(args) {
  // No route, role, port, retry, or TLS override is accepted by this command.
  if (process.platform !== 'win32' || args.length !== 7 || args[0] !== '--execute-reviewed-reader-sync') throw new Error('SCOPE_INVALID');
  const [, executable, authorization, authorizationHash, repository, sourceCommit, relayModule] = args;
  if (Object.keys(process.env).some(key => /^PG/i.test(key) || /^(DATABASE_URL|DB_SSL)$/i.test(key))) throw new Error('AMBIENT_CONNECTION_OVERRIDE');
  if (!/^[a-f0-9]{64}$/.test(authorizationHash) || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('PIN_INVALID');
  for (const file of [executable, authorization, relayModule]) {
    if (!path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('PATH_INVALID');
  }
  if (sha256(authorization) !== authorizationHash || sha256(relayModule) !== '3fa078e139d29f756f904034f8c970797c80b6d3e185564fedecca55dd3f62aa') throw new Error('ARTIFACT_PIN_INVALID');
  const record = fs.readFileSync(authorization, 'utf8');
  const expectedExe = /^executableSha256=([a-f0-9]{64})$/m.exec(record);
  const expectedSupervisor = /^supervisorSourceSha256=([a-f0-9]{64})$/m.exec(record);
  if (!expectedExe || sha256(executable) !== expectedExe[1] || !expectedSupervisor || sha256(__filename) !== expectedSupervisor[1]) throw new Error('EXECUTION_PIN_INVALID');
  assertExecutableReady(executable);
  const { startLoopbackRelay } = require(relayModule);
  let cleaned = false;
  const relay = startLoopbackRelay({ bindAddress: '127.0.0.1', bindPort: 55432,
    targetHost: 'ballast.proxy.rlwy.net', targetPort: 33969, maxSessions: 1,
    lifetimeMs: 90000, onEvent: event => { if (event === 'CLEANUP_COMPLETE') cleaned = true; } });
  // Install failure handlers before startup; no upstream retry is possible.
  const done = relay.done.then(value => value.status === 'completed' && value.sessionsCompleted === 1, () => false);
  let result = null; let cleanup = false; let relaySucceeded = false;
  try {
    await relay.ready;
    result = await runBounded(executable, [authorization, authorizationHash, repository, sourceCommit]);
  } finally {
    const stopAndDrain = Promise.resolve().then(() => relay.stop('RELAY_OPERATOR_STOP')).catch(() => {}).then(() => done)
      .then(ok => { relaySucceeded = ok; return cleaned; });
    cleanup = await Promise.race([stopAndDrain, new Promise(resolve => setTimeout(() => resolve(false), 4000))]);
  }
  console.log('READER_SYNC=' + (result?.completed && cleanup && relaySucceeded ? 'PASS' : 'UNKNOWN_OR_STOP'));
  console.log('WORKER_TERMINATED=' + String(result?.terminated === true).toUpperCase());
  console.log('RELAY_CLEANUP=' + (cleanup ? 'PASS' : 'FAIL'));
  if (!result?.completed || !cleanup || !relaySucceeded) process.exitCode = 1;
}

module.exports = { runBounded, cleanEnvironment, assertExecutableReady };
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.log('READER_SYNC=STOP'); console.log('NO_AUTOMATIC_RETRY=TRUE'); process.exitCode = 1;
});
