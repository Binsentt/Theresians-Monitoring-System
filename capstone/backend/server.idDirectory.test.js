const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let tokenPayloads = {};
let authenticatedAccounts = {};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const resultRows = (rows) => ({ rows });
const mockPool = {
  query: async (sql, params = []) => {
    const normalizedSql = compactSql(sql);
    if (normalizedSql.startsWith('select * from public.accounts where id = $1')) {
      const account = authenticatedAccounts[Number(params[0])];
      return account ? resultRows([account]) : emptyResult;
    }
    return (await queryHandler(normalizedSql, params, sql)) || emptyResult;
  },
  connect: async () => ({
    query: async (sql, params = []) => mockPool.query(sql, params),
    release: () => {},
  }),
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const middleware = () => (req, res, next) => next();
const originalLoad = Module._load;
let serverExports;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => value };
  if (request === 'cors') return () => middleware();
  if (request === 'jsonwebtoken') {
    return {
      sign: () => 'token',
      verify: (token) => tokenPayloads[token] || {},
    };
  }
  if (request === 'multer') return () => ({ single: middleware, array: middleware, fields: middleware });
  if (request === 'pdf-parse') return async () => ({ text: '' });
  return originalLoad.call(this, request, parent, isMain);
};
try {
  serverExports = require('./server');
} finally {
  Module._load = originalLoad;
}

const { app } = serverExports;
const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const requestJson = async (baseUrl, path, headers = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { headers: { ...headers } });
  return { status: response.status, body: await response.json() };
};
const requestWithOptions = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
};

const reset = () => {
  queryHandler = async () => emptyResult;
  tokenPayloads = {
    admin: { userId: 1, sessionVersion: 0 },
    teacher: { userId: 2, sessionVersion: 0 },
    parent: { userId: 3, sessionVersion: 0 },
    parentTeacher: { userId: 4, sessionVersion: 0 },
    student: { userId: 5, sessionVersion: 0 },
  };
  authenticatedAccounts = {
    1: { id: 1, role: 'admin', is_archived: false, session_version: 0 },
    2: { id: 2, role: 'teacher', is_archived: false, session_version: 0 },
    3: { id: 3, role: 'parent', is_archived: false, session_version: 0 },
    4: { id: 4, role: 'parent_teacher', is_archived: false, session_version: 0 },
    5: { id: 5, role: 'student', is_archived: false, session_version: 0 },
  };
};

test('ID Directory is server-protected and returns authoritative student and teacher rows', async (t) => {
  reset();
  let directorySql = '';
  queryHandler = async (sql) => {
    directorySql = sql;
    if (sql.includes('from public.accounts a') && sql.includes('teacher_student_relationships')) {
      return resultRows([
        {
          id: 20,
          directory_type: 'student',
          student_id: '00123456',
          student_name: 'Ana Santos',
          grade_level: 'Grade 4',
          section: 'St. Anne',
          parent_name: 'Paula Santos',
          parent_relationship: 'Parent',
          status: 'Active',
          is_archived: false,
        },
        {
          id: 21,
          directory_type: 'teacher',
          teacher_id: 'T-1001',
          teacher_name: 'Maria Cruz',
          email: 'maria@example.com',
          role: 'parent_teacher',
          status: 'Offline',
          is_archived: false,
        },
        {
          id: 22,
          directory_type: 'student',
          student_id: '00123457',
          student_name: 'Orphan Fixture Student',
          grade_level: 'Grade 4',
          section: 'St. Anne',
          parent_name: null,
          parent_relationship: null,
          status: 'Active',
          is_archived: false,
          progress_archived_at: '2026-09-09T00:00:00.000Z',
        },
      ]);
    }
    return emptyResult;
  };

  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  assert.equal((await requestJson(baseUrl, '/api/admin/id-directory')).status, 401);
  for (const token of ['teacher', 'parent', 'parentTeacher', 'student']) {
    assert.equal((await requestJson(baseUrl, '/api/admin/id-directory', { Authorization: `Bearer ${token}` })).status, 403);
  }

  const response = await requestJson(baseUrl, '/api/admin/id-directory', { Authorization: 'Bearer admin' });
  assert.equal(response.status, 200);
  assert.equal(response.body.students[0].student_id, '00123456');
  assert.equal(response.body.students[0].parent_name, 'Paula Santos');
  assert.equal(response.body.students[1].student_id, '00123457');
  assert.equal(response.body.students[1].parent_name, null);
  assert.equal(response.body.teachers[0].teacher_id, 'T-1001');
  assert.match(directorySql, /from public\.accounts a/);
  assert.match(directorySql, /teacher_student_relationships/);
  assert.doesNotMatch(directorySql, /id_directory/);
  assert.doesNotMatch(directorySql, /progress_archived_at/);
});

test('Teacher permanent deletion removes its directory ID without deleting Student accounts', async (t) => {
  reset();
  let accounts = [
    { id: 31, role: 'teacher', employee_id: 'T-3100', name: 'Archived Teacher', email: 'teacher@example.com', is_archived: true },
    { id: 44, role: 'student', game_student_id: '00440001', name: 'Preserved Student', status: 'Active', is_archived: false },
  ];

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
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
      const account = accounts.find((entry) => entry.id === Number(params[0]));
      return resultRows(account ? [account] : []);
    }
    if (sql.startsWith('delete from public.accounts where id = $1')) {
      const deletedId = Number(params[0]);
      accounts = accounts.filter((account) => account.id !== deletedId);
      return emptyResult;
    }
    return emptyResult;
  };

  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const archivedBefore = await requestJson(baseUrl, '/api/admin/id-directory?archived=true', { Authorization: 'Bearer admin' });
  assert.equal(archivedBefore.body.teachers.length, 1);

  const deleted = await requestWithOptions(baseUrl, '/api/accounts/31?permanent=true', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({ reason: 'Teacher left the school', permanent_confirmation: 'DELETE' }),
  });
  assert.equal(deleted.status, 200);

  const archivedAfter = await requestJson(baseUrl, '/api/admin/id-directory?archived=true', { Authorization: 'Bearer admin' });
  const activeAfter = await requestJson(baseUrl, '/api/admin/id-directory?archived=false', { Authorization: 'Bearer admin' });
  assert.equal(archivedAfter.body.teachers.length, 0);
  assert.equal(activeAfter.body.students.length, 1);
  assert.equal(activeAfter.body.students[0].student_id, '00440001');
});
