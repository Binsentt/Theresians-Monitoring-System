'use strict';

// This probe is launched only by the isolated GitHub PostgreSQL workflow. It
// accepts no URL, connection string, arbitrary container, or external host.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { classifyPsqlFailure } = require('./postgresFailureDiagnostics.cjs');

const CONTAINER = 'tq-backend-test-postgres';
const EXPECTED_MAJOR = process.env.TQ_EXPECTED_POSTGRES_MAJOR;
const SENTINEL = process.env.TQ_DISPOSABLE_DB_SENTINEL;
const FIXED_TIMEOUT_MS = 60_000;
let currentStage = 'ci-scope';
let passed = 0;

function record(label) {
  passed += 1;
  console.log(`PASS: ${label}`);
}

function docker(args, input) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout: FIXED_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw new Error(`docker-exec-error=${result.error.code || 'unknown'}`);
  return result;
}

function assertCommand(result, label) {
  const errorClass = classifyPsqlFailure(result);
  assert.equal(result.status, 0,
    `${label}: status=${result.status ?? 'null'}, signal=${result.signal || 'none'}, errorClass=${errorClass}`);
}

function psql(sql, database = 'postgres') {
  return docker([
    'exec', '-i', CONTAINER, 'psql',
    '--host=127.0.0.1', '--port=5432', '--username=postgres', `--dbname=${database}`,
    '--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1', '--quiet',
    '--tuples-only', '--no-align', '--field-separator=|', '--file=-',
  ], sql);
}

function runDockerCommand(args, label) {
  const result = docker(['exec', CONTAINER, ...args]);
  assertCommand(result, label);
  return String(result.stdout || '').trim();
}

function verifyCiTarget() {
  assert.equal(process.env.CI, 'true', 'CI marker is required');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions marker is required');
  assert.match(EXPECTED_MAJOR || '', /^(16|18)$/, 'only the PostgreSQL 16/18 CI matrix is allowed');
  assert.match(SENTINEL || '', /^[a-f0-9]{48}$/, 'the workflow-generated disposable database sentinel is required');

  const inspect = docker(['inspect', CONTAINER]);
  assertCommand(inspect, 'inspect exact disposable container');
  const [container] = JSON.parse(inspect.stdout);
  assert.equal(container.State.Running, true);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.deepEqual(container.HostConfig.PortBindings || {}, {});
  assert.equal(container.Config.Image, `postgres:${EXPECTED_MAJOR}-bookworm`);

  const identity = psql(`
    SELECT current_database(), current_user,
      COALESCE(pg_catalog.host(pg_catalog.inet_server_addr()), ''),
      pg_catalog.inet_server_port(),
      (current_setting('server_version_num')::integer / 10000)::text,
      (SELECT pg_catalog.shobj_description(database_record.oid, 'pg_database')
       FROM pg_catalog.pg_database AS database_record
       WHERE database_record.datname = current_database());
  `);
  assertCommand(identity, 'verify exact disposable PostgreSQL identity');
  assert.equal(String(identity.stdout || '').trim(),
    `postgres|postgres|127.0.0.1|5432|${EXPECTED_MAJOR}|tq-disposable-ci:${SENTINEL}`);
  record('exact PostgreSQL major, loopback target, no-published-port container, and sentinel identity');
}

