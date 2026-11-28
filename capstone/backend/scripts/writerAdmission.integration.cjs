'use strict';

// CI-only database admission/drain candidate, never a production operator
// command. Run in the existing network-none PG16/18 container namespace.
const assert = require('node:assert/strict');
const candidate = require('./writerAdmissionControl.cjs');
const OWNER = 'tq_writer_admission_owner_ci';
const WRITER = 'tq_writer_admission_writer_ci';
const PUBLIC_WRITER = 'tq_writer_admission_public_ci';
const GROUP = 'tq_writer_admission_group_ci';
const MEMBER = 'tq_writer_admission_member_ci';
const BACKUP = 'tq_writer_admission_backup_ci';
const ROLES = [OWNER, WRITER, PUBLIC_WRITER, GROUP, MEMBER, BACKUP];
const clients = new Set();
let stage = 'ci-target-validation';
let count = 0;
let cleanup = 'not-started';

function passed(message) { count += 1; console.log(`PASS: ${message}`); }

async function clientFor(database, user = 'postgres') {
  // Candidate guard must precede loading the driver or connecting.
  candidate.assertCiEnvironment();
  const { Client } = require('pg');
  const client = new Client({ ...candidate.FIXED, database, user });
  client.on('error', () => {});
  clients.add(client);
  try { await client.connect(); } catch (error) {
    await end(client);
    throw error;
  }
  await client.query("SET statement_timeout = '5s'");
  return client;
}

async function end(client) {
  if (!client) return;
  try { await client.end(); } finally { clients.delete(client); }
}

