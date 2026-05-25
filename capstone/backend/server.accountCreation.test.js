const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let sentMessages = [];

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
    hash: async (value) => `hashed:${value}`,
  },
  cors: () => createMiddleware(),
  jsonwebtoken: {
    sign: () => 'token',
    verify: () => ({}),
  },
  multer: multerStub,
  'pdf-parse': async () => ({ text: '' }),
  './emailDelivery.utils': {
    getEmailSendTimeoutMs: () => 5,
    sendEmailWithProviders: async ({ message }) => {
      sentMessages.push(message);
      return { sent: true, provider: 'test' };
    },
  },
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

test('admin account creation accepts optional profile fields and emails entered address', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    sentMessages = [];
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let insertParams = null;
  setQueryHandler(async (sql, params) => {
    if (sql.includes('select 1 from public.accounts where parent_id')) {
      return emptyResult;
    }
    if (sql.startsWith('insert into public.accounts')) {
      insertParams = params;
      return resultRows([{
        id: 91,
        name: params[0],
        email: params[1],
        password: params[2],
        role: params[3],
        mobile_number: params[4],
        address: params[5],
        birthday: params[6],
        gender: params[7],
        employee_id: params[8],
        parent_id: params[11],
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Paula Parent',
      email: 'paula.parent@gmail.com',
      role: 'parent',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(insertParams[6], null);
  assert.equal(insertParams[7], null);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, 'paula.parent@gmail.com');
  assert.equal(response.body.emailSent, true);
});

test('teacher account creation rejects non-digit employee IDs', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Tom Teacher',
      email: 'tom.teacher@gmail.com',
      role: 'teacher',
      employee_id: 'EMP-123',
    }),
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Employee ID must contain digits only/i);
});

test('teacher account creation rejects employee IDs longer than 10 digits', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Tina Teacher',
      email: 'tina.teacher@gmail.com',
      role: 'teacher',
      employee_id: '12345678901',
    }),
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /10 digits or fewer/i);
});
