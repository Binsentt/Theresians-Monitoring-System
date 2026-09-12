const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let tokenPayloads = {};
let authenticatedAccounts = {};
let queries = [];
let connectCount = 0;

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const resultRows = (rows) => ({ rows });
const runQuery = async (sql, params = []) => {
  const compacted = compactSql(sql);
  queries.push({ sql: compacted, params });
  if (compacted.startsWith('select * from public.accounts where id = $1')) {
    const account = authenticatedAccounts[Number(params[0])];
    if (account) return resultRows([account]);
  }
  return (await queryHandler(compacted, params, sql)) || emptyResult;
};
const mockPool = {
  query: runQuery,
  connect: async () => {
    connectCount += 1;
    return { query: runQuery, release: () => {} };
  },
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const passthrough = () => (req, res, next) => next();
const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => `hashed:${value}` };
  if (request === 'cors') return () => passthrough();
  if (request === 'jsonwebtoken') return { sign: () => 'token', verify: (token) => tokenPayloads[token] || {} };
  if (request === 'multer') return () => ({ single: passthrough, array: passthrough, fields: passthrough });
  if (request === 'pdf-parse') return async () => ({ text: '' });
  return originalLoad.call(this, request, parent, isMain);
};

let app;
try {
  ({ app } = require('./server'));
} finally {
  Module._load = originalLoad;
}

const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const requestJson = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
};

const reset = () => {
  queries = [];
  connectCount = 0;
  queryHandler = async () => emptyResult;
  tokenPayloads = {
    admin: { userId: 1, sessionVersion: 0 },
    parent: { userId: 19, sessionVersion: 0 },
    parentTeacher: { userId: 20, sessionVersion: 0 },
  };
  authenticatedAccounts = {
    1: { id: 1, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false, session_version: 0 },
    19: { id: 19, name: 'Parent User', role: 'parent', is_archived: false, session_version: 0 },
    20: { id: 20, name: 'Parent Teacher', role: 'parent_teacher', is_archived: false, session_version: 0 },
  };
};

test('Parent soft Delete and restore preserve child accounts and relationships', async (t) => {
  reset();
  queryHandler = async (sql, params) => {
    if (sql.startsWith('select id, email, role, is_archived')) {
      return resultRows([{ id: 19, email: 'parent@example.com', role: 'parent', is_archived: false, parent_id: '112832' }]);
    }
    if (sql.startsWith('update public.accounts set is_archived = true')) {
      return resultRows([{ id: 19, role: 'parent', is_archived: true }]);
    }
    if (sql.startsWith('select id, role from public.accounts')) return resultRows([{ id: 19, role: 'parent' }]);
    if (sql.startsWith('update public.accounts set is_archived = false')) {
      return resultRows([{ id: 19, role: 'parent', is_archived: false }]);
    }
    return emptyResult;
  };
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const archived = await requestJson(baseUrl, '/api/accounts/19', {
    method: 'DELETE', headers: { Authorization: 'Bearer admin' }, body: JSON.stringify({ reason: 'Duplicate family account' }),
  });
  const restored = await requestJson(baseUrl, '/api/accounts/19/restore', {
    method: 'POST', headers: { Authorization: 'Bearer admin' },
  });

  assert.equal(archived.status, 200);
  assert.equal(restored.status, 200);
  assert.equal(queries.some(({ sql }) => sql.startsWith('delete from public.accounts')), false);
  assert.equal(queries.some(({ sql }) => sql.startsWith('delete from public.teacher_student_relationships')), false);
});

