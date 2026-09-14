const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let transactionReleaseCount = 0;
const authenticatedParent = { id: 19, role: 'parent', session_version: 0, is_archived: false };
const authenticatedAdmin = { id: 1, role: 'admin', session_version: 0, is_archived: false };

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    const result = (await queryHandler(compactSql(sql), params, sql, 'pool')) || emptyResult;
    if (result.rows?.length > 0) return result;
    if (compactSql(sql).startsWith('select * from public.accounts where id = $1') && Number(params[0]) === 19) {
      return resultRows([authenticatedParent]);
    }
    if (compactSql(sql).startsWith('select * from public.accounts where id = $1') && Number(params[0]) === 1) {
      return resultRows([authenticatedAdmin]);
    }
    return result;
  },
  connect: async () => ({
    query: async (sql, params = []) => queryHandler(compactSql(sql), params, sql, 'transaction'),
    release: () => { transactionReleaseCount += 1; },
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
    verify: (token) => {
      if (token === 'parent-token') return { userId: 19, sessionVersion: 0 };
      if (token === 'admin-token') return { userId: 1, sessionVersion: 0 };
      return {};
    },
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

test('activity log API accepts Godot session aliases and scoped child filters', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  await t.test('stores Godot activity payload aliases for grade, timestamp, and duration', async () => {
    let insertedValues = null;
    setQueryHandler(async (sql, params) => {
      if (sql.startsWith('insert into public.activity_logs')) {
        insertedValues = params;
        return resultRows([{ id: 9, student_id: params[0] }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/activity-logs', {
      method: 'POST',
      body: JSON.stringify({
        student_id: 44,
        student_name: 'Ava Santos',
        grade: 'Grade 4',
        current_quest: 'Boss Fractions',
        timestamp: '2026-05-27T08:30:00.000Z',
        duration_seconds: 375,
      }),
    });

    assert.equal(response.status, 201);
    assert.ok(insertedValues.includes('Grade 4'));
    assert.ok(insertedValues.includes('Boss Fractions'));
    assert.ok(insertedValues.includes(375));
    assert.ok(insertedValues.includes('2026-05-27T08:30:00.000Z'));
  });

  await t.test('keeps parent activity requests scoped to the selected child', async () => {
    let mainQuery = '';
    let mainParams = [];
    setQueryHandler(async (sql, params) => {
      if (sql.startsWith('select al.id')) {
        mainQuery = sql;
        mainParams = params;
        return resultRows([]);
      }
      if (sql.startsWith('select count(*) as total')) {
        return resultRows([{ total: 0 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/activity-logs?parent_id=19&student_id=44&limit=10', {
      headers: { Authorization: 'Bearer parent-token' },
    });

    assert.equal(response.status, 200);
    assert.match(mainQuery, /al\.student_id = \$2/);
    assert.deepEqual(mainParams.slice(0, 2), [19, 44]);
  });

  await t.test('searches canonical game Student IDs without removing the authenticated scope', async () => {
    let mainQuery = '';
    let countQuery = '';
    setQueryHandler(async (sql) => {
      if (sql.startsWith('select al.id')) {
        mainQuery = sql;
        return resultRows([]);
      }
      if (sql.startsWith('select count(*) as total')) {
        countQuery = sql;
        return resultRows([{ total: 0 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/activity-logs?search=Grade%201%20Oakleaf%20001234', {
      headers: { Authorization: 'Bearer parent-token' },
    });

    assert.equal(response.status, 200);
    assert.match(mainQuery, /lower\(coalesce\(account\.game_student_id, ''\)\) = lower/);
    assert.match(mainQuery, /lower\(coalesce\(al\.grade_level, ''\)\) like/);
    assert.match(mainQuery, /lower\(coalesce\(al\.current_quest, ''\)\) like/);
    assert.equal((mainQuery.match(/ and \(/g) || []).length >= 3, true);
    assert.match(countQuery, /left join public\.accounts account on account\.id = al\.student_id/);
    assert.match(mainQuery, /al\.student_id in \(/);
  });

  await t.test('uses the same canonical Student Quest Activity predicate for data and count queries', async () => {
    let mainQuery = '';
    let countQuery = '';
    let mainParams = [];
    let countParams = [];
    setQueryHandler(async (sql, params) => {
      if (sql.startsWith('select al.id')) {
        mainQuery = sql;
        mainParams = params;
        return resultRows([]);
      }
      if (sql.startsWith('select count(*) as total')) {
        countQuery = sql;
        countParams = params;
        return resultRows([{ total: 0 }]);
      }
      return emptyResult;
    });

    const response = await requestJson(baseUrl, '/api/activity-logs?student_id=44&limit=10', {
      headers: { Authorization: 'Bearer parent-token' },
    });

    assert.equal(response.status, 200);
    for (const sql of [mainQuery, countQuery]) {
      assert.match(sql, /al\.event_key is not null/);
      assert.match(sql, /lower\(btrim\(coalesce\(al\.role, ''\)\)\) = 'student'/);
      assert.match(sql, /nullif\(btrim\(al\.current_quest\), ''\) is not null/);
      assert.match(sql, /nullif\(btrim\(al\.current_scene\), ''\) is not null/);
      assert.match(sql, /nullif\(btrim\(al\.current_map\), ''\) is not null/);
      assert.doesNotMatch(sql, /admin_audit_logs/);
      assert.match(sql, /al\.student_id in \(/);
    }
    assert.deepEqual(mainParams.slice(0, 2), [19, 44]);
    assert.deepEqual(countParams.slice(0, 2), [19, 44]);
  });
});

test('Activity Log reset is admin-only, requires RESET, and deletes only canonical Student quest records transactionally', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const transactionSql = [];
  transactionReleaseCount = 0;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (['begin', 'commit', 'rollback'].includes(sql) || sql.startsWith('delete from public.activity_logs al')) {
      transactionSql.push(sql);
    }
    if (sql.startsWith('delete from public.activity_logs al')) return { rows: [], rowCount: 3 };
    return emptyResult;
  });

  const unauthenticated = await requestJson(baseUrl, '/api/activity-logs/reset', {
    method: 'POST',
    body: JSON.stringify({ confirmation: 'RESET' }),
  });
  assert.equal(unauthenticated.status, 401);

  const parent = await requestJson(baseUrl, '/api/activity-logs/reset', {
    method: 'POST',
    headers: { Authorization: 'Bearer parent-token' },
    body: JSON.stringify({ confirmation: 'RESET' }),
  });
  assert.equal(parent.status, 403);

  const invalidConfirmation = await requestJson(baseUrl, '/api/activity-logs/reset', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ confirmation: 'reset' }),
  });
  assert.equal(invalidConfirmation.status, 400);
  assert.equal(transactionSql.length, 0);

  const reset = await requestJson(baseUrl, '/api/activity-logs/reset', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ confirmation: 'RESET' }),
  });

  assert.equal(reset.status, 200);
  assert.equal(reset.body.deleted_count, 3);
  assert.deepEqual(transactionSql.map((sql) => sql === 'begin' || sql === 'commit' ? sql : 'delete'), ['begin', 'delete', 'commit']);
  assert.equal(transactionReleaseCount, 1);

  const deleteSql = transactionSql.find((sql) => sql.startsWith('delete from public.activity_logs al'));
  assert.match(deleteSql, /al\.event_key is not null/);
  assert.match(deleteSql, /lower\(btrim\(coalesce\(al\.role, ''\)\)\) = 'student'/);
  assert.match(deleteSql, /nullif\(btrim\(al\.current_quest\), ''\) is not null/);
  assert.match(deleteSql, /nullif\(btrim\(al\.current_scene\), ''\) is not null/);
  assert.match(deleteSql, /nullif\(btrim\(al\.current_map\), ''\) is not null/);
  for (const protectedTable of ['admin_audit_logs', 'accounts', 'student_game_progress', 'playtime_sessions', 'question', 'learning_file']) {
    assert.doesNotMatch(deleteSql, new RegExp(protectedTable));
  }

  transactionSql.length = 0;
  transactionReleaseCount = 0;
  setQueryHandler(async (sql) => {
    if (['begin', 'commit', 'rollback'].includes(sql) || sql.startsWith('delete from public.activity_logs al')) {
      transactionSql.push(sql);
    }
    if (sql.startsWith('delete from public.activity_logs al')) throw new Error('simulated delete failure');
    return emptyResult;
  });

  const failedReset = await requestJson(baseUrl, '/api/activity-logs/reset', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ confirmation: 'RESET' }),
  });
  assert.equal(failedReset.status, 500);
  assert.deepEqual(transactionSql.map((sql) => sql === 'begin' || sql === 'rollback' ? sql : 'delete'), ['begin', 'delete', 'rollback']);
  assert.equal(transactionReleaseCount, 1);
});

test('canonical game quest events use the active lease, canonical profile data, and idempotent event keys', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const credential = 'c'.repeat(64);
  let insertCalls = 0;
  let insertedValues = null;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select ps.id') && sql.includes('from public.playtime_sessions ps')) {
      return resultRows([{
        id: 77,
        student_id: 44,
        session_credential_hash: crypto.createHash('sha256').update(credential).digest('hex'),
        learning_cycle_version: 3,
        current_learning_cycle_version: 3,
        student_name: 'Canonical Student',
        grade_level: 'Grade 1',
        section: null,
      }]);
    }
    if (sql.startsWith('insert into public.activity_logs')) {
      insertCalls += 1;
      insertedValues = params;
      return resultRows(insertCalls === 1 ? [{ id: 909 }] : []);
    }
    return emptyResult;
  });

  const payload = {
    session_id: 77,
    session_credential: credential,
    learning_cycle_version: 3,
    event_type: 'task_triggered',
    event_key: 'teacher-house:task-triggered:v1',
    task_id: 'teacher-house',
  };
  const first = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const retry = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  assert.equal(first.status, 201);
  assert.equal(first.body.duplicate, false);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(insertCalls, 2);
  assert.ok(insertedValues.includes('Canonical Student'));
  assert.equal(insertedValues.includes('Forged Student'), false);

  const forgedIdentity = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify({ ...payload, student_name: 'Forged Student' }),
  });
  assert.equal(forgedIdentity.status, 400);
});

