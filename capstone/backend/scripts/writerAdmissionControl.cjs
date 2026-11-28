'use strict';

// Disposable-CI candidate only. This module accepts no URL, hostname, database
// name, password or libpq environment override. It never terminates a backend.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const DATABASE = 'tq_writer_admission_test_ci';
const ANCHOR_DATABASE = 'tq_writer_quiescence_test_ci';
const JOURNAL_SCHEMA = 'tq_writer_admission_ci';
const JOURNAL = `${JOURNAL_SCHEMA}.gate_journal`;
const FIXED = Object.freeze({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres',
  connectionTimeoutMillis: 4_000, keepAlive: true,
});
const verifiedControls = new WeakMap();

function assertCiEnvironment(env = process.env) {
  assert.equal(env.CI, 'true', 'candidate is restricted to disposable CI');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'GitHub Actions is required');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'exact source SHA is required');
  assert.match(env.TQ_EXPECTED_POSTGRES_MAJOR || '', /^(16|18)$/, 'only PostgreSQL 16/18 is allowed');
  assert.match(env.TQ_DISPOSABLE_DB_SENTINEL || '', /^[a-f0-9]{48}$/, 'run-specific sentinel is required');
  assert.deepEqual(Object.keys(env).filter((name) =>
    /^(?:DATABASE_URL|PGHOST|PGHOSTADDR|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE|PGSERVICEFILE|PGPASSFILE|PGOPTIONS)$/i.test(name)),
  [], 'ambient PostgreSQL connection settings are forbidden');
}

function assertControlIdentity(row, env = process.env) {
  assertCiEnvironment(env);
  assert.equal(row.database, 'postgres');
  assert.equal(row.role, 'postgres');
  assert.equal(row.isSuperuser, true);
  assert.equal(Number(row.major), Number(env.TQ_EXPECTED_POSTGRES_MAJOR));
  assert.equal(row.address, '127.0.0.1');
  assert.equal(Number(row.port), 5432);
  assert.match(row.dataDirectory, /^\/var\/lib\/postgresql\/(?:data|18\/docker)\/?$/);
  assert.equal(row.anchorComment, `tq-disposable-ci:${env.TQ_DISPOSABLE_DB_SENTINEL}`);
}

function sessionKey(session) {
  assert.ok(Number.isSafeInteger(session.pid) && session.pid > 0, 'exact backend PID is required');
  assert.equal(typeof session.backendStart, 'string');
  assert.ok(session.backendStart.length > 0, 'exact backend_start is required');
  assert.match(session.roleOid, /^[0-9]+$/, 'exact login role OID is required');
  return JSON.stringify([session.pid, session.backendStart, session.roleOid]);
}

function assessDrain(facts, allowlist) {
  assert.ok(Array.isArray(allowlist) && allowlist.length > 0, 'preconnected allowlist is required');
  const allowed = new Set(allowlist.map(sessionKey));
  assert.equal(allowed.size, allowlist.length, 'duplicate allowlisted sessions are forbidden');
  const present = new Set(facts.sessions.map(sessionKey));
  const remainingSessionCount = facts.sessions.filter((session) => !allowed.has(sessionKey(session))).length;
  const missingAllowedSessionCount = [...allowed].filter((key) => !present.has(key)).length;
  assert.ok(Number.isSafeInteger(facts.preparedTransactionCount) && facts.preparedTransactionCount >= 0);
  assert.ok(Number.isSafeInteger(facts.inFlightStartupCount) && facts.inFlightStartupCount >= 0);
  return {
    admissionDrained: facts.gateClosed === true && facts.journalActive === true &&
      facts.sameDatabaseIdentity === true && remainingSessionCount === 0 &&
      missingAllowedSessionCount === 0 && facts.preparedTransactionCount === 0 && facts.inFlightStartupCount === 0,
    remainingSessionCount, missingAllowedSessionCount,
    preparedTransactionCount: facts.preparedTransactionCount,
    inFlightStartupCount: facts.inFlightStartupCount,
    productionQuiescence: 'NO_GO',
    unprovenBoundaries: [
      'privileged-control-plane-isolation', 'background-worker-bypass',
      'allowlisted-session-write-discipline', 'external-and-foreign-writers',
      'pg-dump-new-connection',
    ],
  };
}

