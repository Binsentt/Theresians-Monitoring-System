const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let verifiedTokenPayload = {};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const runQuery = async (sql, params = []) => {
  const rawSql = sql && typeof sql === 'object' && sql.text ? sql.text : sql;
  const rawParams = sql && typeof sql === 'object' && Array.isArray(sql.values) ? sql.values : params;
  const compacted = compactSql(rawSql);
  const result = (await queryHandler(compacted, rawParams, rawSql)) || emptyResult;
  if (result.rows?.length > 0) return result;

  // /api/playtime/start now validates the database-authoritative parent code first.
  if (compacted.includes('from public.accounts') && compacted.includes('where parent_id = $1') && compacted.includes('lower(role) in')) {
    return { rows: [{ id: 19, parent_id: rawParams[0], name: 'Parent User' }] };
  }
  return result;
};
const mockPool = {
  query: runQuery,
  connect: async () => ({
    query: runQuery,
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
    compare: async () => false,
    hash: async (value) => value,
  },
  cors: () => createMiddleware(),
  jsonwebtoken: {
    sign: () => 'token',
    verify: () => verifiedTokenPayload,
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

const resetTestState = () => {
  verifiedTokenPayload = {};
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

test('playtime start creates a Playing session for Godot gameplay', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let linkedStudentValues = null;
  let insertedValues = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) {
      linkedStudentValues = params;
      return resultRows([{ id: 44, name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_today: 25 }]);
    }
    if (sql.startsWith('insert into public.playtime_sessions')) {
      insertedValues = params;
      return resultRows([{
        id: 77,
        student_id: 44,
        parent_id: '123456',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
        status: 'Playing',
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '123456',
      student_name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: 'Section A',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.session_id, 77);
  assert.deepEqual(linkedStudentValues, [19, '001234']);
  assert.deepEqual(insertedValues.slice(0, 5), [44, '123456', 'Ava Santos', 'Grade 3', 'Section A']);
});

test('playtime start persists the linked child profile instead of caller-supplied identity metadata', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let insertedValues = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) {
      return resultRows([{
        id: 44,
        name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
      }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_today: 0 }]);
    }
    if (sql.startsWith('insert into public.playtime_sessions')) {
      insertedValues = params;
      return resultRows([{ id: 78, student_id: 44, status: 'Playing' }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '123456',
      student_name: 'Caller supplied name',
      grade_level: 'Grade 6',
      section: 'Section Z',
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(insertedValues.slice(0, 5), [44, '123456', 'Ava Santos', 'Grade 3', 'Section A']);
});

test('playtime start preserves a linked child canonical null Section instead of caller metadata', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let insertedValues = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) {
      return resultRows([{ id: 44, name: 'Ava Santos', grade_level: 'Grade 3', section: null }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_today: 0 }]);
    }
    if (sql.startsWith('insert into public.playtime_sessions')) {
      insertedValues = params;
      return resultRows([{ id: 79, student_id: 44, status: 'Playing' }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '123456',
      student_name: 'Caller supplied name',
      grade_level: 'Grade 6',
      section: 'Caller supplied Section',
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(insertedValues.slice(0, 5), [44, '123456', 'Ava Santos', 'Grade 3', null]);
});

test('playtime start creates and links an unused six-digit Student ID for New Game', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let createdStudentValues = null;
  let relationshipValues = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) return emptyResult;
    if (sql.includes('select id from public.accounts') && sql.includes('where game_student_id = $1')) return emptyResult;
    if (sql.startsWith('insert into public.accounts')) {
      createdStudentValues = params;
      return resultRows([{ id: 55, name: 'Integration Test Student', game_student_id: '000042' }]);
    }
    if (sql.includes('from public.teacher_student_relationships') && sql.includes('lower(relationship_type) = $3')) return emptyResult;
    if (sql.startsWith('insert into public.teacher_student_relationships')) {
      relationshipValues = params;
      return resultRows([{ id: 91, teacher_id: 19, student_id: 55, relationship_type: 'parent' }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_today: 0 }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes("status = 'playing'")) return emptyResult;
    if (sql.startsWith('insert into public.playtime_sessions')) {
      return resultRows([{ id: 92, student_id: 55, status: 'Playing' }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '000042',
      parent_id: '123456',
      student_name: 'Integration Test Student',
      grade_level: 'Grade 3',
      section: '',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.is_new_registration, undefined);
  assert.deepEqual(createdStudentValues.slice(-1), ['000042']);
  assert.deepEqual(relationshipValues, [19, 55, 'parent']);
});

test('playtime start rejects an archived account that already owns the submitted Student ID', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let createdStudent = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) return emptyResult;
    if (sql.includes('select id from public.accounts') && sql.includes('where game_student_id = $1')) {
      assert.doesNotMatch(sql, /coalesce\(is_archived, false\) = false/);
      return resultRows([{ id: 55 }]);
    }
    if (sql.startsWith('insert into public.accounts')) createdStudent = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '000042',
      parent_id: '123456',
      student_name: 'Integration Test Student',
      grade_level: 'Grade 3',
      section: '',
    }),
  });

  assert.equal(response.status, 403);
  assert.match(response.body.error, /already registered/i);
  assert.equal(createdStudent, false);
});

