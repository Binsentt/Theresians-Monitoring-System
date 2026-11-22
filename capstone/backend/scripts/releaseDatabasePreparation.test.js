const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REQUIRED_SCHEMA } = require('../database/startupSchemaReadiness');
const { RELEASE_MIGRATIONS, migrationChecksum } = require('../releaseMigrations');

const scripts = __dirname;
const read = (name) => fs.readFileSync(path.join(scripts, name), 'utf8');
const PREFLIGHT_DIAGNOSTIC_OPERATIONS = new Set([
  'preflight-entry', 'backend-root-resolution', 'validator-module-path-check',
  'security-module-import', 'get-acl-command-resolution', 'validator-module-import',
  'repository-root-lookup', 'ambient-libpq-check', 'psql-path-check',
  'credential-validation', 'server-address-validation', 'source-head-lookup',
  'source-head-comparison', 'reviewed-input-cleanliness',
  'credential-repository-root-validation',
  'passfile-path-reparse-validation', 'passfile-existence-validation',
  'passfile-attributes-validation', 'passfile-parent-reparse-validation',
  'passfile-parent-acl-validation', 'passfile-file-acl-validation',
  'passfile-resolved-path-validation', 'service-file-path-reparse-validation',
  'service-file-existence-validation', 'service-file-attributes-validation',
  'service-file-parent-reparse-validation', 'service-file-parent-acl-validation',
  'service-file-file-acl-validation', 'service-file-resolved-path-validation',
  'passfile-readability', 'service-file-readability', 'service-configuration-validation',
  'restricted-acl-get-acl', 'restricted-acl-current-identity',
  'restricted-acl-owner-retrieval', 'restricted-acl-rule-enumeration',
  'restricted-acl-grant-verification',
]);
const parsePreflightDiagnosticTrace = (output = '') => {
  const stack = [];
  let markerCount = 0;
  let lastCompletedOperation = 'none';
  let invalidReason = null;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.includes('TQ_PREFLIGHT_STAGE:')) continue;
    const match = line.match(/^TQ_PREFLIGHT_STAGE:(begin|complete):([a-z0-9-]+)$/);
    if (!match) { invalidReason = 'malformed'; break; }
    const [, phase, operation] = match;
    if (!PREFLIGHT_DIAGNOSTIC_OPERATIONS.has(operation)) { invalidReason = 'unknown-operation'; break; }
    markerCount += 1;
    if (phase === 'begin') {
      stack.push(operation);
    } else if (stack.at(-1) !== operation) {
      invalidReason = 'out-of-order';
      break;
    } else {
      stack.pop();
      lastCompletedOperation = operation;
    }
  }
  const stageTraceValid = markerCount > 0 && invalidReason === null;
  return {
    markerCount,
    lastCompletedOperation,
    currentOperation: stageTraceValid ? (stack.at(-1) || 'none') : 'none',
    stageTraceValid,
    traceComplete: stageTraceValid && stack.length === 0,
    invalidReason: invalidReason || (markerCount === 0 ? 'missing' : 'none'),
  };
};

test('preflight diagnostic parser accepts complete and partial fixed-stage traces', () => {
  const complete = parsePreflightDiagnosticTrace([
    'TQ_PREFLIGHT_STAGE:begin:preflight-entry',
    'TQ_PREFLIGHT_STAGE:complete:preflight-entry',
    'TQ_PREFLIGHT_STAGE:begin:source-head-comparison',
    'TQ_PREFLIGHT_STAGE:complete:source-head-comparison',
  ].join('\n'));
  assert.deepEqual(complete, {
    markerCount: 4,
    lastCompletedOperation: 'source-head-comparison',
    currentOperation: 'none',
    stageTraceValid: true,
    traceComplete: true,
    invalidReason: 'none',
  });

  const partial = parsePreflightDiagnosticTrace([
    'TQ_PREFLIGHT_STAGE:begin:credential-validation',
    'TQ_PREFLIGHT_STAGE:begin:passfile-file-acl-validation',
    'TQ_PREFLIGHT_STAGE:begin:restricted-acl-get-acl',
  ].join('\n'));
  assert.equal(partial.stageTraceValid, true);
  assert.equal(partial.traceComplete, false);
  assert.equal(partial.lastCompletedOperation, 'none');
  assert.equal(partial.currentOperation, 'restricted-acl-get-acl');
});

test('preflight diagnostic parser rejects missing, malformed, unknown, and out-of-order traces safely', () => {
  assert.deepEqual(parsePreflightDiagnosticTrace('ordinary error output'), {
    markerCount: 0,
    lastCompletedOperation: 'none',
    currentOperation: 'none',
    stageTraceValid: false,
    traceComplete: false,
    invalidReason: 'missing',
  });
  for (const trace of [
    'TQ_PREFLIGHT_STAGE:begin:credential-validation extra=private-path',
    'TQ_PREFLIGHT_STAGE:begin:unrecognized-stage',
    'TQ_PREFLIGHT_STAGE:begin:credential-validation\nTQ_PREFLIGHT_STAGE:complete:passfile-readability',
  ]) {
    const summary = parsePreflightDiagnosticTrace(trace);
    assert.equal(summary.stageTraceValid, false);
    assert.equal(summary.traceComplete, false);
    assert.equal(JSON.stringify(summary).includes('private-path'), false);
  }
});

test('preflight diagnostic parser handles LF and CRLF without retaining arbitrary output', () => {
  const lf = 'TQ_PREFLIGHT_STAGE:begin:preflight-entry\nTQ_PREFLIGHT_STAGE:complete:preflight-entry\n';
  assert.deepEqual(parsePreflightDiagnosticTrace(lf), parsePreflightDiagnosticTrace(lf.replace(/\n/g, '\r\n')));
  const rawOutput = `${lf}password=must-not-be-reported\nC:\\private\\passfile`;
  assert.doesNotMatch(JSON.stringify(parsePreflightDiagnosticTrace(rawOutput)), /password|must-not-be-reported|private|passfile/i);
});

