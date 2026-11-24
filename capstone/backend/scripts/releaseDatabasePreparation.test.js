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

function createRestrictedWindowsPowerShellEnvironment(powershellPath, sourceEnv = process.env) {
  const allowedNames = [
    'PATH', 'PATHEXT', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'COMSPEC', 'TEMP', 'TMP',
  ];
  const childEnv = Object.fromEntries(
    allowedNames.filter((name) => sourceEnv[name]).map((name) => [name, sourceEnv[name]]),
  );
  const systemModuleRoots = [
    path.win32.join(path.win32.dirname(powershellPath), 'Modules'),
    path.win32.join(sourceEnv.ProgramFiles || String.raw`C:\Program Files`, 'WindowsPowerShell', 'Modules'),
  ];
  childEnv.PSModulePath = systemModuleRoots.join(path.win32.delimiter);
  return childEnv;
}

function describePowerShellResult(result, elapsedMs) {
  return `status=${result.status} signal=${result.signal || 'none'} errorCode=${result.error?.code || 'none'} elapsedMs=${elapsedMs}`;
}

function readIsolatedBackendWorkflow() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'STUDENT_PROGRESS_CI_WORKFLOW_PATH')) {
    const configuredPath = process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH;
    if (!configuredPath) {
      throw new Error('STUDENT_PROGRESS_CI_WORKFLOW_PATH is explicitly configured but empty');
    }
    try {
      return fs.readFileSync(configuredPath, 'utf8');
    } catch (error) {
      throw new Error(`STUDENT_PROGRESS_CI_WORKFLOW_PATH is missing or unreadable: ${configuredPath}`, { cause: error });
    }
  }

  const localCandidates = [
    path.resolve(scripts, '../../../.github/workflows/backend-network-isolated.yml'),
    path.resolve(scripts, '../../.github/workflows/backend-network-isolated.yml'),
  ];
  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch (error) {
        throw new Error(`repository-relative backend workflow is unreadable: ${candidate}`, { cause: error });
      }
    }
  }
  throw new Error(`backend-network-isolated.yml was not found at repository-relative paths: ${localCandidates.join(', ')}`);
}

function withWorkflowPath(value, callback) {
  const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, 'STUDENT_PROGRESS_CI_WORKFLOW_PATH');
  const previous = process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH;
  try {
    if (value === undefined) delete process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH;
    else process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH = value;
    return callback();
  } finally {
    if (hadPrevious) process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH = previous;
    else delete process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH;
  }
}

test('read-only preflight audit is fixed to catalog and migration-ledger metadata', () => {
  const sql = read('release-preflight-role-audit.sql');
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.match(sql, /statement_timeout\s*=\s*'10s'/i);
  assert.match(sql, /lock_timeout\s*=\s*'2s'/i);
  assert.match(sql, /tq_release_preflight_reader/);
  assert.match(sql, /schema_migrations/);
  assert.match(sql, /application_relation_select_count/);
  assert.match(sql, /has_column_privilege/);
  assert.match(sql, /extra_ledger_column_select_count/);
  assert.match(sql, /executable_security_definer_function_count/);
  assert.match(sql, /ROLLBACK/i);
  assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|CREATE\b|ALTER\b|DROP\b)/im);
  assert.doesNotMatch(sql, /SELECT\s+.+\s+FROM\s+public\.(?:accounts|game_results|playtime_sessions)\b/is);
});


