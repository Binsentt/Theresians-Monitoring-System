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
let signedTokenOptions = [];
let authenticatedTestAccount = null;
let hashedPasswordInputs = [];

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    const rawSql = sql && typeof sql === 'object' && sql.text ? sql.text : sql;
    const rawParams = sql && typeof sql === 'object' && Array.isArray(sql.values) ? sql.values : params;
    const normalizedSql = compactSql(rawSql);
    if (
      authenticatedTestAccount
      && normalizedSql.startsWith('select * from public.accounts where id = $1')
      && Number(rawParams[0]) === Number(authenticatedTestAccount.id)
    ) {
      return resultRows([authenticatedTestAccount]);
    }
    return (await queryHandler(normalizedSql, rawParams, rawSql)) || emptyResult;
  },
  connect: async () => ({
    query: mockPool.query,
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
    compare: async (value, storedHash) => passwordMatches || storedHash === `hashed:${value}`,
    hash: async (value) => {
      hashedPasswordInputs.push(value);
      return `hashed:${value}`;
    },
  },
  cors: () => createMiddleware(),
  jsonwebtoken: {
    sign: (payload, secret, options) => {
      signedTokenPayloads.push(payload);
      signedTokenOptions.push(options || {});
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
  signedTokenOptions = [];
  authenticatedTestAccount = null;
  hashedPasswordInputs = [];
  setQueryHandler(async () => emptyResult);
};

const authenticateAsAdmin = () => {
  authenticatedTestAccount = {
    id: 1,
    name: 'Ada Admin',
    email: 'ada@example.com',
    role: 'admin',
    is_archived: false,
    session_version: 0,
  };
  verifiedTokenPayload = { userId: authenticatedTestAccount.id, sessionVersion: 0 };
  return { Authorization: 'Bearer admin-token' };
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
  const authHeaders = authenticateAsAdmin();
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
        must_change_password: params[10],
        parent_id: params[11],
        temporary_password_issued_at: params[12],
        temporary_password_expires_at: params[13],
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Paula Parent',
      email: 'paula.parent@gmail.com',
      role: 'parent',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(insertParams[6], null);
    assert.equal(insertParams[7], null);
    assert.match(insertParams[2], /^hashed:/);
    assert.equal(insertParams[10], true);
  assert.ok(insertParams[12] instanceof Date);
  assert.ok(insertParams[13] instanceof Date);
  assert.equal(await serverDependencyStubs.bcrypt.compare(hashedPasswordInputs.at(-1), insertParams[2]), true);
  const escapedGeneratedPassword = hashedPasswordInputs.at(-1)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, 'paula.parent@gmail.com');
  assert.ok(sentMessages[0].html.includes(escapedGeneratedPassword));
  assert.match(sentMessages[0].html, /Account Role:/);
  assert.match(sentMessages[0].html, /Parent/);
    assert.equal(response.body.emailSent, true);
    assert.equal(response.body.user.requiresInitialPasswordSetup, true);
});

test('teacher account creation emails the entered address with the account role', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = authenticateAsAdmin();
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
        must_change_password: params[10],
        temporary_password_issued_at: params[12],
        temporary_password_expires_at: params[13],
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Tessa Teacher',
      email: '  Tessa.Teacher@Example.COM  ',
      role: 'teacher',
      employee_id: '1234567890',
    }),
  });

  assert.equal(response.status, 201);
    assert.equal(insertParams[1], 'tessa.teacher@example.com');
    assert.equal(insertParams[10], true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, 'tessa.teacher@example.com');
  assert.match(sentMessages[0].html, /Account Role:/);
  assert.match(sentMessages[0].html, /Teacher/);
    assert.equal(response.body.emailSent, true);
    assert.equal(response.body.user.requiresInitialPasswordSetup, true);
});

