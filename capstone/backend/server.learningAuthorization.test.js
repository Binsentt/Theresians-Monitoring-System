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
    query: async (sql, params = []) => {
      const normalizedSql = compactSql(sql);
      if (normalizedSql.startsWith('select * from public.accounts where id = $1')) {
        const account = authenticatedAccounts[Number(params[0])];
        return account ? resultRows([account]) : emptyResult;
      }
      return (await queryHandler(normalizedSql, params, sql)) || emptyResult;
    },
    release: () => {},
  }),
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: mockPool,
};

const createMiddleware = () => (req, res, next) => next();
const multerStub = () => ({
  single: createMiddleware,
  array: createMiddleware,
  fields: createMiddleware,
});
const serverDependencyStubs = {
  bcrypt: {
    compare: async () => false,
    hash: async (value) => value,
  },
  cors: () => createMiddleware(),
  jsonwebtoken: {
    sign: () => 'token',
    verify: (token) => {
      const payload = tokenPayloads[token];
      if (payload instanceof Error) throw payload;
      return payload || {};
    },
  },
  multer: multerStub,
  'pdf-parse': async () => ({ text: '' }),
};

const originalLoad = Module._load;
let serverExports;
Module._load = function loadWithServerStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(serverDependencyStubs, request)) {
    return serverDependencyStubs[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  serverExports = require('./server');
} finally {
  Module._load = originalLoad;
}

const { app } = serverExports;

const resetTestState = () => {
  queryHandler = async () => emptyResult;
  tokenPayloads = {
    'admin-token': { userId: 1, sessionVersion: 0 },
    'teacher-token': { userId: 2, sessionVersion: 0 },
    'parent-teacher-token': { userId: 3, sessionVersion: 0 },
    'parent-token': { userId: 4, sessionVersion: 0 },
    'student-token': { userId: 5, sessionVersion: 0 },
    'expired-token': { userId: 6, sessionVersion: 0, sessionExpiresAt: '2000-01-01T00:00:00.000Z' },
    'invalid-token': new Error('invalid token'),
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

const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()));
});

const requestJson = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return {
    status: response.status,
    body: await response.json(),
  };
};

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });
const withScope = (path, scope) => `${path}${path.includes('?') ? '&' : '?'}scope=${encodeURIComponent(scope)}`;

const protectedLearningRoutes = [
  { method: 'GET', path: '/api/folders' },
  { method: 'GET', path: '/api/folders/trash' },
  { method: 'POST', path: '/api/folders/create' },
  { method: 'PUT', path: '/api/folders/11' },
  { method: 'DELETE', path: '/api/folders/11' },
  { method: 'POST', path: '/api/folders/11/restore' },
  { method: 'DELETE', path: '/api/folders/11/permanent' },
  { method: 'POST', path: '/api/learning-files/upload' },
  { method: 'GET', path: '/api/question-folders' },
  { method: 'GET', path: '/api/learning-files/folder?grade_level=Grade%201&difficulty=Easy' },
  { method: 'GET', path: '/api/learning-files' },
  { method: 'GET', path: '/api/learning-files/storage-summary' },
  { method: 'GET', path: '/api/learning-files/77/questions' },
  { method: 'GET', path: '/api/learning-files/77/preview' },
  { method: 'PUT', path: '/api/learning-files/77/rename' },
  { method: 'PUT', path: '/api/learning-files/77' },
  { method: 'DELETE', path: '/api/learning-files/77' },
  { method: 'POST', path: '/api/learning-files/77/restore' },
  { method: 'DELETE', path: '/api/learning-files/77/permanent' },
  { method: 'POST', path: '/api/questions/publish/77' },
  { method: 'POST', path: '/api/questions/unpublish/77' },
  { method: 'GET', path: '/api/learning-files/trash' },
];

test('every Lesson and Question Manager route rejects an unauthenticated request', async (t) => {
  resetTestState();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  for (const route of protectedLearningRoutes) {
    const response = await requestJson(baseUrl, route.path, { method: route.method });
    assert.equal(response.status, 401, `${route.method} ${route.path}`);
  }
});

test('Lesson and Question Manager routes allow Admin, Teacher, and Parent/Teacher Teacher-scope sessions', async (t) => {
  resetTestState();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  for (const token of ['admin-token', 'teacher-token']) {
    const response = await requestJson(baseUrl, '/api/question-folders', { headers: authHeaders(token) });
    assert.equal(response.status, 200, token);
  }

  const response = await requestJson(baseUrl, '/api/question-folders?scope=teacher', {
    headers: authHeaders('parent-teacher-token'),
  });
  assert.equal(response.status, 200);
});

test('Lesson and Question Manager routes reject Parent/Teacher Parent scope before every route handler', async (t) => {
  resetTestState();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  for (const route of protectedLearningRoutes) {
    const response = await requestJson(baseUrl, withScope(route.path, 'parent'), {
      method: route.method,
      headers: authHeaders('parent-teacher-token'),
    });
    assert.equal(response.status, 403, `${route.method} ${route.path}`);
  }
});

test('Lesson and Question Manager routes reject missing and invalid Parent/Teacher scopes', async (t) => {
  resetTestState();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  for (const path of ['/api/question-folders', '/api/question-folders?scope=admin']) {
    const response = await requestJson(baseUrl, path, { headers: authHeaders('parent-teacher-token') });
    assert.equal(response.status, 403, path);
  }
});

test('Lesson and Question Manager routes reject Parent and Student sessions even when the request body spoofs a teacher role', async (t) => {
  resetTestState();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  let publishLookupCount = 0;
  queryHandler = async (sql) => {
    if (sql.startsWith('select * from public.learning_files')) publishLookupCount += 1;
    return emptyResult;
  };

  for (const token of ['parent-token', 'student-token']) {
    const response = await requestJson(baseUrl, '/api/questions/publish/77', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ role: 'teacher', uploaded_by: 2 }),
    });
    assert.equal(response.status, 403, token);
  }
  assert.equal(publishLookupCount, 0);
});

test('Lesson and Question Manager routes reject invalid and expired sessions before route handlers run', async (t) => {
  resetTestState();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  for (const token of ['invalid-token', 'expired-token']) {
    const response = await requestJson(baseUrl, '/api/question-folders', { headers: authHeaders(token) });
    assert.equal(response.status, 401, token);
  }
});