async function identity(client) {
  const result = await client.query(`SELECT pg_backend_pid() AS pid,
    backend_start::text AS "backendStart", usesysid::text AS "roleOid"
    FROM pg_catalog.pg_stat_activity WHERE pid = pg_backend_pid()`);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function backendExited(control, pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await control.query('SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1', [pid]);
    if (result.rows[0].n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail('owned synthetic backend did not exit within bounded observation period');
}

async function expectAdmissionDenied(role) {
  await assert.rejects(clientFor(candidate.DATABASE, role), (error) => error.code === '55000',
    'all normal reconnects must fail with object_not_in_prerequisite_state');
}

async function flags(control) {
  return (await control.query(`SELECT oid::text AS oid, datallowconn, datacl::text AS acl,
    datdba::text AS owner, datconnlimit FROM pg_catalog.pg_database WHERE datname = $1`, [candidate.DATABASE])).rows[0];
}

async function main() {
  candidate.assertCiEnvironment();
  // Negative guards are tested before any connection, including the driver.
  const originalSentinel = process.env.TQ_DISPOSABLE_DB_SENTINEL;
  process.env.TQ_DISPOSABLE_DB_SENTINEL = 'invalid';
  assert.throws(() => candidate.assertCiEnvironment());
  process.env.TQ_DISPOSABLE_DB_SENTINEL = originalSentinel;
  process.env.PGHOST = 'invalid.example';
  assert.throws(() => candidate.assertCiEnvironment());
  delete process.env.PGHOST;
  passed('sentinel and ambient PostgreSQL target overrides fail before connection');

  stage = 'verified-disposable-control';
  let control = await candidate.connectVerifiedControl();
  clients.add(control);
  let createdDatabase = false;
  let createdRoles = [];
  let original = null;
  let createdJournal = false;
  let backup = null;
  let maintenance = null;
  let writer = null;
  let publicWriter = null;
  let prepared = false;
  try {
    const existing = await control.query(`SELECT count(*)::integer AS n FROM pg_catalog.pg_database WHERE datname = $1`, [candidate.DATABASE]);
    assert.equal(existing.rows[0].n, 0, 'refuse any preexisting fixture database');
    assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS absent', [candidate.JOURNAL_SCHEMA])).rows[0].absent, true,
      'refuse any preexisting control journal schema');
    const roleCount = await control.query('SELECT count(*)::integer AS n FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])', [ROLES]);
    assert.equal(roleCount.rows[0].n, 0, 'refuse any preexisting fixture identities');

    stage = 'synthetic-fixture-creation';
    for (const role of ROLES) {
      await control.query(`CREATE ROLE "${role}" ${role === GROUP ? 'NOLOGIN' : 'LOGIN'}`);
      createdRoles.push(role);
    }
    await control.query(`GRANT "${GROUP}" TO "${MEMBER}"`);
    await control.query(`CREATE DATABASE "${candidate.DATABASE}" OWNER "${OWNER}"`);
    createdDatabase = true;
    await control.query(`COMMENT ON DATABASE "${candidate.DATABASE}" IS 'tq-disposable-ci:${originalSentinel}'`);
    await control.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${candidate.DATABASE}" TO "${GROUP}"`);
    await control.query(`GRANT CREATE, TEMPORARY ON DATABASE "${candidate.DATABASE}" TO "${PUBLIC_WRITER}"`);
    original = await flags(control);
    maintenance = await clientFor(candidate.DATABASE);
    await maintenance.query('CREATE SCHEMA admission_probe');
    await maintenance.query('CREATE TABLE admission_probe.progress (id integer PRIMARY KEY, value integer NOT NULL)');
    await maintenance.query('INSERT INTO admission_probe.progress VALUES (1, 0)');
    await maintenance.query('CREATE SEQUENCE admission_probe.progress_seq START 400 CACHE 8');
    await maintenance.query(`CREATE FUNCTION admission_probe.trigger_write() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = pg_catalog, admission_probe AS $$ BEGIN
        PERFORM pg_catalog.setval('admission_probe.progress_seq', 900, true);
        RETURN NEW;
      END $$`);
    await maintenance.query(`CREATE TRIGGER sequence_side_effect AFTER UPDATE ON admission_probe.progress
      FOR EACH ROW WHEN (NEW.value = 2) EXECUTE FUNCTION admission_probe.trigger_write()`);
    await maintenance.query(`CREATE FUNCTION admission_probe.routine_write() RETURNS void LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = pg_catalog, admission_probe AS $$ BEGIN
        UPDATE admission_probe.progress SET value = value + 1 WHERE id = 1;
      END $$`);
    await maintenance.query(`GRANT USAGE ON SCHEMA admission_probe TO "${WRITER}", "${PUBLIC_WRITER}", "${BACKUP}"`);
    await maintenance.query(`GRANT SELECT, UPDATE ON admission_probe.progress TO "${WRITER}"`);
    await maintenance.query(`GRANT USAGE, SELECT, UPDATE ON admission_probe.progress_seq TO "${WRITER}"`);
    await maintenance.query(`GRANT SELECT ON admission_probe.progress, admission_probe.progress_seq TO "${BACKUP}"`);
    await maintenance.query(`REVOKE ALL ON FUNCTION admission_probe.routine_write() FROM PUBLIC`);
    await maintenance.query(`GRANT EXECUTE ON FUNCTION admission_probe.routine_write() TO "${PUBLIC_WRITER}"`);
    backup = await clientFor(candidate.DATABASE, BACKUP);
    const allowlist = [await identity(backup)];

    stage = 'read-only-assessment';
    const assessmentSql = require('node:fs').readFileSync(require('node:path').join(__dirname, 'writerAdmissionAssessment.sql'), 'utf8');
    const assessmentResults = await maintenance.query(assessmentSql);
    const assessmentRows = assessmentResults.filter((result) => result.command === 'SELECT').map((result) => result.rows);
    assert.equal(assessmentRows[0][0].production_quiescence, 'NO_GO');
    assert.equal(assessmentRows[1][0].public_connect, true);
    assert.ok(Number(assessmentRows[1][0].login_roles_with_effective_connect) >= ROLES.length - 1);
    assert.equal(assessmentRows[5][0].enabled_subscription_count, '0');
    assert.equal(assessmentRows[5][0].user_security_definer_routine_count, '2');
    assert.equal(assessmentRows[5][0].enabled_user_trigger_count, '1');
    assert.equal(assessmentResults.at(-1).command, 'ROLLBACK');
    passed('read-only aggregate assessment accounts for PUBLIC, effective role privileges, routines and triggers');

    stage = 'transaction-rollback';
    await control.query('BEGIN');
    await control.query(`ALTER DATABASE "${candidate.DATABASE}" ALLOW_CONNECTIONS false`);
    await control.query('ROLLBACK');
    assert.deepEqual(await flags(control), original);
    const rollbackProbe = await clientFor(candidate.DATABASE, PUBLIC_WRITER);
    await end(rollbackProbe);
    passed('uncommitted admission closure rolls back without changing database controls');

    stage = 'interruption-before-commit';
    const interrupted = await candidate.connectVerifiedControl();
    clients.add(interrupted);
    const interruptedPid = (await identity(interrupted)).pid;
    await interrupted.query('BEGIN');
    await interrupted.query(`ALTER DATABASE "${candidate.DATABASE}" ALLOW_CONNECTIONS false`);
    interrupted.connection.stream.destroy();
    clients.delete(interrupted);
    await backendExited(control, interruptedPid);
    assert.deepEqual(await flags(control), original);
    passed('owned controller disconnect before COMMIT rolls back the admission flag');

    stage = 'existing-writers-before-closure';
    writer = await clientFor(candidate.DATABASE, WRITER);
    assert.equal(Number((await writer.query("SELECT nextval('admission_probe.progress_seq') AS value")).rows[0].value), 400);
    await writer.query('BEGIN');
    await writer.query('UPDATE admission_probe.progress SET value = value + 1 WHERE id = 1');
    publicWriter = await clientFor(candidate.DATABASE, PUBLIC_WRITER);

    stage = 'in-flight-startup-before-closure';
    // post_auth_delay runs after the admission check and before the backend
    // is published in pg_stat_activity. It exposes a session-only drain race.
    const { Client } = require('pg');
    const delayed = new Client({ ...candidate.FIXED, database: candidate.DATABASE,
      options: '-c post_auth_delay=2' });
    delayed.on('error', () => {});
    clients.add(delayed);
    const delayedResult = delayed.connect().then(() => ({ connected: true }), (error) => ({ error }));
    let startupPid = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const startup = await control.query(`SELECT pid FROM pg_catalog.pg_locks WHERE locktype = 'object'
        AND classid = 'pg_catalog.pg_database'::regclass AND objid = $1::oid
        AND mode = 'RowExclusiveLock' AND granted`, [original.oid]);
      if (startup.rowCount === 1) { startupPid = startup.rows[0].pid; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(startupPid, 'delayed connection must hold a database startup lock');
    await new Promise((resolve) => setTimeout(resolve, 100));

    stage = 'close-admission';
    await candidate.closeAdmission(control, allowlist);
    createdJournal = true;
    assert.equal((await flags(control)).datallowconn, false);
    await assert.rejects(candidate.closeAdmission(control, allowlist), /already-disabled/);
    const undrained = await candidate.inspectAdmission(control);
    assert.equal(undrained.admissionDrained, false);
    assert.equal(undrained.remainingSessionCount, 3);
    assert.equal(undrained.inFlightStartupCount, 1);
    passed('committed gate retains exact allowlist and waits for every existing target session');

    stage = 'in-flight-startup-accounting';
    const delayedOutcome = await delayedResult;
    assert.equal(delayedOutcome.connected, true, 'a startup that passed the flag check before closure can finish after closure');
    await delayed.query('SELECT 1');
    assert.equal((await candidate.inspectAdmission(control)).remainingSessionCount, 4);
    await end(delayed);
    passed('startup lock blocks readiness before pg_stat_activity publication; a pre-gate connection can finish after closure');

    stage = 'all-normal-admissions-denied';
    for (const role of [WRITER, PUBLIC_WRITER, MEMBER, OWNER, 'postgres', BACKUP]) await expectAdmissionDenied(role);
    passed('explicit, PUBLIC CONNECT, inherited, owner, superuser and backup-role new admissions are denied');

    stage = 'owner-control-plane-bypass';
    const ownerControl = await clientFor('postgres', OWNER);
    await ownerControl.query(`ALTER DATABASE "${candidate.DATABASE}" ALLOW_CONNECTIONS true`);
    assert.equal((await candidate.inspectAdmission(control)).admissionDrained, false);
    const admittedAfterOwnerOverride = await clientFor(candidate.DATABASE, WRITER);
    await end(admittedAfterOwnerOverride);
    await ownerControl.query(`ALTER DATABASE "${candidate.DATABASE}" ALLOW_CONNECTIONS false`);
    await end(ownerControl);
    passed('owner in another database can reopen admission; external privileged isolation remains required');

    stage = 'existing-session-write-bypass';
    await writer.query('COMMIT');
    assert.equal(Number((await writer.query("SELECT nextval('admission_probe.progress_seq') AS value")).rows[0].value), 401);
    await publicWriter.query('CREATE SCHEMA admission_late_schema');
    await publicWriter.query('CREATE TEMPORARY TABLE admission_temp (id integer)');
    await publicWriter.query('SELECT admission_probe.routine_write()');
    assert.equal(Number((await backup.query('SELECT last_value FROM admission_probe.progress_seq')).rows[0].last_value), 900);
    assert.equal(Number((await writer.query("SELECT nextval('admission_probe.progress_seq') AS value")).rows[0].value), 402);
    assert.equal((await candidate.inspectAdmission(control)).admissionDrained, false);
    passed('existing sessions retain cached nextval, CREATE/TEMP, SECURITY DEFINER and trigger write paths until exit');

    stage = 'prepared-transaction-accounting';
    const preparedCapacity = Number((await maintenance.query("SHOW max_prepared_transactions")).rows[0].max_prepared_transactions);
    assert.ok(preparedCapacity > 0, 'CI must enable max_prepared_transactions=10 for the required real prepared-transaction case');
    await writer.query('BEGIN');
    await writer.query('UPDATE admission_probe.progress SET value = value + 1 WHERE id = 1');
    await writer.query("PREPARE TRANSACTION 'tq_writer_admission_pending_ci'");
    prepared = true;
    await end(writer); writer = null;
    await end(publicWriter); publicWriter = null;
    const preparedReport = await candidate.inspectAdmission(control);
    assert.equal(preparedReport.preparedTransactionCount, 1);
    assert.equal(preparedReport.admissionDrained, false);
    await maintenance.query("ROLLBACK PREPARED 'tq_writer_admission_pending_ci'");
    prepared = false;
    await end(maintenance); maintenance = null;
    passed('prepared transaction blocks drain after writer disconnect and requires explicit resolution');

    stage = 'natural-session-drain';
    let drained;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      drained = await candidate.inspectAdmission(control);
      if (drained.admissionDrained) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(drained.admissionDrained, true);
    assert.equal(drained.productionQuiescence, 'NO_GO');
    const frozen = (await backup.query('SELECT last_value, is_called FROM admission_probe.progress_seq')).rows;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual((await backup.query('SELECT last_value, is_called FROM admission_probe.progress_seq')).rows, frozen);
    }
    assert.equal(Number((await backup.query('SELECT value FROM admission_probe.progress WHERE id = 1')).rows[0].value), 2);
    await backup.query('BEGIN READ ONLY');
    await backup.query('LOCK TABLE admission_probe.progress IN ACCESS SHARE MODE');
    await backup.query('ROLLBACK');
    passed('natural drain removes old sequence caches while preconnected SELECT and ACCESS SHARE remain possible');

    stage = 'durable-gate-interruption-and-recovery';
    const controlPid = (await identity(control)).pid;
    control.connection.stream.destroy();
    clients.delete(control);
    control = await candidate.connectVerifiedControl();
    clients.add(control);
    await backendExited(control, controlPid);
    assert.equal((await candidate.inspectAdmission(control)).admissionDrained, true);
    await expectAdmissionDenied(WRITER);
    assert.equal((await candidate.reopenAdmission(control)).restored, true);
    assert.deepEqual(await flags(control), original);
    const reconnectedWriter = await clientFor(candidate.DATABASE, WRITER);
    const freshSequenceValue = Number((await reconnectedWriter.query("SELECT nextval('admission_probe.progress_seq') AS value")).rows[0].value);
    assert.ok(freshSequenceValue >= 901, 'reconnected session cannot consume old 403..407 cache values');
    await end(reconnectedWriter);
    passed('committed gate survives controller interruption and a new verified control session restores exact original flags');

    stage = 'recovery-refuses-admin-drift';
    await candidate.closeAdmission(control, allowlist);
    await control.query(`ALTER DATABASE "${candidate.DATABASE}" CONNECTION LIMIT 7`);
    assert.equal((await candidate.inspectAdmission(control)).admissionDrained, false);
    await assert.rejects(candidate.reopenAdmission(control), /identity or privileges drifted/);
    assert.equal((await flags(control)).datallowconn, false);
    await control.query(`ALTER DATABASE "${candidate.DATABASE}" CONNECTION LIMIT ${original.datconnlimit}`);
    await candidate.reopenAdmission(control);
    assert.deepEqual(await flags(control), original);
    passed('recovery refuses changed controls and preserves closed admission until reviewed drift is restored');

    stage = 'lost-allowlisted-backup';
    await candidate.closeAdmission(control, allowlist);
    await end(backup); backup = null;
    const missingBackup = await candidate.inspectAdmission(control);
    assert.equal(missingBackup.admissionDrained, false);
    assert.equal(missingBackup.missingAllowedSessionCount, 1);
    await candidate.reopenAdmission(control);
    assert.deepEqual(await flags(control), original);
    passed('lost preconnected backup session invalidates readiness and recovery needs no target-database session');

    stage = 'already-closed-database-refusal';
    const lateBackup = await clientFor(candidate.DATABASE, BACKUP);
    await control.query(`ALTER DATABASE "${candidate.DATABASE}" ALLOW_CONNECTIONS false`);
    await assert.rejects(candidate.closeAdmission(control, [await identity(lateBackup)]), /already-disabled/);
    assert.equal((await flags(control)).datallowconn, false);
    await control.query(`ALTER DATABASE "${candidate.DATABASE}" ALLOW_CONNECTIONS true`);
    await end(lateBackup);
    passed('candidate refuses to take ownership of an already-closed database');
  } finally {
    cleanup = 'running';
    // Clean up only objects created by this test after identity checks. Never
    // terminate other sessions, use DROP DATABASE FORCE, or touch the anchor.
    if (prepared && maintenance) {
      await maintenance.query("ROLLBACK PREPARED 'tq_writer_admission_pending_ci'");
      prepared = false;
    }
    for (const client of [...clients]) if (client !== control) {
      try { await client.query('ROLLBACK'); } catch {}
      await end(client);
    }
    if (createdDatabase) {
      const sentinel = await control.query(`SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_catalog.pg_database WHERE datname = $1`, [candidate.DATABASE]);
      assert.equal(sentinel.rows[0].comment, `tq-disposable-ci:${originalSentinel}`);
      // On an early test failure a journal may not exist. This explicit
      // synthetic cleanup restores the flag before DROP, never production.
      await control.query(`ALTER DATABASE "${candidate.DATABASE}" ALLOW_CONNECTIONS true`);
      await control.query(`DROP DATABASE "${candidate.DATABASE}"`);
    }
    if (createdJournal) await control.query(`DROP SCHEMA ${candidate.JOURNAL_SCHEMA} CASCADE`);
    for (const role of createdRoles.reverse()) await control.query(`DROP ROLE "${role}"`);
    await end(control);
    cleanup = 'pass';
  }
  passed('synthetic fixture, journal and roles cleaned without terminating sessions');
  console.log(`Writer-admission candidate: PostgreSQL ${process.env.TQ_EXPECTED_POSTGRES_MAJOR}, ${count}/${count} cases passed.`);
  console.log('PRODUCTION_QUIESCENCE=NO_GO: admission/drain is a tested CI candidate; privileged reopen, background-worker bypass, allowlisted writes, external sources and standard pg_dump connection admission remain unresolved.');
}

main().catch((error) => {
  const safeStage = /^[a-z0-9-]+$/.test(stage) ? stage : 'unknown';
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'NONE';
  console.error(`FAIL: writer-admission CI candidate (stage=${safeStage}, cleanup=${cleanup}, name=${error?.name || 'Error'}, sqlstate=${safeCode}).`);
  process.exitCode = 1;
});
