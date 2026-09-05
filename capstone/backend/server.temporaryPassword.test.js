const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let credentialMessages = [];

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    const rawSql = sql && typeof sql === 'object' && sql.text ? sql.text : sql;
    const rawParams = sql && typeof sql === 'object' && Array.isArray(sql.values) ? sql.values : params;
    return queryHandler(compactSql(rawSql), rawParams, rawSql);
  },
  connect: async () => ({
    query: mockPool.query,
    release: () => {},
  }),
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const passthroughMiddleware = () => (req, res, next) => next();
const multerStub = () => ({
  single: passthroughMiddleware,
  array: passthroughMiddleware,
  fields: passthroughMiddleware,
});
const dependencyStubs = {
  bcrypt: {
    compare: async () => true,
    hash: async (value) => `bcrypt:${value}`,
  },
  cors: () => passthroughMiddleware(),
  jsonwebtoken: {
    sign: () => 'new-session-token',
    verify: () => ({ userId: 1, sessionVersion: 0 }),
  },
  multer: multerStub,
  'pdf-parse': async () => ({ text: '' }),
  './emailDelivery.utils': {
    buildSafeEmailLogDetails: () => ({}),
    getEmailSendTimeoutMs: () => 5,
    sendEmailWithProviders: async ({ message }) => {
      credentialMessages.push(message);
      return { sent: true, provider: 'test' };
    },
  },
};

const originalLoad = Module._load;
let serverExports;
Module._load = function loadWithTemporaryPasswordStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(dependencyStubs, request)) return dependencyStubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
try {
  serverExports = require('./server');
} finally {
  Module._load = originalLoad;
}

const { app } = serverExports;

const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});
const requestJson = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    body: contentType.includes('application/json') ? await response.json() : { text: await response.text() },
  };
};

