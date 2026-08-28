const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { buildStudentAnalyticsMetrics } = require('./studentAnalyticsMetrics.utils');
const { buildGroundedInsightInput, buildInsightFingerprint } = require('./studentAnalyticsInsight.utils');

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
      verify: (token) => {
        const payload = tokenPayloads[token];
        if (payload instanceof Error) throw payload;
        return payload || {};
      },
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

const requestGetWithJsonBody = (baseUrl, path, body, headers = {}) => new Promise((resolve, reject) => {
  const url = new URL(path, baseUrl);
  const serializedBody = JSON.stringify(body);
  const request = http.request({
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serializedBody),
      ...headers,
    },
  }, (response) => {
    response.resume();
    response.on('end', () => resolve(response.statusCode));
  });
  request.on('error', reject);
  request.end(serializedBody);
});

const reset = () => {
  queryHandler = async () => emptyResult;
  tokenPayloads = {
    admin: { userId: 1, sessionVersion: 0 },
    teacher: { userId: 2, sessionVersion: 0 },
    parentTeacher: { userId: 3, sessionVersion: 0 },
    parent: { userId: 4, sessionVersion: 0 },
    student: { userId: 5, sessionVersion: 0 },
    expired: { userId: 6, sessionVersion: 0, sessionExpiresAt: '2000-01-01T00:00:00.000Z' },
    invalid: new Error('invalid token'),
  };
  authenticatedAccounts = {
    1: { id: 1, role: 'admin', is_archived: false, session_version: 0 },
    2: { id: 2, role: 'teacher', is_archived: false, session_version: 0 },
    3: { id: 3, role: 'parent_teacher', is_archived: false, session_version: 0 },
    4: { id: 4, role: 'parent', is_archived: false, session_version: 0 },
    5: { id: 5, role: 'student', is_archived: false, session_version: 0 },
    6: { id: 6, role: 'teacher', is_archived: false, session_version: 0 },
  };
};

const protectedAnalyticsRoutes = [
  '/api/students',
  '/api/students/progress',
  '/api/analytics/overview',
  '/api/analytics/recommendations',
  '/api/students/progress-analysis',
  '/api/student-progress/44',
  '/api/top-achievers',
  '/api/leaderboard/top-achievers',
  '/api/activity-logs',
  '/api/playtime',
  '/api/playtime/my-children',
  '/api/playtime/today/44',
  '/api/parent/children',
  '/api/parent/children/44/quizzes',
  '/api/parent/children/44/topics',
];

const successfulAnalyticsQuery = async (sql) => {
  if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) {
    return resultRows([{ linked: true }]);
  }
  if (sql.startsWith('select count(*)') && sql.includes('from public.activity_logs')) {
    return resultRows([{ total: 0 }]);
  }
  if (sql.startsWith('select count(*)::integer as total') && sql.includes('from public.playtime_sessions')) {
    return resultRows([{ total: 0 }]);
  }
  if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
    return resultRows([{ total_playtime_today: 0 }]);
  }
  if (sql.includes('count(gr.id)::integer as unlinked_count')) {
    return resultRows([{ unlinked_count: 0 }]);
  }
  if (sql.startsWith('select p.*') && sql.includes('from public.student_game_progress p')) {
    return resultRows([{ student_id: 44, student_name: 'Scoped Student', score: 0, accuracy_rate: 0, progress_percentage: 0 }]);
  }
  return emptyResult;
};

test('private analytics routes reject unauthenticated, invalid, and expired sessions', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  for (const path of protectedAnalyticsRoutes) {
    assert.equal((await requestJson(baseUrl, path)).status, 401, `anonymous ${path}`);
  }
  for (const token of ['invalid', 'expired']) {
    for (const path of protectedAnalyticsRoutes) {
      assert.equal((await requestJson(baseUrl, path, { headers: authHeaders(token) })).status, 401, `${token} ${path}`);
    }
  }
});

