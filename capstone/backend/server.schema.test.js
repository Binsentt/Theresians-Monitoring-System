const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const schemaStatements = [];
const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();

const mockPool = {
  query: async (sql) => {
    schemaStatements.push(compactSql(sql));
    return { rows: [] };
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
    verify: () => ({}),
  },
  multer: multerStub,
  'pdf-parse': async () => ({ text: '' }),
};

const originalLoad = Module._load;
Module._load = function loadWithServerStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(serverDependencyStubs, request)) {
    return serverDependencyStubs[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require('./server');
} finally {
  Module._load = originalLoad;
}

const waitForSchemaInitialization = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (schemaStatements.some((sql) => sql.includes('idx_questions_grade_difficulty_topic'))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('startup schema creates game_results for future game integration', async () => {
  await waitForSchemaInitialization();

  assert.ok(
    schemaStatements.some((sql) => sql.startsWith('create table if not exists public.game_results')),
    'game_results table should be created during startup schema initialization'
  );
  assert.ok(
    schemaStatements.some((sql) => sql.includes('idx_game_results_parent_id')),
    'game_results parent_id index should be created during startup schema initialization'
  );
  assert.ok(
    schemaStatements.some((sql) => sql.includes('idx_game_results_resolved_student_id')),
    'game_results resolved_student_id index should be created during startup schema initialization'
  );
});
