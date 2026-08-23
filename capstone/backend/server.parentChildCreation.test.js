const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
const authenticatedAccounts = {
  19: { id: 19, name: 'Parent User', role: 'parent', parent_id: '112832', session_version: 0, is_archived: false },
  20: { id: 20, name: 'Parent Teacher', role: 'parent_teacher', parent_id: '112833', session_version: 0, is_archived: false },
  16: { id: 16, name: 'Teacher User', role: 'teacher', session_version: 0, is_archived: false },
};
const tokenPayloads = {
  'parent-token': { userId: 19, sessionVersion: 0 },
  'parent-teacher-token': { userId: 20, sessionVersion: 0 },
  'teacher-token': { userId: 16, sessionVersion: 0 },
};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const runQuery = async (sql, params = []) => {
  const compacted = compactSql(sql);
  if (compacted.startsWith('select * from public.accounts where id = $1')) {
    const account = authenticatedAccounts[Number(params[0])];
    return account ? { rows: [account] } : emptyResult;
  }
  return (await queryHandler(compacted, params, sql)) || emptyResult;
};
const mockPool = {
  query: runQuery,
  connect: async () => ({
    query: runQuery,
    release: () => {},
  }),
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const passthrough = () => (req, res, next) => next();
const originalLoad = Module._load;
Module._load = function loadWithServerStubs(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => `hashed:${value}` };
  if (request === 'cors') return () => passthrough();
  if (request === 'jsonwebtoken') return { sign: () => 'token', verify: (token) => tokenPayloads[token] || {} };
  if (request === 'multer') return () => ({ single: passthrough, array: passthrough, fields: passthrough });
  if (request === 'pdf-parse') return async () => ({ text: '' });
  return originalLoad.call(this, request, parent, isMain);
};

let app;
try {
  ({ app } = require('./server'));
} finally {
  Module._load = originalLoad;
}

const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const requestJson = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    body = { raw: text };
  }
  return { status: response.status, body };
};

const validChild = {
  first_name: 'Ava',
  last_name: 'Santos',
  middle_initial: 'M',
  grade_level: 'Grade 3',
  section: 'Section A',
  student_id: '001234',
};

