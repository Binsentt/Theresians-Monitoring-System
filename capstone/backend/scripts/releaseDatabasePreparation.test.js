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
  assert.match(harness, /passedScenarioCount, 43/);
  assert.match(harness, /assertCiContainer\(\)/);
});

test('role audit exposes membership count and disposable harness restores valid audit after PUBLIC TEMP revoke', () => {
  const audit = read('release-preflight-role-audit.sql');
  const harness = read('run-preflight-postgres-harness.cjs');
  assert.match(audit, /role_membership_count=:role_membership_count/);

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
  assert.match(script, /ExpectedSourceCommit/);
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
  assert.match(sql, /unreadable_relation_count/);
  assert.match(sql, /row_security_relation_count/);
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