test('temporary credential routes enforce admin creation and reject expiry before OTP delivery', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await close(server);
  });

  queryHandler = async () => emptyResult;
  const unauthenticatedCreation = await requestJson(baseUrl, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'No Auth', email: 'no.auth@example.com', role: 'parent' }),
  });

  assert.equal(unauthenticatedCreation.status, 401);
  assert.match(unauthenticatedCreation.body.error, /authentication/i);

  const unauthenticatedList = await requestJson(baseUrl, '/api/accounts');
  assert.equal(unauthenticatedList.status, 401);
  assert.match(unauthenticatedList.body.error, /authentication/i);

  const unauthenticatedLegacyPasswordChange = await requestJson(baseUrl, '/api/request-password-change-otp', {
    method: 'POST',
    body: JSON.stringify({ userId: 999, email: 'other.person@example.com' }),
  });
  assert.equal(unauthenticatedLegacyPasswordChange.status, 401);
  assert.match(unauthenticatedLegacyPasswordChange.body.error, /authentication/i);

  const adminUser = {
    id: 1,
    name: 'Admin User',
    email: 'admin@example.com',
    role: 'admin',
    is_archived: false,
    session_version: 0,
  };
  const targetUser = {
    id: 44,
    name: 'Reset Teacher',
    email: 'reset.teacher@example.com',
    role: 'teacher',
    is_archived: false,
    session_version: 0,
  };
  const regenerationStatements = [];
  credentialMessages = [];
  queryHandler = async (sql, params) => {
    regenerationStatements.push({ sql, params });
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return { rows: [Number(params[0]) === 1 ? adminUser : targetUser] };
    }
    if (sql.startsWith('update public.accounts set password = $1')) {
      return { rows: [{ ...targetUser, password: params[0], must_change_password: true }] };
    }
    return emptyResult;
  };
  const regeneratedCredential = await requestJson(baseUrl, '/api/accounts/44/temporary-password', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
  });

  assert.equal(regeneratedCredential.status, 200);
  assert.equal(regeneratedCredential.body.emailSent, true);
  assert.equal(regeneratedCredential.body.tempPassword, undefined);
  assert.equal(credentialMessages.length, 1);
  assert.ok(regenerationStatements.some(({ sql }) => (
    sql.includes('temporary_password_issued_at') && sql.includes('temporary_password_expires_at')
  )));

  credentialMessages = [];
  queryHandler = async (sql, params) => {
    if (sql.includes('select * from public.accounts where lower(trim(email))')) {
      return {
        rows: [{
          id: 702,
          name: 'Expired Teacher',
          email: params[0],
          password: 'temporary-password',
          role: 'teacher',
          is_archived: false,
          must_change_password: true,
          temporary_password_issued_at: new Date(Date.now() - 60_000).toISOString(),
          temporary_password_expires_at: new Date(Date.now() - 1).toISOString(),
        }],
      };
    }
    return emptyResult;
  };

  const expiredLogin = await requestJson(baseUrl, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'expired.teacher@example.com', password: 'temporary-password' }),
  });

  assert.equal(expiredLogin.status, 401);
  assert.match(expiredLogin.body.error, /temporary password.*expired/i);
  assert.equal(credentialMessages.length, 0);

  const expiredSetupUser = {
    id: 1,
    name: 'Expired Setup Teacher',
    email: 'expired.setup@example.com',
    role: 'teacher',
    password: 'temporary-password',
    is_archived: false,
    must_change_password: true,
    temporary_password_issued_at: new Date(Date.now() - 60_000).toISOString(),
    temporary_password_expires_at: new Date(Date.now() - 1).toISOString(),
    session_version: 0,
  };
  queryHandler = async (sql) => (
    sql.includes('select * from public.accounts where id')
      ? { rows: [expiredSetupUser] }
      : emptyResult
  );
  const expiredInitialSetup = await requestJson(baseUrl, '/api/verify-password-change-otp', {
    method: 'POST',
    headers: { Authorization: 'Bearer expired-setup-token' },
    body: JSON.stringify({ userId: 1, firstLogin: true, newPassword: 'permanent-password-123' }),
  });

  assert.equal(expiredInitialSetup.status, 401);
  assert.match(expiredInitialSetup.body.error, /temporary password.*expired/i);

  const pendingUser = {
    id: 1,
    name: 'First Login Teacher',
    email: 'first.login@example.com',
    role: 'teacher',
    password: 'temporary-password',
    is_archived: false,
    must_change_password: true,
    temporary_password_issued_at: new Date(Date.now() - 1_000).toISOString(),
    temporary_password_expires_at: new Date(Date.now() + 1000).toISOString(),
    session_version: 0,
  };
  const initialPasswordStatements = [];
  queryHandler = async (sql, params) => {
    initialPasswordStatements.push({ sql, params });
    if (sql.startsWith('select * from public.accounts where id = $1')) return { rows: [pendingUser] };
    if (sql.startsWith('update public.accounts set password = $1')) {
      return { rows: [{ ...pendingUser, password: params[0], must_change_password: false, session_version: 1 }] };
    }
    return emptyResult;
  };

  const initialSetup = await requestJson(baseUrl, '/api/account/initial-password', {
    method: 'POST',
    headers: { Authorization: 'Bearer first-login-token' },
    body: JSON.stringify({ newPassword: 'permanent-password-123' }),
  });

  assert.equal(initialSetup.status, 200);
  assert.equal(initialSetup.body.user.mustChangePassword, false);
  assert.equal(initialSetup.body.rememberToken, 'new-session-token');
  assert.ok(initialPasswordStatements.some(({ sql }) => (
    sql.includes('temporary_password_issued_at = null')
      && sql.includes('temporary_password_expires_at = null')
      && sql.includes('session_version = coalesce(session_version, 0) + 1')
  )));

  const establishedUser = {
    id: 1,
    name: 'Established Teacher',
    email: 'established@example.com',
    role: 'teacher',
    password: 'current-password',
    is_archived: false,
    must_change_password: false,
    session_version: 0,
  };
  queryHandler = async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) return { rows: [establishedUser] };
    if (sql.startsWith('update public.accounts set password = $1')) {
      return { rows: [{ ...establishedUser, password: params[0], session_version: 1 }] };
    }
    return emptyResult;
  };

  const normalPasswordChange = await requestJson(baseUrl, '/api/account/password', {
    method: 'PUT',
    headers: { Authorization: 'Bearer established-token' },
    body: JSON.stringify({ currentPassword: 'current-password', newPassword: 'new-permanent-password-123' }),
  });

  assert.equal(normalPasswordChange.status, 200);
  assert.equal(normalPasswordChange.body.user.mustChangePassword, false);
  assert.equal(normalPasswordChange.body.rememberToken, 'new-session-token');
});