test('account management list excludes Godot student accounts', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = authenticateAsAdmin();
  let accountListSql = '';
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.startsWith('select * from public.accounts')) {
      accountListSql = sql;
      return resultRows([
        { id: 1, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false },
        { id: 2, name: 'Tom Teacher', email: 'tom@example.com', role: 'teacher', is_archived: false },
        { id: 3, name: 'Paula Parent', email: 'paula@example.com', role: 'parent', is_archived: false },
        { id: 4, name: 'Pat Dual', email: 'pat@example.com', role: 'parent_teacher', is_archived: false },
      ]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts', { headers: authHeaders });

  assert.equal(response.status, 200);
  assert.match(accountListSql, /lower\(role\) = any\(\$1::text\[\]\)/);
  assert.deepEqual(response.body.map((account) => account.role), ['admin', 'teacher', 'parent', 'parent_teacher']);
  assert.equal(response.body.some((account) => account.role === 'student'), false);
});

test('account management rejects creating student accounts', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = authenticateAsAdmin();
  let insertedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.startsWith('insert into public.accounts')) insertedAccount = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Sam Student',
      email: 'sam.student@gmail.com',
      role: 'student',
    }),
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /website accounts/i);
  assert.equal(insertedAccount, false);
});

test('account management rejects updating student game accounts', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let updatedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      if (Number(params[0]) === 1) {
        return resultRows([{ id: 1, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false, session_version: 0 }]);
      }
      return resultRows([{ id: 44, name: 'Game Student', email: 'student@example.com', role: 'student' }]);
    }
    if (sql.startsWith('update public.accounts')) updatedAccount = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/44', {
    method: 'PUT',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ name: 'Updated Student' }),
  });

  assert.equal(response.status, 403);
  assert.match(response.body.error, /website accounts/i);
  assert.equal(updatedAccount, false);
});

test('account management rejects deleting student game accounts', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let deletedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 1, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false, session_version: 0 }]);
    }
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
      return resultRows([{ id: 44, role: 'student' }]);
    }
    if (sql.startsWith('delete from public.accounts') || sql.startsWith('update public.accounts set is_archived')) {
      deletedAccount = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/44', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin-token' },
  });

  assert.equal(response.status, 403);
  assert.match(response.body.error, /website accounts/i);
  assert.equal(deletedAccount, false);
});

test('account management blocks self-edit through the API', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let updatedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 10, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{
        id: Number(params[0]),
        name: 'Ada Admin',
        email: 'ada@example.com',
        role: 'admin',
        is_archived: false,
        session_version: 0,
      }]);
    }
    if (sql.startsWith('update public.accounts')) updatedAccount = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/10', {
    method: 'PUT',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ name: 'Updated Admin' }),
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'You cannot edit your own account here. Please use My Profile.');
  assert.equal(updatedAccount, false);
});

test('profile update lets authenticated users edit their own profile outside Manage Users', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let updateParams = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 10, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1') || sql.startsWith('select * from accounts where id = $1')) {
      return resultRows([{
        id: Number(params[0]),
        name: 'Ada Admin',
        email: 'ada@example.com',
        role: 'admin',
        is_archived: false,
        session_version: 0,
        status: 'Active',
      }]);
    }
    if (sql.startsWith('update public.accounts set name=$1, email=$2, mobile_number=$3')) {
      updateParams = params;
      return resultRows([{
        id: Number(params[7]),
        name: params[0],
        email: params[1],
        role: 'admin',
        mobile_number: params[2],
        address: params[3],
        birthday: params[4],
        gender: params[5],
        status: params[6],
        is_archived: false,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/user/10', {
    method: 'PUT',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({
      name: 'Ada Updated',
      email: 'ada.updated@example.com',
      mobile_number: '09123456789',
      address: 'Updated Street',
      birthday: '',
      gender: 'Female',
      status: 'Active',
      role: 'teacher',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.name, 'Ada Updated');
  assert.equal(response.body.user.role, 'admin');
  assert.equal(updateParams[1], 'ada.updated@example.com');
});

test('account management blocks self-delete through the API', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let deletedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 10, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{
        id: Number(params[0]),
        name: 'Ada Admin',
        email: 'ada@example.com',
        role: 'admin',
        is_archived: false,
        session_version: 0,
      }]);
    }
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
      return resultRows([{ id: Number(params[0]), role: 'admin', email: 'ada@example.com', is_archived: false }]);
    }
    if (sql.startsWith('delete from public.accounts') || sql.startsWith('update public.accounts set is_archived')) {
      deletedAccount = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/10', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin-token' },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'You cannot delete your own account.');
  assert.equal(deletedAccount, false);
});

