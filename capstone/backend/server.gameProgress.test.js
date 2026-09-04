const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    const rawSql = sql && typeof sql === 'object' && sql.text ? sql.text : sql;
    const rawParams = sql && typeof sql === 'object' && Array.isArray(sql.values) ? sql.values : params;
    return (await queryHandler(compactSql(rawSql), rawParams, rawSql)) || emptyResult;
  },
  connect: async () => ({
    query: async (sql, params = []) => {
      const rawSql = sql && typeof sql === 'object' && sql.text ? sql.text : sql;
      const rawParams = sql && typeof sql === 'object' && Array.isArray(sql.values) ? sql.values : params;
      return (await queryHandler(compactSql(rawSql), rawParams, rawSql)) || emptyResult;
    },
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
    verify: () => ({}),
  },
  multer: multerStub,
  'pdf-parse': async () => ({ text: '' }),
  yauzl: { open: () => {} },
  'fast-xml-parser': { XMLParser: class { parse() { return {}; } } },
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

test('game progress stores scene metadata and uses scene-derived difficulty', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let progressSql = '';
  let progressValues = [];
  let activityValues = [];
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (['begin', 'commit', 'rollback'].includes(sql)) return emptyResult;
    if (sql.startsWith('select id, name, parent_id from public.accounts')) {
      return resultRows([{ id: 19, name: 'Parent User', parent_id: '123456' }]);
    }
    if (sql.startsWith('select s.* from public.accounts s join public.teacher_student_relationships')) {
      return resultRows([{ id: 44, name: 'Ava Santos', email: 'ava@example.com', role: 'student' }]);
    }
    if (sql.startsWith('insert into public.teacher_student_relationships')) return emptyResult;
    if (sql.startsWith('select id from public.student_game_progress')) return resultRows([]);
    if (sql.startsWith('insert into public.student_game_progress')) {
      progressSql = sql;
      progressValues = params;
      return resultRows([{ id: 88, student_id: 44, student_name: 'Ava Santos' }]);
    }
    if (sql.startsWith('insert into public.activity_logs')) {
      activityValues = params;
      return resultRows([{ id: 99, student_id: 44, difficulty_level: params[9] }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/progress', {
    method: 'POST',
    body: JSON.stringify({
      parent_id: '123456',
      student_id: 44,
      student_name: 'Ava Santos',
      grade: 'Grade 3',
      current_quest: 'City Quiz',
      current_scene: 'city_of_knowledge.tscn',
      current_map: 'city_of_knowledge',
      difficulty_level: 'Hard',
      score: 75,
      correct_answers: 6,
      total_questions: 8,
    }),
  });

  assert.equal(response.status, 201);
  assert.match(progressSql, /current_scene/);
  assert.match(progressSql, /current_map/);
  assert.match(progressSql, /difficulty_level/);
  assert.ok(progressValues.includes('city_of_knowledge.tscn'));
  assert.ok(progressValues.includes('city_of_knowledge'));
  assert.ok(progressValues.includes('Normal'));
  assert.equal(activityValues[9], 'Normal');
});

test('game progress persists linked child identity, grade, and section from the canonical profile', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let progressValues = [];
  let activityValues = [];
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (['begin', 'commit', 'rollback'].includes(sql)) return emptyResult;
    if (sql.startsWith('select id, name, parent_id from public.accounts')) {
      return resultRows([{ id: 19, name: 'Parent User', parent_id: '123456' }]);
    }
    if (sql.startsWith('select s.* from public.accounts s join public.teacher_student_relationships')) {
      return resultRows([{
        id: 44,
        name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
        email: 'ava@example.com',
        role: 'student',
      }]);
    }
    if (sql.startsWith('insert into public.teacher_student_relationships')) return emptyResult;
    if (sql.startsWith('select id from public.student_game_progress')) return resultRows([]);
    if (sql.startsWith('insert into public.student_game_progress')) {
      progressValues = params;
      return resultRows([{ id: 88, student_id: 44, student_name: 'Ava Santos' }]);
    }
    if (sql.startsWith('insert into public.activity_logs')) {
      activityValues = params;
      return resultRows([{ id: 99, student_id: 44 }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/progress', {
    method: 'POST',
    body: JSON.stringify({
      parent_id: '123456',
      student_id: '001234',
      student_name: 'Caller supplied name',
      grade_level: 'Grade 6',
      section: 'Section Z',
      current_quest: 'City Quiz',
      current_scene: 'city_of_knowledge.tscn',
      score: 3,
      correct_answers: 3,
      total_questions: 4,
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(progressValues.slice(0, 4), [44, 'Ava Santos', 'Grade 3', 'Section A']);
  assert.deepEqual(activityValues.slice(0, 4), [44, 'Ava Santos', 'Grade 3', 'Section A']);
});

test('game progress resolves an eight-digit public Student ID without converting it to an internal ID', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let linkedStudentValues = [];
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (['begin', 'commit', 'rollback'].includes(sql)) return emptyResult;
    if (sql.startsWith('select id, name, parent_id from public.accounts')) return resultRows([{ id: 19, name: 'Parent User', parent_id: '123456' }]);
    if (sql.startsWith('select s.* from public.accounts s join public.teacher_student_relationships')) {
      linkedStudentValues = params;
      return resultRows([{ id: 44, name: 'Ava Santos', grade_level: 'Grade 3', section: 'Jade' }]);
    }
    if (sql.startsWith('select id from public.student_game_progress')) return emptyResult;
    if (sql.startsWith('insert into public.student_game_progress')) return resultRows([{ id: 88, student_id: 44 }]);
    if (sql.startsWith('insert into public.activity_logs')) return resultRows([{ id: 99, student_id: 44 }]);
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/progress', {
    method: 'POST',
    body: JSON.stringify({
      parent_id: '123456', student_id: '00123456', student_name: 'Ava Santos', grade_level: 'Grade 3',
      current_quest: 'Tutorial', score: 1, correct_answers: 1, total_questions: 1,
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(linkedStudentValues, [19, '00123456']);
});

test('game progress never creates a missing legacy six-digit Student ID', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let createdStudent = false;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (['begin', 'rollback'].includes(sql)) return emptyResult;
    if (sql.startsWith('select id, name, parent_id from public.accounts')) return resultRows([{ id: 19, name: 'Parent User', parent_id: '123456' }]);
    if (sql.startsWith('select s.* from public.accounts s join public.teacher_student_relationships')) return emptyResult;
    if (sql.startsWith('select * from public.accounts where game_student_id = $1')) return emptyResult;
    if (sql.startsWith('insert into public.accounts')) createdStudent = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/progress', {
    method: 'POST',
    body: JSON.stringify({
      parent_id: '123456', student_id: '001234', student_name: 'Ava Santos', grade_level: 'Grade 3',
      current_quest: 'Tutorial', score: 1, correct_answers: 1, total_questions: 1,
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Student ID must be exactly 8 digits.');
  assert.equal(createdStudent, false);
});

test('game progress rejects a heartbeat-stale current-cycle lease before writing progress', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const credential = 'p'.repeat(64);
  let progressWritten = false;
  let staleLeaseFinalized = false;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql === 'begin' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('select id, name, parent_id from public.accounts')) {
      return resultRows([{ id: 19, name: 'Parent User', parent_id: '123456' }]);
    }
    if (sql.startsWith('select s.* from public.accounts s join public.teacher_student_relationships')) {
      return resultRows([{ id: 44, name: 'Canonical Student', grade_level: 'Grade 1', section: null }]);
    }
    if (sql.startsWith('select coalesce(current_learning_cycle_version')) {
      return resultRows([{ current_learning_cycle_version: 1 }]);
    }
    if (sql.startsWith('select id, session_credential_hash') && sql.includes('from public.playtime_sessions')) {
      return resultRows([{
        id: 700,
        session_credential_hash: crypto.createHash('sha256').update(credential).digest('hex'),
        learning_cycle_version: 1,
        heartbeat_stale: true,
      }]);
    }
    if (sql.startsWith('update public.playtime_sessions') && sql.includes("status = 'offline'")) {
      staleLeaseFinalized = true;
      return emptyResult;
    }
    if (sql.includes('student_game_progress') || sql.startsWith('insert into public.activity_logs')) progressWritten = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/progress', {
    method: 'POST',
    body: JSON.stringify({
      parent_id: '123456',
      student_id: '001234',
      student_name: 'Caller Name',
      current_quest: 'Teacher House',
      score: 1,
      correct_answers: 1,
      total_questions: 1,
      playtime_session_id: 700,
      playtime_session_credential: credential,
    }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'PLAYTIME_HEARTBEAT_STALE');
  assert.equal(staleLeaseFinalized, true);
  assert.equal(progressWritten, false);
});

test('game progress preserves a linked child\'s canonical null Section instead of caller metadata', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let progressValues = [];
  let activityValues = [];
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (['begin', 'commit', 'rollback'].includes(sql)) return emptyResult;
    if (sql.startsWith('select id, name, parent_id from public.accounts')) {
      return resultRows([{ id: 19, name: 'Parent User', parent_id: '123456' }]);
    }
    if (sql.startsWith('select s.* from public.accounts s join public.teacher_student_relationships')) {
      return resultRows([{
        id: 44,
        name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: null,
        email: 'ava@example.com',
        role: 'student',
      }]);
    }
    if (sql.startsWith('insert into public.teacher_student_relationships')) return emptyResult;
    if (sql.startsWith('select id from public.student_game_progress')) return resultRows([]);
    if (sql.startsWith('insert into public.student_game_progress')) {
      progressValues = params;
      return resultRows([{ id: 88, student_id: 44, student_name: 'Ava Santos' }]);
    }
    if (sql.startsWith('insert into public.activity_logs')) {
      activityValues = params;
      return resultRows([{ id: 99, student_id: 44 }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/progress', {
    method: 'POST',
    body: JSON.stringify({
      parent_id: '123456',
      student_id: '001234',
      student_name: 'Caller supplied name',
      grade_level: 'Grade 6',
      section: 'Caller supplied Section',
      current_quest: 'City Quiz',
      score: 3,
      correct_answers: 3,
      total_questions: 4,
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(progressValues.slice(0, 4), [44, 'Ava Santos', 'Grade 3', null]);
  assert.deepEqual(activityValues.slice(0, 4), [44, 'Ava Santos', 'Grade 3', null]);
});