test('session validation does not treat stale temporary metadata as active for a permanent account', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await close(server);
  });

  queryHandler = async (sql) => (
    sql.startsWith('select * from public.accounts where id = $1')
      ? {
        rows: [{
          id: 1,
          name: 'Established Admin',
          email: 'admin@example.com',
          role: 'admin',
          is_archived: false,
          must_change_password: false,
          temporary_password_issued_at: new Date(Date.now() - 120_000).toISOString(),
          temporary_password_expires_at: new Date(Date.now() - 60_000).toISOString(),
          session_version: 0,
        }],
      }
      : emptyResult
  );

  const restoredSession = await requestJson(baseUrl, '/api/session/validate', {
    headers: { Authorization: 'Bearer established-account-token' },
  });

  assert.equal(restoredSession.status, 200);
  assert.equal(restoredSession.body.user.requiresInitialPasswordSetup, false);
});

test('every manual password write enforces the raw eight-character website password minimum', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await close(server);
  });

  const websiteAccount = {
    id: 1,
    name: 'Admin Account',
    email: 'admin@example.com',
    role: 'admin',
    password: 'current-password',
    is_archived: false,
    must_change_password: true,
    temporary_password_issued_at: new Date(Date.now() - 1_000).toISOString(),
    temporary_password_expires_at: new Date(Date.now() + 60_000).toISOString(),
    session_version: 0,
  };
  const managedTarget = {
    ...websiteAccount,
    id: 44,
    name: 'Managed Parent',
    email: 'managed.parent@example.com',
    role: 'parent',
    must_change_password: false,
  };
  const resetAccount = {
    ...websiteAccount,
    id: 72,
    email: 'recover@example.com',
    otp_code: '123456',
    otp_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const passwordWrites = [];
  queryHandler = async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return { rows: [Number(params[0]) === 44 ? managedTarget : websiteAccount] };
    }
    if (sql.startsWith('select * from accounts where lower(email)=$1 and otp_code=$2')) {
      return { rows: [resetAccount] };
    }
    if (sql.startsWith('update public.accounts set password = $1') || sql.startsWith('update accounts set password=$1')) {
      passwordWrites.push(params[0]);
      return { rows: [{ ...websiteAccount, password: params[0], must_change_password: false }] };
    }
    if (sql.startsWith('update public.accounts set name=$1')) {
      passwordWrites.push(params[3]);
      return { rows: [{ ...managedTarget, password: params[3] }] };
    }
    return emptyResult;
  };

  const shortPassword = 'seven77';
  const initial = await requestJson(baseUrl, '/api/account/initial-password', {
    method: 'POST',
    headers: { Authorization: 'Bearer teacher-token' },
    body: JSON.stringify({ newPassword: shortPassword }),
  });
  const normal = await requestJson(baseUrl, '/api/account/password', {
    method: 'PUT',
    headers: { Authorization: 'Bearer teacher-token' },
    body: JSON.stringify({ currentPassword: 'current-password', newPassword: shortPassword }),
  });
  const firstLoginOtp = await requestJson(baseUrl, '/api/verify-password-change-otp', {
    method: 'POST',
    headers: { Authorization: 'Bearer teacher-token' },
    body: JSON.stringify({ userId: 1, firstLogin: true, newPassword: shortPassword }),
  });
  const recovery = await requestJson(baseUrl, '/api/reset-password/verify', {
    method: 'POST',
    body: JSON.stringify({ email: 'recover@example.com', otp: '123456', newPassword: shortPassword }),
  });
  const adminEdit = await requestJson(baseUrl, '/api/accounts/44', {
    method: 'PUT',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ name: 'Managed Parent', password: shortPassword }),
  });

  for (const response of [initial, normal, firstLoginOtp, recovery, adminEdit]) {
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Password must be at least 8 characters.');
  }
  assert.deepEqual(passwordWrites, []);

  const rawEightCharacterPassword = '        ';
  const validInitial = await requestJson(baseUrl, '/api/account/initial-password', {
    method: 'POST',
    headers: { Authorization: 'Bearer teacher-token' },
    body: JSON.stringify({ newPassword: rawEightCharacterPassword }),
  });
  assert.equal(validInitial.status, 200);
  assert.ok(passwordWrites.includes(`bcrypt:${rawEightCharacterPassword}`));
});
