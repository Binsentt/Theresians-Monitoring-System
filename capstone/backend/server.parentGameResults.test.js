const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const GAME_RESULT_SESSION_ID = 700;
const GAME_RESULT_SESSION_CREDENTIAL = 'e'.repeat(64);

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let useDefaultGameResultLease = true;
const authenticatedAccounts = {
  1: { id: 1, role: 'admin', session_version: 0, is_archived: false },
  16: { id: 16, role: 'teacher', session_version: 0, is_archived: false },
  19: { id: 19, role: 'parent', parent_id: '112832', session_version: 0, is_archived: false },
};
const tokenPayloads = {
  'admin-token': { userId: 1, sessionVersion: 0 },
  'teacher-token': { userId: 16, sessionVersion: 0 },
  'parent-token': { userId: 19, sessionVersion: 0 },
};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const runQuery = async (sql, params = []) => {
  const compacted = compactSql(sql);
  const result = (await queryHandler(compacted, params, sql)) || emptyResult;
  if (result.rows?.length > 0) return result;

  if (compacted.startsWith('select * from public.accounts where id = $1')) {
    const account = authenticatedAccounts[Number(params[0])];
    return account ? { rows: [account] } : emptyResult;
  }

  // Current routes resolve either an internal parent key or the six-digit parent code before child access.
  // These tests are about the following relationship route, so supply that resolver seam by default.
  if (compacted.startsWith('select id from public.accounts') && compacted.includes('where id = $1')) {
    return { rows: [{ id: Number(params[0]) }] };
  }
  if (compacted.includes('from public.accounts') && compacted.includes('where parent_id = $1') && compacted.includes('lower(role) in')) {
    return { rows: [{ id: 19, parent_id: params[0], name: 'Parent User' }] };
  }
  if (useDefaultGameResultLease && compacted.includes('from public.playtime_sessions') && compacted.includes('expires_at > now()')) {
    return {
      rows: [{
        id: GAME_RESULT_SESSION_ID,
        student_id: params[1],
        parent_id: params[2],
        status: 'Playing',
        expires_at: '2099-01-01T00:00:00.000Z',
        session_credential_hash: crypto.createHash('sha256').update(GAME_RESULT_SESSION_CREDENTIAL).digest('hex'),
      }],
    };
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

// Keep route tests isolated from local or Railway database state.
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

const { app, verifyParentChildAccess } = serverExports;

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
  let requestBody = options.body;
  if (path === '/api/game/result' && options.withGameLease !== false && typeof requestBody === 'string') {
    requestBody = JSON.stringify({
      ...JSON.parse(requestBody),
      playtime_session_id: GAME_RESULT_SESSION_ID,
      playtime_session_credential: GAME_RESULT_SESSION_CREDENTIAL,
    });
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    body: requestBody,
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

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

test('parent game results routes and access middleware', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    useDefaultGameResultLease = true;
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  await t.test('stores a resolved game result session', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('from public.accounts s') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44 }]);
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        difficulty: 'Normal',
        math_topic: 'Fractions',
        score: 8,
        total_items: 10,
        played_at: '2026-05-22T08:00:00.000Z',
      }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true, resolved: true, student_id: 44 });
    assert.equal(insertedValues[2], 44);
    assert.equal(insertedValues[8], 80);
    assert.equal(insertedValues[10], null);
    assert.equal(insertedValues[11], GAME_RESULT_SESSION_ID);
    assert.equal(insertedValues[12], false);
  });

  await t.test('stores an unlinked game result session when the child name is not resolved', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('from public.accounts s') && sql.includes('teacher_student_relationships r')) {
        return emptyResult;
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_name: 'New Player',
        grade_level: 'Grade 2',
        difficulty: 'Easy',
        math_topic: 'Shapes',
        score: 4,
        total_items: 5,
      }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true, resolved: false, student_id: null });
    assert.equal(insertedValues[2], null);
    assert.equal(insertedValues[10], null);
    assert.equal(insertedValues[11], GAME_RESULT_SESSION_ID);
    assert.equal(insertedValues[12], true);
  });

  await t.test('stores a game result with a submitted linked student_id from Godot', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (
        sql.includes('from public.accounts s')
        && sql.includes('teacher_student_relationships r')
        && sql.includes('r.student_id = $2')
      ) {
        assert.deepEqual(params, [19, 44]);
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: 44,
        grade_level: 'Grade 3',
        difficulty: 'Normal',
        math_topic: 'Fractions',
        score: 8,
        total_items: 10,
      }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true, resolved: true, student_id: 44 });
    assert.equal(insertedValues[1], 'Ava Santos');
    assert.equal(insertedValues[2], 44);
    assert.equal(insertedValues[10], null);
    assert.equal(insertedValues[11], GAME_RESULT_SESSION_ID);
    assert.equal(insertedValues[12], false);
  });

  await t.test('resolves a six-digit game Student ID before persisting a question result', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('s.game_student_id = $2') && sql.includes('teacher_student_relationships r')) {
        assert.deepEqual(params, [19, '001234']);
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        difficulty: 'Hard',
        math_topic: 'Fractions',
        score: 0,
        total_items: 1,
      }),
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.student_id, 44);
    assert.equal(insertedValues[2], 44);
    assert.equal(insertedValues[4], 'Hard');
  });

  await t.test('stores a matching active question set with the individual Godot result', async () => {
    let insertedValues = null;
    let questionSetChecked = false;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('s.game_student_id = $2') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.includes('from public.learning_files') && sql.includes('where id = $1')) {
        questionSetChecked = true;
        assert.deepEqual(params, [77]);
        return resultRows([{
          id: 77,
          grade_level: 'Grade 3',
          difficulty: 'Medium',
          math_topic: 'Fractions',
          publish_status: 'active',
          deleted_at: null,
        }]);
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        difficulty: 'Normal',
        math_topic: 'Fractions',
        question_set_id: 77,
        score: 1,
        total_items: 1,
      }),
    });

    assert.equal(response.status, 201);
    assert.equal(questionSetChecked, true);
    assert.equal(insertedValues[10], 77);
    assert.equal(insertedValues[11], GAME_RESULT_SESSION_ID);
    assert.equal(insertedValues[12], false);
  });

  await t.test('uses the linked child name and grade instead of caller-supplied result metadata', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('s.game_student_id = $2') && sql.includes('teacher_student_relationships r')) {
        assert.deepEqual(params, [19, '001234']);
        return resultRows([{ id: 44, name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' }]);
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        student_name: 'Caller supplied name',
        grade_level: 'Grade 6',
        difficulty: 'Hard',
        math_topic: 'Fractions',
        score: 1,
        total_items: 1,
      }),
    });

    assert.equal(response.status, 201);
    assert.equal(insertedValues[1], 'Ava Santos');
    assert.equal(insertedValues[3], 'Grade 3');
  });

  await t.test('rejects a question set that does not match the submitted result scope', async () => {
    let insertedGameResult = false;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('s.game_student_id = $2') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.includes('from public.learning_files') && sql.includes('where id = $1')) {
        return resultRows([{
          id: 77,
          grade_level: 'Grade 2',
          difficulty: 'Medium',
          math_topic: 'Fractions',
          publish_status: 'active',
          deleted_at: null,
        }]);
      }
      if (sql.startsWith('insert into public.game_results')) insertedGameResult = true;
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        grade_level: 'Grade 3',
        difficulty: 'Medium',
        math_topic: 'Fractions',
        question_set_id: 77,
        score: 1,
        total_items: 1,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(insertedGameResult, false);
  });

  await t.test('rejects a malformed question-set ID instead of coercing it to an existing set', async () => {
    let insertedGameResult = false;
    let questionSetLookup = false;
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('s.game_student_id = $2') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.includes('from public.learning_files') && sql.includes('where id = $1')) {
        questionSetLookup = true;
      }
      if (sql.startsWith('insert into public.game_results')) insertedGameResult = true;
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        grade_level: 'Grade 3',
        difficulty: 'Medium',
        math_topic: 'Fractions',
        question_set_id: '77junk',
        score: 1,
        total_items: 1,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(insertedGameResult, false);
    assert.equal(questionSetLookup, false);
  });

  await t.test('rejects a nonexistent question set without recording a result', async () => {
    let insertedGameResult = false;
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('s.game_student_id = $2') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.includes('from public.learning_files') && sql.includes('where id = $1')) return emptyResult;
      if (sql.startsWith('insert into public.game_results')) insertedGameResult = true;
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        grade_level: 'Grade 3',
        difficulty: 'Medium',
        math_topic: 'Fractions',
        question_set_id: 999,
        score: 1,
        total_items: 1,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(insertedGameResult, false);
  });

  await t.test('rejects a staged question set without recording a result', async () => {
    let insertedGameResult = false;
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('s.game_student_id = $2') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.includes('from public.learning_files') && sql.includes('where id = $1')) {
        return resultRows([{
          id: 77,
          grade_level: 'Grade 3',
          difficulty: 'Medium',
          math_topic: 'Fractions',
          publish_status: 'staged',
        }]);
      }
      if (sql.startsWith('insert into public.game_results')) insertedGameResult = true;
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        grade_level: 'Grade 3',
        difficulty: 'Medium',
        math_topic: 'Fractions',
        question_set_id: 77,
        score: 1,
        total_items: 1,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(insertedGameResult, false);
  });

  await t.test('accepts a matching superseded set after a player has already fetched its question, including when it is in Trash', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('s.game_student_id = $2') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.includes('from public.learning_files') && sql.includes('where id = $1')) {
        assert.doesNotMatch(sql, /deleted_at\s+is\s+null/i);
        return resultRows([{
          id: 77,
          grade_level: 'Grade 3',
          difficulty: 'Medium',
          math_topic: 'Fractions',
          publish_status: 'superseded',
          deleted_at: '2026-08-16T00:00:00.000Z',
        }]);
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        grade_level: 'Grade 3',
        difficulty: 'Medium',
        math_topic: 'Fractions',
        question_set_id: 77,
        score: 1,
        total_items: 1,
      }),
    });

    assert.equal(response.status, 201);
    assert.equal(insertedValues[10], 77);
  });

  await t.test('resolves a Godot activity log public Student ID through its parent link', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('s.game_student_id = $1') && sql.includes('join public.accounts parent')) {
        assert.deepEqual(params, ['001234', '123456']);
        return resultRows([{ id: 44 }]);
      }
      if (sql.startsWith('insert into public.activity_logs')) {
        insertedValues = params;
        return resultRows([{ id: 99, student_id: 44 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/activity-logs', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        status: 'Playing',
      }),
    });

    assert.equal(response.status, 201);
    assert.equal(insertedValues[0], 44);
  });

  await t.test('stores a normalized Godot save payload as progress and activity data', async () => {
    const inserts = [];
    setQueryHandler(async (sql, params) => {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456', name: 'Parent User' }]);
      }
      if (sql.includes('from public.accounts s') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.includes('from public.student_game_progress') && sql.includes('where student_id = $1')) {
        return emptyResult;
      }
      if (sql.startsWith('insert into public.student_game_progress')) {
        inserts.push({ kind: 'progress', params });
        return resultRows([{ id: 70, student_id: params[0], progress_percentage: params[9] }]);
      }
      if (sql.startsWith('insert into public.activity_logs')) {
        inserts.push({ kind: 'activity', params });
        return resultRows([{ id: 71, student_id: params[0], total_play_time: params[6] }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/progress', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: '654321',
        student_name: 'Ava Santos',
        grade: 'Grade 3',
        section: 'St. Therese',
        current_quest: 'Boss Fractions',
        score: 140,
        correct_answers: 7,
        total_questions: 10,
        accuracy: 70,
        completion_percentage: 62,
        duration: 420,
        timestamp: '2026-05-28T10:15:00.000Z',
      }),
    });

    assert.equal(response.status, 201);
    assert.equal(inserts.find((item) => item.kind === 'progress').params[2], 'Grade 3');
    assert.equal(inserts.find((item) => item.kind === 'progress').params[8], 70);
    assert.equal(inserts.find((item) => item.kind === 'progress').params[9], 62);
    assert.equal(inserts.find((item) => item.kind === 'activity').params[6], 420);
    assert.equal(inserts.find((item) => item.kind === 'activity').params[10], 'Gameplay progress saved');
    assert.equal(inserts.find((item) => item.kind === 'activity').params[11], '2026-05-28T10:15:00.000Z');
  });

  await t.test('rejects progress sync when submitted student_id is not linked to the parent', async () => {
    let wroteProgress = false;
    setQueryHandler(async (sql) => {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456', name: 'Parent User' }]);
      }
      if (sql.includes('from public.accounts s') && sql.includes('r.student_id = $2')) {
        return emptyResult;
      }
      if (sql.includes('student_game_progress')) wroteProgress = true;
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/progress', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: 99,
        student_name: 'Ava Santos',
        score: 140,
        correct_answers: 7,
        total_questions: 10,
      }),
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'Student is not linked to this parent.');
    assert.equal(wroteProgress, false);
  });

  await t.test('stores a normalized Godot result payload using aliases', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('from public.accounts s') && sql.includes('teacher_student_relationships r')) {
        return resultRows([{ id: 44, name: 'Ava Santos' }]);
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedValues = params;
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_name: 'Ava Santos',
        grade: 'Grade 3',
        difficulty: 'Normal',
        topic: 'Fractions',
        score: 1,
        total_questions: 1,
        timestamp: '2026-05-28T10:18:00.000Z',
      }),
    });

    assert.equal(response.status, 201);
    assert.equal(insertedValues[3], 'Grade 3');
    assert.equal(insertedValues[4], 'Medium');
    assert.equal(insertedValues[5], 'Fractions');
    assert.equal(insertedValues[7], 1);
    assert.equal(insertedValues[8], 100);
    assert.equal(insertedValues[9], '2026-05-28T10:18:00.000Z');
  });

  await t.test('rejects a submitted student_id that is not linked to the parent', async () => {
    let insertedGameResult = false;
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
        return resultRows([{ id: 19, parent_id: '123456' }]);
      }
      if (sql.includes('from public.accounts s') && sql.includes('r.student_id = $2')) {
        return emptyResult;
      }
      if (sql.startsWith('insert into public.game_results')) {
        insertedGameResult = true;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/game/result', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: '123456',
        student_id: 99,
        grade_level: 'Grade 3',
        difficulty: 'Normal',
        math_topic: 'Fractions',
        score: 8,
        total_items: 10,
      }),
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'Student is not linked to this parent.');
    assert.equal(insertedGameResult, false);
  });

  await t.test('returns paginated child quizzes for a linked parent', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships') && sql.startsWith('select 1')) {
        return resultRows([{ linked: true }]);
      }
      if (sql.startsWith('select id, parent_id') && sql.includes('from public.game_results')) {
        return resultRows([{
          id: 12,
          math_topic: 'Fractions',
          score: 8,
          total_items: 10,
          percentage: '80.00',
        }]);
      }
      if (sql.startsWith('select count(*)::integer as total') && sql.includes('from public.game_results')) {
        return resultRows([{ total: 1 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children/44/quizzes?parent_id=19&page=1&limit=20', {
      headers: authHeaders('parent-token'),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data[0].math_topic, 'Fractions');
    assert.deepEqual(response.body.pagination, {
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
    });
  });

  await t.test('rejects child quiz access when the parent link is missing', async () => {
    let queriedGameResults = false;
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships') && sql.startsWith('select 1')) {
        return emptyResult;
      }
      if (sql.includes('from public.game_results')) queriedGameResults = true;
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children/44/quizzes?parent_id=21', {
      headers: authHeaders('parent-token'),
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'Parent cannot access this child.');
    assert.equal(queriedGameResults, false);
  });

  await t.test('returns topic coverage for a linked parent', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships') && sql.startsWith('select 1')) {
        return resultRows([{ linked: true }]);
      }
      if (sql.startsWith('select math_topic') && sql.includes('from public.game_results')) {
        return resultRows([{ math_topic: 'Fractions', times_played: 3, best_score: 9 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children/44/topics?parent_id=19', {
      headers: authHeaders('parent-token'),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ math_topic: 'Fractions', times_played: 3, best_score: 9 }]);
  });

  await t.test('parent children endpoint returns a clean empty-progress shape when no game results exist yet', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships tsr') && sql.includes('left join public.game_results gr on gr.resolved_student_id = s.id')) {
        return resultRows([{
          id: 44,
          name: 'Ava Santos',
          student_name: 'Ava Santos',
          email: 'ava@example.com',
          grade_level: null,
          section: 'Section A',
          total_quizzes: 0,
          last_quiz_date: null,
        }]);
      }
      if (sql.includes('count(gr.id)::integer as unlinked_count')) {
        return resultRows([{ unlinked_count: 0 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children?parent_id=19', {
      headers: authHeaders('parent-token'),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.unlinked_count, 0);
    assert.equal(response.body.children[0].student_name, 'Ava Santos');
    assert.equal(response.body.children[0].total_quizzes, 0);
  });

  await t.test('parent children uses profile Grade/Section and truthful per-child summary metrics', async () => {
    let childrenSql = '';
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships tsr') && sql.includes('left join public.game_results gr on gr.resolved_student_id = s.id')) {
        childrenSql = sql;
        return resultRows([
          {
            id: 44,
            student_id: 44,
            game_student_id: '001234',
            student_name: 'Ava Santos',
            grade_level: 'Grade 3',
            section: 'Section B',
            total_quizzes: 3,
            accuracy: '80.00',
            completion_percentage: '42.00',
          },
          {
            id: 45,
            student_id: 45,
            game_student_id: '001245',
            student_name: 'Noah Santos',
            grade_level: 'Grade 1',
            section: 'Section A',
            total_quizzes: 0,
            accuracy: null,
            completion_percentage: null,
          },
        ]);
      }
      if (sql.includes('count(gr.id)::integer as unlinked_count')) return resultRows([{ unlinked_count: 0 }]);
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children', {
      headers: authHeaders('parent-token'),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.children[0].accuracy, '80.00');
    assert.equal(response.body.children[0].completion_percentage, '42.00');
    assert.equal(response.body.children[1].accuracy, null);
    assert.equal(response.body.children[1].completion_percentage, null);
    assert.match(childrenSql, /coalesce\(p\.grade_level, s\.grade_level\) as grade_level/);
    assert.match(childrenSql, /coalesce\(p\.section, s\.section\) as section/);
    assert.match(childrenSql, /as accuracy/);
    assert.match(childrenSql, /as completion_percentage/);
  });

  await t.test('student analytics detail only uses the requested linked child data', async () => {
    const queriedStudentIds = [];
    setQueryHandler(async (sql, params) => {
      if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) {
        return resultRows([{ linked: true }]);
      }
      if (sql.startsWith('select p.*') && sql.includes('where p.student_id = $1')) {
        queriedStudentIds.push(params[0]);
        return resultRows([{
          student_id: params[0],
          student_name: 'Ava Santos',
          grade_level: 'Grade 3',
          section: 'Section A',
          current_quest: 'Quest 4',
          score: 7,
          correct_answers: 7,
          total_questions: 10,
          accuracy_rate: 70,
          progress_percentage: 60,
        }]);
      }
      if (sql.includes('from public.game_results') && sql.includes('where resolved_student_id = $1')) {
        queriedStudentIds.push(params[0]);
        return resultRows([
          { math_topic: 'Fractions', difficulty: 'Normal', percentage: 60, score: 6, total_items: 10, played_at: '2026-05-20T00:00:00Z' },
          { math_topic: 'Fractions', difficulty: 'Normal', percentage: 70, score: 7, total_items: 10, played_at: '2026-05-21T00:00:00Z' },
        ]);
      }
      if (sql.includes('from public.activity_logs') && sql.includes('where student_id = $1')) {
        queriedStudentIds.push(params[0]);
        return resultRows([
          { student_id: params[0], activity_description: 'Gameplay Session', quest_progress: 60, activity_timestamp: '2026-05-21T00:00:00Z' },
        ]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/student-progress/44?parent_id=19', {
      headers: authHeaders('parent-token'),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.progress.student_id, 44);
    assert.equal(response.body.analyticsReadiness.dataScope.studentId, 44);
    assert.deepEqual(new Set(queriedStudentIds), new Set([44]));
    assert.equal(response.body.analyticsReadiness.topicMastery[0].topic, 'Fractions');
  });

  await t.test('teacher progress list stays scoped to the teacher while returning separate students', async () => {
    setQueryHandler(async (sql, params) => {
      if (sql.startsWith('select p.*') && sql.includes('from public.student_game_progress p')) {
        assert.equal(params[0], 16);
        assert.match(sql, /tsr\.teacher_id = \$1/);
        return resultRows([
          { student_id: 44, student_name: 'Ava Santos', score: 90, accuracy_rate: 90, progress_percentage: 80 },
          { student_id: 45, student_name: 'Noah Santos', score: 70, accuracy_rate: 70, progress_percentage: 60 },
        ]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/students/progress?teacher_id=16', {
      headers: authHeaders('teacher-token'),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map((row) => row.student_id), [44, 45]);
    assert.notEqual(response.body[0].student_id, response.body[1].student_id);
  });

  await t.test('leaderboard top achievers uses completion accuracy answers and quests ranking', async () => {
    let receivedSql = '';
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.student_game_progress')) {
        receivedSql = sql;
        assert.equal(params[0], 16);
        assert.match(sql, /order by progress_percentage desc, accuracy_rate desc, correct_answers desc, quests_completed desc/);
        assert.match(sql, /tsr\.teacher_id = \$1/);
        return resultRows([
          {
            id: 70,
            student_id: 44,
            student_name: 'Ava Santos',
            grade_level: 'Grade 3',
            section: 'St. Therese',
            current_quest: 'Quest 4',
            score: 120,
            correct_answers: 12,
            total_questions: 15,
            accuracy_rate: '80.00',
            progress_percentage: '90.00',
            quests_completed: '4',
            total_play_time: 600,
          },
        ]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/leaderboard/top-achievers?teacher_id=16', {
      headers: authHeaders('teacher-token'),
    });

    assert.equal(response.status, 200);
    assert.equal(receivedSql.includes('coalesce(p.total_quests_completed'), true);
    assert.equal(response.body[0].rank, 1);
    assert.equal(response.body[0].student_name, 'Ava Santos');
    assert.equal(response.body[0].completion_percentage, 90);
    assert.equal(response.body[0].accuracy, 80);
    assert.equal(response.body[0].quests_completed, 4);
    assert.equal(response.body[0].total_play_time, 600);
  });

  await t.test('rejects topic coverage when the parent link is missing', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships') && sql.startsWith('select 1')) {
        return emptyResult;
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children/44/topics?parent_id=21', {
      headers: authHeaders('parent-token'),
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'Parent cannot access this child.');
  });

  await t.test('verifyParentChildAccess exposes the scoped parent and child IDs', async () => {
    setQueryHandler(async (sql) => {
      if (sql.includes('from public.teacher_student_relationships')) {
        return resultRows([{ linked: true }]);
      }
      return emptyResult;
    });

    const req = { authenticatedUser: authenticatedAccounts[19], query: { parent_id: '19' }, params: { studentId: '44' } };
    const res = createResponse();
    let nextCalled = false;

    await verifyParentChildAccess(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.body, null);
    assert.deepEqual(req.parentChildAccess, { parentId: 19, studentId: 44 });
  });

  await t.test('parent-scoped views resolve by parent code and keep the canonical parent relationship', async () => {
    let parentScopeSql = '';
    let parentScopeParams = [];
    setQueryHandler(async (sql, params) => {
      if (sql.includes('from public.teacher_student_relationships tsr') && sql.includes('where tsr.teacher_id = $1')) {
        parentScopeSql = sql;
        parentScopeParams = params;
        return resultRows([{ student_id: 44, student_name: 'Ava Santos' }]);
      }
      if (sql.includes('from public.accounts parent') && sql.includes('gr.parent_id = parent.parent_id')) {
        return resultRows([{ unlinked_count: 0 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/parent/children?parent_id=112832', {
      headers: authHeaders('parent-token'),
    });

    assert.equal(response.status, 200);
    assert.equal(parentScopeParams[0], 19);
    assert.match(parentScopeSql, /tsr\.teacher_id = \$1/);
  });
});

test('game result endpoint rejects missing, expired, and forged playtime leases', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    useDefaultGameResultLease = true;
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const basePayload = {
    parent_id: '123456',
    student_id: '001234',
    student_name: 'Ava Santos',
    grade_level: 'Grade 1',
    difficulty: 'Hard',
    math_topic: 'Problem Solving (Addition and Subtraction)',
    score: 1,
    total_items: 1,
  };
  const missingLease = await requestJson(baseUrl, '/api/game/result', {
    method: 'POST',
    withGameLease: false,
    body: JSON.stringify(basePayload),
  });
  assert.equal(missingLease.status, 400);

  useDefaultGameResultLease = false;
  setQueryHandler(async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
      return resultRows([{ id: 19, parent_id: '123456' }]);
    }
    if (sql.includes('from public.accounts s') && sql.includes('teacher_student_relationships r')) {
      return resultRows([{ id: 44, name: 'Ava Santos' }]);
    }
    if (sql.includes('from public.playtime_sessions') && sql.includes('expires_at > now()')) {
      return emptyResult;
    }
    return emptyResult;
  });
  const expiredLease = await requestJson(baseUrl, '/api/game/result', {
    method: 'POST',
    withGameLease: false,
    body: JSON.stringify({
      ...basePayload,
      playtime_session_id: GAME_RESULT_SESSION_ID,
      playtime_session_credential: GAME_RESULT_SESSION_CREDENTIAL,
    }),
  });
  assert.equal(expiredLease.status, 403);
});

test('student monitoring keeps the external six-digit game Student ID beside the internal route key', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.startsWith('select p.*') && sql.includes('from public.student_game_progress p')) {
      assert.match(sql, /a\.game_student_id/);
      return resultRows([{
        student_id: 44,
        game_student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        correct_answers: 8,
        total_questions: 10,
        accuracy_rate: 80,
        progress_percentage: 70,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/students/progress', {
    headers: authHeaders('admin-token'),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body[0].student_id, 44);
  assert.equal(response.body[0].game_student_id, '001234');
});

test('student analytics reports insufficient data instead of inferring hard-question weaknesses', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) {
      return resultRows([{ linked: true }]);
    }
    if (sql.startsWith('select id') && sql.includes('from public.accounts') && sql.includes('where id = $1')) {
      return emptyResult;
    }
    if (sql.includes('from public.accounts') && sql.includes('where parent_id = $1')) {
      return resultRows([{ id: 19, parent_id: '112832' }]);
    }
    if (sql.startsWith('select p.*') && sql.includes('where p.student_id = $1')) {
      return resultRows([{
        student_id: 44,
        game_student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        correct_answers: 0,
        total_questions: 0,
        accuracy_rate: 0,
        progress_percentage: 0,
      }]);
    }
    if (sql.includes('from public.game_results') || sql.includes('from public.activity_logs')) {
      return resultRows([]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/student-progress/44?parent_id=112832', {
    headers: authHeaders('parent-token'),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.analysis.dataAvailability, 'insufficient');
  assert.deepEqual(response.body.analysis.difficultyBreakdown, { easy: null, medium: null, hard: null });
  assert.deepEqual(response.body.analysis.recommendations, []);
  assert.equal(response.body.analysis.weaknesses.length, 0);
  assert.equal(response.body.aiInsight.status, 'insufficient_data');
});

test('student analytics derives difficulty recommendations from recorded question attempts', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select 1') && sql.includes('from public.teacher_student_relationships')) {
      return resultRows([{ linked: true }]);
    }
    if (sql.startsWith('select p.*') && sql.includes('where p.student_id = $1')) {
      return resultRows([{
        student_id: params[0],
        student_name: 'Ava Santos',
        game_student_id: '001234',
        grade_level: 'Grade 3',
        current_quest: 'Quest 4',
        progress_percentage: 82,
        total_questions: 0,
      }]);
    }
    if (sql.includes('from public.game_results') && sql.includes('where resolved_student_id = $1')) {
      return resultRows([
        { difficulty: 'Easy', score: 9, total_items: 10, math_topic: 'Fractions' },
        { difficulty: 'Normal', score: 8, total_items: 10, math_topic: 'Fractions' },
        { difficulty: 'Hard', score: 2, total_items: 10, math_topic: 'Fractions' },
      ]);
    }
    if (sql.includes('from public.activity_logs') && sql.includes('where student_id = $1')) {
      return resultRows([{ student_id: params[0], activity_description: 'Gameplay Session' }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/student-progress/44', {
    headers: authHeaders('admin-token'),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.analysis.dataAvailability, 'available');
  assert.deepEqual(response.body.analysis.difficultyBreakdown, { easy: 90, medium: 80, hard: 20 });
  assert.deepEqual(response.body.analysis.strengths, []);
  assert.deepEqual(response.body.analysis.weaknesses, []);
  assert.deepEqual(response.body.analysis.recommendations, []);
  assert.equal(response.body.aiInsight.status, 'insufficient_data');
});