test('profile reads require authentication and allow only the account owner or an Admin', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  queryHandler = async (sql, params) => {
    if (sql.startsWith('select * from accounts where id = $1')) {
      const account = authenticatedAccounts[Number(params[0])];
      return account ? resultRows([account]) : emptyResult;
    }
    return emptyResult;
  };

  assert.equal((await requestJson(baseUrl, '/api/user/4')).status, 401);
  assert.equal((await requestJson(baseUrl, '/api/user/4', { headers: authHeaders('parent') })).status, 200);
  assert.equal((await requestJson(baseUrl, '/api/user/4', { headers: authHeaders('teacher') })).status, 403);
  assert.equal((await requestJson(baseUrl, '/api/user/4', { headers: authHeaders('admin') })).status, 200);
});

test('admin and teacher analytics scopes are derived from the authenticated session', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  let teacherScopeParams = null;
  queryHandler = async (sql, params) => {
    if (sql.startsWith('select p.*') && sql.includes('from public.student_game_progress p')) {
      teacherScopeParams = params;
      return resultRows([]);
    }
    return emptyResult;
  };

  assert.equal((await requestJson(baseUrl, '/api/students/progress?teacher_id=999', { headers: authHeaders('admin') })).status, 200);
  assert.equal((await requestJson(baseUrl, '/api/students/progress?teacher_id=999', { headers: authHeaders('teacher') })).status, 200);
  assert.equal(teacherScopeParams[0], 2);
});

test('parent child routes use the authenticated parent instead of spoofed query identity', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  let childListParams = null;
  let protectedResultLookup = false;
  queryHandler = async (sql, params) => {
    if (sql.includes('from public.teacher_student_relationships tsr') && sql.includes('left join public.game_results gr on gr.resolved_student_id = s.id')) {
      childListParams = params;
      return resultRows([]);
    }
    if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) return emptyResult;
    if (sql.includes('from public.game_results')) protectedResultLookup = true;
    if (sql.includes('count(gr.id)::integer as unlinked_count')) return resultRows([{ unlinked_count: 0 }]);
    return emptyResult;
  };

  assert.equal((await requestJson(baseUrl, '/api/parent/children?parent_id=999&role=admin', { headers: authHeaders('parent') })).status, 200);
  assert.equal(childListParams[0], 4);
  assert.equal((await requestJson(baseUrl, '/api/parent/children/99/quizzes?parent_id=999', { headers: authHeaders('parent') })).status, 403);
  assert.equal(protectedResultLookup, false);
});

test('student and parent roles cannot elevate through analytics query or body fields', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  for (const path of protectedAnalyticsRoutes) {
    assert.equal((await requestJson(baseUrl, `${path}${path.includes('?') ? '&' : '?'}role=admin&user_id=1&teacher_id=1&parent_id=1`, { headers: authHeaders('student') })).status, 403, path);
  }
  assert.equal((await requestJson(baseUrl, '/api/students/progress-analysis?role=admin', { headers: authHeaders('parent') })).status, 403);
  assert.equal(
    await requestGetWithJsonBody(baseUrl, '/api/students/progress', { role: 'admin', user_id: 1 }, authHeaders('student')),
    403
  );
  assert.equal(
    await requestGetWithJsonBody(baseUrl, '/api/students/progress-analysis', { role: 'admin', user_id: 1 }, authHeaders('parent')),
    403
  );
});

test('a parent receives 403 for an unrelated student analytics detail request', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  queryHandler = async (sql) => {
    if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) return emptyResult;
    return emptyResult;
  };

  const response = await requestJson(baseUrl, '/api/student-progress/99?scope=parent', { headers: authHeaders('parent') });
  assert.equal(response.status, 403);
});

test('grounded insight generation keeps analytics authentication and child scope server-enforced', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  queryHandler = async (sql) => {
    if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) return emptyResult;
    return emptyResult;
  };

  assert.equal((await requestJson(baseUrl, '/api/student-progress/99/ai-insight', { method: 'POST' })).status, 401);
  assert.equal((await requestJson(baseUrl, '/api/student-progress/99/ai-insight', { method: 'POST', headers: authHeaders('invalid') })).status, 401);
  assert.equal((await requestJson(baseUrl, '/api/student-progress/99/ai-insight?role=admin&user_id=1', {
    method: 'POST',
    headers: authHeaders('student'),
    body: JSON.stringify({ role: 'admin', user_id: 1 }),
  })).status, 403);
  assert.equal((await requestJson(baseUrl, '/api/student-progress/99/ai-insight?scope=parent&parent_id=1', {
    method: 'POST',
    headers: authHeaders('parent'),
    body: JSON.stringify({ role: 'admin', parent_id: 1 }),
  })).status, 403);
});

