const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let tokenPayloads = {};
let authenticatedAccounts = {};
let observed = {};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const resultRows = (rows) => ({ rows });
const runQuery = async (sql, params = []) => {
  const compacted = compactSql(sql);
  if (compacted.startsWith('select * from public.accounts where id = $1')) {
    const account = authenticatedAccounts[Number(params[0])];
    return account ? resultRows([account]) : emptyResult;
  }
  return (await queryHandler(compacted, params, sql)) || emptyResult;
};

const mockPool = {
  query: runQuery,
  connect: async () => ({ query: runQuery, release: () => {} }),
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const passthrough = () => (req, res, next) => next();
const originalLoad = Module._load;
let serverExports;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => value };
  if (request === 'cors') return () => passthrough();
  if (request === 'jsonwebtoken') {
    return {
      sign: () => 'token',
      verify: (token) => {
        const payload = tokenPayloads[token];
        if (payload instanceof Error) throw payload;
        return payload || {};
      },
    };
  }
  if (request === 'multer') return () => ({ single: passthrough, array: passthrough, fields: passthrough });
  if (request === 'pdf-parse') return async () => ({ text: '' });
  return originalLoad.call(this, request, parent, isMain);
};
try {
  serverExports = require('./server');
} finally {
  Module._load = originalLoad;
}

const { app } = serverExports;
const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });
const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const requestJson = async (baseUrl, requestPath, options = {}) => {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch (_) {}
  return { status: response.status, body };
};

const reset = () => {
  observed = {
    transactionStarted: false,
    transactionCommitted: false,
    transactionRolledBack: false,
    boundaryUpdatedFor: null,
    currentSnapshotDeletedFor: null,
    gameResultsDeleted: false,
    playtimeDeleted: false,
    activityHistoryDeleted: false,
    auditReason: null,
    auditActorAccountId: null,
  };
  tokenPayloads = {
    admin: { userId: 1, sessionVersion: 0 },
  };
  authenticatedAccounts = {
    1: { id: 1, role: 'admin', is_archived: false, session_version: 0, name: 'Admin' },
  };
  queryHandler = async (sql, params) => {
    if (sql === 'begin') { observed.transactionStarted = true; return emptyResult; }
    if (sql === 'commit') { observed.transactionCommitted = true; return emptyResult; }
    if (sql === 'rollback') { observed.transactionRolledBack = true; return emptyResult; }
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return resultRows([{ id: 44, name: 'Scoped Student', grade_level: 'Grade 3', section: null }]);
    }
    if (sql.startsWith('update public.accounts set current_learning_cycle_started_at')) {
      observed.boundaryUpdatedFor = Number(params[0]);
      return resultRows([{
        current_learning_cycle_started_at: '2026-08-24T00:00:00.000Z',
        current_learning_cycle_version: 1,
      }]);
    }
    if (sql.startsWith('delete from public.student_game_progress')) {
      observed.currentSnapshotDeletedFor = Number(params[0]);
      return emptyResult;
    }
    if (sql.startsWith('delete from public.game_results')) observed.gameResultsDeleted = true;
    if (sql.startsWith('delete from public.playtime_sessions')) observed.playtimeDeleted = true;
    if (sql.startsWith('delete from public.activity_logs')) observed.activityHistoryDeleted = true;
    if (sql.startsWith('insert into public.activity_logs')) {
      observed.auditReason = String(params.find((value) => String(value).includes('Reason:')) || '');
      observed.auditActorAccountId = Number(params.find((value) => Number(value) === 1));
      return emptyResult;
    }
    return emptyResult;
  };
};

const configureActor = (token, id, role) => {
  tokenPayloads[token] = { userId: id, sessionVersion: 0 };
  authenticatedAccounts[id] = {
    id,
    role,
    is_archived: false,
    session_version: 0,
    name: `${role} account`,
  };
};

const withScopedRelationship = ({ actorId, studentId = 44, scopeType, linked = true }) => {
  const baseHandler = queryHandler;
  queryHandler = async (sql, params, rawSql) => {
    if (scopeType === 'teacher' && sql.includes('select 1 from public.accounts child')) {
      return Number(params[0]) === actorId && Number(params[1]) === studentId && linked
        ? resultRows([{ linked: 1 }])
        : emptyResult;
    }
    if (scopeType === 'parent' && sql.includes('from public.teacher_student_relationships tsr')) {
      return Number(params[0]) === actorId && Number(params[1]) === studentId && linked
        ? resultRows([{ linked: 1 }])
        : emptyResult;
    }
    return baseHandler(sql, params, rawSql);
  };
};