test('archived Parent permanent deletion removes owned children from the account-authoritative directory', async (t) => {
  reset();
  let accounts = [
    { id: 19, name: 'Parent User', email: 'parent@example.com', role: 'parent', parent_id: '112832', is_archived: true },
    { id: 44, name: 'Ava Santos', role: 'student', game_student_id: '00123456', grade_level: 'Grade 1', section: 'Amethyst', status: 'Active', is_archived: false },
  ];
  let relationships = [{ id: 7, teacher_id: 19, student_id: 44, relationship_type: 'Parent' }];
  queryHandler = async (sql, params) => {
    if (sql.includes('left join lateral') && sql.includes('from public.accounts a')) {
      const archived = sql.includes('coalesce(a.is_archived, false) = true');
      return resultRows(accounts
        .filter((account) => Boolean(account.is_archived) === archived)
        .filter((account) => ['student', 'teacher', 'parent_teacher'].includes(account.role))
        .map((account) => ({
          ...account,
          directory_type: account.role === 'student' ? 'student' : 'teacher',
          student_id: account.game_student_id || null,
          student_name: account.role === 'student' ? account.name : null,
          teacher_id: account.employee_id || null,
          teacher_name: account.role === 'student' ? null : account.name,
          parent_name: null,
          parent_relationship: null,
        })));
    }
    if (sql.startsWith('select id, email, role, is_archived')) {
      const account = accounts.find((entry) => entry.id === Number(params[0]));
      return resultRows(account ? [account] : []);
    }
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      const account = accounts.find((entry) => entry.id === Number(params[0]));
      return resultRows(account ? [account] : []);
    }
    if (sql.includes('from public.teacher_student_relationships relationship') && sql.includes('join public.accounts student')) {
      return resultRows(relationships.map((relationship) => {
        const student = accounts.find((entry) => entry.id === relationship.student_id);
        return {
          relationship_id: relationship.id,
          student_id: student.id,
          student_name: student.name,
          game_student_id: student.game_student_id,
          grade_level: student.grade_level,
          section: student.section,
          is_archived: student.is_archived,
        };
      }));
    }
    if (sql.includes('other_parent')) return emptyResult;
    if (sql.startsWith('delete from public.accounts') && sql.includes('any')) {
      const deletedIds = params[0].map(Number);
      const deleted = accounts.filter((account) => deletedIds.includes(account.id));
      accounts = accounts.filter((account) => !deletedIds.includes(account.id));
      relationships = relationships.filter((relationship) => !deletedIds.includes(relationship.student_id));
      return resultRows(deleted.map(({ id, game_student_id }) => ({ id, game_student_id })));
    }
    if (sql.startsWith('delete from public.accounts')) {
      const deletedId = Number(params[0]);
      const deleted = accounts.find((account) => account.id === deletedId);
      accounts = accounts.filter((account) => account.id !== deletedId);
      relationships = relationships.filter((relationship) => relationship.teacher_id !== deletedId);
      return resultRows(deleted ? [deleted] : []);
    }
    return emptyResult;
  };
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const directoryBefore = await requestJson(baseUrl, '/api/admin/id-directory', {
    headers: { Authorization: 'Bearer admin' },
  });
  const response = await requestJson(baseUrl, '/api/accounts/19?permanent=true', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({ reason: 'Duplicate family account', permanent_confirmation: 'DELETE' }),
  });
  const directoryAfter = await requestJson(baseUrl, '/api/admin/id-directory', {
    headers: { Authorization: 'Bearer admin' },
  });

  assert.equal(directoryBefore.status, 200);
  assert.deepEqual(directoryBefore.body.students.map((student) => student.student_id), ['00123456']);
  assert.equal(response.status, 200);
  assert.equal(response.body.deleted_child_count, 1);
  assert.equal(directoryAfter.status, 200);
  assert.deepEqual(directoryAfter.body.students, []);
  assert.deepEqual(accounts, []);
  assert.deepEqual(relationships, []);
  assert.equal(connectCount, 1);
  assert.ok(queries.some(({ sql }) => sql === 'begin'));
  assert.ok(queries.some(({ sql }) => sql.startsWith('delete from public.game_results')));
  assert.ok(queries.some(({ sql }) => sql.startsWith('delete from public.playtime_sessions')));
  assert.ok(queries.some(({ sql }) => sql.startsWith('delete from public.accounts') && sql.includes('any')));
  assert.ok(queries.some(({ sql }) => sql === 'commit'));
});

test('Admin lists and atomically links another eligible existing child', async (t) => {
  reset();
  queryHandler = async (sql, params) => {
    if (sql.includes('from public.teacher_student_relationships relationship') && sql.includes('grade_level')) {
      return resultRows([{ relationship_id: 7, student_id: 44, student_name: 'Ava Santos', game_student_id: '00123456', grade_level: 'Grade 1', section: 'Amethyst' }]);
    }
    if (sql.includes('from public.accounts') && !sql.includes(' s ')
        && (sql.includes('for update') || sql.startsWith('select id, name, email, role, parent_id, is_archived'))) {
      return resultRows([{ id: 19, role: 'parent', parent_id: '112832', is_archived: false }]);
    }
    if (sql.includes('from public.accounts s') && sql.includes("where replace(s.game_student_id, '-', '') = $1")) {
      return resultRows([{ id: 45, name: 'Noah Santos', game_student_id: params[0], grade_level: 'Grade 1', section: 'Amber', is_archived: false }]);
    }
    if (sql.includes('active_parent_relationship')) return emptyResult;
    if (sql.startsWith('select id from public.teacher_student_relationships')) return emptyResult;
    if (sql.startsWith('insert into public.teacher_student_relationships')) return resultRows([{ id: 8 }]);
    return emptyResult;
  };
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const listed = await requestJson(baseUrl, '/api/accounts/19/children', { headers: { Authorization: 'Bearer admin' } });
  const linked = await requestJson(baseUrl, '/api/accounts/19/children', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({ children: [{ operation: 'link', student_id: '00123457' }] }),
  });

  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.children[0], {
    relationship_id: 7,
    student_id: 44,
    student_name: 'Ava Santos',
    game_student_id: '00123456',
    grade_level: 'Grade 1',
    section: 'Amethyst',
    is_archived: false,
  });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.children[0].game_student_id, '00123457');
  assert.ok(queries.some(({ sql }) => sql === 'begin'));
  assert.ok(queries.some(({ sql }) => sql === 'commit'));
});

