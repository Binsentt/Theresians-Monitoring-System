const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

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

const createMiddleware = () => (req, res, next) => next();
const multerStub = () => ({ single: createMiddleware, array: createMiddleware, fields: createMiddleware });
const dependencyStubs = {
  bcrypt: { compare: async () => false, hash: async (value) => value },
  cors: () => createMiddleware(),
  jsonwebtoken: { sign: () => 'token', verify: () => ({}) },
  multer: multerStub,
  'pdf-parse': async () => ({ text: '' }),
  yauzl: { open: () => {} },
  'fast-xml-parser': { XMLParser: class { parse() { return {}; } } },
};
const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };
const originalLoad = Module._load;
let serverExports;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(dependencyStubs, request)) return dependencyStubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
try {
  serverExports = require('./server');
} finally {
  Module._load = originalLoad;
}

const { app } = serverExports;
const resultRows = (rows) => ({ rows });
const listen = () => new Promise((resolve) => {
  const server = app.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const requestJson = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
};

test('canonical activity persists timing, map difficulty, and one player-facing milestone per stable event', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const inserted = [];
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  queryHandler = async (sql, params) => {
    if (sql.startsWith('select ps.id')) {
      return resultRows([{ id: 7, student_id: 44, session_credential_hash: require('node:crypto').createHash('sha256').update('lease').digest('hex'), learning_cycle_version: 2, current_learning_cycle_version: 2, student_name: 'Synthetic Student', grade_level: 'Grade 1', section: 'A' }]);
    }
    if (sql.startsWith('insert into public.activity_logs')) {
      inserted.push({ sql, params });
      return resultRows([{ id: inserted.length }]);
    }
    if (sql.startsWith('insert into public.student_quest_milestones')) return resultRows([{ milestone_id: 'tutorial.complete' }]);
    if (sql.startsWith('update public.student_game_progress')) return resultRows([]);
    return emptyResult;
  };

  const response = await requestJson(baseUrl, '/api/game/activity', {
    method: 'POST',
    body: JSON.stringify({
      telemetry_contract_version: '2.0',
      quest_graph_version: 'oakleaf-city-pinehill-v1',
      activity_event_id: 'cycle:2:activity:tutorial:complete',
      canonical_activity_id: 'tutorial',
      canonical_quest_id: 'main',
      canonical_task_id: 'tutorial',
      canonical_milestone_id: 'tutorial.complete',
      map_id: 'oakleaf_village',
      event_type: 'task_completed',
      event_key: 'cycle:2:tutorial:complete',
      task_id: 'tutorial',
      is_player_facing: true,
      session_id: 7,
      session_credential: 'lease',
      learning_cycle_version: 2,
      started_at: '2026-09-13T01:00:00.000Z',
      completed_at: '2026-09-13T01:00:12.000Z',
      duration_seconds: 12,
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].sql, /activity_event_id/);
  assert.match(inserted[0].sql, /duration_seconds/);
  assert.match(inserted[0].sql, /difficulty_level/);
});