test('learning-cycle migration is additive and retains historical monitoring tables', () => {
  const migrationPath = path.join(__dirname, 'migrations', '009_add_learning_cycle_boundary.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS current_learning_cycle_started_at TIMESTAMPTZ/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS actor_account_id INTEGER/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_accounts_learning_cycle_boundary/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+(public\.)?(game_results|playtime_sessions|activity_logs)/i);
});

test('current-cycle reads exclude pre-reset progress and results without hiding historical monitoring', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const canonicalProgress = source.slice(
    source.indexOf('const buildCanonicalStudentProgressQuery'),
    source.indexOf('const calculateGameResultPercentage')
  );
  const topAchievers = source.slice(
    source.indexOf('const handleTopAchieversRequest'),
    source.indexOf("app.get('/api/top-achievers'")
  );
  const parentChildren = source.slice(
    source.indexOf("app.get('/api/parent/children'"),
    source.indexOf("app.get('/api/parent/children/:studentId/quizzes'")
  );
  const studentDetail = source.slice(
    source.indexOf("app.get('/api/student-progress/:studentId'"),
    source.indexOf('const clientBuildPath')
  );

  assert.match(canonicalProgress, /progress\.updated_at\s*>=\s*a\.current_learning_cycle_started_at/i);
  assert.match(topAchievers, /p\.updated_at\s*>=\s*a\.current_learning_cycle_started_at/i);
  assert.match(parentChildren, /gr\.played_at\s*>=\s*s\.current_learning_cycle_started_at/i);
  assert.match(studentDetail, /played_at\s*>=\s*\$2/i);
  assert.match(studentDetail, /activity_timestamp\s*>=\s*\$2/i);
  const activityLogRoute = source.match(/app\.get\('\/api\/activity-logs'[\s\S]*?\n\}\);\r?\n\r?\nconst parseActivityDurationSeconds/)?.[0] || '';
  const playtimeList = source.slice(source.indexOf('const handlePlaytimeListRequest'), source.indexOf("app.post('/api/playtime/start'"));
  assert.doesNotMatch(activityLogRoute, /current_learning_cycle_started_at/i);
  assert.doesNotMatch(playtimeList, /current_learning_cycle_started_at/i);
});

test('Admin starts a new learning cycle without deleting historical gameplay or Screen Time', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const response = await requestJson(baseUrl, '/api/student-progress/44/reset', {
    method: 'POST',
    headers: authHeaders('admin'),
    body: JSON.stringify({ reason: 'New Lesson' }),
  });

  assert.equal(response.status, 200);
  assert.equal(observed.transactionStarted, true);
  assert.equal(observed.transactionCommitted, true);
  assert.equal(observed.boundaryUpdatedFor, 44);
  assert.equal(observed.currentSnapshotDeletedFor, 44);
  assert.equal(observed.gameResultsDeleted, false);
  assert.equal(observed.playtimeDeleted, false);
  assert.equal(observed.activityHistoryDeleted, false);
  assert.match(observed.auditReason, /Reason: New Lesson/);
  assert.equal(observed.auditActorAccountId, 1);
  assert.deepEqual(response.body.learning_cycle, {
    version: 1,
    started_at: '2026-08-24T00:00:00.000Z',
  });
});

test('Reset Progress requires an approved reason', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const response = await requestJson(baseUrl, '/api/student-progress/44/reset', {
    method: 'POST',
    headers: authHeaders('admin'),
    body: JSON.stringify({ reason: '' }),
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /reason/i);
});