test('canonical completed quest events persist quest-graph weight and true duration fields', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const credential = 'w'.repeat(64);
  let milestoneParams = null;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select ps.id') && sql.includes('from public.playtime_sessions ps')) {
      return resultRows([{
        id: 78, student_id: 45,
        session_credential_hash: crypto.createHash('sha256').update(credential).digest('hex'),
        learning_cycle_version: 2, current_learning_cycle_version: 2,
        student_name: 'Milestone Student', grade_level: 'Grade 2', section: 'A',
      }]);
    }
    if (sql.startsWith('insert into public.activity_logs')) return resultRows([{ id: 910 }]);
    if (sql.startsWith('insert into public.student_quest_milestones')) {
      milestoneParams = params;
      return emptyResult;
    }
    return emptyResult;
  });
  const response = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 78, session_credential: credential, learning_cycle_version: 2,
      event_type: 'task_completed', event_key: 'defeat-the-wizard:complete:v1', task_id: 'defeat-the-wizard',
      started_at: '2026-09-10T00:00:00.000Z', completed_at: '2026-09-10T00:01:12.000Z',
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(milestoneParams[1], 'defeat-the-wizard');
  assert.equal(milestoneParams[3], 4);
  assert.equal(milestoneParams[4], 2);
});

test('canonical completion writes are atomic and duplicate activity retries cannot mint another milestone', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const credential = 'h'.repeat(64);
  const transactionCommands = [];
  let milestoneWrites = 0;
  transactionReleaseCount = 0;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const sessionRow = {
    id: 88,
    student_id: 55,
    session_credential_hash: crypto.createHash('sha256').update(credential).digest('hex'),
    learning_cycle_version: 4,
    current_learning_cycle_version: 4,
    student_name: 'Atomic Student',
    grade_level: 'Grade 3',
    section: 'B',
  };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select ps.id') && sql.includes('from public.playtime_sessions ps')) {
      assert.match(sql, /for update of ps, a/);
      transactionCommands.push('session-lock');
      return resultRows([sessionRow]);
    }
    if (['begin', 'commit', 'rollback'].includes(sql)) {
      transactionCommands.push(sql);
      return emptyResult;
    }
    if (sql.startsWith('insert into public.activity_logs')) return emptyResult;
    if (sql.startsWith('insert into public.student_quest_milestones')) {
      milestoneWrites += 1;
      return emptyResult;
    }
    return emptyResult;
  });

  const payload = {
    session_id: 88,
    session_credential: credential,
    learning_cycle_version: 4,
    event_type: 'task_completed',
    event_key: 'tutorial:complete:v1',
    task_id: 'Tutorial',
  };
  const duplicateWithDifferentTask = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      task_id: 'defeat-bandits',
      canonical_task_id: 'defeat-bandits',
      canonical_milestone_id: 'defeat-bandits.complete',
    }),
  });
  assert.equal(duplicateWithDifferentTask.status, 200);
  assert.equal(duplicateWithDifferentTask.body.duplicate, true);
  assert.equal(milestoneWrites, 0);
  assert.deepEqual(transactionCommands, ['begin', 'session-lock', 'commit']);
  assert.equal(transactionReleaseCount, 1);

  transactionCommands.length = 0;
  transactionReleaseCount = 0;
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select ps.id') && sql.includes('from public.playtime_sessions ps')) {
      transactionCommands.push('session-lock');
      return resultRows([sessionRow]);
    }
    if (['begin', 'commit', 'rollback'].includes(sql)) {
      transactionCommands.push(sql);
      return emptyResult;
    }
    if (sql.startsWith('insert into public.activity_logs')) return resultRows([{ id: 920 }]);
    if (sql.startsWith('insert into public.student_quest_milestones')) {
      throw new Error('synthetic milestone failure');
    }
    return emptyResult;
  });
  const rolledBack = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify({ ...payload, event_key: 'tutorial:complete:v2' }),
  });
  assert.equal(rolledBack.status, 500);
  assert.deepEqual(transactionCommands, ['begin', 'session-lock', 'rollback']);
  assert.equal(transactionReleaseCount, 1);

  transactionCommands.length = 0;
  transactionReleaseCount = 0;
  let staleCycleWriteAttempted = false;
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select ps.id') && sql.includes('from public.playtime_sessions ps')) {
      transactionCommands.push('session-lock');
      return resultRows([{ ...sessionRow, current_learning_cycle_version: 5 }]);
    }
    if (['begin', 'commit', 'rollback'].includes(sql)) {
      transactionCommands.push(sql);
      return emptyResult;
    }
    if (sql.startsWith('insert into public.activity_logs')) staleCycleWriteAttempted = true;
    return emptyResult;
  });
  const staleCycle = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify({ ...payload, event_key: 'tutorial:complete:v3' }),
  });
  assert.equal(staleCycle.status, 409);
  assert.equal(staleCycle.body.code, 'LEARNING_CYCLE_CHANGED');
  assert.equal(staleCycleWriteAttempted, false);
  assert.deepEqual(transactionCommands, ['begin', 'session-lock', 'rollback']);
  assert.equal(transactionReleaseCount, 1);
});