test('account management blocks deleting the last active admin account', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let deletedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 11, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{
        id: Number(params[0]),
        name: 'Other Admin',
        email: 'other-admin@example.com',
        role: 'admin',
        is_archived: false,
        session_version: 0,
      }]);
    }
    if (sql.startsWith('select id, email, role')) {
      return resultRows([{ id: 10, role: 'admin', email: 'ada@example.com', is_archived: false }]);
    }
    if (sql.startsWith('select count')) {
      return resultRows([{ count: '1' }]);
    }
    if (sql.startsWith('delete from public.accounts') || sql.startsWith('update public.accounts set is_archived')) {
      deletedAccount = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/10?permanent=true', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin-token' },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'Cannot delete the last admin account.');
  assert.equal(deletedAccount, false);
});

test('account management blocks archiving the last active admin account', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let archivedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 11, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      if (Number(params[0]) === 11) {
        return resultRows([{
          id: 11,
          name: 'Other Admin',
          email: 'other-admin@example.com',
          role: 'admin',
          is_archived: false,
          session_version: 0,
        }]);
      }
      return resultRows([{ id: 10, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false }]);
    }
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
      return resultRows([{ id: 10, role: 'admin', email: 'ada@example.com', is_archived: false }]);
    }
    if (sql.startsWith('select count')) {
      return resultRows([{ count: '1' }]);
    }
    if (sql.startsWith('update public.accounts set is_archived = true')) {
      archivedAccount = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/10', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin-token' },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'Cannot archive the last admin account.');
  assert.equal(archivedAccount, false);
});

test('account management blocks downgrading the last active admin role', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let updatedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 11, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      if (Number(params[0]) === 11) {
        return resultRows([{
          id: 11,
          name: 'Other Admin',
          email: 'other-admin@example.com',
          role: 'admin',
          is_archived: false,
          session_version: 0,
        }]);
      }
      return resultRows([{
        id: 10,
        name: 'Ada Admin',
        email: 'ada@example.com',
        role: 'admin',
        is_archived: false,
        session_version: 0,
      }]);
    }
    if (sql.startsWith('select count')) {
      return resultRows([{ count: '1' }]);
    }
    if (sql.startsWith('update public.accounts')) {
      updatedAccount = true;
      return resultRows([{
        id: 10,
        name: 'Ada Admin',
        email: 'ada@example.com',
        role: 'admin',
        is_archived: false,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/10', {
    method: 'PUT',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({
      name: 'Ada Admin',
      email: 'ada@example.com',
      role: 'teacher',
      employee_id: '1234567890',
    }),
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'Cannot change the role of the last admin account.');
  assert.equal(updatedAccount, false);
});

test('account management allows archiving another admin when another active admin remains', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let archivedAccount = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 11, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{
        id: Number(params[0]),
        name: 'Other Admin',
        email: 'other-admin@example.com',
        role: 'admin',
        is_archived: false,
        session_version: 0,
      }]);
    }
    if (sql.startsWith('select id, email, role')) {
      return resultRows([{ id: 10, role: 'admin', email: 'ada@example.com', is_archived: false }]);
    }
    if (sql.startsWith('select count')) {
      return resultRows([{ count: '2' }]);
    }
    if (sql.startsWith('update public.accounts set is_archived = true')) {
      archivedAccount = true;
      return resultRows([{ id: Number(params[0]), role: 'admin', is_archived: true, session_version: 2 }]);
    }
    if (sql.startsWith('delete from public.login_otp_device_skips')) {
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts/10', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ reason: 'Duplicate administrator account.' }),
  });

  assert.equal(response.status, 200);
  assert.match(response.body.message, /archived/i);
  assert.equal(archivedAccount, true);
});

