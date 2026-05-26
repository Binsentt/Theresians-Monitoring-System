const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let sentMessages = [];
let passwordMatches = false;
let emailSendResult = { sent: true, provider: 'test' };
let verifiedTokenPayload = {};
let signedTokenPayloads = [];

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    const rawSql = sql && typeof sql === 'object' && sql.text ? sql.text : sql;
    const rawParams = sql && typeof sql === 'object' && Array.isArray(sql.values) ? sql.values : params;
    return (await queryHandler(compactSql(rawSql), rawParams, rawSql)) || emptyResult;
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
    compare: async () => passwordMatches,
    hash: async (value) => `hashed:${value}`,
  },
  cors: () => createMiddleware(),
  jsonwebtoken: {
    sign: (payload) => {
      signedTokenPayloads.push(payload);
      return 'token';
    },
    verify: () => verifiedTokenPayload,
  },
  multer: multerStub,
  'pdf-parse': async () => ({ text: '' }),
  './emailDelivery.utils': {
    buildSafeEmailLogDetails: ({ emailType, role, message, result = {} }) => ({
      emailType,
      role,
      recipientDomain: String(message?.to || '').split('@')[1] || null,
      provider: result.provider || 'test',
      statusCode: result.statusCode || null,
      reason: result.reason || null,
      sanitizedResendErrorMessage: result.sanitizedResendErrorMessage || null,
      hasEmailFrom: true,
      hasSmtpFrom: false,
      hasAppUrl: true,
    }),
    getEmailSendTimeoutMs: () => 5,
    sendEmailWithProviders: async ({ message }) => {
      sentMessages.push(message);
      return emailSendResult;
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

const resetTestState = () => {
  sentMessages = [];
  passwordMatches = false;
  emailSendResult = { sent: true, provider: 'test' };
  verifiedTokenPayload = {};
  signedTokenPayloads = [];
  setQueryHandler(async () => emptyResult);
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

test('admin account creation accepts optional profile fields and emails entered address', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
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
  assert.match(sentMessages[0].html, /Account Role:/);
  assert.match(sentMessages[0].html, /Parent/);
  assert.equal(response.body.emailSent, true);
});

test('teacher account creation emails the entered address with the account role', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  let insertParams = null;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('insert into public.accounts')) {
      insertParams = params;
      return resultRows([{
        id: 92,
        name: params[0],
        email: params[1],
        password: params[2],
        role: params[3],
        employee_id: params[8],
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Tessa Teacher',
      email: '  Tessa.Teacher@Example.COM  ',
      role: 'teacher',
      employee_id: '1234567890',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(insertParams[1], 'tessa.teacher@example.com');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, 'tessa.teacher@example.com');
  assert.match(sentMessages[0].html, /Account Role:/);
  assert.match(sentMessages[0].html, /Teacher/);
  assert.equal(response.body.emailSent, true);
});

test('credential email failure logs safe production diagnostics', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const logEntries = [];
  console.info = (...args) => logEntries.push(['info', ...args]);
  console.warn = (...args) => logEntries.push(['warn', ...args]);
  t.after(async () => {
    console.info = originalInfo;
    console.warn = originalWarn;
    resetTestState();
    await close(server);
  });

  emailSendResult = {
    sent: false,
    provider: 'resend',
    reason: 'sender_domain_not_verified',
    statusCode: 403,
    sanitizedResendErrorMessage: 'Sender domain is not verified by Resend.',
  };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('insert into public.accounts')) {
      return resultRows([{
        id: 93,
        name: params[0],
        email: params[1],
        password: params[2],
        role: params[3],
        employee_id: params[8],
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Failed Mail Teacher',
      email: 'failed.teacher@example.com',
      role: 'teacher',
      employee_id: '1234567890',
    }),
  });

  const serializedLogs = JSON.stringify(logEntries);
  assert.equal(response.status, 201);
  assert.equal(response.body.emailSent, false);
  assert.match(serializedLogs, /Email send started/);
  assert.match(serializedLogs, /Email send failed/);
  assert.match(serializedLogs, /credential/);
  assert.match(serializedLogs, /teacher/);
  assert.match(serializedLogs, /example.com/);
  assert.match(serializedLogs, /sender_domain_not_verified/);
  assert.doesNotMatch(serializedLogs, /failed\.teacher@example\.com|Temporary Password|otp_code|\b\d{6}\b/);
});

test('login OTP for admin teacher and parent accounts is sent to the stored email', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  passwordMatches = true;
  setQueryHandler(async (sql, params) => {
    if (sql.includes('select * from public.accounts where lower(trim(email))')) {
      const email = params[0];
      const role = email.includes('teacher') ? 'teacher' : email.includes('parent') ? 'parent' : 'admin';
      return resultRows([{
        id: role === 'teacher' ? 501 : role === 'parent' ? 502 : 503,
        name: role === 'teacher' ? 'Teacher User' : role === 'parent' ? 'Parent User' : 'Admin User',
        email,
        password: 'correct-password',
        role,
        status: 'Offline',
        is_archived: false,
        must_change_password: false,
      }]);
    }
    if (sql.startsWith('update public.accounts set otp_code')) {
      return emptyResult;
    }
    return emptyResult;
  });

  const teacherResponse = await requestJson(baseUrl, '/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: ' Teacher.User@Example.COM ',
      password: 'correct-password',
    }),
  });
  const parentResponse = await requestJson(baseUrl, '/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: 'parent.user@example.com',
      password: 'correct-password',
    }),
  });
  const adminResponse = await requestJson(baseUrl, '/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: 'admin.user@example.com',
      password: 'correct-password',
    }),
  });

  assert.equal(teacherResponse.status, 200);
  assert.equal(parentResponse.status, 200);
  assert.equal(adminResponse.status, 200);
  assert.equal(teacherResponse.body.emailSent, true);
  assert.equal(parentResponse.body.emailSent, true);
  assert.equal(adminResponse.body.emailSent, true);
  assert.equal(sentMessages[0].to, 'teacher.user@example.com');
  assert.equal(sentMessages[1].to, 'parent.user@example.com');
  assert.equal(sentMessages[2].to, 'admin.user@example.com');
  assert.equal(teacherResponse.body.otp, undefined);
  assert.equal(parentResponse.body.otp, undefined);
  assert.equal(adminResponse.body.otp, undefined);
});

