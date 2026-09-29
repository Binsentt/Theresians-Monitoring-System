const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
const authenticatedAccounts = {
  1: { id: 1, name: 'Admin User', role: 'admin', is_archived: false, session_version: 0 },
  12: { id: 12, name: 'Teacher User', role: 'teacher', is_archived: null, session_version: 0 },
  13: { id: 13, name: 'Other Teacher', role: 'teacher', is_archived: false, session_version: 0 },
  14: { id: 14, name: 'Parent User', role: 'parent', is_archived: false, session_version: 0 },
  15: { id: 15, name: 'Parent Teacher', role: 'parent_teacher', is_archived: false, session_version: 0 },
  16: { id: 16, name: 'Archived Teacher', role: 'teacher', is_archived: true, session_version: 0 },
};
const tokenPayloads = {
  'admin-token': { userId: 1, sessionVersion: 0 },
  'teacher-token': { userId: 12, sessionVersion: 0 },
  'other-teacher-token': { userId: 13, sessionVersion: 0 },
  'parent-token': { userId: 14, sessionVersion: 0 },
  'parent-teacher-token': { userId: 15, sessionVersion: 0 },
  'archived-teacher-token': { userId: 16, sessionVersion: 0 },
};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    if (compactSql(sql).startsWith('select * from public.accounts where id = $1')) {
      const account = authenticatedAccounts[Number(params[0])];
      return account ? resultRows([account]) : emptyResult;
    }
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
    verify: (token) => tokenPayloads[token] || {},
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
const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

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

  let inserted;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select id, name, role from public.accounts')) {
      return resultRows([authenticatedAccounts[Number(params[0])]]);
    }

    if (sql.startsWith('insert into public.announcements')) {
      inserted = params;
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
    headers: authHeaders('teacher-token'),
    body: JSON.stringify({
      title: 'Class reminder',
      message: 'Please review the lesson activity.',
      created_by: 12,
      created_by_role: 'teacher',
      target_role: 'parent',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.title, 'Class reminder');
  assert.deepEqual(inserted, ['Class reminder', 'Please review the lesson activity.', 12, 'teacher', 'parent']);
});

test('announcement mutations reject unauthenticated requests before database writes', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let mutatingQueries = 0;
  const existingAnnouncement = { id: 81, title: 'Original', message: 'Original body', created_by: 12, created_by_role: 'teacher', target_role: 'parent' };
  setQueryHandler(async (sql) => {
    if (/^(insert|update|delete)\b/.test(sql)) mutatingQueries += 1;
    if (sql.startsWith('select id, name, role from public.accounts')) return resultRows([authenticatedAccounts[12]]);
    if (sql.startsWith('select * from public.announcements') || sql.includes('from public.announcements an')) return resultRows([existingAnnouncement]);
    if (sql.startsWith('insert into public.announcements')) return resultRows([{ ...existingAnnouncement, id: 82 }]);
    if (sql.startsWith('update public.announcements')) return resultRows([existingAnnouncement]);
    return emptyResult;
  });

  const payload = {
    title: 'Forged announcement',
    message: 'This must not be saved.',
    created_by: 12,
    created_by_role: 'teacher',
    actor_id: 12,
    actor_role: 'teacher',
    target_role: 'parent',
  };
  const responses = await Promise.all([
    requestJson(baseUrl, '/api/announcements', { method: 'POST', body: JSON.stringify(payload) }),
    requestJson(baseUrl, '/api/announcements/81', { method: 'PUT', body: JSON.stringify(payload) }),
    requestJson(baseUrl, '/api/announcements/81?actor_id=12&actor_role=teacher', { method: 'DELETE', body: JSON.stringify(payload) }),
  ]);

  assert.deepEqual(responses.map(({ status }) => status), [401, 401, 401]);
  assert.equal(mutatingQueries, 0);
});

test('authenticated Admin creates an Admin announcement from the verified account identity', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let inserted;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('insert into public.announcements')) {
      inserted = params;
      return resultRows([{ id: 91, title: params[0], message: params[1], created_by: params[2], created_by_role: params[3], target_role: params[4] }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/announcements', {
    method: 'POST',
    headers: authHeaders('admin-token'),
    body: JSON.stringify({ title: 'Staff notice', message: 'Review the weekly plan.', created_by: 13, created_by_role: 'teacher', target_role: 'teacher' }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(inserted, ['Staff notice', 'Review the weekly plan.', 1, 'admin', 'teacher']);
});

test('authenticated Teacher identity cannot be forged or escalated by creator fields', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let inserted;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('insert into public.announcements')) {
      inserted = params;
      return resultRows([{ id: 92, title: params[0], message: params[1], created_by: params[2], created_by_role: params[3], target_role: params[4] }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/announcements', {
    method: 'POST',
    headers: authHeaders('teacher-token'),
    body: JSON.stringify({ title: 'Family update', message: 'Please review the class update.', created_by: 1, created_by_role: 'admin', target_role: 'parent' }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(inserted, ['Family update', 'Please review the class update.', 12, 'teacher', 'parent']);
});

test('Parent-Teacher announcement management requires Teacher scope; Parent-only cannot create', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let inserts = 0;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select id, name, role from public.accounts')) {
      return resultRows([authenticatedAccounts[Number(params[0])]]);
    }
    if (sql.startsWith('insert into public.announcements')) {
      inserts += 1;
      return resultRows([{ id: 93, title: params[0], message: params[1], created_by: params[2], created_by_role: params[3], target_role: params[4] }]);
    }
    return emptyResult;
  });
  const payload = JSON.stringify({ title: 'Family update', message: 'Please review the class update.', created_by: 15, created_by_role: 'teacher', target_role: 'parent' });

  const noScope = await requestJson(baseUrl, '/api/announcements', { method: 'POST', headers: authHeaders('parent-teacher-token'), body: payload });
  const teacherScope = await requestJson(baseUrl, '/api/announcements?scope=teacher', { method: 'POST', headers: authHeaders('parent-teacher-token'), body: payload });
  const parentOnly = await requestJson(baseUrl, '/api/announcements?scope=parent', { method: 'POST', headers: authHeaders('parent-token'), body: payload });

  assert.equal(noScope.status, 403);
  assert.equal(teacherScope.status, 201);
  assert.equal(parentOnly.status, 403);
  assert.equal(inserts, 1);
});