test('account management requires a deletion reason and audits authenticated actor and operation', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auditEntries = [];
  let archiveMutated = false;
  let permanentlyDeleted = false;

  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{
        id: Number(params[0]),
        name: Number(params[0]) === 1 ? 'Authenticated Admin' : 'Archived Teacher',
        email: Number(params[0]) === 1 ? 'admin@example.com' : 'teacher@example.com',
        role: Number(params[0]) === 1 ? 'admin' : 'teacher',
        is_archived: false,
        session_version: 0,
      }]);
    }
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
      return resultRows([{ id: Number(params[0]), email: 'teacher@example.com', role: 'teacher', is_archived: archiveMutated }]);
    }
    if (sql.startsWith('update public.accounts set is_archived = true')) {
      archiveMutated = true;
      return resultRows([{ id: 42, name: 'Archived Teacher', email: 'teacher@example.com', role: 'teacher', is_archived: true }]);
    }
    if (sql.startsWith('delete from public.accounts where id = $1')) {
      permanentlyDeleted = true;
      return emptyResult;
    }
    if (sql.startsWith('delete from public.login_otp_device_skips')) return emptyResult;
    if (sql.startsWith('insert into public.admin_audit_logs')) {
      auditEntries.push({
        adminName: params[0],
        action: params[1],
        targetUser: params[2],
        reason: params[3],
        targetAccountId: params[4],
        operationType: params[5],
        adminAccountId: params[6],
      });
      return resultRows([{ id: auditEntries.length }]);
    }
    return emptyResult;
  });

  const headers = { Authorization: 'Bearer admin-token' };
  const missingReason = await requestJson(baseUrl, '/api/accounts/42', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ reason: '   ', role: 'admin', deleted_by: 999 }),
  });
  assert.equal(missingReason.status, 400);
  assert.match(missingReason.body.error, /reason.*required/i);
  assert.equal(archiveMutated, false);
  assert.equal(auditEntries.length, 0);

  const archive = await requestJson(baseUrl, '/api/accounts/42', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ reason: '  No longer assigned to this school.  ', role: 'admin', deleted_by: 999 }),
  });
  assert.equal(archive.status, 200);
  assert.equal(archiveMutated, true);
  assert.deepEqual(auditEntries[0], {
    adminName: 'Authenticated Admin',
    action: 'Archive Account',
    targetUser: 'Archived Teacher',
    reason: 'No longer assigned to this school.',
    targetAccountId: 42,
    operationType: 'archive',
    adminAccountId: 1,
  });

  const permanent = await requestJson(baseUrl, '/api/accounts/42?permanent=true', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ reason: 'Duplicate record cleanup.', permanent_confirmation: 'DELETE' }),
  });
  assert.equal(permanent.status, 200);
  assert.equal(permanentlyDeleted, true);
  assert.equal(auditEntries[1].operationType, 'permanent_delete');
  assert.equal(auditEntries[1].reason, 'Duplicate record cleanup.');
});