function startExporter() {
  const child = spawn('docker', [
    'exec', '-i', CONTAINER, 'psql',
    '--host=127.0.0.1', '--port=5432', '--username=postgres', '--dbname=postgres',
    '--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1', '--quiet',
    '--tuples-only', '--no-align', '--file=-',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let buffer = '';
  let stderrBytes = 0;
  let settled = false;
  let timer;
  const readiness = new Promise((resolve, reject) => {
    const fail = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(code));
    };
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrBytes = Math.min(stderrBytes + Buffer.byteLength(chunk), 8192); });
    child.stdin.on('error', (error) => fail(`snapshot-stdin-error=${error.code || 'unknown'}`));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4096) return fail('snapshot-output-over-limit');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const value = line.trim();
        if (!value) continue;
        if (!/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+$/.test(value)) {
          return fail('snapshot-id-output-invalid');
        }
        if (settled) return fail('snapshot-output-ambiguous');
        settled = true;
        clearTimeout(timer);
        resolve(value);
        return;
      }
    });
    child.once('error', (error) => fail(`snapshot-process-error=${error.code || 'unknown'}`));
    child.once('close', (code, signal) => {
      if (!settled) fail(`snapshot-process-exited=${code ?? 'null'}:${signal || 'none'}:stderrBytes=${stderrBytes}`);
    });
    timer = setTimeout(() => fail('snapshot-export-timeout'), 30_000);
  });

  // Keep stdin open after the snapshot ID is returned. That leaves psql idle
  // inside the exporting transaction without a long pg_sleep that would block
  // a queued ROLLBACK during deterministic cleanup.
  child.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_catalog.pg_export_snapshot();\n');
  return { child, readiness };
}

async function stopExporter(exporter) {
  if (!exporter || !exporter.child) return;
  const child = exporter.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.stdin.write('ROLLBACK;\n\\q\n'); } catch { }
  try { child.stdin.end(); } catch { }
  const waitForClose = async (timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve) => child.once('close', () => resolve(true))),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (!(await waitForClose(5000)) && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    if (!(await waitForClose(2000)) && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      if (!(await waitForClose(2000))) throw new Error('snapshot-exporter-process-did-not-close');
    }
  }
}