async function connectVerifiedControl() {
  assertCiEnvironment(); // Before loading pg or opening any socket.
  const { Client } = require('pg');
  const control = new Client(FIXED);
  control.on('error', () => {});
  try {
    await control.connect();
    const result = await control.query(`
      SELECT current_database() AS database, current_user AS role,
             (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS "isSuperuser",
             current_setting('server_version_num')::integer / 10000 AS major,
             host(inet_server_addr()) AS address, inet_server_port() AS port,
             current_setting('data_directory') AS "dataDirectory",
             (SELECT shobj_description(oid, 'pg_database') FROM pg_catalog.pg_database
               WHERE datname = $1) AS "anchorComment"`, [ANCHOR_DATABASE]);
    assert.equal(result.rowCount, 1);
    assertControlIdentity(result.rows[0]);
    await control.query("SET statement_timeout = '10s'");
    await control.query("SET lock_timeout = '3s'");
    verifiedControls.set(control, process.env.TQ_DISPOSABLE_DB_SENTINEL);
    return control;
  } catch (error) {
    try { await control.end(); } catch {}
    throw error;
  }
}

function assertVerified(control) {
  assertCiEnvironment();
  assert.equal(verifiedControls.get(control), process.env.TQ_DISPOSABLE_DB_SENTINEL,
    'control connection must have a verified disposable identity');
}

async function databaseIdentity(control) {
  const result = await control.query(`
    SELECT oid::text AS oid, datname AS name, datdba::text AS "ownerOid",
           datacl::text AS acl, datconnlimit AS "connectionLimit", datallowconn AS "allowConnections",
           shobj_description(oid, 'pg_database') AS comment
      FROM pg_catalog.pg_database WHERE datname = $1`, [DATABASE]);
  assert.equal(result.rowCount, 1, 'exact synthetic database must exist');
  assert.equal(result.rows[0].comment, `tq-disposable-ci:${verifiedControls.get(control)}`,
    'synthetic database must carry the same run-specific sentinel');
  return result.rows[0];
}

async function sessionsForDatabase(control, oid) {
  await control.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
  const result = await control.query(`
    SELECT pid, backend_start::text AS "backendStart", usesysid::text AS "roleOid",
           backend_type AS "backendType", state
      FROM pg_catalog.pg_stat_activity WHERE datid = $1::oid ORDER BY pid`, [oid]);
  // Internal worker identities can have a NULL usesysid. They are never
  // allowlisted, but must remain drain blockers rather than being omitted.
  return result.rows.map((row) => ({ ...row, roleOid: row.roleOid || '0' }));
}

async function ensureJournal(control) {
  await control.query(`CREATE SCHEMA IF NOT EXISTS ${JOURNAL_SCHEMA}`);
  await control.query(`REVOKE ALL ON SCHEMA ${JOURNAL_SCHEMA} FROM PUBLIC`);
  await control.query(`CREATE TABLE IF NOT EXISTS ${JOURNAL} (
    journal_id uuid PRIMARY KEY, database_oid oid NOT NULL, run_sentinel text NOT NULL,
    original_identity jsonb NOT NULL, allowed_sessions jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('closed', 'restored')),
    closed_at timestamptz NOT NULL DEFAULT clock_timestamp(), restored_at timestamptz
  )`);
  await control.query(`REVOKE ALL ON ${JOURNAL} FROM PUBLIC`);
  await control.query(`CREATE UNIQUE INDEX IF NOT EXISTS one_closed_admission_gate
    ON ${JOURNAL} (database_oid) WHERE status = 'closed'`);
}

async function lockDatabase(control, oid) {
  const result = await control.query('SELECT pg_catalog.pg_try_advisory_xact_lock(173781, $1::integer) AS locked', [oid]);
  assert.equal(result.rows[0].locked, true, 'another cooperative admission controller is active');
}

function unchangedIdentity(now, original) {
  return ['oid', 'name', 'ownerOid', 'acl', 'connectionLimit', 'comment'].every((key) => now[key] === original[key]);
}

async function closeAdmission(control, allowedSessions) {
  assertVerified(control);
  // Validate exact identities before starting a mutating transaction.
  assessDrain({ gateClosed: false, journalActive: false, sameDatabaseIdentity: false,
    sessions: [], preparedTransactionCount: 0, inFlightStartupCount: 0 }, allowedSessions);
  await control.query('BEGIN');
  try {
    await lockDatabase(control, (await databaseIdentity(control)).oid);
    // Re-read after acquiring the cooperative lock: another controller may
    // have completed a close/reopen cycle before this lock was obtained.
    const original = await databaseIdentity(control);
    assert.equal(original.allowConnections, true, 'already-disabled database must not be reopened by this candidate');
    const currentSessions = await sessionsForDatabase(control, original.oid);
    const currentKeys = new Set(currentSessions.map(sessionKey));
    for (const session of allowedSessions) {
      assert.ok(currentKeys.has(sessionKey(session)), 'allowlisted session must already be connected to exact target database');
      assert.equal(currentSessions.find((row) => sessionKey(row) === sessionKey(session)).backendType, 'client backend');
    }
    await ensureJournal(control);
    const journalId = randomUUID();
    await control.query(`INSERT INTO ${JOURNAL}
      (journal_id, database_oid, run_sentinel, original_identity, allowed_sessions, status)
      VALUES ($1, $2::oid, $3, $4::jsonb, $5::jsonb, 'closed')`,
    [journalId, original.oid, verifiedControls.get(control), JSON.stringify(original), JSON.stringify(allowedSessions)]);
    // Ordinary new admissions, including superusers and the database owner,
    // are closed together. Existing sessions and bypassing workers survive.
    await control.query(`ALTER DATABASE "${DATABASE}" ALLOW_CONNECTIONS false`);
    await control.query('COMMIT');
    return { journalId, databaseOid: original.oid };
  } catch (error) {
    try { await control.query('ROLLBACK'); } catch {}
    throw error;
  }
}