test('admin account management writes audit log entries for create edit archive restore and role change', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auditEntries = [];
  const accounts = new Map([
    [1, { id: 1, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false, session_version: 0 }],
    [42, { id: 42, name: 'Target Teacher', email: 'teacher@example.com', role: 'teacher', is_archived: false, session_version: 0, employee_id: '1234567890' }],
    [43, { id: 43, name: 'Role Change User', email: 'role-change@example.com', role: 'teacher', is_archived: false, session_version: 0, employee_id: '5555555555' }],
  ]);
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select 1 from public.accounts where parent_id')) {
      return emptyResult;
    }
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows(accounts.has(Number(params[0])) ? [accounts.get(Number(params[0]))] : []);
    }
    if (sql.startsWith('select id, role from public.accounts where id = $1')) {
      const account = accounts.get(Number(params[0]));
      return resultRows(account ? [{ id: account.id, role: account.role }] : []);
    }
    if (sql.startsWith('insert into public.accounts')) {
      const created = {
        id: 90,
        name: params[0],
        email: params[1],
        role: params[3],
        mobile_number: params[4],
        address: params[5],
        birthday: params[6],
        gender: params[7],
        employee_id: params[8],
        must_change_password: params[10],
        parent_id: params[11],
        temporary_password_issued_at: params[12],
        temporary_password_expires_at: params[13],
      };
      accounts.set(created.id, created);
      return resultRows([created]);
    }
    if (sql.startsWith('update public.accounts set name=')) {
      const id = Number(params[12]);
      const updated = {
        ...accounts.get(id),
        name: params[0],
        email: params[1],
        role: params[2],
        mobile_number: params[4],
        address: params[5],
        birthday: params[6],
        gender: params[7],
        status: params[8],
        employee_id: params[9],
        is_archived: params[10],
        parent_id: params[11],
      };
      accounts.set(id, updated);
      return resultRows([updated]);
    }
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
      const account = accounts.get(Number(params[0]));
      return resultRows(account ? [{ id: account.id, email: account.email, role: account.role, is_archived: account.is_archived }] : []);
    }
    if (sql.startsWith('select count')) {
      return resultRows([{ count: '2' }]);
    }
    if (sql.startsWith('update public.accounts set is_archived = true')) {
      const account = { ...accounts.get(Number(params[0])), is_archived: true, status: 'Offline', session_version: 1 };
      accounts.set(account.id, account);
      return resultRows([account]);
    }
    if (sql.startsWith('delete from public.login_otp_device_skips')) {
      return emptyResult;
    }
    if (sql.startsWith('update public.accounts set is_archived = false')) {
      const account = { ...accounts.get(Number(params[0])), is_archived: false };
      accounts.set(account.id, account);
      return resultRows([account]);
    }
    if (sql.startsWith('insert into public.admin_audit_logs')) {
      auditEntries.push({ adminName: params[0], action: params[1], targetUser: params[2] });
      return resultRows([{ id: auditEntries.length }]);
    }
    return emptyResult;
  });

  const authHeaders = { Authorization: 'Bearer admin-token' };
  const createResponse = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'New Parent',
      email: 'new.parent@gmail.com',
      role: 'parent',
    }),
  });
  const editResponse = await requestJson(baseUrl, '/api/accounts/42', {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Edited Teacher',
      email: 'teacher@example.com',
      employee_id: '1234567890',
    }),
  });
  const roleChangeResponse = await requestJson(baseUrl, '/api/accounts/43', {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Role Change User',
      email: 'role-change@example.com',
      role: 'parent',
    }),
  });
  const archiveResponse = await requestJson(baseUrl, '/api/accounts/42', {
    method: 'DELETE',
    headers: authHeaders,
    body: JSON.stringify({ reason: 'Account no longer requires access.' }),
  });
  const restoreResponse = await requestJson(baseUrl, '/api/accounts/42/restore', {
    method: 'POST',
    headers: authHeaders,
  });

  assert.equal(createResponse.status, 201);
  assert.equal(editResponse.status, 200);
  assert.equal(roleChangeResponse.status, 200);
  assert.equal(archiveResponse.status, 200);
  assert.equal(restoreResponse.status, 200);
  assert.deepEqual(auditEntries.map((entry) => entry.adminName), [
    'Ada Admin',
    'Ada Admin',
    'Ada Admin',
    'Ada Admin',
    'Ada Admin',
    'Ada Admin',
  ]);
  assert.deepEqual(auditEntries.map((entry) => entry.action), [
    'Create Account',
    'Edit Account',
    'Edit Account',
    'Change Role',
    'Archive Account',
    'Restore Account',
  ]);
  assert.equal(auditEntries[0].targetUser, 'New Parent');
  assert.equal(auditEntries[2].targetUser, 'Role Change User');
});

