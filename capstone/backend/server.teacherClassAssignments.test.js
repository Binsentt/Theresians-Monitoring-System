const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
const authenticatedAccounts = {
  1: { id: 1, role: 'admin', session_version: 0, is_archived: false },
  16: { id: 16, role: 'teacher', session_version: 0, is_archived: false },
  17: { id: 17, role: 'teacher', session_version: 0, is_archived: false },
  19: { id: 19, role: 'parent', parent_id: '112832', session_version: 0, is_archived: false },
  20: { id: 20, role: 'parent_teacher', parent_id: '112833', session_version: 0, is_archived: false },
  21: { id: 21, role: 'parent', parent_id: '112834', session_version: 0, is_archived: false },
};
const tokenPayloads = {
  admin: { userId: 1, sessionVersion: 0 },
  teacher: { userId: 16, sessionVersion: 0 },
  otherTeacher: { userId: 17, sessionVersion: 0 },
  parent: { userId: 19, sessionVersion: 0 },
  parentTeacher: { userId: 20, sessionVersion: 0 },
  otherParent: { userId: 21, sessionVersion: 0 },
};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const resultRows = (rows) => ({ rows });
const runQuery = async (sql, params = []) => {
  const compacted = compactSql(sql);
  if (compacted.startsWith('select * from public.accounts where id = $1')) {
    const account = authenticatedAccounts[Number(params[0])];
    return account ? resultRows([account]) : emptyResult;
  }
  return (await queryHandler(compacted, params, sql)) || emptyResult;
};

