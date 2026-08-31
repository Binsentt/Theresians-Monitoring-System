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
  assert.ok(
    schemaStatements.some((sql) => sql.includes('add column if not exists question_set_id integer')),
    'game_results should keep a nullable question_set_id for backward-compatible traceability'
  );
  assert.ok(
    schemaStatements.some((sql) => sql.includes('idx_game_results_question_set_id')),
    'game_results question_set_id index should support historical traceability queries'
  );
  assert.ok(
    schemaStatements.some((sql) => sql.includes('game_results_question_set_id_fkey') && sql.includes('on delete restrict')),
    'game_results question_set_id should use a restrictive foreign key so permanent deletion cannot race historical result insertion'
  );
});

test('startup schema keeps nullable canonical topic IDs for learning files and questions', async () => {
  await waitForSchemaInitialization();

  assert.ok(
    schemaStatements.some((sql) => sql.includes('alter table public.learning_files add column if not exists topic_id varchar(100)')),
    'learning_files should add a nullable canonical topic_id without rewriting legacy rows'
  );
  assert.ok(
    schemaStatements.some((sql) => sql.includes('alter table public.questions add column if not exists topic_id varchar(100)')),
    'questions should add a nullable canonical topic_id without rewriting legacy rows'
  );
  assert.ok(
    schemaStatements.some((sql) => sql.includes('learning_files_scope_topic_id_index')),
    'learning_files should index canonical encounter scopes'
  );
  assert.ok(
    schemaStatements.some((sql) => sql.includes('questions_learning_file_topic_id_index')),
    'questions should index canonical question metadata'
  );
});