test('credential email failure logs safe production diagnostics', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = authenticateAsAdmin();
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
    headers: authHeaders,
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
  const authHeaders = authenticateAsAdmin();
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    headers: authHeaders,
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
  const authHeaders = authenticateAsAdmin();
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    headers: authHeaders,
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

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 1, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false, session_version: 0 }]);
    }
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
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

  const response = await requestJson(baseUrl, '/api/accounts/42', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ reason: 'Employment ended.' }),
  });

  assert.equal(response.status, 200);
  assert.match(response.body.message, /archived/i);
  assert.ok(statements.some((entry) => entry.sql.includes('session_version = coalesce(session_version, 0) + 1')));
  assert.ok(statements.some((entry) => entry.sql.includes('otp_code = null') && entry.sql.includes('otp_expires_at = null')));
  assert.ok(statements.some((entry) => entry.sql.startsWith('delete from public.login_otp_device_skips')));
});

test('permanent account deletion requires an archived account and typed DELETE confirmation', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let targetArchived = false;
  let permanentlyDeleted = false;

  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{
        id: 1,
        name: 'Ada Admin',
        email: 'ada@example.com',
        role: 'admin',
        is_archived: false,
        session_version: 0,
      }]);
    }
    if (sql.startsWith('select id, email, role, is_archived from public.accounts where id = $1')) {
      return resultRows([{
        id: Number(params[0]),
        email: 'archived.teacher@example.com',
        role: 'teacher',
        is_archived: targetArchived,
      }]);
    }
    if (sql.startsWith('delete from public.login_otp_device_skips')) return emptyResult;
    if (sql.startsWith('delete from public.accounts where id = $1')) {
      permanentlyDeleted = true;
      return emptyResult;
    }
    if (sql.startsWith('insert into public.admin_audit_logs')) return resultRows([{ id: 1 }]);
    return emptyResult;
  });

  const headers = { Authorization: 'Bearer admin-token' };
  const activeTarget = await requestJson(baseUrl, '/api/accounts/42?permanent=true', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ reason: 'Duplicate account cleanup.', permanent_confirmation: 'DELETE' }),
  });
  assert.equal(activeTarget.status, 409);
  assert.equal(permanentlyDeleted, false);

  targetArchived = true;
  const missingTypedConfirmation = await requestJson(baseUrl, '/api/accounts/42?permanent=true', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ reason: 'Duplicate account cleanup.' }),
  });
  assert.equal(missingTypedConfirmation.status, 400);
  assert.match(missingTypedConfirmation.body.error, /type delete/i);
  assert.equal(permanentlyDeleted, false);

  const permanent = await requestJson(baseUrl, '/api/accounts/42?permanent=true', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ reason: 'Duplicate account cleanup.', permanent_confirmation: 'DELETE' }),
  });
  assert.equal(permanent.status, 200);
  assert.equal(permanentlyDeleted, true);
});