test('canonical activity task IDs are persisted in normalized lowercase form', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const credential = 'n'.repeat(64);
  let activityParams = null;
  let milestoneParams = null;
  let questCountUpdateSql = '';
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select ps.id') && sql.includes('from public.playtime_sessions ps')) {
      return resultRows([{
        id: 89,
        student_id: 56,
        session_credential_hash: crypto.createHash('sha256').update(credential).digest('hex'),
        learning_cycle_version: 1,
        current_learning_cycle_version: 1,
        student_name: 'Case Student',
        grade_level: 'Grade 1',
        section: 'A',
      }]);
    }
    if (sql.startsWith('insert into public.activity_logs')) {
      activityParams = params;
      return resultRows([{ id: 921 }]);
    }
    if (sql.startsWith('insert into public.student_quest_milestones')) {
      milestoneParams = params;
      return emptyResult;
    }
    if (sql.startsWith('update public.student_game_progress p') && sql.includes('total_quests_completed')) {
      questCountUpdateSql = sql;
      return emptyResult;
    }
    return emptyResult;
  });
  const response = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 89,
      session_credential: credential,
      learning_cycle_version: 1,
      event_type: 'task_completed',
      event_key: 'tutorial:mixed-case:v1',
      task_id: 'Tutorial',
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(activityParams[12], 'tutorial');
  assert.equal(milestoneParams[1], 'tutorial');
  assert.equal(milestoneParams[8], 'tutorial');
  assert.match(questCountUpdateSql, /where p\.id = \( select current_progress\.id/);
  assert.match(questCountUpdateSql, /current_progress\.updated_at >= account\.current_learning_cycle_started_at/);
});

