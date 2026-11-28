'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
let control = {};
try { control = require('./writerAdmissionControl.cjs'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const environment = () => ({
  CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_SHA: 'a'.repeat(40),
  TQ_EXPECTED_POSTGRES_MAJOR: '16', TQ_DISPOSABLE_DB_SENTINEL: 'b'.repeat(48),
});
const allowed = { pid: 100, backendStart: '2026-11-28 01:00:00.123456+00', roleOid: '10' };
const activity = (identity = allowed, extra = {}) => ({
  pid: identity.pid, backendStart: identity.backendStart, roleOid: identity.roleOid,
  backendType: 'client backend', ...extra,
});
const facts = () => ({
  gateClosed: true, journalActive: true, sameDatabaseIdentity: true,
  sessions: [activity()], preparedTransactionCount: 0, inFlightStartupCount: 0,
});

test('CI target guard rejects ambient PostgreSQL destinations and incomplete proof before connecting', () => {
  assert.equal(typeof control.assertCiEnvironment, 'function', 'CI-only target guard is implemented');
  assert.doesNotThrow(() => control.assertCiEnvironment(environment()));
  for (const key of ['CI', 'GITHUB_ACTIONS', 'GITHUB_SHA', 'TQ_EXPECTED_POSTGRES_MAJOR', 'TQ_DISPOSABLE_DB_SENTINEL']) {
    assert.throws(() => control.assertCiEnvironment({ ...environment(), [key]: '' }), key);
  }
  for (const key of ['DATABASE_URL', 'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
    'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGOPTIONS', 'pgHost']) {
    assert.throws(() => control.assertCiEnvironment({ ...environment(), [key]: '' }), key);
  }
  assert.throws(() => control.assertCiEnvironment({ ...environment(), TQ_EXPECTED_POSTGRES_MAJOR: '17' }));
});

test('control identity proof requires exact disposable database sentinel, address, role, version and storage', () => {
  assert.equal(typeof control.assertControlIdentity, 'function', 'server proof is implemented');
  const identity = {
    database: 'postgres', role: 'postgres', isSuperuser: true, major: 16,
    address: '127.0.0.1', port: 5432, dataDirectory: '/var/lib/postgresql/data',
    anchorComment: `tq-disposable-ci:${environment().TQ_DISPOSABLE_DB_SENTINEL}`,
  };
  assert.doesNotThrow(() => control.assertControlIdentity(identity, environment()));
  for (const [key, value] of Object.entries({
    database: 'app', role: 'writer', isSuperuser: false, major: 18,
    address: '::1', port: 6543, dataDirectory: '/production/data', anchorComment: 'not-ci',
  })) assert.throws(() => control.assertControlIdentity({ ...identity, [key]: value }, environment()), key);
});

test('drain requires every nonallowlisted session to exit including idle writers and background workers', () => {
  assert.equal(typeof control.assessDrain, 'function', 'exact-session drain assessment is implemented');
  for (const extra of [{ state: 'idle' }, { state: 'idle in transaction' }, { backendType: 'logical replication worker' }]) {
    const report = control.assessDrain({ ...facts(), sessions: [activity(), activity({ ...allowed, pid: 101 }, extra)] }, [allowed]);
    assert.equal(report.admissionDrained, false);
    assert.equal(report.remainingSessionCount, 1);
    assert.equal(report.productionQuiescence, 'NO_GO');
  }
});

test('PID reuse, changed login identity or missing preconnected backup session invalidates drain proof', () => {
  assert.equal(typeof control.assessDrain, 'function');
  for (const sessions of [[], [activity({ ...allowed, backendStart: '2026-11-28 01:00:01+00' })],
    [activity({ ...allowed, roleOid: '20' })]]) {
    const report = control.assessDrain({ ...facts(), sessions }, [allowed]);
    assert.equal(report.admissionDrained, false);
    assert.equal(report.missingAllowedSessionCount, 1);
  }
  assert.throws(() => control.assessDrain(facts(), []));
  assert.throws(() => control.assessDrain(facts(), [allowed, allowed]));
});

test('prepared transactions, reopened gate, stale journal and database identity changes fail closed', () => {
  assert.equal(typeof control.assessDrain, 'function');
  for (const mutation of [{ preparedTransactionCount: 1 }, { gateClosed: false },
    { journalActive: false }, { sameDatabaseIdentity: false }]) {
    assert.equal(control.assessDrain({ ...facts(), ...mutation }, [allowed]).admissionDrained, false);
  }
});

test('an in-flight connection not yet published in pg_stat_activity blocks drain', () => {
  assert.equal(typeof control.assessDrain, 'function');
  const report = control.assessDrain({ ...facts(), inFlightStartupCount: 1 }, [allowed]);
  assert.equal(report.admissionDrained, false);
  assert.equal(report.inFlightStartupCount, 1);
});

test('a drained admission gate never promotes itself to a production backup authorization', () => {
  assert.equal(typeof control.assessDrain, 'function');
  const report = control.assessDrain(facts(), [allowed]);
  assert.equal(report.admissionDrained, true);
  assert.equal(report.remainingSessionCount, 0);
  assert.equal(report.missingAllowedSessionCount, 0);
  assert.equal(report.productionQuiescence, 'NO_GO');
  assert.ok(report.unprovenBoundaries.includes('privileged-control-plane-isolation'));
  assert.ok(report.unprovenBoundaries.includes('background-worker-bypass'));
  assert.ok(report.unprovenBoundaries.includes('pg-dump-new-connection'));
});
