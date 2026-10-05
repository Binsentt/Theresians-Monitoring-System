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

test('unlinking a Parent-child relationship preserves the active Student directory row', async (t) => {
  reset();
  const accounts = [
    { id: 44, role: 'student', game_student_id: '00440001', name: 'Unlinked Student', is_archived: false },
    { id: 45, role: 'student', game_student_id: '00450001', name: 'Other Student', is_archived: false },
  ];
  const relationships = [
    { id: 7, teacher_id: 19, student_id: 44, relationship_type: 'Parent' },
    { id: 8, teacher_id: 19, student_id: 45, relationship_type: 'Parent' },
  ];
  const progressStudentIds = [44, 45];
  queryHandler = async (sql, params) => {
    if (sql.includes('from public.accounts a') && sql.includes('teacher_student_relationships')) {
      const archived = sql.includes('coalesce(a.is_archived, false) = true');
      return resultRows(accounts.filter((account) => Boolean(account.is_archived) === archived).map((account) => ({
        ...account,
        directory_type: 'student',
        student_id: account.game_student_id,
        student_name: account.name,
      })));
    }
    if (sql.startsWith('select id, name, email, role, parent_id, is_archived from public.accounts where id = $1')) {
      return resultRows([{ id: 19, role: 'parent', parent_id: '000019', is_archived: false }]);
    }
    if (sql.startsWith('delete from public.teacher_student_relationships')) {
      const index = relationships.findIndex((relationship) => relationship.teacher_id === Number(params[0]) && relationship.student_id === Number(params[1]));
      if (index < 0) return emptyResult;
      return resultRows([relationships.splice(index, 1)[0]]);
    }
    if (sql.startsWith('insert into public.admin_audit_logs')) return resultRows([{ id: 1 }]);
    return emptyResult;
  };

  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const before = await requestJson(baseUrl, '/api/admin/id-directory?archived=false', { Authorization: 'Bearer admin' });
  assert.deepEqual(before.body.students.map((student) => student.student_id), ['00440001', '00450001']);
  const unlinked = await requestWithOptions(baseUrl, '/api/accounts/19/children/44', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({ reason: 'Relationship cleanup only.' }),
  });
  assert.equal(unlinked.status, 200);
  const after = await requestJson(baseUrl, '/api/admin/id-directory?archived=false', { Authorization: 'Bearer admin' });
  assert.deepEqual(after.body.students.map((student) => student.student_id), ['00440001', '00450001']);
  assert.equal(relationships.some((relationship) => relationship.student_id === 44), false);
  assert.deepEqual(progressStudentIds, [44, 45]);
});

test('permanently deleting one Student removes its directory row and leaves the other Student untouched', async (t) => {
  reset();
  let accounts = [
    { id: 44, role: 'student', game_student_id: '00440001', name: 'Deleted Student', is_archived: false },
    { id: 45, role: 'student', game_student_id: '00450001', name: 'Retained Student', is_archived: false },
  ];
  const relationships = [
    { id: 7, teacher_id: 19, student_id: 44, relationship_type: 'Parent' },
    { id: 8, teacher_id: 19, student_id: 45, relationship_type: 'Parent' },
  ];
  let gameResultStudentIds = [44, 45];
  let playtimeStudentIds = [44, 45];
  let progressStudentIds = [44, 45];
  queryHandler = async (sql, params) => {
    if (sql.includes('from public.accounts a') && sql.includes('teacher_student_relationships')) {
      const archived = sql.includes('coalesce(a.is_archived, false) = true');
      return resultRows(accounts.filter((account) => Boolean(account.is_archived) === archived).map((account) => ({
        ...account,
        directory_type: 'student',
        student_id: account.game_student_id,
        student_name: account.name,
      })));
    }
    if (sql.includes('from public.accounts parent') && sql.includes('join public.teacher_student_relationships')) {
      const student = accounts.find((account) => account.id === Number(params[1]));
      const relationship = relationships.find((entry) => entry.teacher_id === Number(params[0]) && entry.student_id === Number(params[1]));
      return student && relationship ? resultRows([{
        parent_id: 19,
        parent_code: '000019',
        parent_role: 'parent',
        parent_is_archived: false,
        student_id: student.id,
        student_name: student.name,
        game_student_id: student.game_student_id,
      }]) : emptyResult;
    }
    if (sql.includes('other_parent')) return emptyResult;
    if (sql.startsWith('delete from public.game_results')) {
      gameResultStudentIds = gameResultStudentIds.filter((id) => !params[0].includes(id));
      return emptyResult;
    }
    if (sql.startsWith('delete from public.playtime_sessions')) {
      playtimeStudentIds = playtimeStudentIds.filter((id) => !params[0].includes(id));
      return emptyResult;
    }
    if (sql.startsWith('delete from public.accounts') && sql.includes('where id = any')) {
      const selectedIds = params[0];
      const deleted = accounts.filter((account) => selectedIds.includes(account.id));
      accounts = accounts.filter((account) => !selectedIds.includes(account.id));
      relationships.splice(0, relationships.length, ...relationships.filter((relationship) => !selectedIds.includes(relationship.student_id)));
      progressStudentIds = progressStudentIds.filter((id) => !selectedIds.includes(id));
      return resultRows(deleted.map(({ id, game_student_id }) => ({ id, game_student_id })));
    }
    if (sql.startsWith('insert into public.admin_audit_logs')) return resultRows([{ id: 1 }]);
    return emptyResult;
  };

  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const deleted = await requestWithOptions(baseUrl, '/api/accounts/19/children/44?permanent=true', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({ reason: 'Duplicate Student record.', permanent_confirmation: 'DELETE' }),
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted_student.game_student_id, '00440001');
  const activeDirectory = await requestJson(baseUrl, '/api/admin/id-directory?archived=false', { Authorization: 'Bearer admin' });
  const archivedDirectory = await requestJson(baseUrl, '/api/admin/id-directory?archived=true', { Authorization: 'Bearer admin' });
  assert.deepEqual(activeDirectory.body.students.map((student) => student.student_id), ['00450001']);
  assert.equal(archivedDirectory.body.students.some((student) => student.student_id === '00440001'), false);
  assert.deepEqual(gameResultStudentIds, [45]);
  assert.deepEqual(playtimeStudentIds, [45]);
  assert.deepEqual(progressStudentIds, [45]);
  assert.deepEqual(relationships.map((relationship) => relationship.student_id), [45]);
});