test('teacher login OTP success logs safe production diagnostics', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalInfo = console.info;
  const logEntries = [];
  console.info = (...args) => logEntries.push(['info', ...args]);
  t.after(async () => {
    console.info = originalInfo;
    resetTestState();
    await close(server);
  });

  passwordMatches = true;
  emailSendResult = { sent: true, provider: 'resend', messageIdPresent: true };
  setQueryHandler(async (sql, params) => {
    if (sql.includes('select * from public.accounts where lower(trim(email))')) {
      return resultRows([{
        id: 601,
        name: 'Teacher User',
        email: params[0],
        password: 'correct-password',
        role: 'teacher',
        status: 'Offline',
        is_archived: false,
        must_change_password: false,
      }]);
    }
    if (sql.startsWith('update public.accounts set otp_code')) {
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: 'teacher.otp@example.com',
      password: 'correct-password',
    }),
  });

  const serializedLogs = JSON.stringify(logEntries);
  assert.equal(response.status, 200);
  assert.equal(response.body.emailSent, true);
  assert.match(serializedLogs, /Email send started/);
  assert.match(serializedLogs, /Email send succeeded/);
  assert.match(serializedLogs, /otp/);
  assert.match(serializedLogs, /teacher/);
  assert.match(serializedLogs, /example.com/);
  assert.doesNotMatch(serializedLogs, /teacher\.otp@example\.com|\b\d{6}\b|otp_code/);
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

test('archiving an account invalidates sessions and OTP skip records', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const statements = [];
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.startsWith('select id, role from public.accounts where id = $1')) {
      return resultRows([{ id: Number(params[0]), role: 'teacher' }]);
    }
    if (sql.startsWith('update public.accounts set is_archived = true')) {
      return resultRows([{ id: Number(params[0]), role: 'teacher', is_archived: true, session_version: 4 }]);
    }
    if (sql.startsWith('delete from public.login_otp_device_skips')) {
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/42', { method: 'DELETE' });

  assert.equal(response.status, 200);
  assert.match(response.body.message, /archived/i);
  assert.ok(statements.some((entry) => entry.sql.includes('session_version = coalesce(session_version, 0) + 1')));
  assert.ok(statements.some((entry) => entry.sql.includes('otp_code = null') && entry.sql.includes('otp_expires_at = null')));
  assert.ok(statements.some((entry) => entry.sql.startsWith('delete from public.login_otp_device_skips')));
});

test('session validation rejects archived accounts and stale token versions', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 77, email: 'teacher@example.com', sessionVersion: 1 };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{
        id: 77,
        name: 'Archived Teacher',
        email: 'teacher@example.com',
        role: 'teacher',
        is_archived: true,
        session_version: 1,
      }]);
    }
    return emptyResult;
  });

  const archivedResponse = await requestJson(baseUrl, '/api/session/validate', {
    headers: { Authorization: 'Bearer stale-token' },
  });
  assert.equal(archivedResponse.status, 401);
  assert.match(archivedResponse.body.error, /expired/i);

  verifiedTokenPayload = { userId: 77, email: 'teacher@example.com', sessionVersion: 1 };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{
        id: 77,
        name: 'Teacher User',
        email: 'teacher@example.com',
        role: 'teacher',
        is_archived: false,
        session_version: 2,
      }]);
    }
    return emptyResult;
  });

  const staleVersionResponse = await requestJson(baseUrl, '/api/session/validate', {
    headers: { Authorization: 'Bearer stale-token' },
  });
  assert.equal(staleVersionResponse.status, 401);
  assert.match(staleVersionResponse.body.error, /expired/i);
});

test('remember tokens include the account session version', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  passwordMatches = true;
  setQueryHandler(async (sql, params) => {
    if (sql.includes('select * from public.accounts where lower(trim(email))')) {
      return resultRows([{
        id: 88,
        name: 'Teacher User',
        email: params[0],
        password: 'correct-password',
        role: 'teacher',
        status: 'Offline',
        is_archived: false,
        session_version: 5,
        must_change_password: false,
      }]);
    }
    if (sql.includes('from public.login_otp_device_skips')) {
      return resultRows([{ id: 1 }]);
    }
    if (sql.startsWith('update public.accounts set otp_code = null')) {
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: 'teacher.user@example.com',
      password: 'correct-password',
      deviceId: 'trusted-device',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(signedTokenPayloads[0].sessionVersion, 5);
});
