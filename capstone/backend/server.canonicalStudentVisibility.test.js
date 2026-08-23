const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let authenticatedAccounts = {
  1: { id: 1, role: 'admin', session_version: 0, is_archived: false },
  16: { id: 16, role: 'teacher', session_version: 0, is_archived: false },
  17: { id: 17, role: 'teacher', session_version: 0, is_archived: false },
  19: { id: 19, role: 'parent', parent_id: '112832', session_version: 0, is_archived: false },
  20: { id: 20, role: 'parent_teacher', parent_id: '112833', session_version: 0, is_archived: false },
};
let tokenPayloads = {
  admin: { userId: 1, sessionVersion: 0 },
  teacher: { userId: 16, sessionVersion: 0 },
  otherTeacher: { userId: 17, sessionVersion: 0 },
  parent: { userId: 19, sessionVersion: 0 },
  parentTeacher: { userId: 20, sessionVersion: 0 },
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
      verify: (token) => {
        const payload = tokenPayloads[token];
        if (payload instanceof Error) throw payload;
        return payload || {};
      },
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
const requestJson = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
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
  section: 'Section A',
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

test('canonical students remain visible before gameplay through only their authenticated scope', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  const observedScopes = [];
  queryHandler = async (sql, params) => {
    if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) {
      return resultRows([{ linked: true }]);
    }
    if (isCanonicalProgressQuery(sql)) {
      observedScopes.push({ sql, params });
      if (params.includes(17)) return emptyResult;
      return resultRows([canonicalZeroGameplayStudent]);
    }
    if (sql.includes('from public.game_results') || sql.includes('from public.activity_logs') || sql.includes('from public.playtime_sessions') || sql.includes('from public.student_ai_insights')) {
      return emptyResult;
    }
    return emptyResult;
  };

  const admin = await requestJson(baseUrl, '/api/students/progress', { headers: authHeaders('admin') });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.length, 1);
  assert.equal(admin.body[0].student_id, 44);
  assert.equal(admin.body[0].game_student_id, '001234');
  assert.equal(admin.body[0].grade_level, 'Grade 3');
  assert.equal(admin.body[0].section, 'Section A');
  assert.equal(admin.body[0].correct_answers, null);
  assert.equal(admin.body[0].total_questions, null);
  assert.equal(admin.body[0].accuracy_rate, null);
  assert.equal(admin.body[0].difficultyBreakdown.easy.accuracy, null);

  const teacher = await requestJson(baseUrl, '/api/students/progress?teacher_id=999', { headers: authHeaders('teacher') });
  assert.equal(teacher.status, 200);
  assert.equal(teacher.body.length, 1);

  const unrelatedTeacher = await requestJson(baseUrl, '/api/students/progress?teacher_id=16', { headers: authHeaders('otherTeacher') });
  assert.equal(unrelatedTeacher.status, 200);
  assert.deepEqual(unrelatedTeacher.body, []);

  const parent = await requestJson(baseUrl, '/api/students/progress?parent_id=999', { headers: authHeaders('parent') });
  assert.equal(parent.status, 200);
  assert.equal(parent.body.length, 1);
  assert.equal(parent.body[0].game_student_id, '001234');

  const teacherScope = observedScopes.find((entry) => entry.params.includes(16));
  const otherTeacherScope = observedScopes.find((entry) => entry.params.includes(17));
  const parentScope = observedScopes.find((entry) => entry.params.includes(19));
  assert.ok(teacherScope?.sql.includes('from public.teacher_student_relationships tsr'));
  assert.ok(otherTeacherScope?.sql.includes('from public.teacher_student_relationships tsr'));
  assert.ok(parentScope?.sql.includes("lower(tsr.relationship_type) = 'parent'"));
});

test('Parent/Teacher keeps its teacher and parent scopes distinct for the same canonical child', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  let teacherScopeSql = '';
  let parentScopeSql = '';
  queryHandler = async (sql, params) => {
    if (isCanonicalProgressQuery(sql) && params.includes(20)) {
      if (sql.includes("lower(tsr.relationship_type) = 'parent'")) {
        parentScopeSql = sql;
        return resultRows([canonicalZeroGameplayStudent]);
      }
      teacherScopeSql = sql;
      return emptyResult;
    }
    return emptyResult;
  };

  const teacherContext = await requestJson(baseUrl, '/api/students/progress', { headers: authHeaders('parentTeacher') });
  const parentContext = await requestJson(baseUrl, '/api/students/progress?scope=parent', { headers: authHeaders('parentTeacher') });

  assert.equal(teacherContext.status, 200);
  assert.deepEqual(teacherContext.body, []);
  assert.equal(parentContext.status, 200);
  assert.equal(parentContext.body.length, 1);
  assert.ok(teacherScopeSql.includes("lower(tsr.relationship_type) = 'teacher'"));
  assert.ok(parentScopeSql.includes("lower(tsr.relationship_type) = 'parent'"));
});

test('teacher-student assignment management is Admin-only', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  queryHandler = async (sql) => {
    if (sql.includes('from public.teacher_student_relationships r')) return resultRows([]);
    return emptyResult;
  };

  const anonymousGet = await requestJson(baseUrl, '/api/teacher-student-relationships?teacherId=16');
  const teacherGet = await requestJson(baseUrl, '/api/teacher-student-relationships?teacherId=16', { headers: authHeaders('teacher') });
  const anonymousPost = await requestJson(baseUrl, '/api/teacher-student-relationships', {
    method: 'POST',
    body: JSON.stringify({ teacherId: 16, studentEmail: 'student@example.invalid' }),
  });
  const anonymousDelete = await requestJson(baseUrl, '/api/teacher-student-relationships/9', { method: 'DELETE' });
  const adminGet = await requestJson(baseUrl, '/api/teacher-student-relationships?teacherId=16', { headers: authHeaders('admin') });

  assert.equal(anonymousGet.status, 401);
  assert.equal(teacherGet.status, 403);
  assert.equal(anonymousPost.status, 401);
  assert.equal(anonymousDelete.status, 401);
  assert.equal(adminGet.status, 200);
});

test('an authenticated parent can open a canonical zero-gameplay child analysis without invented metrics', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  queryHandler = async (sql) => {
    if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) {
      return resultRows([{ linked: true }]);
    }
    if (isCanonicalProgressQuery(sql)) return resultRows([canonicalZeroGameplayStudent]);
    if (sql.includes('from public.game_results') || sql.includes('from public.activity_logs') || sql.includes('from public.playtime_sessions') || sql.includes('from public.student_ai_insights')) {
      return emptyResult;
    }
    return emptyResult;
  };

  const response = await requestJson(baseUrl, '/api/student-progress/44?scope=parent', { headers: authHeaders('parent') });
  assert.equal(response.status, 200);
  assert.equal(response.body.progress.game_student_id, '001234');
  assert.equal(response.body.progress.grade_level, 'Grade 3');
  assert.equal(response.body.progress.section, 'Section A');
  assert.equal(response.body.metrics.correctAnswers, null);
  assert.equal(response.body.metrics.totalQuestions, null);
  assert.equal(response.body.metrics.accuracy, null);
  assert.equal(response.body.metrics.totalProgress, null);
});