test('grounded insight endpoint returns a current cache without another provider request', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = global.fetch;
  t.after(async () => { global.fetch = originalFetch; reset(); await close(server); });

  const progress = {
    student_id: 44,
    grade_level: 'Grade 3',
    score: 12,
    correct_answers: 3,
    total_questions: 5,
    accuracy_rate: 60,
    progress_percentage: 42,
    total_quests_completed: 1,
    current_quest: 'Fraction Forest',
  };
  const results = Array.from({ length: 5 }, (_, index) => ({
    score: index < 3 ? 1 : 0,
    total_items: 1,
    difficulty: 'Medium',
    math_topic: 'Fractions',
  }));
  const input = buildGroundedInsightInput({
    gradeLevel: progress.grade_level,
    metrics: buildStudentAnalyticsMetrics({ progress, quizSessions: results, playtimeSessions: [] }),
  });
  const cachedInsight = { performance_insight: 'Cached grounded insight.', strengths: [], weaknesses: [], recommendations: [] };
  queryHandler = async (sql) => {
    if (sql.startsWith('select p.*') && sql.includes('from public.student_game_progress p')) return resultRows([progress]);
    if (sql.includes('from public.game_results')) return resultRows(results);
    if (sql.includes('from public.playtime_sessions')) return resultRows([]);
    if (sql.includes('from public.student_ai_insights')) {
      return resultRows([{
        input_fingerprint: buildInsightFingerprint(input),
        insight: cachedInsight,
        generated_at: '2026-08-16T00:00:00.000Z',
        stale_at: null,
      }]);
    }
    return emptyResult;
  };
  global.fetch = async (url, options) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, options);
    throw new Error('provider must not be called for a current cache');
  };

  const response = await requestJson(baseUrl, '/api/student-progress/44/ai-insight', {
    method: 'POST',
    headers: authHeaders('admin'),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'cached');
  assert.deepEqual(response.body.insight, cachedInsight);
});

test('grounded insight requires five valid results before contacting OpenAI', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = global.fetch;
  t.after(async () => { global.fetch = originalFetch; reset(); await close(server); });

  queryHandler = async (sql) => {
    if (sql.startsWith('select p.*') && sql.includes('from public.student_game_progress p')) {
      return resultRows([{
        student_id: 44,
        grade_level: 'Grade 3',
        correct_answers: 2,
        total_questions: 4,
        progress_percentage: 40,
      }]);
    }
    if (sql.includes('from public.game_results')) {
      return resultRows(Array.from({ length: 4 }, (_, index) => ({
        score: index < 2 ? 1 : 0,
        total_items: 1,
        difficulty: 'Medium',
        math_topic: 'Fractions',
      })));
    }
    if (sql.includes('from public.playtime_sessions') || sql.includes('from public.student_ai_insights')) return resultRows([]);
    return emptyResult;
  };
  global.fetch = async (url, options) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, options);
    throw new Error('provider must not be called below the five-result threshold');
  };

  const response = await requestJson(baseUrl, '/api/student-progress/44/ai-insight', {
    method: 'POST',
    headers: authHeaders('admin'),
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.status, 'insufficient_data');
  assert.equal(response.body.valid_result_count, 4);
  assert.equal(response.body.required_result_count, 5);
});

test('Parent/Teacher may use separate authenticated teacher and parent contexts', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  let teacherParams = null;
  let parentParams = null;
  queryHandler = async (sql, params) => {
    if (sql.startsWith('select p.*') && sql.includes('from public.student_game_progress p')) {
      if (sql.includes("lower(tsr.relationship_type) = 'parent'")) parentParams = params;
      else teacherParams = params;
      return resultRows([]);
    }
    return emptyResult;
  };

  assert.equal((await requestJson(baseUrl, '/api/students/progress?scope=teacher&teacher_id=999', { headers: authHeaders('parentTeacher') })).status, 200);
  assert.equal((await requestJson(baseUrl, '/api/students/progress?scope=parent&parent_id=999', { headers: authHeaders('parentTeacher') })).status, 200);
  assert.equal(teacherParams[0], 3);
  assert.equal(parentParams[0], 3);
});