test('authenticated non-owner cannot update or delete another account announcement', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const writes = [];
  const existingAnnouncement = { id: 84, title: 'Other teacher post', message: 'Original', created_by: 13, created_by_role: 'teacher', target_role: 'parent' };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select') && sql.includes('from public.announcements')) return resultRows([existingAnnouncement]);
    if (sql.startsWith('update public.announcements')) {
      writes.push('update');
      return resultRows([existingAnnouncement]);
    }
    if (sql.startsWith('delete from public.announcements')) writes.push('delete');
    return emptyResult;
  });
  const forgedOwner = JSON.stringify({ title: 'Changed', message: 'Changed body', actor_id: 13, actor_role: 'teacher', created_by: 13, created_by_role: 'teacher' });

  const update = await requestJson(baseUrl, '/api/announcements/84', { method: 'PUT', headers: authHeaders('teacher-token'), body: forgedOwner });
  const deletion = await requestJson(baseUrl, '/api/announcements/84?actor_id=13&actor_role=teacher', { method: 'DELETE', headers: authHeaders('teacher-token'), body: forgedOwner });

  assert.deepEqual([update.status, deletion.status], [403, 403]);
  assert.deepEqual(writes, []);
});

test('announcement owner can update and delete using authenticated identity only', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const writes = [];
  const ownedAnnouncement = { id: 85, title: 'Teacher post', message: 'Original', created_by: 12, created_by_role: 'teacher', target_role: 'parent' };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select') && sql.includes('from public.announcements') && sql.includes('where')) return resultRows([ownedAnnouncement]);
    if (sql.startsWith('update public.announcements')) {
      writes.push('update');
      return resultRows([{ ...ownedAnnouncement, title: params[0], message: params[1] }]);
    }
    if (sql.includes('from public.announcements an')) return resultRows([ownedAnnouncement]);
    if (sql.startsWith('delete from public.announcements')) {
      writes.push('delete');
      return emptyResult;
    }
    return emptyResult;
  });

  const update = await requestJson(baseUrl, '/api/announcements/85', {
    method: 'PUT',
    headers: authHeaders('teacher-token'),
    body: JSON.stringify({ title: 'Updated title', message: 'Updated body' }),
  });
  const deletion = await requestJson(baseUrl, '/api/announcements/85', { method: 'DELETE', headers: authHeaders('teacher-token') });

  assert.equal(update.status, 200);
  assert.equal(deletion.status, 200);
  assert.deepEqual(writes, ['update', 'delete']);
});

test('invalid target and archived account are rejected without inserting', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let inserts = 0;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('insert into public.announcements')) {
      inserts += 1;
      return resultRows([{ id: 94, title: params[0], message: params[1], created_by: params[2], created_by_role: params[3], target_role: params[4] }]);
    }
    return emptyResult;
  });
  const body = JSON.stringify({ title: 'Invalid target', message: 'Do not save.', target_role: 'admin' });
  const invalidTarget = await requestJson(baseUrl, '/api/announcements', { method: 'POST', headers: authHeaders('teacher-token'), body });
  const archived = await requestJson(baseUrl, '/api/announcements', { method: 'POST', headers: authHeaders('archived-teacher-token'), body: JSON.stringify({ title: 'Archived', message: 'Do not save.', target_role: 'parent' }) });

  assert.equal(invalidTarget.status, 400);
  assert.equal(archived.status, 401);
  assert.equal(inserts, 0);
});

test('announcement listing remains available with target and creator filters', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let selectParams;
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.announcements an')) {
      selectParams = params;
      return resultRows([{ id: 96, title: 'Teacher update', target_role: 'parent' }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/announcements?target_role=parent&created_by=12&created_by_role=teacher&limit=20');

  assert.equal(response.status, 200);
  assert.equal(response.body[0].title, 'Teacher update');
  assert.deepEqual(selectParams, ['parent', 12, 'teacher', 20]);
});
