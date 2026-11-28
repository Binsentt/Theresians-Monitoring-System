'use strict';

// CI-only feasibility test for a PostgreSQL relation-lock writer barrier.
// This is not an operator command and must not be used against production.
// The workflow runs it inside the network-none disposable PostgreSQL
// container's network namespace with a run-specific database sentinel.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const DATABASE = 'tq_writer_quiescence_test_ci';
const SCHEMA = 'tq_writer_quiescence_probe';
const WRITER_A = 'tq_writer_quiescence_writer_a';
const WRITER_B = 'tq_writer_quiescence_writer_b';
const FIXED = Object.freeze({
  host: '127.0.0.1', port: 5432, user: 'postgres',
  connectionTimeoutMillis: 4_000,
  keepAlive: true,
});
const liveClients = new Set();

function assertCiTarget() {
  assert.equal(process.env.CI, 'true', 'writer barrier test is restricted to CI');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'writer barrier test requires GitHub Actions');
  assert.match(process.env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'exact checked-out source SHA is required');
  assert.match(process.env.TQ_EXPECTED_POSTGRES_MAJOR || '', /^(16|18)$/, 'only PostgreSQL 16/18 is allowed');
  assert.match(process.env.TQ_DISPOSABLE_DB_SENTINEL || '', /^[a-f0-9]{48}$/, 'run-specific disposable sentinel is required');
  const forbiddenConnectionEnvironment = Object.keys(process.env).filter((name) =>
    /^(?:DATABASE_URL|PGHOST|PGHOSTADDR|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE|PGSERVICEFILE|PGPASSFILE|PGOPTIONS)$/i.test(name));
  assert.deepEqual(forbiddenConnectionEnvironment, [], 'ambient PostgreSQL connection settings must not be inherited');
}

function newClient(database, user = 'postgres') {
  // No URL, tunnel, connection string, passfile, or ambient libpq variable is
  // accepted. The sole socket target is this CI container's loopback port.
  const client = new Client({ ...FIXED, user, database });
  client.on('error', () => {});
  liveClients.add(client);
  return client;
}

async function connect(client) {
  await client.connect();
}