test('Admin can validate create/link Student IDs without writing and linked ownership stays protected', async (t) => {
  reset();
  let activeParent = false;
  queryHandler = async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes("where replace(s.game_student_id, '-', '') = $1")) {
      return resultRows([{ id: 45, name: 'Noah Santos', game_student_id: params[0], is_archived: false }]);
    }
    if (sql.includes('active_parent_relationship')) {
      return activeParent ? resultRows([{ active_parent_relationship: true }]) : emptyResult;
    }
    return emptyResult;
  };
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const available = await requestJson(baseUrl, '/api/accounts/student-link-eligibility?student_id=001234&operation=link', {
    headers: { Authorization: 'Bearer admin' },
  });
  activeParent = true;
  const owned = await requestJson(baseUrl, '/api/accounts/student-link-eligibility?student_id=001234&operation=link', {
    headers: { Authorization: 'Bearer admin' },
  });
  const invalid = await requestJson(baseUrl, '/api/accounts/student-link-eligibility?student_id=123&operation=link', {
    headers: { Authorization: 'Bearer admin' },
  });
  const forbidden = await requestJson(baseUrl, '/api/accounts/student-link-eligibility?student_id=001234&operation=link', {
    headers: { Authorization: 'Bearer parent' },
  });

  assert.equal(available.status, 200);
  assert.deepEqual(available.body, { available: true, student_id: '001234', operation: 'link' });
  assert.equal(owned.status, 409);
  assert.equal(owned.body.error, 'This Student is already linked to a Parent account.');
  assert.equal(invalid.status, 400);
  assert.equal(forbidden.status, 403);
  assert.equal(queries.some(({ sql }) => /^(insert|update|delete|begin|commit)/.test(sql)), false);
});

test('Admin unlink requires a reason, preserves the Student, and permanent deletion requires typed confirmation', async (t) => {
  reset();
  queryHandler = async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return resultRows([{ id: 19, role: 'parent', parent_id: '112832', is_archived: false }]);
    }
    if (sql.startsWith('delete from public.teacher_student_relationships')) {
      return resultRows([{ id: 7, teacher_id: 19, student_id: 44, relationship_type: 'Parent' }]);
    }
    return emptyResult;
  };
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const rejected = await requestJson(baseUrl, '/api/accounts/19/children/44?permanent=true', {
    method: 'DELETE', headers: { Authorization: 'Bearer admin' }, body: JSON.stringify({}),
  });
  const missingReason = await requestJson(baseUrl, '/api/accounts/19/children/44', {
    method: 'DELETE', headers: { Authorization: 'Bearer admin' }, body: JSON.stringify({}),
  });
  const unlinked = await requestJson(baseUrl, '/api/accounts/19/children/44', {
    method: 'DELETE', headers: { Authorization: 'Bearer admin' }, body: JSON.stringify({ reason: 'Incorrect Parent relationship' }),
  });

  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /type delete/i);
  assert.equal(missingReason.status, 400);
  assert.match(missingReason.body.error, /reason/i);
  assert.equal(unlinked.status, 200);
  assert.equal(queries.some(({ sql }) => sql.startsWith('delete from public.accounts')), false);
  const unlinkAudit = queries.find(({ sql, params }) => sql.startsWith('insert into public.admin_audit_logs') && params.includes('Incorrect Parent relationship'));
  assert.ok(unlinkAudit);
  assert.equal(unlinkAudit.params[4], 44);
  assert.deepEqual(JSON.parse(unlinkAudit.params[7]), {
    relationship_id: 7,
    parent_account_id: 19,
    student_account_id: 44,
    relationship_type: 'Parent',
  });
  assert.deepEqual(JSON.parse(unlinkAudit.params[8]), {
    relationship_removed: true,
    student_account_preserved: true,
  });
});

test('Parent and Parent-Teacher cannot list, add, unlink, or delete managed children', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  for (const token of ['parent', 'parentTeacher']) {
    for (const [path, options] of [
      ['/api/accounts/19/children', {}],
      ['/api/accounts/19/children', { method: 'POST', body: JSON.stringify({ children: [] }) }],
      ['/api/accounts/19/children/44', { method: 'DELETE' }],
      ['/api/accounts/19/children/44?permanent=true', { method: 'DELETE', body: JSON.stringify({ permanent_confirmation: 'DELETE' }) }],
    ]) {
      const response = await requestJson(baseUrl, path, { ...options, headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 403);
    }
  }
  assert.equal(connectCount, 0);
});