test('preflight diagnostic markers are opt-in, fixed-label, and cover the guarded startup path', () => {
  const script = read('run-release-preflight.ps1');
  const validation = read('backupRestoreRehearsal.validation.psm1');
  for (const source of [script, validation]) {
    assert.match(source, /\$env:TQ_RELEASE_PREFLIGHT_DIAGNOSTICS\s+-ceq\s+'1'/);
    assert.match(source, /\[Console\]::Error\.WriteLine\(/);
    assert.match(source, /\[Console\]::Error\.Flush\(\)/);
  }
  for (const operation of [
    'security-module-import', 'get-acl-command-resolution', 'validator-module-import',
    'repository-root-lookup', 'ambient-libpq-check', 'psql-path-check',
    'credential-validation', 'server-address-validation', 'source-head-lookup',
    'source-head-comparison', 'reviewed-input-cleanliness',
  ]) {
    assert.match(script, new RegExp(`-Operation '${operation}'`));
  }
  for (const operation of [
    'credential-repository-root-validation', 'passfile-path-reparse-validation',
    'service-file-path-reparse-validation', 'passfile-parent-acl-validation',
    'service-file-file-acl-validation', 'passfile-readability',
    'service-file-readability', 'service-configuration-validation',
    'restricted-acl-get-acl', 'restricted-acl-current-identity',
    'restricted-acl-owner-retrieval', 'restricted-acl-rule-enumeration',
    'restricted-acl-grant-verification',
  ]) {
    assert.ok(validation.includes(`'${operation}'`), `missing sanitized stage ${operation}`);
  }
  for (const source of [script, validation]) {
    const helper = source.match(/function Write-PreflightDiagnosticStage \{([\s\S]*?)\n\}/);
    assert.ok(helper, 'diagnostic helper should be defined');
    assert.doesNotMatch(helper[1], /\$Path|\$sid|\$Expected|\$passfile|\$serviceText|Exception/i,
      'diagnostic marker content must not include paths, identities, credentials, or exception text');
  }
});

const readIsolatedBackendWorkflow = (
  workflowPathOverride = process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH
) => {
  const hasOverride = workflowPathOverride !== undefined;
  if (hasOverride && !workflowPathOverride.trim()) {
    throw new Error('STUDENT_PROGRESS_CI_WORKFLOW_PATH is configured but empty.');
  }

  const workflowPathCandidates = hasOverride
    ? [path.resolve(workflowPathOverride)]
    : [
      path.resolve(scripts, '../../../.github/workflows/backend-network-isolated.yml'),
      path.resolve(scripts, '../../.github/workflows/backend-network-isolated.yml'),
    ];
  const readErrors = [];
  let lastError = null;

  for (const workflowPath of workflowPathCandidates) {
    try {
      return fs.readFileSync(workflowPath, 'utf8');
    } catch (error) {
      lastError = error;
      readErrors.push('"' + workflowPath + '": ' + error.message);
    }
  }

  const source = hasOverride
    ? 'STUDENT_PROGRESS_CI_WORKFLOW_PATH override "' + workflowPathOverride + '"'
    : 'repository-relative backend workflow candidates';
  throw new Error('Unable to read ' + source + ' (' + readErrors.join('; ') + ')', { cause: lastError });
};

test('read-only preflight audit is fixed to catalog and migration-ledger metadata', () => {
  const sql = read('release-preflight-role-audit.sql');
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.match(sql, /statement_timeout\s*=\s*'10s'/i);
  assert.match(sql, /lock_timeout\s*=\s*'2s'/i);
  assert.match(sql, /tq_release_preflight_reader/);
  assert.match(sql, /schema_migrations/);
  assert.match(sql, /application_relation_select_count/);
  assert.match(sql, /has_column_privilege/);
  assert.match(sql, /^\\echo Preflight role audit counts: .*role_membership_count=:role_membership_count\r?$/m);
  assert.match(sql, /has_any_column_privilege/);
  assert.match(sql, /extra_ledger_column_select_count/);
  assert.match(sql, /executable_security_definer_function_count/);
  assert.match(sql, /ROLLBACK/i);
  assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|CREATE\b|ALTER\b|DROP\b)/im);
  assert.doesNotMatch(sql, /SELECT\s+.+\s+FROM\s+public\.(?:accounts|game_results|playtime_sessions)\b/is);
});