test('a structurally valid set with proved arithmetic conflict receives approval but remains publication-gated', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const statements = [];
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  const reviewedFile = {
    id: 91,
    title: 'reviewed-basic-addition.docx',
    file_name: 'reviewed-basic-addition.docx',
    file_type: 'fixed_questions',
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    topic_id: 'basic_addition',
    math_topic: 'Basic Addition',
    document_topic: 'Addition and Subtraction',
    published: false,
    publish_status: 'staged',
    approval_status: 'review_required',
  };
  const additionQuestionNumbers = new Set([1, 2, 4, 6, 8, 10, 11, 13, 15]);
  const reviewedQuestions = Array.from({ length: 15 }, (_, index) => {
    const number = index + 1;
    const isAddition = additionQuestionNumbers.has(number);
    const correctAnswer = isAddition ? String(number + 1) : '1';
    return {
      id: 910 + number,
      learning_file_id: 91,
      question: isAddition ? `What is ${number} + 1?` : `What is ${number} - ${number - 1}?`,
      options: [String(Number(correctAnswer) - 1), correctAnswer, String(Number(correctAnswer) + 1), String(Number(correctAnswer) + 2)],
      correct_answer: correctAnswer,
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: null,
    };
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 1, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false, session_version: 0 }]);
    }
    if (sql.startsWith('select * from public.learning_files where id = $1')) return resultRows([reviewedFile]);
    if (sql.includes('from public.questions') && sql.includes('where learning_file_id = $1')) return resultRows(reviewedQuestions);
    if (sql.startsWith('update public.learning_files set approval_status =')) {
      return resultRows([{ ...reviewedFile, approval_status: 'approved', approved_by: params[1], approved_content_fingerprint: params[2] }]);
    }
    if (sql.startsWith('insert into public.admin_audit_logs')) return resultRows([{ id: 1 }]);
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/91/approve', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.learningFile.approval_status, 'approved');
  assert.equal(response.body.validation.review_eligibility.eligible, true);
  assert.equal(response.body.validation.publication_eligibility.eligible, false);
  assert.equal(response.body.validation.publication_eligibility.code, 'QUESTION_TOPIC_MISMATCH');
  assert.match(response.body.validation.publication_eligibility.message, /Question 3 conflicts with selected Topic: Basic Addition/i);
  assert.ok(statements.some((entry) => entry.sql.startsWith('update public.learning_files set approval_status =')));
  assert.ok(statements.some((entry) => entry.sql.startsWith('insert into public.admin_audit_logs')));
});

test('a structurally invalid question set cannot be approved', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let approvalUpdateAttempted = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 1, name: 'Ada Admin', email: 'ada@example.com', role: 'admin', is_archived: false, session_version: 0 }]);
    }
    if (sql.startsWith('select * from public.learning_files where id = $1')) {
      return resultRows([{
        id: 92,
        file_type: 'fixed_questions',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        document_topic: 'Basic Addition',
        published: false,
        publish_status: 'staged',
        approval_status: 'review_required',
      }]);
    }
    if (sql.includes('from public.questions') && sql.includes('where learning_file_id = $1')) {
      return resultRows([{
        id: 921,
        learning_file_id: 92,
        question: 'What is 2 + 3?',
        options: ['3', '4', '5'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
      }]);
    }
    if (sql.startsWith('update public.learning_files set approval_status =')) approvalUpdateAttempted = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/92/approve', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.code, 'QUESTION_SET_REVIEW_VALIDATION_FAILED');
  assert.equal(response.body.review_eligibility.code, 'STRUCTURAL_VALIDATION_FAILED');
  assert.equal(approvalUpdateAttempted, false);
});