test('Teacher can reset only an authorized student', async (t) => {
  reset();
  configureActor('teacher', 2, 'teacher');
  withScopedRelationship({ actorId: 2, scopeType: 'teacher' });
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const allowed = await requestJson(baseUrl, '/api/student-progress/44/reset', {
    method: 'POST', headers: authHeaders('teacher'), body: JSON.stringify({ reason: 'New Lesson' }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(observed.currentSnapshotDeletedFor, 44);

  reset();
  configureActor('teacher', 2, 'teacher');
  withScopedRelationship({ actorId: 2, studentId: 44, scopeType: 'teacher', linked: false });
  const denied = await requestJson(baseUrl, '/api/student-progress/45/reset', {
    method: 'POST', headers: authHeaders('teacher'), body: JSON.stringify({ reason: 'New Lesson' }),
  });
  assert.equal(denied.status, 403);
  assert.equal(observed.transactionStarted, false);
});

test('Parent and Parent/Teacher reset scopes remain isolated', async (t) => {
  reset();
  configureActor('parent', 3, 'parent');
  withScopedRelationship({ actorId: 3, scopeType: 'parent' });
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const parentAllowed = await requestJson(baseUrl, '/api/student-progress/44/reset', {
    method: 'POST', headers: authHeaders('parent'), body: JSON.stringify({ reason: 'Completed Current Lesson' }),
  });
  assert.equal(parentAllowed.status, 200);

  reset();
  configureActor('parentTeacher', 4, 'parent_teacher');
  withScopedRelationship({ actorId: 4, scopeType: 'parent' });
  const parentScope = await requestJson(baseUrl, '/api/student-progress/44/reset?scope=parent', {
    method: 'POST', headers: authHeaders('parentTeacher'), body: JSON.stringify({ reason: 'New Grading Period' }),
  });
  assert.equal(parentScope.status, 200);

  reset();
  configureActor('parentTeacher', 4, 'parent_teacher');
  withScopedRelationship({ actorId: 4, scopeType: 'teacher', linked: false });
  const teacherScopeDenied = await requestJson(baseUrl, '/api/student-progress/44/reset', {
    method: 'POST', headers: authHeaders('parentTeacher'), body: JSON.stringify({ reason: 'New Grading Period' }),
  });
  assert.equal(teacherScopeDenied.status, 403);
  assert.equal(observed.transactionStarted, false);
});

test('Reset rolls back if the current progress snapshot cannot be cleared', async (t) => {
  reset();
  const baseHandler = queryHandler;
  queryHandler = async (sql, params, rawSql) => {
    if (sql.startsWith('delete from public.student_game_progress')) throw new Error('snapshot delete failed');
    return baseHandler(sql, params, rawSql);
  };
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const response = await requestJson(baseUrl, '/api/student-progress/44/reset', {
    method: 'POST', headers: authHeaders('admin'), body: JSON.stringify({ reason: 'Testing Data Cleanup' }),
  });
  assert.equal(response.status, 500);
  assert.equal(observed.transactionStarted, true);
  assert.equal(observed.transactionCommitted, false);
  assert.equal(observed.transactionRolledBack, true);
});

test('Archive preserves gameplay and monitoring history, and rejects New Lesson as an archive reason', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const rejected = await requestJson(baseUrl, '/api/student-progress/44/archive', {
    method: 'POST', headers: authHeaders('admin'), body: JSON.stringify({ reason: 'New Lesson' }),
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Reset Progress/i);

  const archived = await requestJson(baseUrl, '/api/student-progress/44/archive', {
    method: 'POST', headers: authHeaders('admin'), body: JSON.stringify({ reason: 'Transferred' }),
  });
  assert.equal(archived.status, 200);
  assert.equal(observed.transactionCommitted, true);
  assert.equal(observed.currentSnapshotDeletedFor, null);
  assert.equal(observed.gameResultsDeleted, false);
  assert.equal(observed.playtimeDeleted, false);
  assert.equal(observed.activityHistoryDeleted, false);
});

test('Admin permanent delete removes only approved gameplay-derived rows and advances the cycle', async (t) => {
  reset();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { reset(); await close(server); });

  const denied = await requestJson(baseUrl, '/api/student-progress/44/permanent-delete', {
    method: 'POST', headers: authHeaders('admin'), body: JSON.stringify({ reason: 'Testing Data Cleanup', confirmation_phrase: 'REMOVE' }),
  });
  assert.equal(denied.status, 400);

  const deleted = await requestJson(baseUrl, '/api/student-progress/44/permanent-delete', {
    method: 'POST', headers: authHeaders('admin'), body: JSON.stringify({ reason: 'Testing Data Cleanup', confirmation_phrase: 'DELETE' }),
  });
  assert.equal(deleted.status, 200);
  assert.equal(observed.currentSnapshotDeletedFor, 44);
  assert.equal(observed.gameResultsDeleted, true);
  assert.equal(observed.playtimeDeleted, false);
  assert.equal(observed.activityHistoryDeleted, false);
  assert.deepEqual(deleted.body.learning_cycle, { version: 1, started_at: '2026-08-24T00:00:00.000Z' });
});