test('parent child creation is authenticated, scoped, and duplicate-safe', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  await t.test('creates a six-digit child account and canonical Parent relationship from the session', async () => {
    let accountInsert = null;
    let relationshipInsert = null;
    queryHandler = async (sql, params) => {
      if (sql.includes('from public.accounts s') && sql.includes('where s.game_student_id = $1')) return emptyResult;
      if (sql.startsWith('insert into public.accounts')) {
        accountInsert = params;
        return { rows: [{ id: 44, ...validChild, game_student_id: params.at(-1), role: 'student', name: 'Ava M Santos' }] };
      }
      if (sql.startsWith('select id from public.teacher_student_relationships')) return emptyResult;
      if (sql.startsWith('insert into public.teacher_student_relationships')) {
        relationshipInsert = params;
        return { rows: [{ id: 9, teacher_id: params[0], student_id: params[1], relationship_type: params[2] }] };
      }
      return emptyResult;
    };

    const response = await requestJson(baseUrl, '/api/parent/children', {
      method: 'POST',
      headers: { Authorization: 'Bearer parent-token' },
      body: JSON.stringify({ ...validChild, parent_id: '999999' }),
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.child.game_student_id, '001234');
    assert.equal(accountInsert.includes('999999'), false);
    assert.equal(accountInsert.at(-1), '001234');
    assert.deepEqual(relationshipInsert, [19, 44, 'parent']);
  });

  await t.test('normalizes a real Section label before storing the canonical child profile', async () => {
    let accountInsert = null;
    queryHandler = async (sql, params) => {
      if (sql.includes('from public.accounts s') && sql.includes('where s.game_student_id = $1')) return emptyResult;
      if (sql.startsWith('insert into public.accounts')) {
        accountInsert = params;
        return { rows: [{ id: 46, game_student_id: params.at(-1), role: 'student', name: 'Ava M Santos', grade_level: 'Grade 3', section: 'Rizal' }] };
      }
      if (sql.startsWith('select id from public.teacher_student_relationships')) return emptyResult;
      if (sql.startsWith('insert into public.teacher_student_relationships')) return { rows: [{ id: 11 }] };
      return emptyResult;
    };

    const response = await requestJson(baseUrl, '/api/parent/children', {
      method: 'POST',
      headers: { Authorization: 'Bearer parent-token' },
      body: JSON.stringify({ ...validChild, section: '  Rizal  ', student_id: '001246' }),
    });

    assert.equal(response.status, 201);
    assert.ok(accountInsert.includes('Rizal'));
    assert.equal(accountInsert.includes('  Rizal  '), false);
  });

  await t.test('keeps a blank optional Section as null while preserving a leading-zero Student ID', async () => {
    let accountInsert = null;
    queryHandler = async (sql, params) => {
      if (sql.includes('from public.accounts s') && sql.includes('where s.game_student_id = $1')) return emptyResult;
      if (sql.startsWith('insert into public.accounts')) {
        accountInsert = params;
        return { rows: [{ id: 47, game_student_id: params.at(-1), role: 'student', name: 'Ava M Santos', grade_level: 'Grade 3', section: null }] };
      }
      if (sql.startsWith('select id from public.teacher_student_relationships')) return emptyResult;
      if (sql.startsWith('insert into public.teacher_student_relationships')) return { rows: [{ id: 12 }] };
      return emptyResult;
    };

    const response = await requestJson(baseUrl, '/api/parent/children', {
      method: 'POST',
      headers: { Authorization: 'Bearer parent-token' },
      body: JSON.stringify({ ...validChild, section: '   ', student_id: '001247' }),
    });

    assert.equal(response.status, 201);
    assert.ok(accountInsert.includes(null));
    assert.equal(accountInsert.at(-1), '001247');
  });

  await t.test('allows Parent/Teacher only through the authenticated parent identity', async () => {
    let relationshipInsert = null;
    queryHandler = async (sql, params) => {
      if (sql.includes('from public.accounts s') && sql.includes('where s.game_student_id = $1')) return emptyResult;
      if (sql.startsWith('insert into public.accounts')) return { rows: [{ id: 45, game_student_id: params.at(-1), role: 'student', name: 'Noah Santos' }] };
      if (sql.startsWith('select id from public.teacher_student_relationships')) return emptyResult;
      if (sql.startsWith('insert into public.teacher_student_relationships')) {
        relationshipInsert = params;
        return { rows: [{ id: 10 }] };
      }
      return emptyResult;
    };

    const response = await requestJson(baseUrl, '/api/parent/children', {
      method: 'POST',
      headers: { Authorization: 'Bearer parent-teacher-token' },
      body: JSON.stringify({ ...validChild, first_name: 'Noah', student_id: '001245', parent_id: '112832' }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(relationshipInsert, [20, 45, 'parent']);
  });

  await t.test('rejects unauthenticated and teacher-only callers before writes', async () => {
    let wrote = false;
    queryHandler = async (sql) => {
      if (sql.startsWith('insert')) wrote = true;
      return emptyResult;
    };

    const anonymous = await requestJson(baseUrl, '/api/parent/children', {
      method: 'POST', body: JSON.stringify(validChild),
    });
    const teacher = await requestJson(baseUrl, '/api/parent/children', {
      method: 'POST', headers: { Authorization: 'Bearer teacher-token' }, body: JSON.stringify(validChild),
    });

    assert.equal(anonymous.status, 401);
    assert.equal(teacher.status, 403);
    assert.equal(wrote, false);
  });

  await t.test('rejects an already linked or another-parent Student ID without creating a duplicate', async () => {
    let wrote = false;
    queryHandler = async (sql) => {
      if (sql.includes('from public.accounts s') && sql.includes('where s.game_student_id = $1')) {
        return { rows: [{ id: 44, game_student_id: '001234', linked_to_authenticated_parent: true, linked_to_another_parent: false }] };
      }
      if (sql.startsWith('insert')) wrote = true;
      return emptyResult;
    };

    const alreadyLinked = await requestJson(baseUrl, '/api/parent/children', {
      method: 'POST', headers: { Authorization: 'Bearer parent-token' }, body: JSON.stringify(validChild),
    });
    assert.equal(alreadyLinked.status, 409);
    assert.match(alreadyLinked.body.error, /already linked/i);

    queryHandler = async (sql) => {
      if (sql.includes('from public.accounts s') && sql.includes('where s.game_student_id = $1')) {
        return { rows: [{ id: 55, game_student_id: '001234', linked_to_authenticated_parent: false, linked_to_another_parent: true }] };
      }
      if (sql.startsWith('insert')) wrote = true;
      return emptyResult;
    };
    const differentParent = await requestJson(baseUrl, '/api/parent/children', {
      method: 'POST', headers: { Authorization: 'Bearer parent-token' }, body: JSON.stringify(validChild),
    });
    assert.equal(differentParent.status, 409);
    assert.match(differentParent.body.error, /another parent/i);
    assert.equal(wrote, false);
  });
});