test('activity logs and top achievers ignore caller-supplied parent and teacher identities', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const observedScopeParams = [];
  queryHandler = async (sql, params) => {
    if (sql.includes('from public.activity_logs al') || sql.includes('from public.student_game_progress p')) {
      observedScopeParams.push(params);
      if (sql.startsWith('select count(*)')) return resultRows([{ total: 0 }]);
      return resultRows([]);
    }
    return emptyResult;
  };

  assert.equal((await requestJson(baseUrl, '/api/activity-logs?teacher_id=999', { headers: authHeaders('teacher') })).status, 200);
  assert.equal((await requestJson(baseUrl, '/api/top-achievers?parent_id=999', { headers: authHeaders('parent') })).status, 200);
  assert.ok(observedScopeParams.some((params) => params.includes(2)), 'teacher scope must use authenticated account id');
  assert.ok(observedScopeParams.some((params) => params.includes(4)), 'parent scope must use authenticated account id');
});

test('each management role is allowed only on its authenticated analytics policy routes', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  queryHandler = successfulAnalyticsQuery;
  const routesByToken = {
    admin: [
      '/api/students', '/api/students/progress', '/api/analytics/overview', '/api/analytics/recommendations',
      '/api/students/progress-analysis', '/api/student-progress/44', '/api/top-achievers',
      '/api/leaderboard/top-achievers', '/api/activity-logs', '/api/playtime', '/api/playtime/today/44',
    ],
    teacher: [
      '/api/students', '/api/students/progress', '/api/analytics/overview', '/api/analytics/recommendations',
      '/api/students/progress-analysis', '/api/student-progress/44', '/api/top-achievers',
      '/api/leaderboard/top-achievers', '/api/activity-logs', '/api/playtime', '/api/playtime/today/44',
    ],
    parent: [
      '/api/students/progress', '/api/analytics/overview', '/api/analytics/recommendations',
      '/api/student-progress/44?scope=parent', '/api/top-achievers', '/api/leaderboard/top-achievers',
      '/api/activity-logs', '/api/playtime/my-children', '/api/playtime/today/44', '/api/parent/children',
      '/api/parent/children/44/quizzes', '/api/parent/children/44/topics',
    ],
    parentTeacher: [
      '/api/students', '/api/students/progress', '/api/analytics/overview', '/api/analytics/recommendations',
      '/api/students/progress-analysis', '/api/student-progress/44', '/api/student-progress/44?scope=parent',
      '/api/top-achievers', '/api/leaderboard/top-achievers', '/api/activity-logs', '/api/playtime',
      '/api/playtime/my-children', '/api/playtime/today/44', '/api/parent/children',
      '/api/parent/children/44/quizzes', '/api/parent/children/44/topics',
    ],
  };

  for (const [token, routes] of Object.entries(routesByToken)) {
    for (const path of routes) {
      assert.equal((await requestJson(baseUrl, path, { headers: authHeaders(token) })).status, 200, `${token} ${path}`);
    }
  }
});

test('management roles are denied routes outside their authenticated analytics context', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const deniedRoutesByToken = {
    admin: ['/api/parent/children', '/api/parent/children/44/quizzes', '/api/parent/children/44/topics', '/api/playtime/my-children'],
    teacher: ['/api/parent/children', '/api/parent/children/44/quizzes', '/api/parent/children/44/topics', '/api/playtime/my-children'],
    parent: ['/api/students', '/api/students/progress-analysis', '/api/playtime'],
  };

  for (const [token, routes] of Object.entries(deniedRoutesByToken)) {
    for (const path of routes) {
      assert.equal((await requestJson(baseUrl, path, { headers: authHeaders(token) })).status, 403, `${token} ${path}`);
    }
  }
});
