const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let nextClientId = 0;
const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => queryHandler(compactSql(sql), params, null) || emptyResult,
  connect: async () => {
    const clientId = ++nextClientId;
    return {
      query: async (sql, params = []) => (await queryHandler(compactSql(sql), params, clientId)) || emptyResult,
      release: () => {},
    };
  },
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };
const createMiddleware = () => (req, res, next) => next();
const multerStub = () => ({ single: createMiddleware, array: createMiddleware, fields: createMiddleware });
const serverDependencyStubs = {
  bcrypt: { compare: async () => false, hash: async (value) => value },
  cors: () => createMiddleware(),
  jsonwebtoken: { sign: () => 'token', verify: () => ({}) },
  multer: multerStub,
  'pdf-parse': async () => ({ text: '' }),
  yauzl: { open: () => {} },
  'fast-xml-parser': { XMLParser: class { parse() { return {}; } } },
};
const originalLoad = Module._load;
let serverExports;
Module._load = function loadWithServerStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(serverDependencyStubs, request)) return serverDependencyStubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
try {
  serverExports = require('./server');
} finally {
  Module._load = originalLoad;
}
const { app } = serverExports;

const clone = (value) => JSON.parse(JSON.stringify(value));
const resultRows = (rows) => ({ rows });
const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});
const requestJson = async (baseUrl, body) => {
  const response = await fetch(`${baseUrl}/api/game/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

function createStore({ cycleVersion = 0 } = {}) {
  const parent = { id: 19, name: 'Parent User', parent_id: '123456', role: 'parent' };
  const students = new Map([[44, {
    id: 44,
    game_student_id: '12345678',
    name: 'Ava Santos',
    email: 'ava@example.test',
    role: 'student',
    grade_level: 'Grade 3',
    section: 'Section A',
  }]]);
  const state = {
    parents: new Map([['123456', parent]]),
    students,
    links: new Set(['19:44']),
    currentCycles: new Map([[44, cycleVersion]]),
    sessions: new Map(),
    progress: new Map(),
    activities: [],
    receipts: new Map(),
    failActivityInsert: false,
    queryCount: 0,
    onCommit: null,
  };
  const transactions = new Map();
  const lockTails = new Map();
  let nextProgressId = 500;
  let nextActivityId = 800;

  async function acquireLock(key) {
    const previous = lockTails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    lockTails.set(key, tail);
    await previous;
    return () => {
      release();
      if (lockTails.get(key) === tail) lockTails.delete(key);
    };
  }

  function currentProgressFor(studentId, tx) {
    return tx?.progressWrites.get(studentId) || state.progress.get(studentId) || null;
  }

  function findReceipt(key, tx) {
    return tx?.receiptWrites.get(key) || state.receipts.get(key) || null;
  }

  async function query(sql, params, clientId) {
    state.queryCount += 1;
    const tx = clientId === null ? null : transactions.get(clientId);

    if (sql === 'begin') {
      transactions.set(clientId, { progressWrites: new Map(), activityWrites: [], receiptWrites: new Map(), releaseLock: null });
      return emptyResult;
    }
    if (sql === 'commit') {
      const current = transactions.get(clientId);
      if (current) {
        for (const [studentId, row] of current.progressWrites) state.progress.set(studentId, row);
        for (const [key, receipt] of current.receiptWrites) state.receipts.set(key, receipt);
        state.activities.push(...current.activityWrites);
        transactions.delete(clientId);
        current.releaseLock?.();
      }
      state.onCommit?.();
      return emptyResult;
    }
    if (sql === 'rollback') {
      const current = transactions.get(clientId);
      if (current) {
        transactions.delete(clientId);
        current.releaseLock?.();
      }
      return emptyResult;
    }
    if (sql.startsWith('select id, name, parent_id from public.accounts')) {
      const found = state.parents.get(String(params[0]));
      return resultRows(found ? [clone(found)] : []);
    }
    if (sql.startsWith('select s.* from public.accounts s join public.teacher_student_relationships')) {
      const parentId = Number(params[0]);
      const submitted = params[1];
      const found = [...state.students.values()].find((student) => {
        const linked = state.links.has(`${parentId}:${student.id}`);
        return linked && (String(student.game_student_id) === String(submitted) || Number(student.id) === Number(submitted));
      });
      return resultRows(found ? [clone(found)] : []);
    }
    if (sql.startsWith('select * from public.accounts where game_student_id')) {
      const found = [...state.students.values()].find((student) => String(student.game_student_id) === String(params[0]));
      return resultRows(found ? [clone(found)] : []);
    }
    if (sql.includes('select coalesce(current_learning_cycle_version, 0) as current_learning_cycle_version from public.accounts')) {
      const txState = transactions.get(clientId);
      if (txState && !txState.releaseLock) txState.releaseLock = await acquireLock(`student:${params[0]}`);
      return resultRows([{ current_learning_cycle_version: state.currentCycles.get(Number(params[0])) ?? 0 }]);
    }
    if (sql.startsWith('select id, session_credential_hash, coalesce(learning_cycle_version, 0)')) {
      const session = state.sessions.get(Number(params[0]));
      const studentId = Number(params[1]);
      const currentCycle = state.currentCycles.get(studentId) ?? 0;
      if (!session || session.student_id !== studentId || session.expired || session.cycle !== currentCycle) return emptyResult;
      return resultRows([{
        id: session.id,
        session_credential_hash: session.credential_hash,
        learning_cycle_version: session.cycle,
        heartbeat_stale: Boolean(session.heartbeat_stale),
      }]);
    }
    if (sql.startsWith('insert into public.game_progress_save_commits')) {
      const [studentId, cycle, commitHash, payloadHash, eventKey] = params;
      const key = `${studentId}:${cycle}:${commitHash}`;
      if (findReceipt(key, tx)) return emptyResult;
      tx.receiptWrites.set(key, {
        student_id: Number(studentId),
        learning_cycle_version: Number(cycle),
        save_commit_id_hash: commitHash,
        payload_sha256: payloadHash,
        activity_event_key: eventKey,
        response_status: 201,
        response_body: null,
      });
      return resultRows([{ save_commit_id_hash: commitHash }]);
    }
    if (sql.startsWith('select payload_sha256, response_status, response_body from public.game_progress_save_commits')) {
      const key = `${params[0]}:${params[1]}:${params[2]}`;
      const receipt = findReceipt(key, tx);
      return resultRows(receipt ? [{
        payload_sha256: receipt.payload_sha256,
        response_status: receipt.response_status,
        response_body: clone(receipt.response_body),
      }] : []);
    }
    if (sql.startsWith('update public.game_progress_save_commits')) {
      const key = `${params[0]}:${params[1]}:${params[2]}`;
      const receipt = tx.receiptWrites.get(key);
      if (!receipt) return emptyResult;
      receipt.response_body = JSON.parse(params[3]);
      return resultRows([{ save_commit_id_hash: receipt.save_commit_id_hash }]);
    }
    if (sql.startsWith('select id from public.student_game_progress')) {
      const studentId = Number(params[0]);
      const row = currentProgressFor(studentId, tx);
      const currentCycle = state.currentCycles.get(studentId) ?? 0;
      return resultRows(row && row.learning_cycle_version === currentCycle ? [{ id: row.id }] : []);
    }
    if (sql.startsWith('insert into public.student_game_progress')) {
      const [studentId, studentName, gradeLevel, section, currentQuest, score, correctAnswers,
        totalQuestions, accuracyRate, progressPercentage, lessonProgress, totalQuestsCompleted,
        totalPlayTime, currentScene, currentMap, difficultyLevel] = params;
      const row = {
        id: nextProgressId++, student_id: Number(studentId), student_name: studentName,
        grade_level: gradeLevel, section, current_quest: currentQuest, score, correct_answers: correctAnswers,
        total_questions: totalQuestions, accuracy_rate: accuracyRate, progress_percentage: progressPercentage,
        lesson_progress: lessonProgress, total_quests_completed: totalQuestsCompleted,
        total_play_time: totalPlayTime, current_scene: currentScene, current_map: currentMap,
        difficulty_level: difficultyLevel, learning_cycle_version: state.currentCycles.get(Number(studentId)) ?? 0,
      };
      tx.progressWrites.set(Number(studentId), row);
      return resultRows([clone(row)]);
    }
    if (sql.startsWith('update public.student_game_progress')) {
      const [studentName, gradeLevel, section, currentQuest, score, correctAnswers, totalQuestions,
        accuracyRate, progressPercentage, lessonProgress, totalQuestsCompleted, totalPlayTime,
        currentScene, currentMap, difficultyLevel, progressId] = params;
      const studentId = Number([...state.progress.entries()].find(([, row]) => row.id === progressId)?.[0]
        ?? [...tx.progressWrites.entries()].find(([, row]) => row.id === progressId)?.[0]);
      const previous = currentProgressFor(studentId, tx);
      const row = {
        ...previous, student_name: studentName, grade_level: gradeLevel ?? previous.grade_level,
        section: section ?? previous.section, current_quest: currentQuest ?? previous.current_quest,
        score, correct_answers: correctAnswers, total_questions: totalQuestions, accuracy_rate: accuracyRate,
        progress_percentage: progressPercentage, lesson_progress: lessonProgress,
        total_quests_completed: Math.max(previous.total_quests_completed || 0, totalQuestsCompleted),
        total_play_time: Math.max(previous.total_play_time || 0, totalPlayTime),
        current_scene: currentScene ?? previous.current_scene, current_map: currentMap ?? previous.current_map,
        difficulty_level: difficultyLevel,
      };
      tx.progressWrites.set(studentId, row);
      return resultRows([clone(row)]);
    }
    if (sql.startsWith('insert into public.activity_logs')) {
      if (state.failActivityInsert) {
        state.failActivityInsert = false;
        throw new Error('synthetic activity insert failure');
      }
      const eventKey = params[15] ?? null;
      const studentId = Number(params[0]);
      if (eventKey && [...state.activities, ...tx.activityWrites].some((row) => row.student_id === studentId && row.event_key === eventKey)) {
        const error = new Error('duplicate activity event key');
        error.code = '23505';
        throw error;
      }
      const row = {
        id: nextActivityId++, student_id: studentId, student_name: params[1], grade_level: params[2],
        section: params[3], current_quest: params[4], save_status: params[5], total_play_time: params[6],
        quest_progress: params[7], lesson_progress: params[8], difficulty_level: params[9],
        activity_description: params[10], login_time: params[11], logout_time: params[12],
        current_scene: params[13], current_map: params[14], event_key: eventKey,
      };
      tx.activityWrites.push(row);
      return resultRows([clone(row)]);
    }
    return emptyResult;
  }

  return { state, query };
}

const setQueryHandler = (handler) => { queryHandler = handler; };
const withServer = async (t, options, run) => {
  const store = createStore(options);
  setQueryHandler(store.query);
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });
  await run({ store, server, baseUrl });
};
const makePayload = (overrides = {}) => ({
  parent_id: '123456',
  student_id: 44,
  student_name: 'Ava Santos',
  current_quest: 'Forest Gatekeeper',
  quest_progress: 3,
  lesson_progress: 25,
  score: 8,
  correct_answers: 4,
  total_questions: 5,
  total_play_time: 120,
  learning_cycle_version: 0,
  save_commit_id: 'manual:12345678:0:1',
  ...overrides,
});
const sessionHash = (credential) => crypto.createHash('sha256').update(credential).digest('hex');

test('first save writes progress, activity, and a scoped completed receipt atomically', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    const response = await requestJson(baseUrl, makePayload());
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(Object.keys(response.body).sort(), ['activity_log_id', 'progress_id', 'success']);
    assert.equal(store.state.receipts.size, 1);
    assert.equal(store.state.progress.size, 1);
    assert.equal(store.state.activities.length, 1);
    const [receipt] = store.state.receipts.values();
    assert.equal(receipt.response_status, 201);
    assert.equal(receipt.response_body.success, true);
    assert.equal(store.state.activities[0].event_key, receipt.activity_event_key);
  });
});

test('identical retry returns the stored successful response without duplicate activity', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    const first = await requestJson(baseUrl, makePayload());
    const second = await requestJson(baseUrl, makePayload());
    assert.equal(second.status, first.status);
    assert.deepEqual(second.body, first.body);
    assert.equal(store.state.receipts.size, 1);
    assert.equal(store.state.activities.length, 1);
    assert.equal(store.state.activities.filter((row) => row.event_key).length, 1);
  });
});

test('reusing one commit ID with a different business payload returns HTTP 409', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    await requestJson(baseUrl, makePayload());
    const conflict = await requestJson(baseUrl, makePayload({ score: 9 }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'SAVE_COMMIT_ID_REUSED');
    assert.equal(store.state.receipts.size, 1);
    assert.equal(store.state.activities.length, 1);
  });
});

test('concurrent identical requests serialize and create one activity', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    const [first, second] = await Promise.all([
      requestJson(baseUrl, makePayload()),
      requestJson(baseUrl, makePayload()),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(first.body, second.body);
    assert.equal(store.state.receipts.size, 1);
    assert.equal(store.state.activities.length, 1);
  });
});

test('distinct commit IDs with identical progress create distinct activities', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    await requestJson(baseUrl, makePayload());
    const second = await requestJson(baseUrl, makePayload({ save_commit_id: 'manual:12345678:0:2' }));
    assert.equal(second.status, 201);
    assert.equal(store.state.receipts.size, 2);
    assert.equal(store.state.activities.length, 2);
    assert.equal(store.state.progress.size, 1);
  });
});

test('the same commit ID is isolated by authorized student', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    store.state.students.set(45, {
      id: 45, game_student_id: '87654321', name: 'Ben Reyes', email: 'ben@example.test',
      role: 'student', grade_level: 'Grade 4', section: 'Section B',
    });
    store.state.links.add('19:45');
    store.state.currentCycles.set(45, 0);
    await requestJson(baseUrl, makePayload());
    const second = await requestJson(baseUrl, makePayload({ student_id: 45, student_name: 'Ben Reyes' }));
    assert.equal(second.status, 201);
    assert.equal(store.state.receipts.size, 2);
    assert.equal(store.state.activities.length, 2);
  });
});

test('the same commit ID is isolated by learning cycle', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    const commitId = 'cycle-retry-id';
    await requestJson(baseUrl, makePayload({ save_commit_id: commitId }));
    store.state.currentCycles.set(44, 1);
    const credential = 'current-session-credential';
    store.state.sessions.set(77, {
      id: 77, student_id: 44, cycle: 1, credential_hash: sessionHash(credential), expired: false,
    });
    const second = await requestJson(baseUrl, makePayload({
      save_commit_id: commitId,
      learning_cycle_version: 1,
      playtime_session_id: 77,
      playtime_session_credential: credential,
    }));
    assert.equal(second.status, 201);
    assert.equal(store.state.receipts.size, 2);
    assert.equal(store.state.activities.length, 2);
    assert.notEqual(
      [...store.state.receipts.values()][0].activity_event_key,
      [...store.state.receipts.values()][1].activity_event_key,
    );
  });
});

test('older clients that omit save_commit_id retain the existing non-idempotent response contract', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    const body = makePayload();
    delete body.save_commit_id;
    const response = await requestJson(baseUrl, body);
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(store.state.receipts.size, 0);
    assert.equal(store.state.activities.length, 1);
    assert.equal(store.state.activities[0].event_key, null);
  });
});

test('malformed and oversized commit IDs are rejected before opening a transaction', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    for (const value of ['', 7, null, 'not allowed', 'bad/id', 'x'.repeat(129)]) {
      const response = await requestJson(baseUrl, makePayload({ save_commit_id: value }));
      assert.equal(response.status, 400);
    }
    assert.equal(store.state.receipts.size, 0);
    assert.equal(store.state.progress.size, 0);
    assert.equal(store.state.activities.length, 0);
    assert.equal(store.state.queryCount, 0);
  });
});

test('failed activity insertion rolls back receipt and progress writes', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    store.state.failActivityInsert = true;
    const response = await requestJson(baseUrl, makePayload());
    assert.equal(response.status, 500);
    assert.equal(store.state.receipts.size, 0);
    assert.equal(store.state.progress.size, 0);
    assert.equal(store.state.activities.length, 0);
  });
});

test('a retry after the first response is lost returns the committed outcome once', async (t) => {
  await withServer(t, {}, async ({ store, baseUrl }) => {
    const controller = new AbortController();
    store.state.onCommit = () => controller.abort();
    const droppedResponse = fetch(`${baseUrl}/api/game/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload()),
      signal: controller.signal,
    });
    await assert.rejects(droppedResponse, (error) => error.name === 'AbortError');
    store.state.onCommit = null;
    const retry = await requestJson(baseUrl, makePayload());
    assert.equal(retry.status, 201);
    assert.equal(retry.body.success, true);
    assert.equal(store.state.receipts.size, 1);
    assert.equal(store.state.activities.length, 1);
  });
});

test('unlinked students and expired learning-cycle sessions cannot create receipts', async (t) => {
  await withServer(t, { cycleVersion: 0 }, async ({ store, baseUrl }) => {
    const unlinked = await requestJson(baseUrl, makePayload({ student_id: 999 }));
    assert.equal(unlinked.status, 403);
    assert.equal(store.state.receipts.size, 0);

    store.state.currentCycles.set(44, 1);
    const expired = await requestJson(baseUrl, makePayload({
      learning_cycle_version: 1,
      playtime_session_id: 404,
      playtime_session_credential: 'expired-session',
    }));
    assert.equal(expired.status, 403);
    assert.equal(store.state.receipts.size, 0);
    assert.equal(store.state.progress.size, 0);
    assert.equal(store.state.activities.length, 0);
  });
});