async function run() {
  verifyCiTarget();
  const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
  const table = `tq_export_snapshot_probe_${suffix}`;
  const sequence = `tq_export_snapshot_seq_${suffix}`;
  const restoreDatabase = `tq_snapshot_restore_${suffix}`;
  const archive = `/tmp/tq-exported-snapshot-${suffix}.dump`;
  let sourceObjectsMayExist = false;
  let restoreDatabaseCreated = false;
  let exporter = null;
  try {
    currentStage = 'create-synthetic-source';
    const sourceNames = psql(`
      SELECT (pg_catalog.to_regclass('public."${table}"') IS NULL)::text || '|' ||
             (pg_catalog.to_regclass('public."${sequence}"') IS NULL)::text;
    `);
    assertCommand(sourceNames, 'verify unique synthetic source names are unused');
    assert.equal(String(sourceNames.stdout || '').trim(), 'true|true',
      'unique synthetic table and sequence names must not already exist');
    sourceObjectsMayExist = true;
    const createSource = psql(`
      CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL);
      INSERT INTO public."${table}" (id, payload) VALUES (1, 'before-snapshot');
      CREATE SEQUENCE public."${sequence}" START WITH 100 CACHE 1;
    `);
    assertCommand(createSource, 'create synthetic snapshot source');
    record('synthetic source table and non-MVCC sequence created');

    currentStage = 'export-snapshot';
    exporter = startExporter();
    const snapshotId = await exporter.readiness;
    assert.match(snapshotId, /^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+$/);
    record('repeatable-read exporter transaction remains open after exporting snapshot');

    currentStage = 'concurrent-mutation';
    const mutate = psql(`
      UPDATE public."${table}" SET payload = 'after-snapshot' WHERE id = 1;
      SELECT pg_catalog.nextval('public."${sequence}"'::regclass);
    `);
    assertCommand(mutate, 'commit synthetic concurrent row and sequence mutation');

    currentStage = 'import-snapshot';
    const imported = psql(`
      BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
      SET TRANSACTION SNAPSHOT '${snapshotId}';
      SELECT row_record.payload || '|' || sequence_record.is_called::text
      FROM public."${table}" AS row_record
      CROSS JOIN public."${sequence}" AS sequence_record
      WHERE row_record.id = 1;
      COMMIT;
    `);
    assertCommand(imported, 'import shared snapshot');
    assert.equal(String(imported.stdout || '').trim(), 'before-snapshot|true');
    record('imported snapshot retains pre-update MVCC row and exposes changed non-MVCC sequence state');

    currentStage = 'pg-dump-shared-snapshot';
    const absentArchive = docker(['exec', CONTAINER, 'test', '!', '-e', archive]);
    assertCommand(absentArchive, 'confirm unique synthetic archive target is absent');
    const dump = docker([
      'exec', CONTAINER, 'pg_dump', '--host=127.0.0.1', '--port=5432', '--username=postgres',
      '--dbname=postgres', '--no-password', '--format=custom', `--snapshot=${snapshotId}`,
      `--table=public.${table}`, `--file=${archive}`,
    ]);
    assertCommand(dump, 'pg_dump importing exported snapshot');
    record('pg_dump completed from the same exported snapshot');

    currentStage = 'isolated-restore';
    const restoreNameCheck = psql(`
      SELECT (COUNT(*) = 0)::text FROM pg_catalog.pg_database WHERE datname = '${restoreDatabase}';
    `);
    assertCommand(restoreNameCheck, 'verify unique disposable restore database name is unused');
    assert.equal(String(restoreNameCheck.stdout || '').trim(), 'true',
      'unique disposable restore database name must not already exist');
    const createRestoreDatabase = docker(['exec', CONTAINER, 'createdb', '--host=127.0.0.1', '--port=5432', '--username=postgres', restoreDatabase]);
    assertCommand(createRestoreDatabase, 'create uniquely named disposable restore database');
    restoreDatabaseCreated = true;
    const restore = docker([
      'exec', CONTAINER, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges',
      `--dbname=${restoreDatabase}`, archive,
    ]);
    assertCommand(restore, 'restore exported-snapshot archive into isolated database');
    const restored = psql(`SELECT payload FROM public."${table}" WHERE id = 1;`, restoreDatabase);
    assertCommand(restored, 'read synthetic restored row');
    assert.equal(String(restored.stdout || '').trim(), 'before-snapshot');
    record('restored archive contains the row visible to the exported snapshot');

    currentStage = 'source-after-mutation';
    const currentSource = psql(`SELECT payload FROM public."${table}" WHERE id = 1;`);
    assertCommand(currentSource, 'verify committed source mutation remains present');
    assert.equal(String(currentSource.stdout || '').trim(), 'after-snapshot');
    record('source retains the committed post-snapshot change');
  } finally {
    const cleanupFailures = [];
    currentStage = 'release-exporter';
    try { await stopExporter(exporter); } catch { cleanupFailures.push('exporter'); }
    currentStage = 'cleanup-synthetic-fixtures';
    if (restoreDatabaseCreated) {
      try {
        const dropDatabase = docker(['exec', CONTAINER, 'dropdb', '--if-exists', '--host=127.0.0.1', '--port=5432', '--username=postgres', restoreDatabase]);
        if (dropDatabase.status !== 0) cleanupFailures.push('restore-database');
      } catch { cleanupFailures.push('restore-database'); }
    }
    if (sourceObjectsMayExist) {
      try {
        const dropTable = psql(`DROP TABLE IF EXISTS public."${table}";`);
        if (dropTable.status !== 0) cleanupFailures.push('source-table');
      } catch { cleanupFailures.push('source-table'); }
      try {
        const dropSequence = psql(`DROP SEQUENCE IF EXISTS public."${sequence}";`);
        if (dropSequence.status !== 0) cleanupFailures.push('source-sequence');
      } catch { cleanupFailures.push('source-sequence'); }
    }
    try {
      const removeArchive = docker(['exec', CONTAINER, 'rm', '-f', archive]);
      if (removeArchive.status !== 0) cleanupFailures.push('archive');
    } catch { cleanupFailures.push('archive'); }
    if (cleanupFailures.length) throw new Error(`synthetic-cleanup-failed:${cleanupFailures.join(',')}`);
  }
}

run().then(() => {
  assert.equal(passed, 7, 'all exported snapshot integration scenarios must pass');
  console.log(`Exported snapshot integration result: ${passed}/${passed} passed on PostgreSQL ${EXPECTED_MAJOR}.`);
}).catch((error) => {
  console.error(`FAIL: exported-snapshot stage=${currentStage} reason=${String(error.message || 'unknown').slice(0, 240)}`);
  process.exitCode = 1;
});