const mockPool = {
  query: runQuery,
  connect: async () => ({ query: runQuery, release: () => {} }),
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const passthrough = () => (req, res, next) => next();
const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => value };
  if (request === 'cors') return () => passthrough();
  if (request === 'jsonwebtoken') {
    return {
      sign: () => 'token',
      verify: (token) => tokenPayloads[token] || {},
    };
  }
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

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });
const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const requestJson = async (baseUrl, pathInput, options = {}) => {
  const response = await fetch(`${baseUrl}${pathInput}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
};

const canonicalZeroGameplayStudent = {
  student_id: 44,
  student_name: 'Ava Santos',
  student_email: 'game-student@example.invalid',
  student_role: 'student',
  game_student_id: '001234',
  grade_level: 'Grade 3',
  section: 'Rizal',
  score: null,
  correct_answers: null,
  total_questions: null,
  accuracy_rate: null,
  progress_percentage: null,
  current_quest: null,
  current_scene: null,
  current_map: null,
  difficulty_level: null,
  last_played: null,
};

const isCanonicalProgressQuery = (sql) => (
  sql.includes('from public.accounts a')
  && sql.includes("lower(a.role) = 'student'")
  && sql.includes('left join lateral')
  && sql.includes('student_game_progress')
);

test('teacher class assignment migration is additive and enforces authoritative normalized class scope', () => {
  const migrationPath = path.join(__dirname, 'migrations', '008_add_teacher_class_assignments.sql');
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(migration, /create table if not exists public\.teacher_class_assignments/i);
  assert.match(migration, /teacher_account_id/i);
  assert.match(migration, /created_by_admin/i);
  assert.match(migration, /grade_level.*grade 1.*grade 6/is);
  assert.match(migration, /section_key/i);
  assert.match(migration, /unique.*teacher_account_id.*grade_level.*section_key/is);
  assert.match(migration, /teacher.*parent_teacher/is);
  assert.doesNotMatch(migration, /\b(drop\s+table|truncate|delete\s+from)\b/i);
});

test('only an Admin can create, update, list, and remove a normalized teacher class assignment', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const assignment = {
    id: 71,
    teacher_account_id: 16,
    grade_level: 'Grade 3',
    section: 'Rizal',
    section_key: 'rizal',
  };
  let insertParams = null;
  let duplicateInsert = false;
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  queryHandler = async (sql, params) => {
    if (sql.startsWith('select id, role, is_archived from public.accounts where id = $1')) {
      return resultRows([{ id: 16, role: 'teacher', is_archived: false }]);
    }
    if (sql.startsWith('insert into public.teacher_class_assignments')) {
      insertParams = params;
      return duplicateInsert ? emptyResult : resultRows([assignment]);
    }
    if (sql.startsWith('select id, teacher_account_id, grade_level, section, section_key')) {
      return resultRows([assignment]);
    }
    if (sql.startsWith('update public.teacher_class_assignments')) {
      return resultRows([{ ...assignment, grade_level: 'Grade 4', section: 'Mabini', section_key: 'mabini' }]);
    }
    if (sql.startsWith('delete from public.teacher_class_assignments')) return resultRows([assignment]);
    return emptyResult;
  };

  const nonAdmin = await requestJson(baseUrl, '/api/teacher-class-assignments', {
    method: 'POST',
    headers: authHeaders('teacher'),
    body: JSON.stringify({ teacherId: 16, grade_level: 'Grade 3', section: 'Rizal' }),
  });
  assert.equal(nonAdmin.status, 403);

  const nonAdminList = await requestJson(baseUrl, '/api/teacher-class-assignments?teacherId=16', { headers: authHeaders('teacher') });
  assert.equal(nonAdminList.status, 403);

  const created = await requestJson(baseUrl, '/api/teacher-class-assignments', {
    method: 'POST',
    headers: authHeaders('admin'),
    body: JSON.stringify({ teacherId: 16, grade_level: 'Grade 3', section: '  Rizal  ' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.assignment.section, 'Rizal');
  assert.deepEqual(insertParams.slice(0, 4), [16, 'Grade 3', 'Rizal', 'rizal']);

  duplicateInsert = true;
  const duplicate = await requestJson(baseUrl, '/api/teacher-class-assignments', {
    method: 'POST',
    headers: authHeaders('admin'),
    body: JSON.stringify({ teacherId: 16, grade_level: 'Grade 3', section: 'rizal' }),
  });
  assert.equal(duplicate.status, 409);

  const listed = await requestJson(baseUrl, '/api/teacher-class-assignments?teacherId=16', { headers: authHeaders('admin') });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.assignments, [assignment]);

  const updated = await requestJson(baseUrl, '/api/teacher-class-assignments/71', {
    method: 'PUT',
    headers: authHeaders('admin'),
    body: JSON.stringify({ grade_level: 'Grade 4', section: 'Mabini' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.assignment.section_key, 'mabini');

  const nonAdminUpdate = await requestJson(baseUrl, '/api/teacher-class-assignments/71', {
    method: 'PUT',
    headers: authHeaders('teacher'),
    body: JSON.stringify({ grade_level: 'Grade 4', section: 'Mabini' }),
  });
  assert.equal(nonAdminUpdate.status, 403);

  const removed = await requestJson(baseUrl, '/api/teacher-class-assignments/71', {
    method: 'DELETE',
    headers: authHeaders('admin'),
  });
  assert.equal(removed.status, 200);

  const nonAdminDelete = await requestJson(baseUrl, '/api/teacher-class-assignments/71', {
    method: 'DELETE',
    headers: authHeaders('teacher'),
  });
  assert.equal(nonAdminDelete.status, 403);
});

test('class assignment grants only the matching teacher automatic canonical zero-gameplay visibility', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let classMatches = true;
  const observedScopeSql = [];
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  queryHandler = async (sql, params) => {
    if (isCanonicalProgressQuery(sql)) {
      observedScopeSql.push({ sql, params });
      if (!sql.includes('teacher_class_assignments')) return emptyResult;
      if (params.includes(17) || !classMatches) return emptyResult;
      return resultRows([canonicalZeroGameplayStudent]);
    }
    return emptyResult;
  };

  const assignedTeacher = await requestJson(baseUrl, '/api/students/progress?teacher_id=17', { headers: authHeaders('teacher') });
  assert.equal(assignedTeacher.status, 200);
  assert.equal(assignedTeacher.body.length, 1);
  assert.equal(assignedTeacher.body[0].game_student_id, '001234');
  assert.equal(assignedTeacher.body[0].correct_answers, null);
  assert.equal(assignedTeacher.body[0].accuracy_rate, null);

  const unrelatedTeacher = await requestJson(baseUrl, '/api/students/progress?teacher_id=16', { headers: authHeaders('otherTeacher') });
  assert.equal(unrelatedTeacher.status, 200);
  assert.deepEqual(unrelatedTeacher.body, []);

  classMatches = false;
  const afterGradeOrSectionChange = await requestJson(baseUrl, '/api/students/progress', { headers: authHeaders('teacher') });
  assert.equal(afterGradeOrSectionChange.status, 200);
  assert.deepEqual(afterGradeOrSectionChange.body, []);

  const teacherScope = observedScopeSql.find((entry) => entry.params.includes(16));
  assert.match(teacherScope.sql, /teacher_class_assignments/);
  assert.match(teacherScope.sql, /teacher_student_relationships/);
  assert.match(teacherScope.sql, /lower\(tsr\.relationship_type\) = 'teacher'/);
});

test('Parent/Teacher keeps assigned-class teacher scope and parent-child scope isolated', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let teacherScopeSql = '';
  let parentScopeSql = '';
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  queryHandler = async (sql, params) => {
    if (isCanonicalProgressQuery(sql) && params.includes(20)) {
      if (sql.includes("lower(tsr.relationship_type) = 'parent'")) {
        parentScopeSql = sql;
        return resultRows([canonicalZeroGameplayStudent]);
      }
      teacherScopeSql = sql;
      return resultRows([canonicalZeroGameplayStudent]);
    }
    if (isCanonicalProgressQuery(sql) && params.includes(21)) return emptyResult;
    return emptyResult;
  };

  const teacherContext = await requestJson(baseUrl, '/api/students/progress', { headers: authHeaders('parentTeacher') });
  const parentContext = await requestJson(baseUrl, '/api/students/progress?scope=parent', { headers: authHeaders('parentTeacher') });
  const unrelatedParent = await requestJson(baseUrl, '/api/students/progress?scope=parent', { headers: authHeaders('otherParent') });

  assert.equal(teacherContext.status, 200);
  assert.equal(teacherContext.body.length, 1);
  assert.equal(parentContext.status, 200);
  assert.equal(parentContext.body.length, 1);
  assert.deepEqual(unrelatedParent.body, []);
  assert.match(teacherScopeSql, /teacher_class_assignments/);
  assert.doesNotMatch(teacherScopeSql, /lower\(tsr\.relationship_type\) = 'parent'/);
  assert.match(parentScopeSql, /lower\(tsr\.relationship_type\) = 'parent'/);
  assert.doesNotMatch(parentScopeSql, /teacher_class_assignments/);
});

test('Teacher-facing analytics, activity, playtime, and student-detail routes share the class-derived scope', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const scopedQueries = [];
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  queryHandler = async (sql) => {
    if (sql.includes('teacher_class_assignments')) scopedQueries.push(sql);
    if (sql.startsWith('select 1') && sql.includes('from public.accounts child')) return resultRows([{ allowed: true }]);
    if (isCanonicalProgressQuery(sql)) return resultRows([canonicalZeroGameplayStudent]);
    if (sql.includes('from public.student_game_progress p')) return emptyResult;
    if (sql.includes('from public.activity_logs al') && sql.includes('count(*) as total')) return resultRows([{ total: 0 }]);
    if (sql.includes('from public.activity_logs al')) return emptyResult;
    if (sql.includes('from public.playtime_sessions ps') && sql.includes('count(*)::integer as total')) return resultRows([{ total: 0 }]);
    if (sql.includes('from public.playtime_sessions ps')) return emptyResult;
    if (sql.includes('from public.game_results') || sql.includes('from public.playtime_sessions') || sql.includes('from public.student_ai_insights')) return emptyResult;
    return emptyResult;
  };

  const [topAchievers, activityLog, screenTime, studentDetail] = await Promise.all([
    requestJson(baseUrl, '/api/top-achievers', { headers: authHeaders('teacher') }),
    requestJson(baseUrl, '/api/activity-logs', { headers: authHeaders('teacher') }),
    requestJson(baseUrl, '/api/playtime', { headers: authHeaders('teacher') }),
    requestJson(baseUrl, '/api/student-progress/44', { headers: authHeaders('teacher') }),
  ]);

  assert.equal(topAchievers.status, 200);
  assert.equal(activityLog.status, 200);
  assert.equal(screenTime.status, 200);
  assert.equal(studentDetail.status, 200);
  assert.ok(scopedQueries.length >= 5);
  scopedQueries.forEach((sql) => {
    assert.match(sql, /teacher_class_assignments/);
    assert.match(sql, /teacher_student_relationships/);
  });
});