async function activeJournal(control) {
  const result = await control.query(`SELECT journal_id AS "journalId", database_oid::text AS "databaseOid",
      original_identity AS original, allowed_sessions AS "allowedSessions"
    FROM ${JOURNAL} WHERE status = 'closed' AND run_sentinel = $1 ORDER BY closed_at`,
  [verifiedControls.get(control)]);
  assert.equal(result.rowCount, 1, 'exactly one current-run closed gate journal is required');
  return result.rows[0];
}

async function inspectAdmission(control) {
  assertVerified(control);
  const journal = await activeJournal(control);
  const now = await databaseIdentity(control);
  // Startup checks datallowconn BEFORE publishing pg_stat_activity. A session
  // that passed the check before closure can still be in post_auth_delay.
  // Sample database-object startup locks BEFORE activity: a startup that
  // completes between these samples is then visible in the activity sample.
  // Any sampled lock holder absent from activity is a conservative blocker.
  const startupLocks = await control.query(`SELECT DISTINCT pid FROM pg_catalog.pg_locks
    WHERE locktype = 'object' AND classid = 'pg_catalog.pg_database'::regclass
      AND objid = $1::oid AND objsubid = 0`, [now.oid]);
  const sessions = await sessionsForDatabase(control, now.oid);
  const visiblePids = new Set(sessions.map((session) => session.pid));
  const inFlightStartupCount = startupLocks.rows.filter((row) => row.pid === null || !visiblePids.has(row.pid)).length;
  const prepared = await control.query(`SELECT count(*)::integer AS n FROM pg_catalog.pg_prepared_xacts WHERE database = $1`, [DATABASE]);
  const finalIdentity = await databaseIdentity(control);
  const journalStatus = await control.query(`SELECT status FROM ${JOURNAL} WHERE journal_id = $1`, [journal.journalId]);
  return {
    ...assessDrain({ gateClosed: now.allowConnections === false && finalIdentity.allowConnections === false,
      journalActive: journalStatus.rows[0]?.status === 'closed',
      sameDatabaseIdentity: unchangedIdentity(now, journal.original) && unchangedIdentity(finalIdentity, journal.original), sessions,
      preparedTransactionCount: prepared.rows[0].n, inFlightStartupCount }, journal.allowedSessions),
    journalId: journal.journalId,
  };
}

async function reopenAdmission(control) {
  assertVerified(control);
  // Recovery deliberately discovers the durable journal. The original process
  // may have lost the COMMIT acknowledgement and possess no receipt at all.
  await control.query('BEGIN');
  try {
    await lockDatabase(control, (await databaseIdentity(control)).oid);
    const journal = await activeJournal(control);
    const now = await databaseIdentity(control);
    assert.ok(unchangedIdentity(now, journal.original), 'database identity or privileges drifted; manual recovery review is required');
    assert.equal(now.allowConnections, false, 'closed gate was altered outside the controller');
    assert.equal(journal.original.allowConnections, true);
    await control.query(`ALTER DATABASE "${DATABASE}" ALLOW_CONNECTIONS true`);
    await control.query(`UPDATE ${JOURNAL} SET status = 'restored', restored_at = clock_timestamp()
      WHERE journal_id = $1 AND status = 'closed'`, [journal.journalId]);
    await control.query('COMMIT');
    return { restored: true, journalId: journal.journalId };
  } catch (error) {
    try { await control.query('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = {
  DATABASE, ANCHOR_DATABASE, JOURNAL_SCHEMA, FIXED,
  assertCiEnvironment, assertControlIdentity, assessDrain,
  connectVerifiedControl, closeAdmission, inspectAdmission, reopenAdmission,
};