test('Windows preflight utility uses a service alias, rejects inline passwords, and gates source/identity', () => {
  const script = read('run-release-preflight.ps1');
  const validation = read('backupRestoreRehearsal.validation.psm1');
  assert.match(script, /tq_release_preflight_reader/);
  assert.match(script, /PGPASSWORD/);
  assert.match(script, /-w/);
  assert.match(script, /service=/);
  assert.match(script, /ExpectedSourceCommit/);
  assert.match(script, /\[Parameter\(Mandatory\s*=\s*\$true\)\][\s\S]*?\[ValidatePattern\('\^\[0-9a-fA-F\]\{40\}\$'\)\][\s\S]*?\[string\]\$ExpectedSourceCommit/);
  assert.doesNotMatch(script, /\$ExpectedSourceCommit\s*=\s*['"]/);
  assert.match(script, /sourceHead\s+-ne\s+\$ExpectedSourceCommit/);
  assert.match(script, /reviewed preflight files or migrations are modified\/untracked/);
  assert.match(script, /release-preflight-role-audit\.sql/);
  assert.match(script, /release-migration-026-prerequisite-preflight\.sql/);
  assert.match(script, /release-migration-preflight\.sql/);
  assert.match(script, /PreMigration026/);
  assert.match(script, /PostMigration026/);
  assert.match(script, /Assert-ReviewedPreflightCredentialFiles/);
  assert.match(script, /Assert-InteractiveAuthenticationEnvironment/);
  const securityModuleImport = script.indexOf("Import-Module -Name Microsoft.PowerShell.Security -ErrorAction Stop");
  const validationModuleImport = script.indexOf('Import-Module $validationModule -Force');
  assert.ok(securityModuleImport >= 0 && securityModuleImport < validationModuleImport,
    'PowerShell security cmdlets must be explicitly loaded before the validator module');
  assert.match(script, /Get-Command -Name Get-Acl -CommandType Cmdlet -ErrorAction Stop/);
  assert.ok(script.includes("$getAclCommand.ModuleName -ne 'Microsoft.PowerShell.Security'"));
  assert.match(validation, /function Assert-ReviewedPreflightCredentialFiles/);
  assert.match(validation, /function Assert-NoReparsePointPath/);
  assert.match(validation, /function Assert-RestrictedStorageAcl/);
  assert.match(validation, /function Assert-PostgresServiceConfiguration/);
  assert.ok(script.indexOf('Assert-ReviewedPreflightCredentialFiles') < script.indexOf('& $PsqlPath'),
    'credential path, ACL, and service validation must run before any psql invocation');
  assert.doesNotMatch(script, /Write-(?:Output|Host)[^\r\n]*(?:Passfile|ServiceFile|serviceContents)/i,
    'credential paths or service contents must not be printed');
});

test('PowerShell preflight accepts only an explicit matching source SHA before the psql stub', {
  skip: process.platform !== 'win32',
}, (t) => {
  const scriptPath = path.join(scripts, 'run-release-preflight.ps1');
  const repositoryRoot = path.resolve(scripts, '../../..');
  const powershellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-preflight-source-sha-'));
  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));

  const passfile = path.join(tempDirectory, 'pgpass.conf');
  const serviceFile = path.join(tempDirectory, 'pg_service.conf');
  const callMarker = path.join(tempDirectory, 'psql-stub-calls.txt');
  const psqlStub = path.join(tempDirectory, 'psql-stub.cmd');
  fs.writeFileSync(passfile, '', 'utf8');
  fs.writeFileSync(serviceFile, '[tq_release_preflight]\nhost=127.0.0.1\nport=5432\ndbname=fixture\nuser=tq_release_preflight_reader\n', 'utf8');
  fs.writeFileSync(psqlStub, `@echo invoked>>"${callMarker}"\r\n@exit /b 0\r\n`, 'utf8');

  const childEnv = Object.fromEntries(
    ['PATH', 'PATHEXT', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'COMSPEC', 'TEMP', 'TMP']
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  childEnv.PSModulePath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'Modules',
  );

  const invokePowerShellScript = (script) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const startedAt = Date.now();
    const result = spawnSync(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', env: childEnv, timeout: 15000,
    });
    const stages = [...String(result.stdout || '').matchAll(/PR48_STAGE:(begin|complete):([a-z0-9-]+)/gi)]
      .map(([, phase, operation]) => ({ phase: phase.toLowerCase(), operation }));
    const completedOperations = stages.filter(({ phase }) => phase === 'complete').map(({ operation }) => operation);
    const stageTrace = stages.map(({ phase, operation }) => `${phase}:${operation}`).join('>') || 'none';
    const observation = {
      ...result,
      elapsedMs: Date.now() - startedAt,
      completedOperations,
      stageTrace,
      lastObservedStage: stages.length ? `${stages.at(-1).phase}:${stages.at(-1).operation}` : 'none',
      lastCompletedOperation: completedOperations.at(-1) || 'none (PowerShell startup or first operation)',
    };
    if (process.env.TQ_WINDOWS_ACL_DIAGNOSTICS === '1') {
      process.stderr.write(`[pr48-acl-fixture] elapsedMs=${observation.elapsedMs}; status=${String(observation.status)}; signal=${observation.signal || 'none'}; errorCode=${observation.error?.code || 'none'}; lastCompletedOperation=${observation.lastCompletedOperation}; lastObservedStage=${observation.lastObservedStage}; stageTrace=${stageTrace}\n`);
    }
    return observation;
  };
  const powerShellDiagnostic = (result) => [
    `elapsedMs=${result.elapsedMs}`,
    `status=${String(result.status)}`,
    `signal=${result.signal || 'none'}`,
    `errorCode=${result.error?.code || 'none'}`,
    `lastCompletedOperation=${result.lastCompletedOperation || 'not instrumented'}`,
    `lastObservedStage=${result.lastObservedStage || 'not instrumented'}`,
    `stageTrace=${result.stageTrace || 'none'}`,
  ].join('; ');

  const protectSyntheticPath = (target, isDirectory) => {
    const escapedTarget = target.replace(/'/g, "''");
    const inheritance = isDirectory ? '(OI)(CI)' : '';
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'function Write-FixtureStage([string]$Phase, [string]$Operation) { [Console]::Out.WriteLine("PR48_STAGE:${Phase}:${Operation}"); [Console]::Out.Flush() }',
      'Write-FixtureStage complete powershell-startup',
      `$target = '${escapedTarget}'`,
      'Write-FixtureStage begin identity-lookup',
      "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      'Write-FixtureStage complete identity-lookup',
      'Write-FixtureStage begin icacls-inheritance',
      '& icacls.exe $target /inheritance:r | Out-Null',
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      'Write-FixtureStage complete icacls-inheritance',
      `$grants = @("*$($sid):${inheritance}F", "*S-1-5-18:${inheritance}F", "*S-1-5-32-544:${inheritance}F")`,
      'Write-FixtureStage begin icacls-grant',
      '& icacls.exe $target /grant:r $grants | Out-Null',
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      'Write-FixtureStage complete icacls-grant',
      'Write-FixtureStage begin module-import',
      `Import-Module '${path.join(scripts, 'backupRestoreRehearsal.validation.psm1').replace(/'/g, "''")}' -Force`,
      'Write-FixtureStage complete module-import',
      'Write-FixtureStage begin security-module-load',
      "Import-Module -Name Microsoft.PowerShell.Security -ErrorAction Stop",
      'Write-FixtureStage complete security-module-load',
      'Write-FixtureStage begin get-acl-command-resolution',
      "if ((Get-Command -Name Get-Acl -CommandType Cmdlet -ErrorAction Stop).ModuleName -ne 'Microsoft.PowerShell.Security') { throw 'storage-acl-command-unavailable' }",
      'Write-FixtureStage complete get-acl-command-resolution',
      'Write-FixtureStage begin restricted-acl-assertion',
      'Assert-RestrictedStorageAcl -Path $target',
      'Write-FixtureStage complete restricted-acl-assertion',
    ].join('\n');
    const result = invokePowerShellScript(script);
    assert.equal(result.status, 0,
      `${path.basename(target)} ACL fixture setup failed: ${powerShellDiagnostic(result)}`);
  };
  protectSyntheticPath(tempDirectory, true);
  protectSyntheticPath(passfile, false);
  protectSyntheticPath(serviceFile, false);

  const sourceResult = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(sourceResult.status, 0, sourceResult.stderr);
  const currentSourceSha = sourceResult.stdout.trim();
  const baseArguments = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
    '-ServiceName', 'tq_release_preflight',
    '-ExpectedDatabase', 'fixture',
    '-ExpectedServerAddress', '127.0.0.1',
    '-ExpectedServerPort', '5432',
    '-PassfilePath', passfile,
    '-ServiceFilePath', serviceFile,
    '-PsqlPath', psqlStub,
  ];
  const invoke = (sha, extraEnvironment = {}, { serviceFilePath } = {}) => {
    const args = sha === undefined ? [...baseArguments] : [...baseArguments, '-ExpectedSourceCommit', sha];
    if (serviceFilePath) args[args.indexOf('-ServiceFilePath') + 1] = serviceFilePath;
    const startedAt = Date.now();
    const result = spawnSync(
      powershellPath,
      args,
      { encoding: 'utf8', env: { ...childEnv, ...extraEnvironment }, timeout: 15000 },
    );
    const elapsedMs = Date.now() - startedAt;
    const timedOut = result.error?.code === 'ETIMEDOUT';
    const trace = parsePreflightDiagnosticTrace(result.stderr || '');
    return {
      ...result,
      elapsedMs,
      timedOut,
      exitCode: result.status,
      outputComplete: !timedOut && !result.error,
      trace,
    };
  };
  const outputOf = (result) => `${result.stdout || ''}\n${result.stderr || ''}`;
  const diagnosticSummary = (result) => [
    `lastCompletedOperation=${result.trace.lastCompletedOperation}`,
    `currentOperation=${result.trace.currentOperation}`,
    `markerCount=${result.trace.markerCount}`,
    `stageTraceValid=${result.trace.stageTraceValid}`,
    `traceComplete=${result.trace.traceComplete}`,
    `elapsedMs=${result.elapsedMs}`,
    `timedOut=${result.timedOut}`,
    `exitCode=${String(result.exitCode)}`,
    `signal=${result.signal || 'none'}`,
    `outputComplete=${result.outputComplete}`,
    `errorCode=${result.error?.code || 'none'}`,
  ].join('; ');

  const missingSha = invoke(undefined);
  assert.notEqual(missingSha.status, 0);
  assert.match(outputOf(missingSha), /ExpectedSourceCommit|Mandatory/i);

  const malformedSha = invoke('not-a-commit');
  assert.notEqual(malformedSha.status, 0);
  assert.match(outputOf(malformedSha), /ExpectedSourceCommit|ValidatePattern/i);

  const mismatchedSha = invoke('0000000000000000000000000000000000000000', {
    TQ_RELEASE_PREFLIGHT_DIAGNOSTICS: '1',
  });
  assert.notEqual(mismatchedSha.status, 0);
  assert.equal(mismatchedSha.timedOut, false,
    `source mismatch must fail before the timeout: ${diagnosticSummary(mismatchedSha)}`);
  assert.ok(mismatchedSha.outputComplete && mismatchedSha.exitCode !== null,
    `source mismatch should return a completed process result: ${diagnosticSummary(mismatchedSha)}`);
  assert.ok(/HEAD does not match the approved commit/i.test(outputOf(mismatchedSha)),
    `the preflight must report its expected source mismatch: ${diagnosticSummary(mismatchedSha)}`);
  assert.equal(mismatchedSha.trace.stageTraceValid, true,
    `the opt-in trace must contain only recognized, ordered markers: ${diagnosticSummary(mismatchedSha)}`);
  assert.equal(mismatchedSha.trace.traceComplete, false,
    'the failing source comparison should remain the current incomplete operation');
  assert.equal(mismatchedSha.trace.currentOperation, 'source-head-comparison', diagnosticSummary(mismatchedSha));
  assert.equal(mismatchedSha.trace.lastCompletedOperation, 'source-head-lookup', diagnosticSummary(mismatchedSha));
  assert.equal(fs.existsSync(callMarker), false, 'a SHA mismatch must stop before invoking psql');

  fs.rmSync(passfile);
  const missingPassfile = invoke(currentSourceSha);
  assert.notEqual(missingPassfile.status, 0);
  assert.match(outputOf(missingPassfile), /PGPASSFILE file is missing/i);
  assert.equal(fs.existsSync(callMarker), false, 'missing credential files must stop before invoking psql');
  fs.writeFileSync(passfile, '', 'utf8');
  protectSyntheticPath(passfile, false);

  const unsafeEnvironment = invoke(currentSourceSha, { PGUSER: 'postgres' });
  assert.notEqual(unsafeEnvironment.status, 0);
  assert.match(outputOf(unsafeEnvironment), /PGUSER.*override/i);
  assert.equal(fs.existsSync(callMarker), false, 'ambient connection overrides must stop before invoking psql');

  const serviceSettings = fs.readFileSync(serviceFile, 'utf8');
  fs.writeFileSync(serviceFile, `${serviceSettings}options=-c role=postgres\n`, 'utf8');
  const unsafeService = invoke(currentSourceSha);
  assert.notEqual(unsafeService.status, 0);
  assert.match(outputOf(unsafeService), /unsafe|unsupported setting/i);
  assert.equal(fs.existsSync(callMarker), false, 'unsafe service settings must stop before invoking psql');
  fs.writeFileSync(serviceFile, serviceSettings, 'utf8');
  protectSyntheticPath(serviceFile, false);

  const broadAclScript = [
    `$target = '${serviceFile.replace(/'/g, "''")}'`,
    '& icacls.exe $target /grant "*S-1-5-11:R" | Out-Null',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\n');
  const broadAclEncoded = Buffer.from(broadAclScript, 'utf16le').toString('base64');
  const broadAclSetup = spawnSync(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', broadAclEncoded], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(broadAclSetup.status, 0, broadAclSetup.stderr || broadAclSetup.stdout);
  const broadAcl = invoke(currentSourceSha);
  assert.notEqual(broadAcl.status, 0);
  assert.match(outputOf(broadAcl), /ACL grants access to an unapproved identity/i);
  assert.equal(fs.existsSync(callMarker), false, 'broad ACLs must stop before invoking psql');
  const removeBroadAcl = invokePowerShellScript([
    `$target = '${serviceFile.replace(/'/g, "''")}'`,
    '& icacls.exe $target /remove:g "*S-1-5-11" | Out-Null',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\n'));
  assert.equal(removeBroadAcl.status, 0, powerShellDiagnostic(removeBroadAcl));
  protectSyntheticPath(serviceFile, false);

  const junction = path.join(tempDirectory, 'credential-junction');
  const junctionResult = spawnSync(powershellPath, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `New-Item -ItemType Junction -Path '${junction.replace(/'/g, "''")}' -Target '${tempDirectory.replace(/'/g, "''")}' | Out-Null`,
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(junctionResult.status, 0, junctionResult.stderr || junctionResult.stdout);
  const reparsePath = invoke(currentSourceSha, {}, {
    serviceFilePath: path.join(junction, path.basename(serviceFile)),
  });
  assert.notEqual(reparsePath.status, 0);
  assert.match(outputOf(reparsePath), /reparse|symbolic link|junction/i);
  assert.equal(fs.existsSync(callMarker), false, 'reparse paths must stop before invoking psql');

  const matchingSha = invoke(currentSourceSha);
  const matchingOutput = outputOf(matchingSha);
  assert.doesNotMatch(matchingOutput, /HEAD does not match the approved commit/i);
  if (/reviewed preflight files or migrations are modified\/untracked/i.test(matchingOutput)) {
    assert.notEqual(matchingSha.status, 0, 'dirty reviewed inputs must still fail closed');
    assert.equal(fs.existsSync(callMarker), false);
  } else {
    assert.equal(matchingSha.status, 0, matchingOutput);
    assert.equal(fs.readFileSync(callMarker, 'utf8').trim().split(/\r?\n/).length, 2,
      'the matching SHA path should invoke only the harmless psql stub twice');
  }
});

test('pre-migration 026 SQL matches current source metadata and stays metadata-only/read-only', () => {
  const sql = read('release-migration-026-prerequisite-preflight.sql');
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.match(sql, /SET LOCAL statement_timeout = '10s'/i);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/i);
  assert.match(sql, /ROLLBACK/i);
  assert.match(sql, /migration 024 is pending/i);
  assert.match(sql, /migration 026 is the expected pending migration/i);
  assert.match(sql, /partial or incompatible migration 026 objects exist/i);
  assert.match(sql, /17 tables and 269 columns/i);
  assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|CREATE\b|ALTER\b|DROP\b)\b/im);
  assert.doesNotMatch(sql, /SELECT\s+.+\s+FROM\s+public\.(?:accounts|game_results|playtime_sessions)\b/is);

  const migrationSection = sql.match(/WITH expected\(version, filename, source_sha256\) AS \(\s*VALUES([\s\S]*?)\), applied/);
  assert.ok(migrationSection, 'the migration checksum manifest must be present');
  const migrationRows = [...migrationSection[1].matchAll(/\((\d+), '([^']+)', '([a-f0-9]{64})'\)/g)]
    .map(([, version, filename, checksum]) => ({
      version: Number(version),
      file: filename,
      checksum,
    }));
  const expectedMigrations = RELEASE_MIGRATIONS.map((migration) => ({
    version: migration.version,
    file: migration.file,
    checksum: migrationChecksum(fs.readFileSync(path.join(scripts, '../migrations', migration.file), 'utf8')),
  }));
  assert.deepEqual(migrationRows, expectedMigrations);

  const columnsSection = sql.match(/WITH required_columns\(table_name, column_name\) AS \(\s*VALUES([\s\S]*?)\), schema_contract/);
  assert.ok(columnsSection, 'the exact startup column manifest must be present');
  const requiredColumns = [...columnsSection[1].matchAll(/\('([^']+)', '([^']+)'\)/g)]
    .map(([, table, column]) => `${table}.${column}`)
    .sort();
  const expectedColumns = Object.entries(REQUIRED_SCHEMA)
    .filter(([table]) => table !== 'game_progress_save_commits')
    .flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`))
    .sort();
  assert.equal(expectedColumns.length, 269);
  assert.deepEqual(requiredColumns, expectedColumns);
});

test('pre-migration 026 constraint and index diagnostics use independent exact 17-table scopes', () => {
  const sql = read('release-migration-026-prerequisite-preflight.sql');
  const expectedTables = Object.keys(REQUIRED_SCHEMA)
    .filter((tableName) => tableName !== 'game_progress_save_commits')
    .sort();
  const cteStarts = [...sql.matchAll(/WITH required_tables\(table_name\) AS \(/g)]
    .map((match) => match.index);
  assert.equal(cteStarts.length, 2, 'constraint and index queries must each define a statement-local table CTE');

  const assertScopedTables = (query, label) => {
    const cte = query.match(/WITH required_tables\(table_name\) AS \(\s*VALUES([\s\S]*?)\)\s*SELECT/);
    assert.ok(cte, `${label} diagnostic must define required_tables in its own statement`);
    const tables = [...cte[1].matchAll(/\('([^']+)'\)/g)].map(([, tableName]) => tableName).sort();
    assert.equal(tables.length, 17, `${label} diagnostic must stay within the 17-table pre-migration scope`);
    assert.deepEqual(tables, expectedTables, `${label} diagnostic must use the canonical pre-migration table set`);
    assert.doesNotMatch(query, /required_columns/, `${label} diagnostic must not reference an out-of-scope column CTE`);
  };

  const constraintEnd = sql.indexOf('ORDER BY relation.relname,c.conname;', cteStarts[0]);
  assert.ok(constraintEnd > cteStarts[0]);
  const constraintQuery = sql.slice(cteStarts[0], constraintEnd + 'ORDER BY relation.relname,c.conname;'.length);
  assertScopedTables(constraintQuery, 'constraint');
  assert.match(constraintQuery, /pg_catalog\.pg_constraint/);
  assert.match(constraintQuery, /relation\.relname IN \(SELECT table_name FROM required_tables\)/);

  const indexEnd = sql.indexOf('ORDER BY tablename,indexname;', cteStarts[1]);
  assert.ok(indexEnd > cteStarts[1]);
  const indexQuery = sql.slice(cteStarts[1], indexEnd + 'ORDER BY tablename,indexname;'.length);
  assertScopedTables(indexQuery, 'index');
  assert.match(indexQuery, /pg_catalog\.pg_indexes/);
  assert.match(indexQuery, /tablename IN \(SELECT table_name FROM required_tables\)/);
});

test('configured backend workflow override is used', () => {
  const previousOverride = process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH;
  process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH = __filename;

  try {
    assert.equal(readIsolatedBackendWorkflow(), fs.readFileSync(__filename, 'utf8'));
  } finally {
    if (previousOverride === undefined) delete process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH;
    else process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH = previousOverride;
  }
});

test('configured backend workflow override fails clearly when it cannot be read', () => {
  const missingWorkflowPath = path.join(scripts, 'missing-backend-network-isolated.yml');

  assert.throws(
    () => readIsolatedBackendWorkflow(missingWorkflowPath),
    (error) => error instanceof Error
      && error.message.includes('STUDENT_PROGRESS_CI_WORKFLOW_PATH')
      && error.message.includes(missingWorkflowPath)
  );
});

test('isolated backend workflow provisions and sentinel-marks every new synthetic preflight database', () => {
  const workflow = readIsolatedBackendWorkflow();
  for (const database of [
    'tq_preflight_valid_test_ci',
    'tq_preflight_missing_ledger_test_ci',
    'tq_preflight_missing_table_test_ci',
    'tq_preflight_missing_column_test_ci',
    'tq_preflight_incompatible_type_test_ci',
    'tq_preflight_game_student_id_width_test_ci',
    'tq_preflight_malformed_ledger_test_ci',
    'tq_preflight_pending_024_test_ci',
    'tq_preflight_pending_025_test_ci',
    'tq_preflight_missing_receipt_constraint_test_ci',
    'tq_preflight_pre_026_test_ci',
    'tq_preflight_partial_receipt_026_test_ci',
    'tq_preflight_026_applied_test_ci',
    'tq_preflight_pre_024_test_ci',
    'tq_preflight_wrong_filename_ledger_test_ci',
  ]) {
    assert.equal(workflow.split(database).length - 1, 3,
      `${database} must be created and sentinel-marked in the PostgreSQL 16 and 18 jobs`);
  }
  assert.match(workflow, /--network none/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /postgres:16-bookworm/);
  assert.match(workflow, /postgres:18-bookworm/);
  assert.match(workflow, /TQ_EXPECTED_POSTGRES_MAJOR: '16'/);
  assert.match(workflow, /TQ_EXPECTED_POSTGRES_MAJOR: '18'/);
  assert.match(workflow, /test "\$image_pgdata" = "\/var\/lib\/postgresql\/18\/docker"/);
  assert.match(workflow, /--tmpfs "\/var\/lib\/postgresql:rw,nosuid,nodev,size=1g/);
  const parentProbe = workflow.match(/cat > "[^\"]*parent-route-postgres\.integration\.cjs" <<'PARENT_TEST'\r?\n([\s\S]*?)\r?\n\s+PARENT_TEST/);
  assert.ok(parentProbe, 'the disposable Parent PostgreSQL probe script must remain discoverable');
  const ledgerSetupIndex = parentProbe[1].indexOf('CREATE TABLE IF NOT EXISTS public.schema_migrations');
  const gatedMigrationIndex = parentProbe[1].indexOf('runSyntheticApprovedReleaseMigrations');
  assert.ok(ledgerSetupIndex >= 0 && ledgerSetupIndex < gatedMigrationIndex,
    'the synthetic Parent PostgreSQL probe must prepare its ledger before using the gated migration helper');
  const windowsJob = workflow.slice(workflow.indexOf('\n  windows-backup-validation:'));
  assert.match(windowsJob, /uses:\s*actions\/setup-node@v4[\s\S]*?node-version:\s*['\"]20['\"]/,
    'the Windows-only preflight integration test must run under Node 20');
  assert.match(windowsJob, /node --test ['\"]?capstone\/backend\/scripts\/releaseDatabasePreparation\.test\.js['\"]?/,
    'the Windows job must execute the psql-stub credential and source-pin regression');
});

test('disposable PostgreSQL harness exercises read-only backup audit and isolated archive restore', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(harness, /pg_dump/);
  assert.match(harness, /pg_restore/);
  assert.match(harness, /--single-transaction/);
  assert.match(harness, /--no-owner/);
  assert.match(harness, /synthetic-only-backup-probe/);
  assert.match(harness, /tq_restore_backup_test_ci/);
  assert.match(harness, /SCHEMA_READINESS_SQL/);
  assert.match(harness, /BEGIN READ ONLY;/);
  assert.match(harness, /primary-key column order mismatch/);
  assert.match(harness, /foreign-key target mismatch/);
  assert.match(harness, /case-changed regular-expression literal/);
  assert.match(harness, /whitespace-changed regular-expression literal/);
  assert.match(harness, /unexpected deferrable unique constraint/);
  assert.match(harness, /unvalidated CHECK constraint/);
  assert.match(harness, /passedScenarioCount, 41/);
  assert.match(harness, /passedScenarioCount, 56/);
  assert.match(harness, /pg_restore', '--list/);
  assert.match(harness, /getSyntheticAggregateCounts\(restoreDatabase, 'tq_restore_operator'\)/);
  assert.match(harness, /GRANT SELECT \(version, filename, checksum\) ON TABLE public\.schema_migrations/);
  assert.match(harness, /tampered archive and aggregate sidecar are rejected/);
  assert.match(harness, /assertCiContainer\(\)/);
});

test('disposable preflight databases remove inherited PUBLIC TEMP and test rejection plus restoration', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  const databaseSetup = harness.match(/for \(const \[mode, database\] of Object\.entries\(CASES\)\) \{([\s\S]*?)\n\}/);
  assert.ok(databaseSetup, 'all fixed disposable databases must share the restricted setup');
  const revokeTempAt = databaseSetup[1].indexOf('REVOKE TEMP ON DATABASE ${database} FROM PUBLIC;');
  const grantConnectAt = databaseSetup[1].indexOf('GRANT CONNECT ON DATABASE ${database} TO ${ROLE};');
  assert.ok(revokeTempAt >= 0 && grantConnectAt > revokeTempAt, 'revoke PUBLIC TEMP before role audit setup');

  const grantAt = harness.indexOf('const grantPublicTemp');
  const auditAt = harness.indexOf('const publicTempRoleAudit', grantAt);
  const revokeAt = harness.indexOf('const revokePublicTemp =', auditAt);
  const restoredAuditAt = harness.indexOf('const restoredPublicTempAudit', revokeAt);
  assert.ok(grantAt >= 0 && auditAt > grantAt && revokeAt > auditAt && restoredAuditAt > revokeAt,
    'the test must reject inherited TEMP, revoke it, then confirm the valid role audit is restored');
  assert.match(harness, /assert\.equal\(publicTempRoleAudit\.status, 3/);
  assert.match(harness, /assert\.equal\(restoredPublicTempAudit\.status, 0/);
});

test('backup fixture grants schema privileges in the disposable target database', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  const roleSetupAt = harness.indexOf("const createBackupRole = psql('postgres', 'postgres'");
  const databaseGrantsAt = harness.indexOf("const grantBackupRole = psql(CASES.valid, 'postgres'");
  const auditAt = harness.indexOf('const backupRoleAudit');
  assert.ok(roleSetupAt >= 0 && databaseGrantsAt > roleSetupAt && auditAt > databaseGrantsAt);
  const roleSetup = harness.slice(roleSetupAt, databaseGrantsAt);
  const databaseGrants = harness.slice(databaseGrantsAt, auditAt);
  assert.doesNotMatch(roleSetup, /GRANT (?:USAGE ON SCHEMA|SELECT ON ALL)/);
  assert.match(databaseGrants, /GRANT USAGE ON SCHEMA public TO tq_prod_backup_reader/);
  assert.match(databaseGrants, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO tq_prod_backup_reader/);
  assert.match(databaseGrants, /GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO tq_prod_backup_reader/);
});
test('backup utility has separate explicit backup and isolated-restore gates', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const sql = read('backup-role-preflight.sql');
  assert.match(script, /ExecuteApprovedProductionBackup/);
  assert.match(script, /ExecuteIsolatedRestore/);
  assert.match(script, /ExpectedSourceCommit/);
  assert.match(script, /EncryptionEvidencePath/);
  assert.match(script, /ExpectedEncryptionEvidenceSha256/);
  assert.match(script, /Assert-BackupStorageDirectory/);
  assert.doesNotMatch(script, /EncryptedStorageConfirmed/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore/);
  assert.match(script, /--single-transaction/);
  assert.match(script, /& \$PgRestorePath @restoreArgs \*>\s*\$null/, 'restore diagnostics must not stream row values to terminal logs');
  assert.match(script, /--exit-on-error/);
  assert.match(script, /restore-input\.toc\.txt/);
  assert.match(script, /backup\/preflight files or migrations are modified\/untracked/);
  assert.match(script, /pg_auth_members/);
  assert.doesNotMatch(script, /--clean\b|--create\b/i);
  assert.match(script, /tq_prod_backup/);
  assert.match(script, /tq_restore_/);
  assert.match(sql, /unreadable_relation_count/);
  assert.match(sql, /row_security_relation_count/);
  assert.match(sql, /^\\echo Backup-role catalog counts: .*foreign_table_count=:foreign_table_count\r?$/m);
  assert.match(sql, /relation_write_privilege_count/);
  assert.match(sql, /rolinherit/);
  assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|CREATE\b|ALTER\b|DROP\b)/im);
  assert.doesNotMatch(sql, /SELECT\s+.+\s+FROM\s+public\.(?:accounts|game_results|playtime_sessions)\b/is);
});

test('migration 026 remains additive and runner accepts only the exact approved pending list', () => {
  const migration = fs.readFileSync(path.join(scripts, '../migrations/026_game_progress_save_commit_idempotency.sql'), 'utf8');
  const runner = fs.readFileSync(path.join(scripts, 'run-approved-release-migrations.js'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.game_progress_save_commits/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|DROP\b)/im);
  assert.match(runner, /assertExactVersions\(actualVersions, plan\.expectedVersions\)/);
  assert.match(runner, /database migration filename does not match this source revision/);
  assert.match(runner, /database migration checksum does not match this source revision/);
  assert.match(runner, /migration 024/i);
});

test('offline backup rehearsal pins source, forces interactive auth, and validates mode-specific snapshots', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const validation = read('backupRestoreRehearsal.validation.psm1');

  assert.match(script, /Set-StrictMode\s+-Version\s+Latest/);
  assert.match(script, /\[Parameter\(Mandatory=\$true\)\]\[string\]\$ExpectedSourceCommit/);
  assert.doesNotMatch(script, /\$ExpectedSourceCommit\s*=/);
  assert.match(script, /ValidateSet\('PreMigration026','PostMigration026'\)/);
  assert.match(script, /Assert-ApprovedRecoverySource/);
  assert.match(script, /Assert-ReleaseMigrationLedger/);
  assert.match(script, /Assert-ReceiptSchemaState/);
  assert.match(script, /release-preflight-role-audit\.sql/);
  assert.match(script, /NOT\s+t\.tgisinternal/i, 'receipt validation must ignore PostgreSQL internal FK triggers');
  assert.doesNotMatch(script, /relkind\s+NOT\s+IN\s*\('i','I'\)/i, 'pre-026 receipt scan must include named index relations');
  assert.match(script, /pg_catalog\.pg_type[\s\S]*?typrelid=0/, 'restore target preflight must detect standalone user-defined types');
  assert.match(script, /rolreplication/, 'restore target role must not have replication privilege');
  assert.match(script, /--password/);
  assert.doesNotMatch(script, /--no-password/);
  assert.doesNotMatch(script, /\$env:PGPASSWORD\s*=/);
  assert.doesNotMatch(script, /\$env:PGPASSFILE\s*=/);
  assert.match(script, /--snapshot=\$SnapshotId/);
  assert.match(script, /ExpectedAggregateManifestSha256/);
  assert.match(script, /Assert-IsolatedRestoreTarget/);
  assert.match(script, /return \$fields/);
  assert.doesNotMatch(script, /return ,\$fields/);
  assert.match(script, /--single-transaction/);
  assert.doesNotMatch(script, /--clean\b|--create\b/i);
  assert.doesNotMatch(script, /\$Variables\b/, 'psql wrapper must not use an undefined variables collection');
  assert.match(script, /\$tocFinal="\$archive\.toc\.txt"/, 'completed TOC path must be checked before writing');
  assert.match(script, /foreach\(\$path in @\(\$archive,\$partial,\$tocPartial,\$tocFinal/);

  const tableBlock = validation.match(/\$script:AggregateTables\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(tableBlock, 'aggregate table allowlist must be explicit');
  const tables = [...tableBlock[1].matchAll(/'([^']+)'/g)].map(([, table]) => table);
  assert.deepEqual(tables, Object.keys(REQUIRED_SCHEMA).filter((table) => table !== 'game_progress_save_commits'));
  assert.match(validation, /SET TRANSACTION SNAPSHOT '\$SnapshotId'/);
  const aggregateBuilderStart = validation.indexOf('function New-BackupAggregateSql');
  assert.notEqual(aggregateBuilderStart, -1, 'aggregate SQL builder must exist');
  const aggregateBuilder = validation.slice(aggregateBuilderStart);
  assert.doesNotMatch(aggregateBuilder, /SELECT\s+\*|student_id|student_name|question_text|answer_text|email/i);
  assert.match(validation, /duplicate migration ledger filename/);
});

test('backup and migration preflight role audits reject column-level write grants', () => {
  for (const name of ['backup-role-preflight.sql', 'release-migration-preflight.sql']) {
    const sql = read(name);
    assert.match(sql, /has_any_column_privilege\([^\n]+,\s*'INSERT'\)/i, `${name} must reject column INSERT grants`);
    assert.match(sql, /has_any_column_privilege\([^\n]+,\s*'UPDATE'\)/i, `${name} must reject column UPDATE grants`);
    assert.match(sql, /has_any_column_privilege\([^\n]+,\s*'REFERENCES'\)/i, `${name} must reject column REFERENCES grants`);
  }
});