test('Windows preflight utility uses a service alias, rejects inline passwords, and gates source/identity', () => {
  const script = read('run-release-preflight.ps1');
  const connectionValidation = read('releasePreflightConnection.validation.psm1');
  assert.match(script, /tq_release_preflight_reader/);
  assert.match(script, /Assert-TqNoAmbientPgOverrides/);
  assert.match(script, /-w/);
  assert.match(script, /service=/);
  assert.match(script, /ExpectedSourceCommit/);
  assert.match(script, /\[Parameter\(Mandatory\s*=\s*\$true\)\][\s\S]*?\[ValidatePattern\('\^\[0-9a-fA-F\]\{40\}\$'\)\][\s\S]*?\[string\]\$ExpectedSourceCommit/);
  assert.doesNotMatch(script, /\$ExpectedSourceCommit\s*=\s*['"]/);
  assert.match(script, /sourceHead\s+-ne\s+\$ExpectedSourceCommit/);
  assert.match(script, /reviewed preflight files or migrations are modified\/untracked/);
  assert.match(script, /releasePreflightConnection\.validation\.psm1/);
  assert.match(script, /Assert-TqNoAmbientPgOverrides/);
  assert.match(script, /Assert-TqPreflightConnectionFiles/);
  assert.match(script, /ExpectedTunnelPort/);
  assert.match(script, /VerifiedCaPath/);
  assert.match(script, /release-preflight-role-audit\.sql/);
  assert.match(script, /release-migration-026-prerequisite-preflight\.sql/);
  assert.match(script, /release-migration-preflight\.sql/);
  assert.match(script, /PreMigration026/);
  assert.match(script, /PostMigration026/);
  assert.match(connectionValidation, /sslmode/);
  assert.match(connectionValidation, /verify-full/);
  assert.match(connectionValidation, /hostaddr/);
  assert.match(connectionValidation, /9A84D18ED0BB44450D38DA6F35A3C4E22AD68192A0C91A2C96DD16E5C17C04DF/);
  assert.match(connectionValidation, /Assert-TqRestrictedAclRecord/);
  assert.match(connectionValidation, /AreAccessRulesProtected/);
  assert.match(connectionValidation, /ReparsePoint/);
  assert.match(connectionValidation, /Get-TqAmbientPgOverrideNames/);
  assert.doesNotMatch(connectionValidation, /PGPASSWORD\s*=/i);
});


test('restricted Windows PowerShell child environment exposes only trusted system module roots', () => {
  const powershellPath = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const sourceEnv = {
    PATH: String.raw`C:\Windows\System32`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: String.raw`C:\Windows`,
    ProgramFiles: String.raw`C:\Program Files`,
    'ProgramFiles(x86)': String.raw`C:\Program Files (x86)`,
    COMSPEC: String.raw`C:\Windows\System32\cmd.exe`,
    TEMP: String.raw`C:\Temp`,
    TMP: String.raw`C:\Temp`,
    PSModulePath: 'untrusted-user-module-path',
    PGPASSWORD: 'synthetic-only',
  };
  const childEnv = createRestrictedWindowsPowerShellEnvironment(powershellPath, sourceEnv);
  assert.equal(childEnv.PSModulePath, [
    String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`,
    String.raw`C:\Program Files\WindowsPowerShell\Modules`,
  ].join(';'));
  assert.deepEqual(Object.keys(childEnv).sort(), [
    'COMSPEC', 'PATH', 'PATHEXT', 'PSModulePath', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot', 'TEMP', 'TMP',
  ]);
  assert.doesNotMatch(childEnv.PSModulePath, /untrusted-user|PGPASSWORD|synthetic-only/i);
});


test('PowerShell service-file, TLS, environment, and ACL-record validators pass synthetic regressions', {
  skip: process.platform !== 'win32',
}, () => {
  const validationTestPath = path.join(scripts, 'releasePreflightConnection.validation.test.ps1');
  const powershellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const startedAt = Date.now();
  const result = spawnSync(powershellPath, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', validationTestPath,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    env: createRestrictedWindowsPowerShellEnvironment(powershellPath),
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 0, `${describePowerShellResult(result, elapsedMs)} ${result.stdout || ''} ${result.stderr || ''}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /PASS: 20 synthetic/);
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
  const caFile = path.join(tempDirectory, 'root.crt');
  const callMarker = path.join(tempDirectory, 'psql-stub-calls.txt');
  const psqlStub = path.join(tempDirectory, 'psql-stub.cmd');
  fs.writeFileSync(passfile, 'synthetic-only-not-a-production-credential\n', 'utf8');
  fs.writeFileSync(caFile, 'synthetic certificate fixture; no real key or credential\n', 'utf8');
  fs.writeFileSync(serviceFile, `[tq_release_preflight]\nhost=localhost\nhostaddr=127.0.0.1\nport=55432\ndbname=fixture\nuser=tq_release_preflight_reader\nsslmode=verify-full\nsslrootcert=${caFile}\n`, 'utf8');
  fs.writeFileSync(psqlStub, `@echo invoked>>"${callMarker}"\r\n@exit /b 0\r\n`, 'utf8');

  const sourceResult = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(sourceResult.status, 0, sourceResult.stderr);
  const currentSourceSha = sourceResult.stdout.trim();
  const baseArguments = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
    '-ServiceName', 'tq_release_preflight',
    '-ExpectedDatabase', 'fixture',
    '-ExpectedServerAddress', '127.0.0.1',
    '-ExpectedServerPort', '5432',
    '-ExpectedTunnelPort', '55432',
    '-PassfilePath', passfile,
    '-ServiceFilePath', serviceFile,
    '-VerifiedCaPath', caFile,
    '-PsqlPath', psqlStub,
  ];
  const childEnv = createRestrictedWindowsPowerShellEnvironment(powershellPath);

  const invoke = (sha) => {
    const startedAt = Date.now();
    const result = spawnSync(
      powershellPath,
      sha === undefined ? baseArguments : [...baseArguments, '-ExpectedSourceCommit', sha],
      { encoding: 'utf8', env: childEnv, timeout: 15000 },
    );
    return { ...result, elapsedMs: Date.now() - startedAt };
  };
  const outputOf = (result) => `${result.stdout || ''}\n${result.stderr || ''}`;

  const missingSha = invoke(undefined);
  assert.notEqual(missingSha.status, 0);
  assert.match(outputOf(missingSha), /ExpectedSourceCommit|Mandatory/i);

  const malformedSha = invoke('not-a-commit');
  assert.notEqual(malformedSha.status, 0);
  assert.match(outputOf(malformedSha), /ExpectedSourceCommit|ValidatePattern/i);

  const mismatchedSha = invoke('0000000000000000000000000000000000000000');
  assert.notEqual(mismatchedSha.status, 0);
  assert.match(outputOf(mismatchedSha), /HEAD does not match the approved commit/i,
    describePowerShellResult(mismatchedSha, mismatchedSha.elapsedMs));
  assert.equal(fs.existsSync(callMarker), false, 'a SHA mismatch must stop before invoking psql');

  const matchingSha = invoke(currentSourceSha);
  const matchingOutput = outputOf(matchingSha);
  assert.doesNotMatch(matchingOutput, /HEAD does not match the approved commit/i);
  if (/reviewed preflight files or migrations are modified\/untracked/i.test(matchingOutput)) {
    assert.notEqual(matchingSha.status, 0, 'dirty reviewed inputs must still fail closed');
    assert.equal(fs.existsSync(callMarker), false);
  } else {
    assert.notEqual(matchingSha.status, 0, 'synthetic inherited ACLs and an unpinned synthetic CA must stop before psql');
    assert.match(matchingOutput, /ACL|fingerprint|certificate|modified\/untracked/i);
    assert.equal(fs.existsSync(callMarker), false,
      'a matching source SHA cannot override protected-file, certificate-pin, or source-cleanliness gates');
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
    checksum: migrationChecksum(fs.readFileSync(path.join(scripts, '../migrations', migration.file), 'utf8').replace(/\r\n/g, '\n')),
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


test('backend workflow resolver uses the explicit override and fails closed for a missing path', () => {
  const localCandidates = [
    path.resolve(scripts, '../../../.github/workflows/backend-network-isolated.yml'),
    path.resolve(scripts, '../../.github/workflows/backend-network-isolated.yml'),
  ];
  const validOverridePath = process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH
    || localCandidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(validOverridePath, 'a valid workflow override or repository-relative workflow must be available');
  const missingPath = path.join(os.tmpdir(), `missing-backend-workflow-${process.pid}.yml`);
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-workflow-directory-'));
  try {
    const overrideText = withWorkflowPath(validOverridePath, () => readIsolatedBackendWorkflow());
    assert.match(overrideText, /name:\s*Isolated backend regression/);
    assert.throws(() => withWorkflowPath(missingPath, () => readIsolatedBackendWorkflow()),
      (error) => error.message.includes('STUDENT_PROGRESS_CI_WORKFLOW_PATH') && error.message.includes(missingPath));
    assert.throws(() => withWorkflowPath(directoryPath, () => readIsolatedBackendWorkflow()),
      (error) => error.message.includes('STUDENT_PROGRESS_CI_WORKFLOW_PATH') && error.message.includes(directoryPath));
    const localText = withWorkflowPath(undefined, () => {
      if (localCandidates.some((candidate) => fs.existsSync(candidate))) {
        return readIsolatedBackendWorkflow();
      }
      assert.throws(() => readIsolatedBackendWorkflow(), /backend-network-isolated\.yml was not found/);
      return null;
    });
    if (localText !== null) {
      assert.equal(localText, overrideText, 'local lookup must work without an environment override');
    }
  } finally {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
});


test('Windows preflight connection validators run on Node 20 under both PowerShell editions in isolated CI', () => {
  const workflow = readIsolatedBackendWorkflow().replace(/\r\n?/g, '\n');
  const job = workflow.match(/  windows-preflight-connection-validation:\n([\s\S]*?)(?=\n  [a-z0-9_-]+:\n|\n[^ \n]|$)/)?.[1];
  assert.ok(job, 'the Windows validation job must be defined as a top-level job');
  assert.match(job, /runs-on:\s*windows-2022/);
  assert.match(job, /node-version:\s*['"]20['"]/);
  assert.match(job, /powershell\.exe[\s\S]*releasePreflightConnection\.validation\.test\.ps1/i);
  assert.match(job, /pwsh[\s\S]*releasePreflightConnection\.validation\.test\.ps1/i);
  assert.match(job, /releaseDatabasePreparation\.test\.js/);
  assert.doesNotMatch(job, /\$\{\{\s*secrets\./i);
  assert.doesNotMatch(job, /\brailway\s+(?:ssh|up|deploy|restart)\b/i);
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
});


test('disposable PostgreSQL harness exercises read-only backup audit and isolated archive restore', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(harness, /pg_dump/);
  assert.match(harness, /pg_restore/);
  assert.match(harness, /--single-transaction/);
  assert.match(harness, /--no-owner/);
  assert.doesNotMatch(harness, /--no-tablespaces',\s*'-'/,
    'pg_restore must read custom archives from stdin without treating a dash as a filename');
  assert.match(harness, /backupLedgerShapeDiagnostics/);
  assert.match(harness, /BACKUP_LEDGER_SHAPE_DIAGNOSTICS/);
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
  assert.match(harness, /truncated custom-format archive must be rejected/);
  assert.match(harness, /OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED:/);
  assert.match(harness, /passedScenarioCount, 84/);
  const unexpectedInsertAt = harness.indexOf('const unexpectedMigration = psql(CASES.preMigration026');
  const unexpectedClassifiedAt = harness.indexOf(
    "assert.equal(parseBackupReleaseState(unexpectedBackupStateResult).readiness, 'UNVERIFIED');",
    unexpectedInsertAt,
  );
  const unexpectedCleanupAt = harness.indexOf('const removeUnexpectedMigration = psql(CASES.preMigration026', unexpectedClassifiedAt);
  const restoredPre026StateAt = harness.indexOf('const restoredPreMigration026State = parseBackupReleaseState', unexpectedCleanupAt);
  const backupScenarioCountAt = harness.indexOf('assert.equal(passedScenarioCount, 54', restoredPre026StateAt);
  assert.ok(unexpectedInsertAt >= 0 && unexpectedClassifiedAt > unexpectedInsertAt &&
    unexpectedCleanupAt > unexpectedClassifiedAt && restoredPre026StateAt > unexpectedCleanupAt &&
    backupScenarioCountAt > restoredPre026StateAt,
    'unexpected migration must be classified, removed from the shared synthetic template, and baseline-verified before recovery integration can reuse it');
  const cleanupBlock = harness.slice(unexpectedCleanupAt, restoredPre026StateAt);
  assert.match(cleanupBlock, /DELETE FROM public\.schema_migrations[\s\S]*WHERE version = 27[\s\S]*filename = '027_unexpected\.sql'[\s\S]*checksum = repeat\('0', 64\)[\s\S]*RETURNING version/);
  assert.match(cleanupBlock, /removeUnexpectedMigration\.stdout\.trim\(\), '27'/);
  const templateRestorationBlock = harness.slice(restoredPre026StateAt, backupScenarioCountAt);
  assert.match(templateRestorationBlock, /readiness, preSourceState\.readiness/);
  assert.match(templateRestorationBlock, /fingerprint, preSourceState\.fingerprint/);
  const restoredProbeAssertion = harness.indexOf("assert.equal(restoredProbe.stdout.trim(), 't'");
  const aggregateRestoreRecord = harness.indexOf("recordScenario('restored archive preserves synthetic content and ledger counts using aggregate-only checks')");
  const sourceStateProbe = harness.indexOf('const postSourceState', restoredProbeAssertion);
  const metadataFingerprintAssertion = harness.indexOf('assert.equal(postRestoredState.fingerprint, postSourceState.fingerprint', sourceStateProbe);
  const metadataRestoreRecord = harness.indexOf("recordScenario('restored archive matches source release readiness and catalog metadata fingerprint without comparing application rows')");
  assert.ok(
    restoredProbeAssertion >= 0 && aggregateRestoreRecord > restoredProbeAssertion &&
    sourceStateProbe > aggregateRestoreRecord && metadataFingerprintAssertion > sourceStateProbe &&
    metadataRestoreRecord > metadataFingerprintAssertion,
    'restored synthetic content and source-metadata equality must be separately recorded only after their aggregate assertions pass',
  );
  assert.match(harness, /assertCiContainer\(\)/);
});

test('large-object fixture uses an escaped psql gset command on its own line', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(harness, /AS fixture_lo_fd\r?\n\s+\\\\gset\r?\n\s+SELECT lowrite/);
  assert.doesNotMatch(harness, /AS fixture_lo_fd[ \t]+\\gset/);
});


test('recovery PostgreSQL harness reports the failed preflight gate without exposing identity values', () => {
  const harness = read('recoveryMigration026.postgres.integration.cjs');
  assert.match(harness, /client\.on\('error'/);
  assert.match(harness, /cleanupInProgress/);
  assert.match(harness, /residual-client-connections-terminated/);
  assert.match(harness, /scenario-client-error-event/);
  assert.match(harness, /CLIENT_EVENT: phase=.*database=.*sqlstate=/);
  assert.match(harness, /PREFLIGHT_STAGE: phase=.* query=.* status=.* validation=.* row_count=/);
  assert.match(harness, /PREFLIGHT_IDENTITY: failed=/);
  assert.match(harness, /PREFLIGHT_RECEIPT_CLIENT: table_absent=.*relations_absent=.*constraints_absent=.*triggers_absent=.*type_absent=/);
  assert.match(harness, /PREFLIGHT_RECEIPT_ADMIN: table_absent=.*relations_absent=.*constraints_absent=.*triggers_absent=.*type_absent=/);
  assert.match(harness, /function preflightQueryLabel\(sql\)/);
  assert.match(harness, /const label = preflightQueryLabel\(text\)/);
  assert.doesNotMatch(harness, /preflightQueryLabel\(state\.queries/);
  assert.match(harness, /preflightRecord\?\.label === 'receipt-absence'/);
  assert.match(harness, /function inspectReceiptAbsenceComponents/);
  const receiptInspector = harness.slice(
    harness.indexOf('async function inspectReceiptAbsenceComponents'),
    harness.indexOf('async function queryReceiptCatalog'),
  );
  assert.match(receiptInspector, /queryAdmin\(database, RECEIPT_ABSENCE_COMPONENTS_SQL\)/);
  const receiptSqlStart = harness.indexOf('const RECEIPT_ABSENCE_COMPONENTS_SQL = `');
  const receiptSqlEnd = harness.indexOf('\n  `;', receiptSqlStart);
  assert.ok(receiptSqlStart >= 0 && receiptSqlEnd > receiptSqlStart,
    'the receipt-absence catalog SQL must remain a separately inspectable constant');
  const receiptDiagnosticSql = harness.slice(receiptSqlStart, receiptSqlEnd);
  assert.match(receiptDiagnosticSql, /FROM pg_catalog\.pg_class/);
  assert.match(receiptDiagnosticSql, /FROM pg_catalog\.pg_constraint/);
  assert.match(receiptDiagnosticSql, /FROM pg_catalog\.pg_trigger/);
  assert.match(receiptDiagnosticSql, /FROM pg_catalog\.pg_type/);
  assert.doesNotMatch(receiptDiagnosticSql, /FROM public\.(accounts|schema_migrations)/);
  const { preflightQueryLabel, summarizeIdentityFailures } = require('./recoveryMigration026.postgres.integration.cjs');
  const preflightQueries = [
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_present",
    "SELECT current_setting('server_version_num') AS server_version_num, runtime_role_non_admin",
    'WITH cols AS (SELECT 1) SELECT count(*) = 4 AS ledger_shape_ok FROM cols',
    'SELECT version, filename, checksum FROM public.schema_migrations WHERE version >= 18 ORDER BY version',
    "SELECT to_regclass('public.game_progress_save_commits') IS NULL AS receipt_objects_absent",
  ];
  assert.deepEqual(
    preflightQueries.map(preflightQueryLabel),
    ['ledger-presence', 'identity-and-role', 'ledger-shape', 'ledger-rows', 'receipt-absence'],
  );
  assert.equal(preflightQueryLabel('BEGIN ISOLATION LEVEL SERIALIZABLE'), 'unclassified');
  assert.equal(preflightQueryLabel(8), 'unclassified');
  assert.match(harness, /validation = 'passed'/);
  assert.match(harness, /status = 'query-failed'/);

  const config = { database: 'tq_identity_synthetic', user: 'tq_migrator_synthetic', port: 5432 };
  const row = {
    database_name: config.database,
    database_user: config.user,
    session_user: config.user,
    server_address: '127.0.0.1',
    server_port: 5432,
    server_version_num: 180001,
    transaction_read_only: 'off',
    runtime_role_present: true,
    runtime_role_non_admin: true,
    runtime_role_has_no_memberships: true,
    runtime_role_is_distinct: true,
    migrator_non_admin: true,
    migrator_has_no_memberships: true,
    migrator_cannot_create_database: true,
    migrator_cannot_create_temp: true,
    migrator_public_usage: true,
    migrator_public_create: true,
    migrator_no_other_schema_create: true,
    migrator_ledger_select: true,
    migrator_ledger_insert: true,
    migrator_ledger_no_update: true,
    migrator_ledger_no_delete: true,
    migrator_accounts_id_references: true,
    migrator_no_unapproved_table_writes: true,
    migrator_no_sequence_writes: true,
  };
  assert.deepEqual(summarizeIdentityFailures(row, config, 18), []);
  for (const key of Object.keys(row)) {
    const invalid = { ...row, [key]: typeof row[key] === 'boolean' ? false : 'unexpected' };
    assert.ok(summarizeIdentityFailures(invalid, config, 18).includes(key === 'server_version_num' ? 'server_version_major' : key));
  }
});

test('role audits expose membership counts and disposable harness restores valid audit after PUBLIC TEMP revoke', () => {
  const audit = read('release-preflight-role-audit.sql');
  const backupAudit = read('backup-role-preflight.sql');
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(audit, /role_membership_count=:role_membership_count/);
  assert.match(backupAudit, /\(SELECT role_membership_count FROM role_membership_audit\) AS role_membership_count/);
  assert.match(backupAudit, /\\echo Backup-role catalog counts:[^\n]*role_membership_count=:role_membership_count/);

  const grantAt = harness.indexOf('const grantPublicTemp');
  const negativeAuditAt = harness.indexOf('const publicTempRoleAudit', grantAt);
  const revokeAt = harness.indexOf('const revokePublicTemp', negativeAuditAt);
  const restoredAuditAt = harness.indexOf('const restoredPublicTempAudit', revokeAt);
  assert.ok(grantAt >= 0 && negativeAuditAt > grantAt && revokeAt > negativeAuditAt && restoredAuditAt > revokeAt,
    'PUBLIC TEMP must be removed before a separate valid-role audit');
  assert.match(harness.slice(revokeAt, restoredAuditAt), /REVOKE TEMP ON DATABASE .* FROM PUBLIC/);
  assert.match(harness.slice(restoredAuditAt, restoredAuditAt + 500), /status, 0/);
  assert.match(harness.slice(restoredAuditAt, restoredAuditAt + 700), /PASS: target identity, read-only limits, and preflight-only privileges verified/);
});


test('synthetic backup role schema and sequence grants occur only in the disposable target database', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  const roleCreateAt = harness.indexOf('const createBackupRole');
  const grantsAt = harness.indexOf('const grantBackupRole', roleCreateAt);
  const auditAt = harness.indexOf('const backupRoleAudit', grantsAt);
  assert.ok(roleCreateAt >= 0 && grantsAt > roleCreateAt && auditAt > grantsAt);
  assert.match(harness.slice(roleCreateAt, grantsAt), /GRANT CONNECT ON DATABASE/);
  const targetGrants = harness.slice(grantsAt, auditAt);
  assert.match(targetGrants, /psql\(CASES\.valid, 'postgres'/);
  assert.match(targetGrants, /GRANT USAGE ON SCHEMA public TO tq_prod_backup_reader/);
  assert.match(targetGrants, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO tq_prod_backup_reader/);
  assert.match(targetGrants, /GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO tq_prod_backup_reader/);
  assert.doesNotMatch(harness.slice(roleCreateAt, grantsAt), /GRANT (?:USAGE ON SCHEMA|SELECT ON ALL)/);
});


test('backup utility has separate explicit backup and isolated-restore gates', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const sql = read('backup-role-preflight.sql');
  assert.match(script, /ExecuteApprovedProductionBackup/);
  assert.match(script, /ExecuteIsolatedRestore/);
  assert.match(script, /ExpectedToolSourceCommit/);
  assert.match(script, /ExpectedProductionApplicationCommit/);
  assert.match(script, /EncryptedStorageConfirmed/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore/);
  assert.match(script, /--single-transaction/);
  assert.match(script, /--exit-on-error/);
  assert.match(script, /restore-input\.toc\.txt/);
  assert.match(script, /backup\/preflight files or migrations are modified\/untracked/);
  assert.match(script, /pg_auth_members/);
  assert.doesNotMatch(script, /--clean\b|--create\b/i);
  assert.match(script, /tq_prod_backup/);
  assert.match(script, /tq_restore_/);
  assert.match(script, /ExpectedArchiveSha256/);
  assert.match(script, /Assert-EncryptedLocalVolume/);
  assert.match(script, /Assert-RestrictedStorageAcl/);
  assert.match(script, /Assert-SufficientFreeSpace/);
  assert.ok(/Assert-SufficientFreeSpace \$restoreDataDirectory \(\[long\]\$metadata\.databaseSizeBytes\)/.test(script),
    'restore free-space reserve must use uncompressed source database size, not archive size');
  assert.ok(/databaseSizeBytes = \[Math\]::Max\(\$beforeState\.DatabaseSizeBytes, \$afterState\.DatabaseSizeBytes\)/.test(script),
    'backup manifest must retain the larger pre/post source-size estimate for restore planning');
  assert.match(script, /sslmode=verify-full/);
  assert.match(script, /Read-only source\/restore catalog metadata comparison/);
  assert.match(script, /pg_largeobject_metadata/);
  assert.match(script, /\$fields\.Count -ne 11/);
  assert.match(script, /\$fields\[5\] -ne '0'/);
  assert.match(script, /no schema repair or migration was run/i);
  assert.match(script, /clusterRolesIncluded = \$false/);
  assert.match(sql, /unreadable_relation_count/);
  assert.match(sql, /row_security_relation_count/);
  assert.match(sql, /relation_write_privilege_count/);
  assert.match(sql, /unreadable_large_object_count/);
  assert.match(sql, /large_object_write_privilege_count/);
  assert.match(sql, /pg_largeobject_metadata/);
  assert.match(sql, /pg_catalog\.aclexplode/);
  assert.match(sql, /pg_catalog\.acldefault\('L'/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /has_largeobject_privilege\s*\(/i,
    'large-object privilege checks must remain compatible with the PostgreSQL 16 CI target');
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
test('backup never starts pg_dump while nonwriting-role audit remains unverified', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const roleSql = read('backup-role-preflight.sql');
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(roleSql, /OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED/);
  assert.match(harness, /OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED/);
  const roleGate = script.indexOf("OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED:");
  const dumpInvocation = script.indexOf('& $PgDumpPath @dumpArguments');
  assert.ok(roleGate >= 0 && dumpInvocation > roleGate,
    'the unverified role audit must throw before any logical archive is created');
  assert.match(script, /STOP: backup role non-writing guarantee is UNVERIFIED/);
});


test('restore rejects a mismatched archive digest before invoking pg_restore', () => {
  const script = read('backup-restore-rehearsal.ps1');
  const digestCheck = script.indexOf("$actualDigest -ine $ExpectedArchiveSha256");
  const restoreInvocation = script.indexOf('& $PgRestorePath @restoreArguments');
  assert.ok(digestCheck >= 0 && restoreInvocation > digestCheck,
    'a corrupt, truncated, or substituted archive must fail its pinned SHA-256 before restore');
  assert.match(script, /archive checksum does not match the approved digest/);
});


test('backup utility prompts for passwords without password files or implicit profile fallbacks', () => {
  const script = read('backup-restore-rehearsal.ps1');
  assert.match(script, /Test-Path Env:PGPASSWORD/);
  assert.match(script, /Test-Path Env:PGPASSFILE/);
  assert.match(script, /Set-InteractivePassfileOverride/);
  assert.match(script, /Assert-RestrictedStorageAcl \$serviceDirectory 'Modify' \$true/);
  assert.match(script, /\.tq-prompt-only-/);
  assert.match(script, /\$env:PGPASSFILE\s*=\s*\$candidate/);
  assert.match(script, /Assert-InteractivePassfileAbsent/);
  assert.doesNotMatch(script, /\$PassfilePath/i);
  assert.doesNotMatch(script, /--no-password|['\"]-w['\"]/i);
});


test('backup restore readiness is separate from archive integrity and source identities', () => {
  const script = read('backup-restore-rehearsal.ps1');
  assert.match(script, /ExpectedToolSourceCommit/);
  assert.match(script, /ExpectedProductionApplicationCommit/);
  assert.match(script, /Invoke-ReleaseStateAudit/);
  assert.match(script, /UNVERIFIED/);
  assert.doesNotMatch(script, /release_ledger_row_count.*?!==\s*'9'/s);
  assert.match(script, /PASS: archive restore integrity checks \(SHA-256, custom TOC, empty loopback target, transactional pg_restore\) completed/i);
  assert.match(script, /Archive integrity and migration readiness are separate results/i);
  assert.doesNotMatch(script, /ExpectedSourceCommit\s*=/);
  assert.doesNotMatch(script, /release_ledger_row_count/);
});


test('restore metadata is bound to the exact reviewed backup-tool source commit', () => {
  const script = read('backup-restore-rehearsal.ps1');
  assert.match(script, /metadata\.toolSourceCommit\s+-cne\s+\$ExpectedToolSourceCommit/,
    'a well-formed but different tool SHA must not authenticate the restore procedure');
  assert.match(script, /ExpectedToolSourceCommit\s*-notmatch\s*'\^\[a-f0-9\]\{40\}\$'/,
    'the approved tool SHA must remain a required full commit identifier');
});



test('backup classifier accounts for PostgreSQL 16 and 18 NOT NULL catalog constraints', () => {
  const sql = read('backup-release-state-preflight.sql');
  assert.match(sql, /current_setting\('server_version_num'\)::integer\s*>=\s*180000/,
    'PG18+ catalog-specific NOT NULL rows must be handled explicitly');
  assert.match(sql, /COUNT\(\*\)\s+FILTER\s*\(WHERE\s+constraint_record\.contype\s*=\s*'p'\)\s*=\s*1/,
    'the ledger must retain exactly one primary key constraint');
  assert.match(sql, /COUNT\(\*\)\s+FILTER\s*\(WHERE\s+constraint_record\.contype\s*=\s*'n'\)[\s\S]*?THEN 4 ELSE 0 END/,
    'ledger NOT NULL catalog rows must be zero on PG16 and exactly four on PG18+');
  assert.match(sql, /attribute_record\.attname IN \('version',\s*'filename',\s*'checksum',\s*'applied_at'\)/,
    'PG18 ledger NOT NULL constraints must map only to canonical ledger columns');
  assert.match(sql, /COUNT\(\*\)\s+FILTER\s*\(WHERE\s+c\.contype\s*<>\s*'n'\)\s*=\s*8/,
    'the receipt table must retain its exact eight structural constraints');
  assert.match(sql, /COUNT\(\*\)\s*=\s*7[\s\S]*?COUNT\(DISTINCT\s+attribute_record\.attname\)\s*=\s*7/,
    'PG18 receipt NOT NULL catalog rows must map one-to-one to seven required columns');
  assert.match(sql, /expected_columns AS e\s+ON e\.attname\s*=\s*attribute_record\.attname\s+AND e\.required_not_null/,
    'receipt NOT NULL rows must correspond only to the existing required-column manifest');
  assert.match(sql, /constraint_record\.convalidated\s+AND NOT constraint_record\.condeferrable\s+AND NOT constraint_record\.condeferred/,
    'catalog not-null rows must be validated and non-deferrable');
});

test('backup-role system-schema privilege regression uses the post-revoke audit result', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  const audit = harness.match(/const postSystemSchemaCreateAudit = invokeBackupRoleAudit\(CASES\.valid\);([\s\S]{0,500})/);
  assert.ok(audit, 'the synthetic positive audit must run after revoking system-schema CREATE');
  assert.match(audit[1], /postSystemSchemaCreateAudit\.status,\s*0/);
  assert.match(audit[1], /\$\{postSystemSchemaCreateAudit\.stderr\}/);
  assert.match(audit[1], /\$\{postSystemSchemaCreateAudit\.stdout\}/);
  assert.doesNotMatch(audit[1], /\$\{postSystemSchemaCreate\.(?:stderr|stdout)\}/,
    'failure diagnostics must reference the post-revoke result and never throw a ReferenceError');
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

test('backup state classifier enforces the exact ledger and current 026 schema contracts', () => {
  const sql = read('backup-release-state-preflight.sql');
  assert.match(sql, /SET LOCAL search_path\s*=\s*pg_catalog\s*;/,
    'constraint-definition rendering must not depend on an operator role search_path');
  assert.match(sql, /formatted_type\s*=\s*'character varying\(255\)'/,
    'ledger filename type must match the release runner contract');
  assert.match(sql, /formatted_type\s*=\s*'character\(64\)'/,
    'ledger checksum type must match the release runner contract');
  assert.match(sql, /constraint_record\.conkey\s*=\s*ARRAY\[version_column\.attnum\][\s\S]*constraint_record\.contype\s*=\s*'p'/,
    'ledger version primary key must be exact');
  assert.match(sql, /indisvalid[\s\S]*indisready|indisready[\s\S]*indisvalid/,
    'the ledger primary-key backing index must be valid and ready');
  assert.match(sql, /pg_get_expr[\s\S]*applied_at|applied_at[\s\S]*pg_get_expr/,
    'ledger applied_at must retain its canonical default expression');
  assert.match(sql, /present_table_count\s*=\s*17[\s\S]*present_column_count\s*=\s*269/,
    'pre-026 readiness must include the complete current-main schema baseline');
  assert.match(sql, /teacher_class_assignments_validate_teacher/,
    'pre-026 readiness must include the required enabled teacher-assignment trigger');
  assert.match(sql, /game_student_id[\s\S]*character varying\(8\)/,
    'pre-026 readiness must retain the canonical Student ID width contract');
  assert.match(sql, /pg_get_constraintdef/,
    'post-026 readiness must inspect normalized constraint definitions');
  assert.match(sql, /game_progress_save_commits_response_status_check/,
    'post-026 readiness must include the response-status contract');
});


test('backup classifier mirrors the canonical 269-column and core-type manifests', () => {
  const source = read('release-migration-026-prerequisite-preflight.sql');
  const backup = read('backup-release-state-preflight.sql');
  const manifestRows = (text, ctePattern, tuplePattern) => {
    const match = text.match(ctePattern);
    assert.ok(match, 'expected schema manifest CTE is present');
    return [...match[1].matchAll(tuplePattern)].map((row) => row.slice(1));
  };
  const sourceColumns = manifestRows(
    source,
    /WITH required_columns\(table_name, column_name\) AS \(\s*VALUES([\s\S]*?)\), schema_contract/,
    /\('([^']+)',\s*'([^']+)'\)/g,
  );
  const backupColumns = manifestRows(
    backup,
    /expected_pre026_columns\(table_name, column_name\) AS \(\s*VALUES([\s\S]*?)\), pre026_schema_contract/,
    /\('([^']+)',\s*'([^']+)'\)/g,
  );
  assert.equal(sourceColumns.length, 269);
  assert.deepEqual(backupColumns, sourceColumns);

  const sourceTypes = manifestRows(
    source,
    /WITH expected_types\(table_name, column_name, expected_data_type\) AS \(\s*VALUES([\s\S]*?)\), type_mismatches/,
    /\('([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g,
  );
  const backupTypes = manifestRows(
    backup,
    /expected_pre026_types\(table_name, column_name, expected_data_type\) AS \(\s*VALUES([\s\S]*?)\), pre026_type_mismatches/,
    /\('([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g,
  );
  assert.deepEqual(backupTypes, sourceTypes);
});


test('backup release-state audit is read-only and only classifies exact pre/post 026 metadata', () => {
  const sql = read('backup-release-state-preflight.sql');
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.match(sql, /statement_timeout/i);
  assert.match(sql, /lock_timeout/i);
  assert.match(sql, /\\set ON_ERROR_STOP on/i);
  assert.match(sql, /PRE_MIGRATION_026/);
  assert.match(sql, /POST_MIGRATION_026/);
  assert.match(sql, /UNVERIFIED/);
  assert.match(sql, /SELECT 1 \/ 0;/, 'fail-closed identity checks must produce a nonzero psql exit status');
  assert.doesNotMatch(sql, /\\quit\s+3\b/i, 'psql \\quit does not set the process exit status');
  assert.match(sql, /MD5 is only a compact equality fingerprint.*not archive integrity/s);
  assert.match(sql, /026_game_progress_save_commit_idempotency\.sql/);
  assert.ok(/receipt_partial_objects AS \(/.test(sql),
    'pre-026 classification must audit orphaned receipt-named catalog objects');
  assert.ok(/pg_catalog\.pg_constraint/.test(sql));
  assert.ok(/pg_catalog\.pg_trigger/.test(sql));
  assert.ok(/pg_catalog\.pg_type/.test(sql));
  assert.ok(/AND \(SELECT objects_absent FROM receipt_partial_objects\)/.test(sql));
  assert.doesNotMatch(sql, /FROM\s+public\.(?:accounts|game_results|playtime_sessions)\b/i);
  assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE\s+\S|DELETE\s+FROM|TRUNCATE\b|CREATE\b|ALTER\b|DROP\b)/im);
  const releaseManifest = sql.match(/WITH expected\(version, filename, source_sha256\) AS \(\s*VALUES([\s\S]*?)\), receipt_table/);
  assert.ok(releaseManifest, 'backup-state classifier must pin release migration names and checksums');
  const observedMigrations = [...releaseManifest[1].matchAll(/\((\d+), '([^']+)', '([a-f0-9]{64})'\)/g)]
    .map(([, version, file, checksum]) => ({ version: Number(version), file, checksum }));
  const expectedMigrations = RELEASE_MIGRATIONS.map(({ version, file }) => ({
    version,
    file,
    checksum: migrationChecksum(fs.readFileSync(path.join(scripts, '../migrations', file), 'utf8').replace(/\r\n/g, '\n')),
  }));
  assert.deepEqual(observedMigrations, expectedMigrations);
});


test('backup harness rejects orphaned migration 026 catalog objects', () => {
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(harness, /orphaned migration-026 constraint/);
  assert.match(harness, /orphaned migration-026 trigger/);
  assert.match(harness, /orphaned migration-026 type/);
  assert.match(harness, /passedScenarioCount, 84/);
});


test('backup role audit rejects executable large-object creators and unsafe callable routines', () => {
  const sql = read('backup-role-preflight.sql');
  const untrustedHarness = read('run-preflight-postgres-harness.cjs');
  assert.match(untrustedHarness,
    /CREATE FUNCTION public\.fixture_backup_untrusted\(integer, integer\) RETURNS boolean[\s\S]*?AS 'int4eq' LANGUAGE internal/,
    'the untrusted-language fixture must use an available built-in internal routine');
  assert.doesNotMatch(untrustedHarness, /intentionally_missing_test_(?:library|symbol)/,
    'the fixture must not depend on a nonexistent shared library');
  assert.match(sql, /has_function_privilege\(current_user, .*EXECUTE/is,
    'effective EXECUTE including PUBLIC grants must be audited');
  assert.match(sql, /lo_create\(oid\)/);
  assert.match(sql, /lo_creat\(integer\)/);
  assert.match(sql, /lo_from_bytea\(oid,bytea\)/);
  assert.match(sql, /executable_large_object_creation_function_count/);
  assert.match(sql, /lo_import\(text\)/);
  assert.match(sql, /lo_import\(text,oid\)/);
  assert.match(sql, /lo_export\(oid,text\)/);
  assert.match(sql, /executable_large_object_server_file_function_count/,
    'effective EXECUTE on server-side file import/export functions must be audited');
  assert.match(sql, /relation_maintenance_privilege_count/,
    'PostgreSQL 17+ MAINTAIN grants must be treated as a data-mutating capability');
  assert.match(sql, /current_setting\('server_version_num'\)::integer >= 170000/,
    'the MAINTAIN check must remain compatible with PostgreSQL 16');
  assert.match(sql, /pg_catalog\.pg_parameter_acl/,
    'explicit ALTER SYSTEM parameter grants must be audited');
  assert.match(sql, /parameter_set_privilege_count/,
    'privileged GUC SET grants must not be able to bypass large-object ACLs');
  assert.match(sql, /parameter_alter_system_privilege_count/);
  assert.match(sql, /relation_maintenance_privilege_count = 0/is,
    'a successful audit must require zero effective maintenance privileges');
  assert.match(sql, /parameter_set_privilege_count = 0/is,
    'a successful audit must reject SET on the large-object compatibility bypass');
  assert.match(sql, /parameter_alter_system_privilege_count = 0/is,
    'a successful audit must reject effective ALTER SYSTEM privileges');
  const schemaAudit = sql.match(/schema_audit AS \(([\s\S]*?)\), role_membership_audit/);
  assert.ok(schemaAudit, 'backup-role schema privilege audit must remain explicit');
  const schemaCreateScope = schemaAudit[1].match(/COUNT\(\*\) FILTER \(\s*WHERE has_schema_privilege\(current_user, namespace_record\.oid, 'CREATE'\)[\s\S]*?\)::integer AS schema_create_privilege_count/);
  assert.ok(schemaCreateScope, 'backup-role CREATE privilege count must be explicit');
  assert.doesNotMatch(schemaCreateScope[0], /nspname\s*!~\s*'\^pg_'/,
    'CREATE grants on system schemas must not be excluded from the write/DDL audit');
  assert.match(sql, /owned_user_routine_count/,
    'the backup role must not own routines that it can alter between audit and dump');
  assert.match(sql, /executable_security_definer_function_count/);
  assert.match(sql, /executable_untrusted_function_count/);
  assert.match(sql, /pg_catalog\.pg_proc/);
  assert.match(sql, /pg_catalog\.pg_language/);
  assert.match(sql, /rolinherit/);
  assert.match(sql, /OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED:/);
  assert.match(sql, /UNVERIFIED: .*trusted.*function bodies.*side effects/i,
    'the role audit must not claim arbitrary function-body side effects are proven safe');

  const backupScript = read('backup-restore-rehearsal.ps1');
  assert.match(backupScript, /\$text -match '\(\?im\)\^OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED:/);
  assert.match(backupScript, /STOP: backup role non-writing guarantee is UNVERIFIED/);

  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(harness, /public EXECUTE on large-object creation functions is rejected/);
  assert.match(harness, /direct EXECUTE on a large-object creator is rejected/);
  assert.match(harness, /PUBLIC ALTER SYSTEM parameter grant is rejected after a synthetic configuration write/);
  assert.match(harness, /direct ALTER SYSTEM parameter grant is rejected after a synthetic configuration write/);
  assert.match(harness, /lo_compat_privileges SET grant bypass is rejected after a synthetic large-object write/);
  assert.match(harness, /MAINTAIN privilege is rejected on supported PostgreSQL versions/);
  assert.match(harness, /MAINTAIN privilege check is version-safe on PostgreSQL 16/);
  assert.match(harness, /backup role cannot create large objects after mutator EXECUTE is revoked/);
  assert.match(harness, /large-object reads remain available after creator restrictions/);
  assert.match(harness, /large-object write descriptor requires UPDATE privilege/);
  assert.match(harness, /backup role ownership of a synthetic large object is rejected/);
  assert.match(harness, /lowrite and both truncate APIs are transactionally rolled back/);
  assert.match(harness, /lo_truncate64\(/);
  assert.match(harness, /executable SECURITY DEFINER function is rejected by backup-role audit/);
  assert.match(harness, /explicit SECURITY DEFINER grant to backup role is rejected/);
  assert.match(harness, /callable untrusted-language function is rejected by backup-role audit/);
  assert.match(harness, /NOINHERIT backup role membership bypass is rejected/);
  assert.match(harness, /RLS-enabled relation is rejected by backup-role audit/);
  assert.match(harness, /PUBLIC EXECUTE on server-side large-object file functions is rejected/);
  assert.match(harness, /direct EXECUTE on server-side large-object file functions is rejected/);
  assert.match(harness, /backup role ownership of a user routine is rejected/);
  assert.match(harness, /CREATE privilege on pg_catalog is rejected by backup-role audit/);
  assert.match(harness, /passedScenarioCount, 84/);

  const workflow = fs.readFileSync(path.resolve(scripts, '../../../.github/workflows/backend-network-isolated.yml'), 'utf8');
  const matrixJobs = /postgres_image:\s*\['postgres:16-bookworm',\s*'postgres:18-bookworm'\]/.test(workflow)
    && /POSTGRES_IMAGE:\s*\$\{\{\s*matrix\.postgres_image\s*\}\}/.test(workflow);
  const splitJobs = /postgres18-preflight:/.test(workflow)
    && /TQ_EXPECTED_POSTGRES_MAJOR:\s*'16'/.test(workflow)
    && /TQ_EXPECTED_POSTGRES_MAJOR:\s*'18'/.test(workflow);
  assert.ok(matrixJobs || splitJobs,
    'isolated workflow must validate PostgreSQL 16 and 18 through either the verified image matrix or separate major-pinned jobs');
  assert.match(workflow, /postgres:16-bookworm/);
  assert.match(workflow, /postgres:18-bookworm/);
  assert.match(workflow, /run-preflight-postgres-harness\.cjs/);
});