test('game leaderboard requires a current lease and exposes canonical student display data', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const credential = 'l'.repeat(64);
  const transactionCommands = [];
  const querySources = [];
  let sessionSql = '';
  const startingReleaseCount = transactionReleaseCount;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, _params, rawSql, querySource) => {
    if (['begin', 'commit', 'rollback'].includes(sql)) {
      transactionCommands.push(sql);
      return emptyResult;
    }
    if (sql.startsWith('select ps.id') && sql.includes('from public.playtime_sessions ps')) {
      sessionSql = String(rawSql);
      querySources.push(['lease', querySource]);
      return resultRows([{
        id: 77,
        student_id: 44,
        session_credential_hash: crypto.createHash('sha256').update(credential).digest('hex'),
        learning_cycle_version: 3,
        current_learning_cycle_version: 3,
      }]);
    }
    if (sql.includes('from public.student_game_progress p') && sql.includes('ranked_progress')) {
      querySources.push(['ranking', querySource]);
      return resultRows([{
        student_id: 44,
        display_name: 'Ava Santos',
        grade: 'Grade 3',
        game_score: 87,
        progress_percentage: 82,
        accuracy_rate: 91,
        correct_answers: 9,
        total_questions: 10,
        total_quests_completed: 2,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/leaderboard', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 77,
      session_credential: credential,
      learning_cycle_version: 3,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.entries, [{
    rank: 1,
    display_name: 'Ava Santos',
    grade: 'Grade 3',
    game_score: 87,
    progress_percentage: 82,
    accuracy_rate: 91,
    correct_answers: 9,
    total_questions: 10,
    quests_completed: 2,
  }]);
  assert.equal(JSON.stringify(response.body).includes('student_id'), false);
  assert.equal(JSON.stringify(response.body).includes('email'), false);
  assert.match(sessionSql, /FOR UPDATE OF ps, a/i);
  assert.deepEqual(querySources.slice(0, 2), [['lease', 'transaction'], ['ranking', 'transaction']]);

  const missingLease = await requestJson(baseUrl, '/api/game/leaderboard', { method: 'POST', body: '{}' });
  assert.equal(missingLease.status, 400);

  const invalidLease = await requestJson(baseUrl, '/api/game/leaderboard', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 77,
      session_credential: 'x'.repeat(64),
      learning_cycle_version: 3,
    }),
  });
  assert.equal(invalidLease.status, 403);

  const staleCycle = await requestJson(baseUrl, '/api/game/leaderboard', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 77,
      session_credential: credential,
      learning_cycle_version: 2,
    }),
  });
  assert.equal(staleCycle.status, 409);
  assert.equal(staleCycle.body.code, 'LEARNING_CYCLE_CHANGED');
  assert.deepEqual(transactionCommands, ['begin', 'commit', 'begin', 'rollback', 'begin', 'rollback']);
  assert.equal(transactionReleaseCount - startingReleaseCount, 3);
});