test('playtime start returns explicit can_play contract for authorized sessions', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) {
      return resultRows([{ id: 44 }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_today: 25 }]);
    }
    if (sql.startsWith('insert into public.playtime_sessions')) {
      return resultRows([{
        id: 78,
        student_id: 44,
        parent_id: '123456',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
        status: 'Playing',
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '123456',
      student_name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: 'Section A',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.can_play, true);
  assert.equal(response.body.message, 'Playtime session started.');
});

test('server-authoritative playtime migration is additive and preserves existing rows', () => {
  const migrationPath = path.join(__dirname, 'migrations', '007_add_server_authoritative_playtime.sql');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  for (const column of [
    'total_playtime_seconds',
    'server_started_at',
    'expires_at',
    'last_heartbeat_at',
    'session_credential_hash',
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`, 'i'));
  }
  assert.match(migration, /add column if not exists playtime_session_id/i);
  assert.doesNotMatch(migration, /\b(drop|truncate|update)\b/i);
});

test('playtime start ignores caller time and returns a server-authoritative lease', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let insertSql = '';
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params, rawSql) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) {
      return resultRows([{ id: 44 }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_today: 25 }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes("status = 'playing'")) {
      return emptyResult;
    }
    if (sql.startsWith('insert into public.playtime_sessions')) {
      insertSql = String(rawSql);
      return resultRows([{
        id: 79,
        student_id: 44,
        parent_id: '123456',
        status: 'Playing',
        server_started_at: '2026-08-22T08:00:00.000Z',
        expires_at: '2026-08-22T08:35:00.000Z',
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '123456',
      student_name: 'Ava Santos',
      grade_level: 'Grade 3',
      start_time: '2000-01-01T00:00:00.000Z',
    }),
  });

  assert.equal(response.status, 201);
  assert.doesNotMatch(insertSql, /coalesce\(\$6::timestamptz/i);
  assert.equal(response.body.remaining_seconds, 2100);
  assert.equal(response.body.expires_at, '2026-08-22T08:35:00.000Z');
  assert.match(response.body.session_credential, /^[a-f0-9]{64}$/);
});

test('playtime start preserves six-digit external student IDs through the link lookup and rejects bad contracts', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let linkedStudentValues = null;
  let totalTodayCallCount = 0;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) {
      linkedStudentValues = params;
      if (params[0] === 19 && params[1] === '001234') {
        return resultRows([{ id: 44 }]);
      }
      return emptyResult;
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      totalTodayCallCount += 1;
      return resultRows([{ total_playtime_today: 15 }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('status = \'playing\'')) {
      return emptyResult;
    }
    if (sql.startsWith('insert into public.playtime_sessions')) {
      return resultRows([{
        id: 88,
        student_id: 44,
        parent_id: '123456',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
        status: 'Playing',
      }]);
    }
    return emptyResult;
  });

  const validResponse = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '123456',
      student_name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: 'Section A',
    }),
  });

  assert.equal(validResponse.status, 201);
  assert.equal(validResponse.body.success, true);
  assert.deepEqual(linkedStudentValues, [19, '001234']);
  assert.equal(totalTodayCallCount, 1);

  const malformedStudent = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '12345',
      parent_id: '123456',
      student_name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: 'Section A',
    }),
  });
  assert.equal(malformedStudent.status, 400);

  const malformedParent = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '12345',
      student_name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: 'Section A',
    }),
  });
  assert.equal(malformedParent.status, 400);

  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) {
      return emptyResult;
    }
    if (sql.includes('select id from public.accounts') && sql.includes('where game_student_id = $1')) {
      return emptyResult;
    }
    if (sql.startsWith('insert into public.accounts')) {
      return resultRows([{ id: 45, game_student_id: '001234' }]);
    }
    if (sql.includes('from public.teacher_student_relationships') && sql.includes('lower(relationship_type) = $3')) {
      return emptyResult;
    }
    if (sql.startsWith('insert into public.teacher_student_relationships')) {
      return resultRows([{ id: 92, teacher_id: 19, student_id: 45, relationship_type: 'parent' }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_today: 15 }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes("status = 'playing'")) return emptyResult;
    if (sql.startsWith('insert into public.playtime_sessions')) {
      return resultRows([{ id: 93, student_id: 45, status: 'Playing' }]);
    }
    return emptyResult;
  });

  const unlinkedResponse = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '123456',
      student_name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: 'Section A',
    }),
  });
  assert.equal(unlinkedResponse.status, 201);
  assert.equal(unlinkedResponse.body.is_new_registration, undefined);
  assert.equal(unlinkedResponse.body.can_play, true);

  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.accounts s') && sql.includes('game_student_id = $2')) {
      return resultRows([{ id: 44 }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_today: 60 }]);
    }
    return emptyResult;
  });

  const limitResponse = await requestJson(baseUrl, '/api/playtime/start', {
    method: 'POST',
    body: JSON.stringify({
      student_id: '001234',
      parent_id: '123456',
      student_name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: 'Section A',
    }),
  });
  assert.equal(limitResponse.status, 403);
  assert.equal(limitResponse.body.can_play, false);
});

test('playtime end requires the issued lease credential and ignores caller end time', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let updatedValues = null;
  let updateSql = '';
  const sessionCredential = 'a'.repeat(64);
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select *') && sql.includes('from public.playtime_sessions') && sql.includes('status = \'playing\'')) {
      return resultRows([{
        id: 77,
        student_id: 44,
        status: 'Playing',
        session_credential_hash: crypto.createHash('sha256').update(sessionCredential).digest('hex'),
      }]);
    }
    if (sql.startsWith('update public.playtime_sessions')) {
      updatedValues = params;
      updateSql = sql;
      return resultRows([{
        id: 77,
        student_id: 44,
        end_time: '2026-06-01T09:30:00.000Z',
        total_playtime_minutes: 30,
        status: 'Completed',
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/end', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 77,
      end_time: '2026-06-01T09:30:00.000Z',
      status: 'Completed',
      session_credential: sessionCredential,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.session.total_playtime_minutes, 30);
  assert.deepEqual(updatedValues, [77, 'Completed']);
  assert.doesNotMatch(updateSql, /\$3::timestamptz/);
});

test('playtime end rejects a missing or invalid lease credential', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  const missingCredential = await requestJson(baseUrl, '/api/playtime/end', {
    method: 'POST',
    body: JSON.stringify({ session_id: 77, status: 'Completed' }),
  });
  assert.equal(missingCredential.status, 400);

  setQueryHandler(async (sql) => {
    if (sql.startsWith('select *') && sql.includes('from public.playtime_sessions')) {
      return resultRows([{
        id: 77,
        status: 'Playing',
        session_credential_hash: crypto.createHash('sha256').update('a'.repeat(64)).digest('hex'),
      }]);
    }
    return emptyResult;
  });
  const invalidCredential = await requestJson(baseUrl, '/api/playtime/end', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 77,
      session_credential: 'b'.repeat(64),
      status: 'Completed',
    }),
  });
  assert.equal(invalidCredential.status, 403);
});

test('playtime heartbeat refreshes an unexpired server lease without accepting client timing', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sessionCredential = 'c'.repeat(64);
  let heartbeatUpdateSql = '';
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql, _params, rawSql) => {
    if (sql.startsWith('select *,') && sql.includes('from public.playtime_sessions')) {
      return resultRows([{
        id: 77,
        student_id: 44,
        status: 'Playing',
        remaining_seconds: 120,
        expires_at: '2026-08-22T09:02:00.000Z',
        session_credential_hash: crypto.createHash('sha256').update(sessionCredential).digest('hex'),
      }]);
    }
    if (sql.startsWith('update public.playtime_sessions') && sql.includes('last_heartbeat_at')) {
      heartbeatUpdateSql = String(rawSql);
      return resultRows([{
        id: 77,
        student_id: 44,
        status: 'Playing',
        remaining_seconds: 119,
        expires_at: '2026-08-22T09:02:00.000Z',
      }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_seconds: 3481, total_playtime_today: 58 }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 77,
      session_credential: sessionCredential,
      client_remaining_seconds: 999999,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.remaining_seconds, 119);
  assert.equal(response.body.can_play, true);
  assert.match(heartbeatUpdateSql, /last_heartbeat_at = now\(\)/i);
  assert.doesNotMatch(heartbeatUpdateSql, /client_remaining_seconds|timestamp/i);
});

test('playtime heartbeat expires the lease server-side and blocks additional gameplay', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sessionCredential = 'd'.repeat(64);
  let timeoutUpdate = false;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.startsWith('select *,') && sql.includes('from public.playtime_sessions')) {
      return resultRows([{
        id: 77,
        student_id: 44,
        status: 'Playing',
        remaining_seconds: 0,
        expires_at: '2026-08-22T09:00:00.000Z',
        session_credential_hash: crypto.createHash('sha256').update(sessionCredential).digest('hex'),
      }]);
    }
    if (sql.startsWith('update public.playtime_sessions') && sql.includes("status = 'timed out'")) {
      timeoutUpdate = true;
      return resultRows([]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      return resultRows([{ total_playtime_seconds: 3600, total_playtime_today: 60 }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ session_id: 77, session_credential: sessionCredential }),
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.can_play, false);
  assert.equal(response.body.remaining_seconds, 0);
  assert.equal(timeoutUpdate, true);
});

test('all-student playtime rejects parent sessions and allows admin scoped filters', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let allSessionsSql = '';
  let allSessionsParams = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 10, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 10, role: 'parent', parent_id: '123456', session_version: 0 }]);
    }
    return emptyResult;
  });

  const parentResponse = await requestJson(baseUrl, '/api/playtime', {
    headers: { Authorization: 'Bearer parent-token' },
  });
  assert.equal(parentResponse.status, 403);

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 1, role: 'admin', session_version: 0 }]);
    }
    if (sql.startsWith('select count(*)::integer as total from public.playtime_sessions ps')) {
      return resultRows([{ total: 1 }]);
    }
    if (sql.startsWith('select ps.id')) {
      allSessionsSql = sql;
      allSessionsParams = params;
      return resultRows([{
        id: 5,
        student_id: 44,
        parent_id: '123456',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
        date_played: '2026-06-01',
        start_time: '2026-06-01T09:00:00.000Z',
        end_time: '2026-06-01T09:30:00.000Z',
        total_playtime_minutes: 30,
        status: 'Completed',
      }]);
    }
    return emptyResult;
  });

  const adminResponse = await requestJson(
    baseUrl,
    '/api/playtime?date=2026-06-01&grade_level=Grade%203&section=Section%20A&student_id=44&parent_id=123456&status=Completed&search=ava&sort_by=total_playtime&sort_order=asc',
    { headers: { Authorization: 'Bearer admin-token' } }
  );

  assert.equal(adminResponse.status, 200);
  assert.equal(adminResponse.body.data.length, 1);
  assert.match(allSessionsSql, /order by ps\.total_playtime_minutes asc/);
  assert.deepEqual(allSessionsParams.slice(0, 7), [
    '2026-06-01',
    'Grade 3',
    'Section A',
    44,
    '123456',
    'Completed',
    '%ava%',
  ]);
});

test('my child playtime is scoped to the authenticated parent linkage and parent code', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let scopedSql = '';
  let scopedParams = null;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 10, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 10, role: 'parent', parent_id: '123456', session_version: 0 }]);
    }
    if (sql.startsWith('select count(*)::integer as total from public.playtime_sessions ps')) {
      return resultRows([{ total: 1 }]);
    }
    if (sql.startsWith('select ps.id')) {
      scopedSql = sql;
      scopedParams = params;
      return resultRows([{
        id: 5,
        student_id: 44,
        parent_id: '123456',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
        date_played: '2026-06-01',
        start_time: '2026-06-01T09:00:00.000Z',
        end_time: '2026-06-01T09:30:00.000Z',
        total_playtime_minutes: 30,
        status: 'Completed',
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/my-children?student_id=44&status=Completed', {
    headers: { Authorization: 'Bearer parent-token' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.match(scopedSql, /teacher_student_relationships/);
  assert.match(scopedSql, /ps\.parent_id = \$2/);
  assert.deepEqual(scopedParams.slice(0, 4), [10, '123456', 44, 'Completed']);
});

test('playtime list defaults to student name ordering and hides Auto Save statuses', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let listSql = '';
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 1, role: 'admin', session_version: 0 }]);
    }
    if (sql.startsWith('select count(*)::integer as total from public.playtime_sessions ps')) {
      return resultRows([{ total: 1 }]);
    }
    if (sql.startsWith('select ps.id')) {
      listSql = sql;
      return resultRows([{
        id: 6,
        student_id: 45,
        parent_id: '123456',
        student_name: 'Noah Santos',
        child_name: 'Noah Santos',
        grade_level: 'Grade 3',
        section: 'Section B',
        date_played: '2026-06-02',
        start_time: '2026-06-02T09:00:00.000Z',
        end_time: '2026-06-02T09:30:00.000Z',
        total_playtime_minutes: 30,
        status: 'Auto Saved',
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime', {
    headers: { Authorization: 'Bearer admin-token' },
  });

  assert.equal(response.status, 200);
  assert.match(listSql, /order by ps\.student_name asc/);
  assert.equal(response.body.data[0].status, 'Completed');
});

test('daily playtime limit reports remaining minutes and can_play status', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    resetTestState();
    await close(server);
  });

  verifiedTokenPayload = { userId: 1, sessionVersion: 0 };
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([{ id: 1, role: 'admin', session_version: 0, is_archived: false }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('date_played = current_date')) {
      assert.equal(params[0], 44);
      return resultRows([{ total_playtime_today: 60 }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/playtime/today/44', {
    headers: { Authorization: 'Bearer admin-token' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    student_id: 44,
    total_playtime_today: 60,
    total_playtime_seconds: 3600,
    remaining_minutes: 0,
    remaining_seconds: 0,
    can_play: false,
    daily_limit_minutes: 60,
  });
});