async function inspectTarget() {
  const control = newClient('postgres');
  await connect(control);
  try {
    const identity = await control.query(`
      SELECT current_database() AS control_database,
             current_user AS role,
             current_setting('server_version_num')::integer / 10000 AS major,
             inet_server_addr()::text AS address,
             inet_server_port() AS port,
             current_setting('data_directory') AS data_directory,
             (SELECT shobj_description(oid, 'pg_database')
                FROM pg_catalog.pg_database WHERE datname = $1) AS database_comment
        `, [DATABASE]);
    assert.equal(identity.rowCount, 1);
    const row = identity.rows[0];
    assert.equal(row.control_database, 'postgres');
    assert.equal(row.role, 'postgres');
    assert.equal(Number(row.major), Number(process.env.TQ_EXPECTED_POSTGRES_MAJOR));
    assert.equal(row.address, '127.0.0.1');
    assert.equal(Number(row.port), 5432);
    assert.match(row.data_directory, /^\/var\/lib\/postgresql\/(?:data|18\/docker)\/?$/);
    assert.equal(row.database_comment, `tq-disposable-ci:${process.env.TQ_DISPOSABLE_DB_SENTINEL}`);
  } finally {
    await control.end();
    liveClients.delete(control);
  }
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function inventoryDigest(rows) {
  const value = rows.map((row) => `${row.oid}|${row.schema_name}|${row.relation_name}|${row.kind}|${row.persistence}`).join('\n');
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function getRelationInventory(client) {
  const result = await client.query(`
    SELECT c.oid::text AS oid, n.nspname AS schema_name, c.relname AS relation_name,
           c.relkind AS kind, c.relpersistence AS persistence
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'S', 'm', 'v', 'f', 't')
       AND n.nspname NOT LIKE 'pg_temp_%'
       AND n.nspname <> 'information_schema'
     ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", c.oid
  `);
  return result.rows;
}

async function acquireCandidateBarrier(client, lockTimeout = '5s', onInventoryCaptured = null) {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
  await client.query("SET LOCAL statement_timeout = '20s'");

  const before = await getRelationInventory(client);
  const foreignRelations = before.filter((row) => row.kind === 'f');
  assert.equal(foreignRelations.length, 0,
    'candidate refuses foreign tables because their remote data writers are outside this database lock domain');
  if (onInventoryCaptured) await onInventoryCaptured();

  // Lock application relations first so existing writers drain before the
  // system catalogs are locked. Then lock catalogs and their TOAST tables so
  // concurrent CREATE/ALTER/GRANT work cannot add an unprotected relation.
  const dataRelations = before.filter((row) =>
    !['pg_catalog', 'information_schema'].includes(row.schema_name) && !row.schema_name.startsWith('pg_toast'));
  const systemRelations = before.filter((row) =>
    (row.schema_name === 'pg_catalog' || row.schema_name.startsWith('pg_toast')) && ['r', 't'].includes(row.kind));
  const targets = [...dataRelations, ...systemRelations];

  for (let offset = 0; offset < targets.length; offset += 40) {
    const names = targets.slice(offset, offset + 40)
      .map((row) => `${quoteIdent(row.schema_name)}.${quoteIdent(row.relation_name)}`);
    if (names.length) await client.query(`LOCK TABLE ${names.join(', ')} IN SHARE MODE`);
  }

  const after = await getRelationInventory(client);
  assert.equal(inventoryDigest(after), inventoryDigest(before),
    'relation catalog changed while locks were being acquired; candidate barrier must abort');
  return {
    backendPid: Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid),
    relationCount: targets.length,
    inventorySha256: inventoryDigest(after),
  };
}

async function expectLockTimeout(query, message) {
  await assert.rejects(query, (error) => {
    assert.equal(error.code, '55P03', `${message}: expected lock_not_available, received ${error.code || 'no SQLSTATE'}`);
    return true;
  }, message);
}

async function createFixture() {
  const admin = newClient(DATABASE);
  await connect(admin);
  await admin.query("SET statement_timeout = '10s'");
  // The isolated container uses trust authentication and has no network
  // interface. These passwordless LOGIN identities exist only in this
  // per-workflow disposable cluster.
  await admin.query(`CREATE ROLE ${quoteIdent(WRITER_A)} LOGIN`);
  await admin.query(`CREATE ROLE ${quoteIdent(WRITER_B)} LOGIN`);
  await admin.query(`CREATE SCHEMA ${quoteIdent(SCHEMA)}`);
  await admin.query(`CREATE SEQUENCE ${quoteIdent(SCHEMA)}."progress_seq" START WITH 400 CACHE 8`);
  await admin.query(`CREATE TABLE ${quoteIdent(SCHEMA)}."progress" (id bigint PRIMARY KEY, value integer NOT NULL)`);
  await admin.query(`INSERT INTO ${quoteIdent(SCHEMA)}."progress" VALUES (1, 0)`);
  for (const role of [WRITER_A, WRITER_B]) {
    await admin.query(`GRANT USAGE ON SCHEMA ${quoteIdent(SCHEMA)} TO ${quoteIdent(role)}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdent(SCHEMA)}."progress" TO ${quoteIdent(role)}`);
    await admin.query(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${quoteIdent(SCHEMA)}."progress_seq" TO ${quoteIdent(role)}`);
  }
  return admin;
}

async function verifyAndCleanup(admin) {
  const remaining = await admin.query(`
    SELECT count(*)::integer AS relation_count
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
  `, [SCHEMA]);
  assert.equal(Number(remaining.rows[0].relation_count), 2, 'only the expected synthetic table and sequence remain');
  await admin.query(`DROP SCHEMA ${quoteIdent(SCHEMA)} CASCADE`);
  await admin.query(`DROP ROLE ${quoteIdent(WRITER_A)}`);
  await admin.query(`DROP ROLE ${quoteIdent(WRITER_B)}`);
}

async function cleanupSyntheticFixture(admin) {
  await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SCHEMA)} CASCADE`);
  await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(WRITER_A)}`);
  await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(WRITER_B)}`);
}

