const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    return (await queryHandler(compactSql(sql), params, sql)) || emptyResult;
  },
};

// Keep route tests isolated from local or Railway database state.
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
    verify: () => ({}),
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

const { app, verifyParentChildAccess } = serverExports;

const setQueryHandler = (handler) => {
  queryHandler = handler;
};

const resultRows = (rows) => ({ rows });

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

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

test('parent game results routes and access middleware', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  await t.test('stores a resolved game result session', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('from public.accounts s') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44 }]);
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        difficulty: 'Normal',
        math_topic: 'Fractions',
        score: 8,
        total_items: 10,
        played_at: '2026-05-22T08:00:00.000Z',
      }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true, resolved: true });
    assert.equal(insertedValues[2], 44);
    assert.equal(insertedValues[8], 80);
    assert.equal(insertedValues[10], false);
  });

  await t.test('stores an unlinked game result session when the child name is not resolved', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('from public.accounts s') && sql.includes('teacher_student_relationships r')) {
        return emptyResult;
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_name: 'New Player',
        grade_level: 'Grade 2',
        difficulty: 'Easy',
        math_topic: 'Shapes',
        score: 4,
        total_items: 5,
      }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true, resolved: false });
    assert.equal(insertedValues[2], null);
    assert.equal(insertedValues[10], true);
  });

  await t.test('returns paginated child quizzes for a linked parent', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships') && sql.startsWith('select 1')) {
        return resultRows([{ linked: true }]);
      }
      if (sql.startsWith('select id, parent_id') && sql.includes('from public.game_results')) {
        return resultRows([{
          id: 12,
          math_topic: 'Fractions',
          score: 8,
          total_items: 10,
          percentage: '80.00',
        }]);
      }
      if (sql.startsWith('select count(*)::integer as total') && sql.includes('from public.game_results')) {
        return resultRows([{ total: 1 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children/44/quizzes?parent_id=19&page=1&limit=20');

    assert.equal(response.status, 200);
    assert.equal(response.body.data[0].math_topic, 'Fractions');
    assert.deepEqual(response.body.pagination, {
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
    });
  });

  await t.test('rejects child quiz access when the parent link is missing', async () => {
    let queriedGameResults = false;
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships') && sql.startsWith('select 1')) {
        return emptyResult;
      }
      if (sql.includes('from public.game_results')) queriedGameResults = true;
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children/44/quizzes?parent_id=21');

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'Parent cannot access this child.');
    assert.equal(queriedGameResults, false);
  });

  await t.test('returns topic coverage for a linked parent', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships') && sql.startsWith('select 1')) {
        return resultRows([{ linked: true }]);
      }
      if (sql.startsWith('select math_topic') && sql.includes('from public.game_results')) {
        return resultRows([{ math_topic: 'Fractions', times_played: 3, best_score: 9 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children/44/topics?parent_id=19');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ math_topic: 'Fractions', times_played: 3, best_score: 9 }]);
  });

  await t.test('rejects topic coverage when the parent link is missing', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships') && sql.startsWith('select 1')) {
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children/44/topics?parent_id=21');

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'Parent cannot access this child.');
  });

  await t.test('verifyParentChildAccess exposes the scoped parent and child IDs', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships')) {
        return resultRows([{ linked: true }]);
      }
      return emptyResult;
    });

    const req = { query: { parent_id: '19' }, params: { studentId: '44' } };
    const res = createResponse();
    let nextCalled = false;

    await verifyParentChildAccess(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.body, null);
    assert.deepEqual(req.parentChildAccess, { parentId: 19, studentId: 44 });
  });
});
