const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const runQuery = async (sql, params = []) => (
  (await queryHandler(compactSql(sql), params, sql)) || emptyResult
);
const mockPool = {
  query: runQuery,
  connect: async () => ({ query: runQuery, release: () => {} }),
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const passthrough = () => (req, res, next) => next();
const originalLoad = Module._load;
Module._load = function loadWithServerStubs(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => `hashed:${value}` };
  if (request === 'cors') return () => passthrough();
  if (request === 'jsonwebtoken') return { sign: () => 'token', verify: () => ({}) };
  if (request === 'multer') return () => ({ single: passthrough, array: passthrough, fields: passthrough });
  if (request === 'pdf-parse') return async () => ({ text: '' });
  if (request === 'yauzl') return { open: () => {} };
  if (request === 'fast-xml-parser') return { XMLParser: class { parse() { return {}; } } };
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
const requestJson = async (baseUrl, path) => {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
};

const activeParent = { id: 19, parent_id: '654321', role: 'parent', is_archived: false };
const canonicalChild = {
  id: 44,
  game_student_id: '001234',
  name: 'Ava Santos',
  grade_level: 'Grade 3',
  section: null,
};

test('profile check returns only the canonical linked child profile', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  await t.test('returns name, grade, and a nullable Section without coercing a leading-zero Student ID', async () => {
    let linkedStudentSql = '';
    let linkedStudentParams = [];
    queryHandler = async (sql, params, rawSql) => {
      if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) return { rows: [activeParent] };
      if (sql.includes('from public.accounts s') && sql.includes('join public.teacher_student_relationships r')) {
        linkedStudentSql = String(rawSql);
        linkedStudentParams = params;
        return { rows: [canonicalChild] };
      }
      if (sql.includes('from public.student_game_progress')) return emptyResult;
      return emptyResult;
    };

    const response = await requestJson(baseUrl, '/api/game/profile/check/001234?parent_id=654321');

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.can_play, true);
    assert.deepEqual(response.body.canonical_profile, {
      name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: null,
    });
    assert.deepEqual(linkedStudentParams, [activeParent.id, '001234']);
    assert.match(linkedStudentSql, /s\.name/i);
    assert.match(linkedStudentSql, /s\.grade_level/i);
    assert.match(linkedStudentSql, /s\.section/i);
  });

  await t.test('accepts an eight-digit Student code for profile and learning-cycle lookup', async () => {
    let profileParams = [];
    let learningCycleParams = [];
    queryHandler = async (sql, params) => {
      if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) return { rows: [activeParent] };
      if (sql.includes('current_learning_cycle_version') && sql.includes('from public.accounts s') && !sql.includes('s.name')) {
        learningCycleParams = params;
        return { rows: [{ id: 44, current_learning_cycle_version: 1, current_learning_cycle_started_at: null }] };
      }
      if (sql.includes('from public.accounts s') && sql.includes('join public.teacher_student_relationships r')) {
        profileParams = params;
        return { rows: [{ ...canonicalChild, game_student_id: '00123456' }] };
      }
      if (sql.includes('from public.student_game_progress')) return emptyResult;
      return emptyResult;
    };

    const profile = await requestJson(baseUrl, '/api/game/profile/check/00123456?parent_id=654321');
    const learningCycle = await requestJson(baseUrl, '/api/game/learning-cycle/00123456?parent_id=654321');

    assert.equal(profile.status, 200);
    assert.deepEqual(profileParams, [activeParent.id, '00123456']);
    assert.equal(learningCycle.status, 200);
    assert.deepEqual(learningCycleParams, [activeParent.id, '00123456']);
  });

  await t.test('ignores caller-supplied identity metadata and returns only the linked canonical profile', async () => {
    queryHandler = async (sql) => {
      if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) return { rows: [activeParent] };
      if (sql.includes('from public.accounts s') && sql.includes('join public.teacher_student_relationships r')) return { rows: [canonicalChild] };
      if (sql.includes('from public.student_game_progress')) return emptyResult;
      return emptyResult;
    };

    const response = await requestJson(baseUrl, '/api/game/profile/check/001234?parent_id=654321&name=Client%20Override&grade_level=Grade%206&section=Invented');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.canonical_profile, {
      name: 'Ava Santos',
      grade_level: 'Grade 3',
      section: null,
    });
  });

  await t.test('rejects a valid Parent paired with an unrelated Student without returning a profile', async () => {
    queryHandler = async (sql) => {
      if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) return { rows: [activeParent] };
      if (sql.includes('from public.accounts s') && sql.includes('join public.teacher_student_relationships r')) return emptyResult;
      if (sql.includes('select id, is_archived from public.accounts where game_student_id = $1')) return { rows: [{ id: 77, is_archived: false }] };
      return emptyResult;
    };

    const response = await requestJson(baseUrl, '/api/game/profile/check/009999?parent_id=654321');

    assert.equal(response.status, 403);
    assert.equal(response.body.should_block, true);
    assert.equal(response.body.error, 'This Student is not linked to this Parent account.');
    assert.equal(Object.hasOwn(response.body, 'canonical_profile'), false);
  });

  await t.test('rejects an unknown Student instead of authorizing manual identity entry', async () => {
    queryHandler = async (sql) => {
      if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) return { rows: [activeParent] };
      return emptyResult;
    };

    const response = await requestJson(baseUrl, '/api/game/profile/check/008888?parent_id=654321');

    assert.equal(response.status, 404);
    assert.equal(response.body.should_block, true);
    assert.equal(response.body.can_play, false);
    assert.equal(Object.hasOwn(response.body, 'canonical_profile'), false);
  });

  await t.test('rejects a Parent ID that cannot be resolved to an active Parent account', async () => {
    queryHandler = async () => emptyResult;

    const response = await requestJson(baseUrl, '/api/game/profile/check/001234?parent_id=111111');

    assert.equal(response.status, 404);
    assert.equal(Object.hasOwn(response.body, 'canonical_profile'), false);
  });

  await t.test('rejects inactive Parents and inactive Students without returning canonical data', async () => {
    queryHandler = async (sql) => {
      if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) {
        return { rows: [{ ...activeParent, is_archived: true }] };
      }
      return emptyResult;
    };
    const inactiveParent = await requestJson(baseUrl, '/api/game/profile/check/001234?parent_id=654321');
    assert.equal(inactiveParent.status, 403);
    assert.equal(Object.hasOwn(inactiveParent.body, 'canonical_profile'), false);

    queryHandler = async (sql) => {
      if (sql.includes('from public.accounts where parent_id = $1') && sql.includes('lower(role) in')) return { rows: [activeParent] };
      if (sql.includes('from public.accounts s') && sql.includes('join public.teacher_student_relationships r')) return emptyResult;
      if (sql.includes('select id, is_archived from public.accounts where game_student_id = $1')) return { rows: [{ id: canonicalChild.id, is_archived: true }] };
      return emptyResult;
    };
    const inactiveStudent = await requestJson(baseUrl, '/api/game/profile/check/001234?parent_id=654321');
    assert.equal(inactiveStudent.status, 403);
    assert.equal(inactiveStudent.body.error, 'Student account is no longer active.');
    assert.equal(Object.hasOwn(inactiveStudent.body, 'canonical_profile'), false);
  });
});
