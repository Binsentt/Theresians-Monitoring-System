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

test('question publishing replaces the active Godot bundle for one grade difficulty topic', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let unpublishedLearningFiles = null;
  let unpublishedQuestions = null;
  let publishedLearningFile = null;
  let publishedQuestions = null;

  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      return resultRows([{
        id: 77,
        title: 'addition-quiz',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
        subject: 'Mathematics',
        deleted_at: null,
      }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('published = false')) {
      unpublishedLearningFiles = { sql, params };
      return emptyResult;
    }
    if (sql.startsWith('update public.questions q') && sql.includes('published = false')) {
      unpublishedQuestions = { sql, params };
      return emptyResult;
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('published = true')) {
      publishedLearningFile = { sql, params };
      return resultRows([{ id: 77, published: true }]);
    }
    if (sql.startsWith('update public.questions') && sql.includes('published = true')) {
      publishedQuestions = { sql, params };
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/publish/77', { method: 'POST' });

  assert.equal(response.status, 200);
  assert.deepEqual(unpublishedLearningFiles.params, ['Grade 1', 'Normal', 'Addition', 77]);
  assert.match(unpublishedLearningFiles.sql, /id <> \$4/);
  assert.deepEqual(unpublishedQuestions.params, ['Grade 1', 'Normal', 'Addition', 77]);
  assert.match(unpublishedQuestions.sql, /lf\.id <> \$4/);
  assert.deepEqual(publishedLearningFile.params, [77]);
  assert.deepEqual(publishedQuestions.params, [77]);
});

test('Godot question endpoint accepts grade and topic query aliases', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const queryCalls = [];
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.learning_files') || sql.includes('from public.questions q')) {
      queryCalls.push(params);
      return resultRows([]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=Grade%201&difficulty=Easy&topic=Basic%20Addition');

  assert.equal(response.status, 200);
  assert.deepEqual(queryCalls[0], ['Mathematics', 'Grade 1', 'Easy', 'Basic Addition']);
  assert.deepEqual(queryCalls[1], ['Mathematics', 'Grade 1', 'Easy', 'Basic Addition']);
});

test('Godot question endpoint normalizes numeric grade aliases and scopes to one active source', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const queryCalls = [];
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.learning_files') || sql.includes('from public.questions q')) {
      queryCalls.push({ sql, params });
      return resultRows([]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=1&difficulty=Easy&topic=Basic%20Addition');

  assert.equal(response.status, 200);
  assert.deepEqual(queryCalls[0].params, ['Mathematics', 'Grade 1', 'Easy', 'Basic Addition']);
  assert.deepEqual(queryCalls[1].params, ['Mathematics', 'Grade 1', 'Easy', 'Basic Addition']);
  assert.match(queryCalls[0].sql, /order by uploaded_at desc, id desc limit 1/);
  assert.match(queryCalls[1].sql, /order by active_lf\.uploaded_at desc, active_lf\.id desc limit 1/);
});