test('only Lesson Manager roles in Teacher scope can reach question-set approval', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  const deniedAccounts = [
    { id: 31, role: 'parent' },
    { id: 32, role: 'student' },
    { id: 33, role: 'parent_teacher', scope: 'parent' },
  ];
  for (const account of deniedAccounts) {
    authenticatedTestAccount = {
      ...account,
      name: `${account.role} account`,
      email: `${account.role}@example.com`,
      is_archived: false,
      session_version: 0,
    };
    verifiedTokenPayload = { userId: account.id, sessionVersion: 0 };
    const response = await requestJson(baseUrl, `/api/learning-files/91/approve${account.scope ? `?scope=${account.scope}` : ''}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer role-token' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403);
    if (account.role === 'parent_teacher') {
      assert.equal(response.body.code, 'LESSON_MANAGER_TEACHER_SCOPE_REQUIRED');
    }
  }
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

test('session validation rejects tokens after their explicit 30-day expiry', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let accountLookups = 0;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = {
    userId: 77,
    email: 'teacher@example.com',
    sessionVersion: 1,
    sessionExpiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      accountLookups += 1;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/session/validate', {
    headers: { Authorization: 'Bearer expired-token' },
  });

  assert.equal(response.status, 401);
  assert.match(response.body.error, /expired/i);
  assert.equal(accountLookups, 0);
});

test('remember tokens include 30-day session metadata and the account session version', async (t) => {
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
      return resultRows([{ id: 1, otp_skipped_until: '2026-07-08T00:00:00.000Z' }]);
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
  assert.equal(signedTokenPayloads[0].role, 'teacher');
  assert.equal(signedTokenPayloads[0].otpTrustExpiresAt, '2026-07-08T00:00:00.000Z');
  assert.ok(signedTokenPayloads[0].sessionIssuedAt);
  assert.ok(signedTokenPayloads[0].otpVerifiedAt);
  assert.ok(signedTokenPayloads[0].sessionExpiresAt);
  assert.equal(signedTokenOptions[0].expiresIn, '30d');
  assert.equal(
    Math.round((new Date(signedTokenPayloads[0].sessionExpiresAt) - new Date(signedTokenPayloads[0].sessionIssuedAt)) / (24 * 60 * 60 * 1000)),
    30
  );
});

test('active Parent/Teacher accounts receive a canonical Parent ID and pass Godot validation', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = authenticateAsAdmin();
  let insertParams = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select 1 from public.accounts where parent_id = $1')) return emptyResult;
    if (sql.startsWith('insert into public.accounts')) {
      insertParams = params;
      return resultRows([{
        id: 301,
        name: params[0],
        email: params[1],
        role: params[3],
        employee_id: params[8],
        must_change_password: params[10],
        parent_id: params[11],
        temporary_password_issued_at: params[12],
        temporary_password_expires_at: params[13],
        is_archived: false,
      }]);
    }
    if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) {
      return resultRows([{
        id: 301,
        name: 'Pat Combined',
        parent_id: params[0],
        role: 'parent_teacher',
        is_archived: false,
      }]);
    }
    return emptyResult;
  });

  const created = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Pat Combined',
      email: 'pat.combined@example.com',
      role: 'Parent/Teacher',
      employee_id: '1234567890',
    }),
  });

  assert.equal(created.status, 201);
  assert.equal(insertParams[3], 'parent_teacher');
  assert.equal(insertParams[10], true);
  assert.match(insertParams[11], /^\d{6}$/);
  assert.equal(created.body.user.parent_id, insertParams[11]);
  assert.equal(created.body.user.requiresInitialPasswordSetup, true);

  const validated = await requestJson(baseUrl, '/api/game/parent/validate', {
    method: 'POST',
    body: JSON.stringify({ parent_id: insertParams[11] }),
  });

  assert.equal(validated.status, 200);
  assert.equal(validated.body.ok, true);
  assert.equal(validated.body.parent.role, 'parent_teacher');
});

test('archived Parent/Teacher accounts are rejected by Godot Parent ID validation', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) {
      return resultRows([{
        id: 302,
        name: 'Archived Combined',
        parent_id: '123456',
        role: 'parent_teacher',
        is_archived: true,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/parent/validate', {
    method: 'POST',
    body: JSON.stringify({ parent_id: '123456' }),
  });

  assert.equal(response.status, 403);
  assert.match(response.body.error, /no longer active/i);
});

test('Parent ID generation retries a duplicate code before creating a Parent account', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = authenticateAsAdmin();
  const codeChecks = [];
  let insertedParentId = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select 1 from public.accounts where parent_id = $1')) {
      codeChecks.push(params[0]);
      return codeChecks.length === 1 ? resultRows([{ id: 99 }]) : emptyResult;
    }
    if (sql.startsWith('insert into public.accounts')) {
      insertedParentId = params[11];
      return resultRows([{
        id: 303,
        name: params[0],
        email: params[1],
        role: params[3],
        parent_id: params[11],
        is_archived: false,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Retry Parent',
      email: 'retry.parent@example.com',
      role: 'parent',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(codeChecks.length, 2);
  assert.equal(insertedParentId, codeChecks[1]);
  assert.match(insertedParentId, /^\d{6}$/);
});
