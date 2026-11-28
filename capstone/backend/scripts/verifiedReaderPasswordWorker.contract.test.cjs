'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const workerPath = path.join(__dirname, 'VerifiedReaderPasswordWorker.cs');
const readWorker = () => fs.readFileSync(workerPath, 'utf8');

test('production worker pins the admin service and fixed reader target', () => {
  const source = readWorker();
  assert.match(source, /#if TQ_SYNTHETIC[\s\S]*?#else[\s\S]*?tq_admin_identity[\s\S]*?railway[\s\S]*?tq_release_preflight_reader[\s\S]*?#endif/);
  assert.match(source, /connect_timeout=10/);
  assert.doesNotMatch(source, /sslmode\s*=\s*disable/i);
  assert.doesNotMatch(source, /10\.218\.248\.163/);
  assert.match(source, /TQ_EXPECTED_PG_SERVER_ADDRESS/);
});

test('production connection requires verified TLS and exact identity before password input', () => {
  const source = readWorker();
  assert.match(source, /PQsslInUse/);
  assert.match(source, /PQhost/);
  assert.match(source, /inet_server_addr/);
  assert.match(source, /inet_server_port/);
  assert.match(source, /rolname=current_user AND r\.rolsuper/);
  assert.match(source, /EXPECTED_TARGET_ANCHOR=FAIL/);
  assert.match(source, /sslmode/);
  const main = source.slice(source.indexOf('public static int Main'));
  assert.ok(main.indexOf('ValidateConnectionIdentity(conn') < main.indexOf('ReadSecretFromPassfile('));
  assert.ok(main.indexOf('EXPECTED_TARGET_ANCHOR=FAIL') < main.indexOf('PQconnectdb('));
  assert.match(source, /default_transaction_read_only=on/);
  assert.match(source, /READ_ONLY_OR_BOUNDS=PASS/);
  assert.match(source, /SESSION_READONLY_RESTORE=PASS/);
});

test('one PQchangePassword call is guarded by SCRAM, bounds, and role snapshot checks', () => {
  const source = readWorker();
  assert.equal((source.match(/PQchangePassword\(/g) || []).length, 2, 'one declaration and one invocation');
  assert.match(source, /password_encryption/);
  assert.match(source, /statement_timeout/);
  assert.match(source, /lock_timeout/);
  assert.ok(source.indexOf('PASSWORD_CHANGE_ATTEMPTED=TRUE') < source.indexOf('PQchangePassword(conn, roleToChange'));
  assert.match(source, /RoleSnapshot/);
  assert.match(source, /WHERE m\.roleid=r\.oid/);
  assert.match(source, /SCRAM-SHA-256/);
});

test('password source is a distinct exact passfile tuple and its byte buffers are cleared', () => {
  const source = readWorker();
  assert.match(source, /TQ_READER_PASSFILE_SOURCE/);
  assert.match(source, /ReadSecretFromPassfile/);
  assert.match(source, /localhost/);
  assert.match(source, /tq_release_preflight_reader/);
  assert.match(source, /fields\[4\]/);
  assert.match(source, /Array\.Clear\(raw, 0, raw\.Length\)/);
  assert.match(source, /Array\.Clear\(secret, 0, secret\.Length\)/);
  assert.doesNotMatch(source, /Console\.Read(Line|Key)|ReadAllText\(.*PASS/i);
});

test('worker emits fixed status markers and never writes secret buffers or verifier values', () => {
  const source = readWorker();
  assert.doesNotMatch(source, /Console\.(Write|WriteLine)\([^\n]*\+\s*(secret|secretPointer|secretBytes|verifier|errorMessage)\b/i);
  assert.doesNotMatch(source, /PQerrorMessage\(/);
  assert.match(source, /SYNC=PASS/);
  assert.match(source, /READ_ONLY_OR_BOUNDS=PASS/);
  assert.match(source, /SESSION_READONLY_RESTORE=PASS/);
});

test('passfile parser zeroes each temporary field buffer before clearing and reusing it', () => {
  const source = readWorker();
  assert.match(source, /AddPassfileFieldAndClear\(fields, field\)/);
  assert.match(source, /for \(int index = 0; index < field\.Count; index\+\+\)\s*field\[index\] = 0;\s*field\.Clear\(\);/);
});