test('individual Student archive and restore use account lifecycle while preserving the Student record', async (t) => {
  reset();
  const student = {
    id: 44,
    name: 'Formerly Active Student',
    email: 'student@example.test',
    role: 'student',
    game_student_id: '00440001',
    is_archived: false,
    session_version: 0,
  };
  const directorySql = [];
  const mutations = [];
  const dataDeleteSql = [];
  queryHandler = async (sql, params) => {
    if (/^delete from public\.(game_results|playtime_sessions|student_game_progress|student_quest_milestones|student_ai_insights)/.test(sql)) dataDeleteSql.push(sql);
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
      return resultRows([{ ...student }]);
    }
    if (sql.startsWith('select id, role, is_archived from public.accounts where id = $1')) {
      return resultRows([{ ...student }]);
    }
    if (sql.includes('from public.accounts a') && sql.includes('teacher_student_relationships')) {
      directorySql.push(sql);
      const archived = sql.includes('coalesce(a.is_archived, false) = true');
      return resultRows(student.is_archived === archived ? [{
        ...student,
        directory_type: 'student',
        student_id: student.game_student_id,
        student_name: student.name,
        parent_name: null,
        parent_relationship: null,
      }] : []);
    }
    if (sql.startsWith('update public.accounts set is_archived = true')) {
      mutations.push('archive');
      student.is_archived = true;
      student.status = 'Offline';
      student.session_version += 1;
      return resultRows([{ ...student }]);
    }
    if (sql.startsWith('update public.accounts set is_archived = false')) {
      mutations.push('restore');
      student.is_archived = false;
      student.session_version += 1;
      return resultRows([{ ...student }]);
    }
    if (sql.startsWith('insert into public.admin_audit_logs')) return resultRows([{ id: 1 }]);
    return emptyResult;
  };

  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const archived = await requestWithOptions(baseUrl, '/api/accounts/44', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({ reason: 'Student transferred schools.' }),
  });
  assert.equal(archived.status, 200);
  assert.equal(student.is_archived, true);
  assert.deepEqual(mutations, ['archive']);
  assert.equal((await requestJson(baseUrl, '/api/admin/id-directory?archived=false', { Authorization: 'Bearer admin' })).body.students.length, 0);
  assert.equal((await requestJson(baseUrl, '/api/admin/id-directory?archived=true', { Authorization: 'Bearer admin' })).body.students[0].student_id, '00440001');
  assert.deepEqual(dataDeleteSql, []);

  const restored = await requestWithOptions(baseUrl, '/api/accounts/44/restore', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin' },
    body: JSON.stringify({}),
  });
  assert.equal(restored.status, 200);
  assert.equal(student.is_archived, false);
  assert.equal((await requestJson(baseUrl, '/api/admin/id-directory?archived=false', { Authorization: 'Bearer admin' })).body.students[0].student_id, '00440001');
  assert.deepEqual(mutations, ['archive', 'restore']);
  assert.equal(directorySql.length, 3);
});
