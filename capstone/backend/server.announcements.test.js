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

test('announcement posting treats legacy null archive flags as active accounts', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let creatorLookupUsedNullSafeArchivePredicate = false;
  setQueryHandler(async (sql, params) => {
    if (sql.includes('select id, name, role from public.accounts')) {
      creatorLookupUsedNullSafeArchivePredicate = sql.includes('coalesce(is_archived, false) = false');
      return creatorLookupUsedNullSafeArchivePredicate
        ? resultRows([{ id: params[0], name: 'Teacher User', role: 'teacher' }])
        : emptyResult;
    }

    if (sql.startsWith('insert into public.announcements')) {
      return resultRows([{
        id: 81,
        title: params[0],
        message: params[1],
        created_by: params[2],
        created_by_role: params[3],
        target_role: params[4],
      }]);
    }

    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/announcements', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Class reminder',
      message: 'Please review the lesson activity.',
      created_by: 12,
      created_by_role: 'teacher',
      target_role: 'parent',
    }),
  });

  assert.equal(creatorLookupUsedNullSafeArchivePredicate, true);
  assert.equal(response.status, 201);
  assert.equal(response.body.title, 'Class reminder');
});
