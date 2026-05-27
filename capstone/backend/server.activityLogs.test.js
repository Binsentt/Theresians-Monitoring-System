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

const { app } = serverExports;

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

test('activity log API accepts Godot session aliases and scoped child filters', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  await t.test('stores Godot activity payload aliases for grade, timestamp, and duration', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.startsWith('insert into public.activity_logs')) {
        insertedValues = params;
        return resultRows([{ id: 9, student_id: params[0] }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/activity-logs', {
      method: 'POST',
      body: JSON.stringify({
        student_id: 44,
        student_name: 'Ava Santos',
        grade: 'Grade 4',
        current_quest: 'Boss Fractions',
        timestamp: '2026-05-27T08:30:00.000Z',
        duration_seconds: 375,
      }),
    });

    assert.equal(response.status, 201);
    assert.ok(insertedValues.includes('Grade 4'));
    assert.ok(insertedValues.includes('Boss Fractions'));
    assert.ok(insertedValues.includes(375));
    assert.ok(insertedValues.includes('2026-05-27T08:30:00.000Z'));
  });

  await t.test('keeps parent activity requests scoped to the selected child', async () => {
    let mainQuery = '';
    let mainParams = [];
    setQueryHandler(async (sql, params) => {
      if (sql.startsWith('select al.id')) {
        mainQuery = sql;
        mainParams = params;
        return resultRows([]);
      }
      if (sql.startsWith('select count(*) as total')) {
        return resultRows([{ total: 0 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/activity-logs?parent_id=19&student_id=44&limit=10');

    assert.equal(response.status, 200);
    assert.match(mainQuery, /al\.student_id = \$2/);
    assert.deepEqual(mainParams.slice(0, 2), [19, 44]);
  });
});