async function assertRoleWriteBlocked(role, sql, label) {
  const client = newClient(DATABASE, role);
  let connected = false;
  try {
    await connect(client);
    connected = true;
    await assertLockTimeoutInTransaction(client, sql, label);
  } finally {
    if (connected) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    try { await client.end(); } catch {}
    liveClients.delete(client);
  }
}

async function assertLockTimeoutInTransaction(client, sql, label) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '250ms'");
    await expectLockTimeout(client.query(sql), label);
  } finally {
    try { await client.query('ROLLBACK'); } catch {}
  }
}

async function waitForBackendExit(admin, pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await admin.query('SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1', [pid]);
    if (Number(result.rows[0].n) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('interrupted barrier backend did not exit within the bounded cleanup window');
}

async function main() {
  assertCiTarget();
  const originalSentinel = process.env.TQ_DISPOSABLE_DB_SENTINEL;
  process.env.TQ_DISPOSABLE_DB_SENTINEL = 'not-a-run-sentinel';
  assert.throws(assertCiTarget, 'wrong CI sentinel must be rejected before opening a database connection');
  process.env.TQ_DISPOSABLE_DB_SENTINEL = originalSentinel;
  const originalPgHost = process.env.PGHOST;
  process.env.PGHOST = 'untrusted.invalid';
  assert.throws(assertCiTarget, 'ambient PostgreSQL target override must be rejected before connecting');
  if (originalPgHost === undefined) delete process.env.PGHOST;
  else process.env.PGHOST = originalPgHost;
  await inspectTarget();
  console.log('PASS: wrong sentinel and ambient target are rejected; fixed loopback, CI run, and PostgreSQL identity verified');

  const admin = await createFixture();
  let barrierClient = null;
  let blocker = null;
  let sequenceWriter = null;
  let fixtureCleaned = false;
  try {
    const driftBarrierClient = newClient(DATABASE);
    await connect(driftBarrierClient);
    await assert.rejects(
      acquireCandidateBarrier(driftBarrierClient, '3s', () =>
        admin.query(`CREATE TABLE ${quoteIdent(SCHEMA)}."inventory_race" (id integer)`)),
      /relation catalog changed while locks were being acquired/,
      'a relation created after inventory capture must invalidate and abort the barrier',
    );
    await driftBarrierClient.query('ROLLBACK');
    await driftBarrierClient.end();
    liveClients.delete(driftBarrierClient);
    await admin.query(`DROP TABLE ${quoteIdent(SCHEMA)}."inventory_race"`);
    console.log('PASS: relation inventory drift fails closed before barrier-ready');

    // A pre-existing transaction holds a writer lock. Barrier acquisition
    // must wait for it to commit before reporting ready.
    blocker = newClient(DATABASE, WRITER_A);
    await connect(blocker);
    await blocker.query('BEGIN');
    await blocker.query(`UPDATE ${quoteIdent(SCHEMA)}."progress" SET value = value + 1 WHERE id = 1`);

    sequenceWriter = newClient(DATABASE, WRITER_B);
    await connect(sequenceWriter);
    const firstSequenceValue = await sequenceWriter.query(`SELECT nextval('${SCHEMA}.progress_seq') AS value`);
    assert.equal(Number(firstSequenceValue.rows[0].value), 400,
      'synthetic writer must have a cached sequence value before the barrier is acquired');

    barrierClient = newClient(DATABASE);
    await connect(barrierClient);
    let barrierSettled = false;
    const barrierPromise = acquireCandidateBarrier(barrierClient)
      .then((result) => { barrierSettled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(barrierSettled, false, 'barrier must not claim quiescence while a prior writer transaction remains open');
    await blocker.query('COMMIT');
    await blocker.end();
    liveClients.delete(blocker);
    blocker = null;
    const barrier = await barrierPromise;
    assert.ok(barrier.relationCount >= 3, 'barrier must include application relations, sequence, and system catalog locks');
    assert.match(barrier.inventorySha256, /^[a-f0-9]{64}$/);
    console.log(`PASS: existing writer drained before barrier-ready; locked-relations=${barrier.relationCount}`);

    const readResult = await admin.query(`SELECT value FROM ${quoteIdent(SCHEMA)}."progress" WHERE id = 1`);
    assert.equal(Number(readResult.rows[0].value), 1, 'read-only access must remain possible under SHARE locks');
    const dumpReader = newClient(DATABASE, WRITER_A);
    await connect(dumpReader);
    await dumpReader.query('BEGIN');
    await dumpReader.query(`LOCK TABLE ${quoteIdent(SCHEMA)}."progress" IN ACCESS SHARE MODE`);
    const dumpRead = await dumpReader.query(`SELECT value FROM ${quoteIdent(SCHEMA)}."progress" WHERE id = 1`);
    assert.equal(Number(dumpRead.rows[0].value), 1);
    await dumpReader.query('ROLLBACK');
    await dumpReader.end();
    liveClients.delete(dumpReader);
    console.log('PASS: read-only SELECT and pg_dump-compatible ACCESS SHARE locks remain available');

    await assertRoleWriteBlocked(WRITER_A,
      `UPDATE ${quoteIdent(SCHEMA)}."progress" SET value = value + 1 WHERE id = 1`, 'writer A update');
    await assertRoleWriteBlocked(WRITER_B,
      `INSERT INTO ${quoteIdent(SCHEMA)}."progress" VALUES (2, 0)`, 'writer B insert');
    await assertRoleWriteBlocked(WRITER_A,
      `DELETE FROM ${quoteIdent(SCHEMA)}."progress" WHERE id = 1`, 'writer A delete');
    await assertLockTimeoutInTransaction(
      sequenceWriter,
      `SELECT nextval('${SCHEMA}.progress_seq')`,
      'cached writer B nextval',
    );
    await assertRoleWriteBlocked(WRITER_B,
      `SELECT setval('${SCHEMA}.progress_seq', 900, true)`, 'writer B setval');
    const sequenceStateWhileLocked = await admin.query(`SELECT last_value, is_called FROM ${quoteIdent(SCHEMA)}."progress_seq"`);
    assert.equal(Number(sequenceStateWhileLocked.rows[0].last_value), 407,
      'blocked sequence operations must not change the already reserved sequence cache range');
    assert.equal(sequenceStateWhileLocked.rows[0].is_called, true);
    const tableStateWhileLocked = await admin.query(`SELECT count(*)::integer AS rows, min(value)::integer AS min_value FROM ${quoteIdent(SCHEMA)}."progress"`);
    assert.equal(Number(tableStateWhileLocked.rows[0].rows), 1);
    assert.equal(Number(tableStateWhileLocked.rows[0].min_value), 1);
    console.log('PASS: distinct writer identities, row writes, nextval, and setval are blocked');

    await assertLockTimeoutInTransaction(
      admin,
      `CREATE TABLE ${quoteIdent(SCHEMA)}."late_relation" (id integer)`,
      'concurrent DDL',
    );
    await assertLockTimeoutInTransaction(
      admin,
      `TRUNCATE ${quoteIdent(SCHEMA)}."progress"`,
      'concurrent truncate',
    );
    const lateRelation = await admin.query(`SELECT to_regclass($1) IS NULL AS absent`, [`${SCHEMA}.late_relation`]);
    assert.equal(lateRelation.rows[0].absent, true, 'blocked DDL must not leave a relation behind');
    console.log('PASS: catalog locks prevent new table DDL and inventory drift');

    await barrierClient.query('ROLLBACK');
    await barrierClient.end();
    liveClients.delete(barrierClient);
    barrierClient = null;
    await admin.query(`UPDATE ${quoteIdent(SCHEMA)}."progress" SET value = value + 1 WHERE id = 1`);
    const cachedSequenceAfterRelease = await sequenceWriter.query(`SELECT nextval('${SCHEMA}.progress_seq') AS value`);
    assert.equal(Number(cachedSequenceAfterRelease.rows[0].value), 401,
      'the cached next value must remain unchanged by blocked calls and become available after release');
    const afterRelease = await admin.query(`SELECT value FROM ${quoteIdent(SCHEMA)}."progress" WHERE id = 1`);
    assert.equal(Number(afterRelease.rows[0].value), 2);
    console.log('PASS: explicit barrier rollback releases locks and restores writes');

    // A pre-existing writer makes barrier acquisition time out. The failed
    // acquisition must roll back every partially acquired relation lock.
    blocker = newClient(DATABASE, WRITER_B);
    await connect(blocker);
    await blocker.query('BEGIN');
    await blocker.query(`UPDATE ${quoteIdent(SCHEMA)}."progress" SET value = value + 1 WHERE id = 1`);
    const timeoutClient = newClient(DATABASE);
    await connect(timeoutClient);
    await assert.rejects(acquireCandidateBarrier(timeoutClient, '150ms'), (error) => error.code === '55P03',
      'barrier acquisition must fail closed at the lock timeout');
    await timeoutClient.end();
    liveClients.delete(timeoutClient);
    await blocker.query('ROLLBACK');
    await blocker.end();
    liveClients.delete(blocker);
    blocker = null;
    await admin.query(`UPDATE ${quoteIdent(SCHEMA)}."progress" SET value = value + 1 WHERE id = 1`);
    console.log('PASS: lock timeout rolls back and does not strand partial barrier locks');

    // Simulate a barrier operator/process disappearing while holding the
    // transaction. The server must release locks when that connection closes.
    const interrupted = newClient(DATABASE);
    await connect(interrupted);
    const interruptedBarrier = await acquireCandidateBarrier(interrupted);
    const socketClosed = new Promise((resolve) => interrupted.connection.stream.once('close', resolve));
    interrupted.connection.stream.destroy();
    await Promise.race([
      socketClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('bounded simulated interruption timed out')), 3_000)),
    ]);
    liveClients.delete(interrupted);
    await waitForBackendExit(admin, interruptedBarrier.backendPid);
    await admin.query(`UPDATE ${quoteIdent(SCHEMA)}."progress" SET value = value + 1 WHERE id = 1`);
    console.log('PASS: interrupted lock-session disconnect releases all relation locks');

    await sequenceWriter.end();
    liveClients.delete(sequenceWriter);
    sequenceWriter = null;
    await verifyAndCleanup(admin);
    fixtureCleaned = true;
    console.log('PASS: synthetic schema and roles cleaned up');
    console.log(`Writer-quiescence lock feasibility: PostgreSQL ${process.env.TQ_EXPECTED_POSTGRES_MAJOR}, 10/10 scenarios passed.`);
    console.log('LIMITATION: this database-local mechanism does not freeze external services, other databases, foreign data sources, or PostgreSQL superuser activity outside the tested relation lock domain.');
  } finally {
    if (blocker) {
      try { await blocker.query('ROLLBACK'); } catch {}
      try { await blocker.end(); } catch {}
      liveClients.delete(blocker);
    }
    if (barrierClient) {
      try { await barrierClient.query('ROLLBACK'); } catch {}
      try { await barrierClient.end(); } catch {}
      liveClients.delete(barrierClient);
    }
    if (sequenceWriter) {
      try { await sequenceWriter.query('RESET ROLE'); } catch {}
      try { await sequenceWriter.end(); } catch {}
      liveClients.delete(sequenceWriter);
    }
    for (const client of [...liveClients]) {
      if (client === admin) continue;
      try { await client.query('ROLLBACK'); } catch {}
      try { await client.end(); } catch {}
      liveClients.delete(client);
    }
    if (!fixtureCleaned) {
      try {
        await cleanupSyntheticFixture(admin);
        console.log('CLEANUP=PASS');
      } catch (cleanupError) {
        const cleanupCode = typeof cleanupError?.code === 'string' && /^[A-Z0-9]+$/.test(cleanupError.code)
          ? cleanupError.code : 'NONE';
        console.error(`CLEANUP=FAIL sqlstate=${cleanupCode}`);
        process.exitCode = 1;
      }
    }
    try { await admin.end(); } catch {}
    liveClients.delete(admin);
  }
}

main().catch((error) => {
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9]+$/.test(error.code) ? error.code : 'NONE';
  console.error(`FAIL: synthetic writer-quiescence integration failed (name=${error?.name || 'Error'}, sqlstate=${safeCode}).`);
  process.exitCode = 1;
});
