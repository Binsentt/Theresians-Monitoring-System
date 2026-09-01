const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLearningFileApprovalFingerprint } = require('./learningFileApproval.utils');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let parsedPdfText = '';
let pdfParseFailure = null;
const authenticatedTeacher = { id: 1, role: 'admin', is_archived: false, session_version: 0 };

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    const normalizedSql = compactSql(sql);
    if (normalizedSql.startsWith('select * from public.accounts where id = $1')) {
      return resultRows([authenticatedTeacher]);
    }
    return (await queryHandler(normalizedSql, params, sql)) || emptyResult;
  },
  connect: async () => ({
    query: async (sql, params = []) => {
      const normalizedSql = compactSql(sql);
      if (normalizedSql.startsWith('select * from public.accounts where id = $1')) {
        return resultRows([authenticatedTeacher]);
      }
      return (await queryHandler(normalizedSql, params, sql)) || emptyResult;
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

let nextUploadedFile = null;
let queuedUploadedFiles = [];
const createMiddleware = () => (req, res, next) => next();
const multerStub = () => ({
  single: () => (req, res, next) => {
    if (queuedUploadedFiles.length > 0) req.file = queuedUploadedFiles.shift();
    else if (nextUploadedFile) req.file = nextUploadedFile;
    next();
  },
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
    verify: () => ({ userId: 1, sessionVersion: 0 }),
  },
  multer: multerStub,
  'pdf-parse': async () => {
    if (pdfParseFailure) throw pdfParseFailure;
    return { text: parsedPdfText };
  },
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

const normalizeApprovalTestDifficulty = (difficulty) => ({
  Medium: 'Normal',
  Hard: 'Difficult',
}[difficulty] || difficulty);

const approvedForPublication = (learningFile, questions) => ({
  ...learningFile,
  approval_status: 'approved',
  approved_content_fingerprint: buildLearningFileApprovalFingerprint(learningFile, questions.map((question) => ({
    ...question,
    difficulty: normalizeApprovalTestDifficulty(question.difficulty),
  }))),
});

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
      Authorization: 'Bearer teacher-token',
      ...(options.headers || {}),
    },
  });
  return {
    status: response.status,
    body: await response.json(),
  };
};

test('Lesson Manager registry endpoint returns only versioned static curriculum metadata and rejects writes', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let queryCount = 0;
  setQueryHandler(async () => {
    queryCount += 1;
    return emptyResult;
  });
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const response = await fetch(`${baseUrl}/api/curriculum/registry`, {
    headers: { Authorization: 'Bearer teacher-token' },
  });
  assert.equal(response.status, 200);
  const registry = await response.json();
  assert.equal(registry.version, '2026-08-31');
  assert.equal(registry.grades.length, 6);
  assert.equal(registry.difficulties.length, 3);
  assert.equal(registry.topics.length, 25);
  assert.equal(registry.scopes.length, 18);
  assert.equal(registry.topics.some((topic) => topic.topic_id === 'basic_addition' && topic.display_label === 'Basic Addition'), true);
  assert.equal(Object.hasOwn(registry, 'questions'), false);
  assert.match(response.headers.get('etag') || '', /2026-08-31/);
  assert.equal(queryCount, 0);

  const unauthenticated = await fetch(`${baseUrl}/api/curriculum/registry`);
  assert.equal(unauthenticated.status, 401);
  const writeAttempt = await fetch(`${baseUrl}/api/curriculum/registry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer teacher-token' },
  });
  assert.equal(writeAttempt.status, 404);
});

test('question publishing replaces the active Godot bundle for one Grade and Difficulty pool', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let unpublishedLearningFiles = null;
  let unpublishedQuestions = null;
  let publishedLearningFile = null;
  let publishedQuestions = null;
  let publicationAudit = null;

  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      const learningFile = {
        id: 77,
        title: 'addition-quiz',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
        subject: 'Mathematics',
        deleted_at: null,
      };
      return resultRows([approvedForPublication(learningFile, [{
        question: 'What is 2 + 3?',
        options: ['4', '5', '6', '7'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
      }])]);
    }
    if (sql.startsWith('select id, learning_file_id') && sql.includes('from public.questions')) {
      return resultRows([{
        id: 101,
        learning_file_id: 77,
        question: 'What is 2 + 3?',
        options: ['4', '5', '6', '7'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
      }]);
    }
    if (sql.startsWith('select count(*)::integer as question_count') && sql.includes('from public.questions')) {
      return resultRows([{ question_count: 1 }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('published = false')) {
      unpublishedLearningFiles = { sql, params };
      return emptyResult;
    }
    if (sql.startsWith('update public.questions q') && sql.includes('published = false')) {
      unpublishedQuestions = { sql, params };
      return emptyResult;
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('published = true')) {
      publishedLearningFile = { sql, params };
      return resultRows([{ id: 77, published: true }]);
    }
    if (sql.startsWith('update public.questions') && sql.includes('published = true')) {
      publishedQuestions = { sql, params };
      return emptyResult;
    }
    if (sql.startsWith('insert into public.admin_audit_logs')) {
      publicationAudit = { sql, params };
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/publish/77', { method: 'POST' });

  assert.equal(response.status, 200);
  assert.deepEqual(unpublishedLearningFiles.params, ['Grade 1', 'Normal', 77]);
  assert.doesNotMatch(unpublishedLearningFiles.sql, /topic_id|math_topic/i);
  assert.match(unpublishedLearningFiles.sql, /id <> \$3/);
  assert.deepEqual(unpublishedQuestions.params, ['Grade 1', 'Normal', 77]);
  assert.doesNotMatch(unpublishedQuestions.sql, /topic_id|math_topic/i);
  assert.match(unpublishedQuestions.sql, /lf\.id <> \$3/);
  assert.deepEqual(publishedLearningFile.params, [77, 1]);
  assert.deepEqual(publishedQuestions.params, [77]);
  assert.match(publicationAudit.sql, /push question set to game/i);
  assert.match(publicationAudit.sql, /question_set_published/i);
});

test('removing an active question set is transactional and preserves its approval record', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let lifecycleUpdate = null;
  let questionUpdate = null;
  let auditInsert = null;
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      return resultRows([{
        id: 77,
        title: 'Approved Addition Set',
        file_name: 'approved-addition.json',
        file_url: '/uploads/approved-addition.json',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        subject: 'Mathematics',
        published: true,
        publish_status: 'active',
        approval_status: 'approved',
        approved_at: '2026-09-01T00:00:00.000Z',
        approved_by: 19,
        approved_content_fingerprint: 'approved-fingerprint',
        deleted_at: null,
      }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('published = false')) {
      lifecycleUpdate = { sql, params };
      return resultRows([{
        id: 77,
        title: 'Approved Addition Set',
        file_name: 'approved-addition.json',
        file_url: '/uploads/approved-addition.json',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        published: false,
        publish_status: 'staged',
        approval_status: 'approved',
        approved_at: '2026-09-01T00:00:00.000Z',
        approved_by: 19,
        approved_content_fingerprint: 'approved-fingerprint',
      }]);
    }
    if (sql.startsWith('update public.questions set published = false')) {
      questionUpdate = { sql, params };
      return emptyResult;
    }
    if (sql.startsWith('insert into public.admin_audit_logs')) {
      auditInsert = { sql, params };
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/unpublish/77', { method: 'POST' });

  assert.equal(response.status, 200);
  assert.equal(response.body.learningFile.id, 77);
  assert.equal(response.body.learningFile.file_name, 'approved-addition.json');
  assert.equal(response.body.learningFile.file_url, '/uploads/approved-addition.json');
  assert.equal(response.body.learningFile.publish_status, 'staged');
  assert.equal(response.body.learningFile.lifecycle.label, 'Approved');
  assert.equal(response.body.learningFile.lifecycle.publishLabel, 'Not in Game');
  assert.deepEqual(lifecycleUpdate.params, [77]);
  assert.doesNotMatch(lifecycleUpdate.sql, /approval_status|approved_at|approved_by|approved_content_fingerprint/i);
  assert.deepEqual(questionUpdate.params, [77]);
  assert.match(auditInsert.sql, /remove question set from game/i);
  assert.match(auditInsert.sql, /question_set_unpublished/i);
});

test('Remove from Game rejects inactive and deleted sets without mutating questions or audit history', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let questionOrAuditMutationAttempted = false;
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      return Number(params[0]) === 77
        ? resultRows([{ id: 77, published: false, publish_status: 'staged', deleted_at: null }])
        : emptyResult;
    }
    if (sql.startsWith('update public.questions') || sql.startsWith('insert into public.admin_audit_logs')) {
      questionOrAuditMutationAttempted = true;
    }
    return emptyResult;
  });

  const inactive = await requestJson(baseUrl, '/api/questions/unpublish/77', { method: 'POST' });
  const deleted = await requestJson(baseUrl, '/api/questions/unpublish/78', { method: 'POST' });

  assert.equal(inactive.status, 409);
  assert.equal(inactive.body.code, 'QUESTION_SET_NOT_ACTIVE');
  assert.equal(deleted.status, 404);
  assert.equal(questionOrAuditMutationAttempted, false);
});

test('active question sets cannot bypass Remove from Game through rename or metadata edits', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let lifecycleMutationAttempted = false;
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select id, published, publish_status from public.learning_files')) {
      return resultRows([{ id: 77, published: true, publish_status: 'active', deleted_at: null }]);
    }
    if (sql.startsWith('update public.learning_files') || sql.startsWith('update public.questions')) {
      lifecycleMutationAttempted = true;
    }
    return emptyResult;
  });

  const rename = await requestJson(baseUrl, '/api/learning-files/77/rename', {
    method: 'PUT',
    body: JSON.stringify({ title: 'renamed-active-set' }),
  });
  const metadata = await requestJson(baseUrl, '/api/learning-files/77', {
    method: 'PUT',
    body: JSON.stringify({
      title: 'renamed-active-set',
      grade_level: 'Grade 1',
      difficulty: 'Normal',
      file_type: 'fixed_questions',
    }),
  });

  assert.equal(rename.status, 409);
  assert.equal(rename.body.code, 'ACTIVE_QUESTION_SET_CANNOT_BE_EDITED');
  assert.equal(metadata.status, 409);
  assert.equal(metadata.body.code, 'ACTIVE_QUESTION_SET_CANNOT_BE_EDITED');
  assert.equal(lifecycleMutationAttempted, false);
});

test('Remove from Game keeps Lesson Manager authorization and Parent/Teacher scope rules authoritative', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalRole = authenticatedTeacher.role;
  t.after(async () => {
    authenticatedTeacher.role = originalRole;
    setQueryHandler(async () => emptyResult);
    await close(server);
  });
  setQueryHandler(async () => emptyResult);

  authenticatedTeacher.role = 'admin';
  assert.equal((await requestJson(baseUrl, '/api/questions/unpublish/77', { method: 'POST' })).status, 404);

  authenticatedTeacher.role = 'teacher';
  assert.equal((await requestJson(baseUrl, '/api/questions/unpublish/77', { method: 'POST' })).status, 404);

  authenticatedTeacher.role = 'parent_teacher';
  const parentTeacherParentScope = await requestJson(baseUrl, '/api/questions/unpublish/77', { method: 'POST' });
  assert.equal(parentTeacherParentScope.status, 403);
  assert.equal(parentTeacherParentScope.body.code, 'LESSON_MANAGER_TEACHER_SCOPE_REQUIRED');
  assert.equal((await requestJson(baseUrl, '/api/questions/unpublish/77?scope=teacher', { method: 'POST' })).status, 404);

  authenticatedTeacher.role = 'parent';
  assert.equal((await requestJson(baseUrl, '/api/questions/unpublish/77', { method: 'POST' })).status, 403);

  authenticatedTeacher.role = 'student';
  assert.equal((await requestJson(baseUrl, '/api/questions/unpublish/77', { method: 'POST' })).status, 403);
});

test('same Grade and Difficulty active content requires replacement confirmation and lists legacy active sets', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let publicationMutationAttempted = false;
  setQueryHandler(async (sql) => {
    if (sql === 'begin' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      const learningFile = {
        id: 78,
        title: 'Replacement Basic Addition',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
        subject: 'Mathematics',
        deleted_at: null,
      };
      return resultRows([approvedForPublication(learningFile, [{
        question: 'What is 2 + 3?',
        options: ['4', '5', '6', '7'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
      }])]);
    }
    if (sql.startsWith('select id, learning_file_id') && sql.includes('from public.questions')) {
      return resultRows([{
        id: 7801,
        learning_file_id: 78,
        question: 'What is 2 + 3?',
        options: ['4', '5', '6', '7'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
      }]);
    }
    if (sql.includes('from public.learning_files') && sql.includes('publish_status = \'active\'')) {
      return resultRows([{
        id: 8,
        title: 'Current Addition',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
        question_count: 5,
      }, {
        id: 9,
        title: 'Current Shapes',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Shapes',
        question_count: 5,
      }]);
    }
    if (sql.startsWith('update public.learning_files') || sql.startsWith('update public.questions')) {
      publicationMutationAttempted = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/publish/78', { method: 'POST' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ACTIVE_SET_REPLACEMENT_CONFIRMATION_REQUIRED');
  assert.equal(response.body.replacement.current_active.id, 8);
  assert.deepEqual(response.body.replacement.affected_active.map((set) => set.id), [8, 9]);
  assert.equal(response.body.replacement.current_active.difficulty, 'Normal');
  assert.equal(response.body.replacement.new_set.id, 78);
  assert.equal(response.body.replacement.new_set.difficulty, 'Normal');
  assert.equal(publicationMutationAttempted, false);
});

test('a confirmed same-scope replacement supersedes only the active set inside one transaction', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let supersededParams = null;
  let activatedParams = null;
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      const learningFile = {
        id: 80,
        title: 'Confirmed Replacement',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
        subject: 'Mathematics',
        deleted_at: null,
      };
      return resultRows([approvedForPublication(learningFile, [{
        question: 'What is 3 + 4?',
        options: ['5', '6', '7', '8'],
        correct_answer: '7',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
      }])]);
    }
    if (sql.startsWith('select id, learning_file_id') && sql.includes('from public.questions')) {
      return resultRows([{
        id: 180,
        learning_file_id: 80,
        question: 'What is 3 + 4?',
        options: ['5', '6', '7', '8'],
        correct_answer: '7',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
      }]);
    }
    if (sql.startsWith('select lf.id') && sql.includes('from public.learning_files lf')) {
      return resultRows([{
        id: 8,
        title: 'Current Addition',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
        question_count: 5,
      }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes("publish_status = 'superseded'")) {
      supersededParams = params;
      return emptyResult;
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('published = true')) {
      activatedParams = params;
      return resultRows([{ id: 80, published: true, publish_status: 'active', difficulty: 'Normal' }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/publish/80', {
    method: 'POST',
    body: JSON.stringify({ confirm_replacement: true }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(supersededParams, ['Grade 1', 'Normal', 80]);
  assert.deepEqual(activatedParams, [80, 1]);
});

test('a confirmed same-scope replacement stays transactional when activation fails', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let rollbackCalled = false;
  let oldActiveSupersedeAttempted = false;
  setQueryHandler(async (sql) => {
    if (sql === 'begin') return emptyResult;
    if (sql === 'rollback') {
      rollbackCalled = true;
      return emptyResult;
    }
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      const learningFile = {
        id: 79,
        title: 'Confirmed Addition Replacement',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
        subject: 'Mathematics',
        deleted_at: null,
      };
      return resultRows([approvedForPublication(learningFile, [{
        question: 'What is 3 + 4?',
        options: ['6', '7', '8', '9'],
        correct_answer: '7',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
      }])]);
    }
    if (sql.startsWith('select id, learning_file_id') && sql.includes('from public.questions')) {
      return resultRows([{
        id: 7901,
        learning_file_id: 79,
        question: 'What is 3 + 4?',
        options: ['6', '7', '8', '9'],
        correct_answer: '7',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
      }]);
    }
    if (sql.includes('from public.learning_files') && sql.includes('publish_status = \'active\'')) {
      return resultRows([{ id: 8, title: 'Current Addition', question_count: 5 }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('published = false')) {
      oldActiveSupersedeAttempted = true;
      return emptyResult;
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('published = true')) {
      throw new Error('simulated activation failure');
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/publish/79', {
    method: 'POST',
    body: JSON.stringify({ confirm_replacement: true }),
  });

  assert.equal(response.status, 500);
  assert.equal(oldActiveSupersedeAttempted, true);
  assert.equal(rollbackCalled, true);
});

test('an invalid legacy-shaped Set 13 cannot be published or mutate publication state', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let publicationUpdateAttempted = false;
  setQueryHandler(async (sql) => {
    if (sql === 'begin' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      return resultRows([{
        id: 13,
        title: 'legacy-set-13',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        topic_id: 'basic_addition',
        math_topic: 'Basic Addition',
        subject: 'Mathematics',
        deleted_at: null,
      }]);
    }
    if (sql.startsWith('select id, learning_file_id') && sql.includes('from public.questions')) {
      return resultRows([{
        id: 1301,
        learning_file_id: 13,
        question: 'What is 2 + 3?',
        options: ['4', '5', '6'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
      }]);
    }
    if (sql.startsWith('update public.learning_files') || sql.startsWith('update public.questions')) {
      publicationUpdateAttempted = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/publish/13', { method: 'POST' });

  assert.equal(response.status, 422);
  assert.equal(response.body.code, 'QUESTION_SET_VALIDATION_FAILED');
  assert.equal(publicationUpdateAttempted, false);
  assert.match(response.body.validation.questions[0].validation_errors.join(' '), /Exactly four/);
});

test('an approved declared Shapes set with a multi-topic-looking heading can publish its exact scope', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let activatedParams = null;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const questions = [
    {
      id: 1401,
      learning_file_id: 14,
      question: 'How many sides does a square have?',
      options: ['3', '4', '5', '6'],
      correct_answer: '4',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Shapes',
    },
  ];
  const learningFile = approvedForPublication({
    id: 14,
    title: 'shapes-review.docx',
    file_type: 'fixed_questions',
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    topic_id: 'shapes',
    math_topic: 'Shapes',
    document_topic: 'Basic Addition, Subtraction, Shapes, and Place Value',
    subject: 'Mathematics',
    deleted_at: null,
    published: false,
    publish_status: 'staged',
  }, questions);

  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) return resultRows([learningFile]);
    if (sql.startsWith('select id, learning_file_id') && sql.includes('from public.questions')) return resultRows(questions);
    if (sql.startsWith('select lf.id') && sql.includes('from public.learning_files lf')) return emptyResult;
    if (sql.startsWith('update public.learning_files') && sql.includes('published = true')) {
      activatedParams = params;
      return resultRows([{ ...learningFile, published: true, publish_status: 'active' }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/publish/14', { method: 'POST' });

  assert.equal(response.status, 200);
  assert.deepEqual(activatedParams, [14, 1]);
  assert.equal(response.body.learningFile.topic_id, 'shapes');
});

test('question folder APIs expose system folders and legacy difficulty files by canonical folder', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const queryCalls = [];
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.learning_files lf')) {
      queryCalls.push({ sql, params });
      return resultRows([{
        id: 88,
        title: 'legacy-normal',
        file_name: 'legacy-normal.json',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
        file_type: 'fixed_questions',
        published: true,
        uploaded_at: '2026-06-01T00:00:00.000Z',
      }]);
    }
    return emptyResult;
  });

  const foldersResponse = await requestJson(baseUrl, '/api/question-folders');
  const filesResponse = await requestJson(baseUrl, '/api/learning-files/folder?grade_level=Grade%201&difficulty=Medium');

  assert.equal(foldersResponse.status, 200);
  assert.equal(foldersResponse.body.root.name, 'Questions');
  assert.equal(foldersResponse.body.grades.length, 6);
  assert.deepEqual(foldersResponse.body.grades[0].difficulties.map((item) => item.name), ['Easy', 'Normal', 'Difficult']);
  assert.equal(filesResponse.status, 200);
  assert.equal(filesResponse.body.path, 'Questions/Grade 1/Normal');
  assert.equal(filesResponse.body.files[0].difficulty, 'Normal');
  assert.equal(filesResponse.body.files[0].status, 'Active in Game');
  assert.deepEqual(queryCalls[0].params, ['Grade 1', 'Normal']);
  assert.match(queryCalls[0].sql, /normal/i);
});

test('learning file preview and rename endpoints preserve canonical folder metadata', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.learning_files') && params[0] === 77) {
      return resultRows([{
        id: 77,
        title: 'legacy-hard',
        file_name: 'legacy-hard.json',
        grade_level: 'Grade 2',
        difficulty: 'Difficult',
        math_topic: 'Problem Solving',
        file_type: 'fixed_questions',
        published: false,
        file_url: null,
      }]);
    }
    if (sql.startsWith('select id, published, publish_status from public.learning_files') && params[0] === 77) {
      return resultRows([{ id: 77, published: false, publish_status: 'staged' }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('set title = $1')) {
      return resultRows([{
        id: 77,
        title: params[0],
        file_name: 'legacy-hard.json',
        grade_level: 'Grade 2',
        difficulty: 'Difficult',
        math_topic: 'Problem Solving',
        file_type: 'fixed_questions',
        published: false,
      }]);
    }
    return emptyResult;
  });

  const previewResponse = await requestJson(baseUrl, '/api/learning-files/77/preview');
  const renameResponse = await requestJson(baseUrl, '/api/learning-files/77/rename', {
    method: 'PUT',
    body: JSON.stringify({ title: 'renamed-hard' }),
  });

  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.body.file.difficulty, 'Difficult');
  assert.equal(previewResponse.body.file.folder_name, 'Questions/Grade 2/Difficult');
  assert.equal(renameResponse.status, 200);
  assert.equal(renameResponse.body.learningFile.title, 'renamed-hard');
  assert.equal(renameResponse.body.learningFile.difficulty, 'Difficult');
  assert.equal(renameResponse.body.learningFile.folder_name, 'Questions/Grade 2/Difficult');
});

test('lesson upload fails gracefully and persists a failed source record without OPENAI_API_KEY', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-upload-test-'));
  const tempPdf = path.join(tempDir, 'lesson.pdf');
  fs.writeFileSync(tempPdf, '%PDF-1.4\nLesson about basic addition');
  const priorKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  parsedPdfText = 'Addition combines quantities using counters.';
  nextUploadedFile = {
    path: tempPdf,
    originalname: 'lesson.pdf',
    mimetype: 'application/pdf',
    size: fs.statSync(tempPdf).size,
  };
  t.after(async () => {
    nextUploadedFile = null;
    parsedPdfText = '';
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf);
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let insertCalled = false;
  let failedStatusPersisted = false;
  setQueryHandler(async (sql) => {
    if (sql.startsWith('insert into public.learning_files')) {
      insertCalled = true;
      return resultRows([{ id: 303 }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes("generation_status = 'failed'")) {
      failedStatusPersisted = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/upload', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'missing-key-generation' },
    body: JSON.stringify({
      title: 'Addition lesson',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'lesson',
      expected_question_count: '2',
    }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'Question AI is temporarily unavailable. Please contact the administrator.');
  assert.equal(response.body.code, 'QUESTION_AI_NOT_CONFIGURED');
  assert.equal(insertCalled, true);
  assert.equal(failedStatusPersisted, true);
});

test('a failed AI generation key cannot replay, while a deliberate new key creates one new attempt', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-retry-key-test-'));
  const uploadNames = ['first.pdf', 'replay.pdf', 'new-key.pdf'];
  const uploadPaths = uploadNames.map((name) => path.join(tempDir, name));
  const uploadsDir = path.join(__dirname, 'uploads');
  const uploadsBefore = new Set(fs.readdirSync(uploadsDir));
  for (const uploadPath of uploadPaths) fs.writeFileSync(uploadPath, '%PDF-1.4\nLesson about basic addition');
  const priorKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  parsedPdfText = 'Addition combines quantities using counters.';
  const records = [];
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
    if (sql.includes('generation_idempotency_key') && sql.startsWith('select')) {
      const [actorId, idempotencyKey] = params;
      return resultRows(records.filter((record) => record.uploaded_by === actorId && record.generation_idempotency_key === idempotencyKey));
    }
    if (sql.includes('generation_request_fingerprint') && sql.startsWith('select')) {
      const [actorId, fingerprint] = params;
      return resultRows(records.filter((record) => record.uploaded_by === actorId && record.generation_request_fingerprint === fingerprint && record.generation_status === 'generating'));
    }
    if (sql.startsWith('insert into public.learning_files')) {
      const record = {
        id: 600 + records.length,
        title: 'Addition lesson',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        file_type: 'lesson',
        source: 'lesson',
        uploaded_by: params[11],
        generation_idempotency_key: params[16],
        generation_request_fingerprint: params[17],
        generation_status: 'generating',
      };
      records.push(record);
      return resultRows([record]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes("generation_status = 'failed'")) {
      const record = records.find((item) => item.id === params[0]);
      record.generation_status = 'failed';
      return emptyResult;
    }
    return emptyResult;
  });
  t.after(async () => {
    nextUploadedFile = null;
    parsedPdfText = '';
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    for (const uploadPath of uploadPaths) {
      if (fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath);
    }
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    for (const entry of fs.readdirSync(uploadsDir)) {
      if (!uploadsBefore.has(entry) && uploadNames.some((name) => entry.endsWith(`_${name}`))) {
        const candidate = path.join(uploadsDir, entry);
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      }
    }
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const body = {
    title: 'Addition lesson',
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: 'Basic Addition',
    file_type: 'lesson',
    expected_question_count: '2',
  };
  const requestWithKey = async (pathIndex, idempotencyKey) => {
    nextUploadedFile = {
      path: uploadPaths[pathIndex],
      originalname: uploadNames[pathIndex],
      mimetype: 'application/pdf',
      size: fs.statSync(uploadPaths[pathIndex]).size,
    };
    return requestJson(baseUrl, '/api/learning-files/upload', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
  };

  const firstResponse = await requestWithKey(0, 'failed-attempt-key');
  const replayResponse = await requestWithKey(1, 'failed-attempt-key');
  const newAttemptResponse = await requestWithKey(2, 'deliberate-new-key');

  assert.equal(firstResponse.status, 503);
  assert.equal(replayResponse.status, 409);
  assert.equal(replayResponse.body.code, 'AI_GENERATION_RETRY_REQUIRED');
  assert.equal(newAttemptResponse.status, 503);
  assert.equal(records.length, 2);
});

test('lesson upload rejects malformed and oversized PDFs before a provider call', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-upload-safety-test-'));
  const malformedPdf = path.join(tempDir, 'malformed.pdf');
  const validPdf = path.join(tempDir, 'oversized.pdf');
  fs.writeFileSync(malformedPdf, 'not a PDF');
  fs.writeFileSync(validPdf, '%PDF-1.4\nLesson about basic addition');
  const originalFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async (url, options) => {
    if (url === 'https://api.openai.com/v1/responses') providerCalls += 1;
    return originalFetch(url, options);
  };
  t.after(async () => {
    nextUploadedFile = null;
    global.fetch = originalFetch;
    if (fs.existsSync(malformedPdf)) fs.unlinkSync(malformedPdf);
    if (fs.existsSync(validPdf)) fs.unlinkSync(validPdf);
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  nextUploadedFile = {
    path: malformedPdf,
    originalname: 'malformed.pdf',
    mimetype: 'application/pdf',
    size: fs.statSync(malformedPdf).size,
  };
  const malformedResponse = await requestJson(baseUrl, '/api/learning-files/upload', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Malformed lesson',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'lesson',
      expected_question_count: '2',
    }),
  });

  nextUploadedFile = {
    path: validPdf,
    originalname: 'oversized.pdf',
    mimetype: 'application/pdf',
    size: (30 * 1024 * 1024) + 1,
  };
  const oversizedResponse = await requestJson(baseUrl, '/api/learning-files/upload', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Oversized lesson',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'lesson',
      expected_question_count: '2',
    }),
  });

  assert.equal(malformedResponse.status, 400);
  assert.equal(oversizedResponse.status, 413);
  assert.equal(oversizedResponse.body.code, 'LESSON_FILE_TOO_LARGE');
  assert.equal(providerCalls, 0);
});

test('lesson upload rejects unsupported, empty, and unreadable PDFs without readying a generated set or calling the provider', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-upload-content-safety-test-'));
  const unsupportedFile = path.join(tempDir, 'lesson.txt');
  const emptyPdf = path.join(tempDir, 'empty.pdf');
  const unreadablePdf = path.join(tempDir, 'unreadable.pdf');
  const uploadsDir = path.join(__dirname, 'uploads');
  const uploadsBefore = new Set(fs.readdirSync(uploadsDir));
  fs.writeFileSync(unsupportedFile, 'not a lesson PDF');
  fs.writeFileSync(emptyPdf, '%PDF-1.4\nNo extracted lesson content');
  fs.writeFileSync(unreadablePdf, '%PDF-1.4\nUnreadable lesson content');
  const priorKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'server-test-key';
  let providerCalls = 0;
  let readyForReview = false;
  global.fetch = async (url, options) => {
    if (url === 'https://api.openai.com/v1/responses') providerCalls += 1;
    return originalFetch(url, options);
  };
  setQueryHandler(async (sql) => {
    if (sql.startsWith('insert into public.learning_files')) return resultRows([{ id: 701 }]);
    if (sql.startsWith('update public.learning_files') && sql.includes("generation_status = 'ready_for_review'")) {
      readyForReview = true;
    }
    return emptyResult;
  });
  t.after(async () => {
    nextUploadedFile = null;
    parsedPdfText = '';
    pdfParseFailure = null;
    global.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    for (const sourcePath of [unsupportedFile, emptyPdf, unreadablePdf]) {
      if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
    }
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    for (const entry of fs.readdirSync(uploadsDir)) {
      if (!uploadsBefore.has(entry) && ['empty.pdf', 'unreadable.pdf'].some((name) => entry.endsWith(`_${name}`))) {
        const candidate = path.join(uploadsDir, entry);
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      }
    }
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const upload = async ({ filePath, originalname, mimetype, idempotencyKey }) => {
    nextUploadedFile = {
      path: filePath,
      originalname,
      mimetype,
      size: fs.statSync(filePath).size,
    };
    return requestJson(baseUrl, '/api/learning-files/upload', {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      body: JSON.stringify({
        title: 'Lesson safety test',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        file_type: 'lesson',
        expected_question_count: '2',
      }),
    });
  };

  const unsupportedResponse = await upload({
    filePath: unsupportedFile,
    originalname: 'lesson.txt',
    mimetype: 'text/plain',
  });
  parsedPdfText = '';
  const emptyResponse = await upload({
    filePath: emptyPdf,
    originalname: 'empty.pdf',
    mimetype: 'application/pdf',
    idempotencyKey: 'empty-lesson-request',
  });
  pdfParseFailure = new Error('unreadable PDF fixture');
  const unreadableResponse = await upload({
    filePath: unreadablePdf,
    originalname: 'unreadable.pdf',
    mimetype: 'application/pdf',
    idempotencyKey: 'unreadable-lesson-request',
  });

  assert.equal(unsupportedResponse.status, 400);
  assert.equal(emptyResponse.status, 422);
  assert.equal(emptyResponse.body.code, 'QUESTION_AI_EMPTY_LESSON');
  assert.equal(unreadableResponse.status, 422);
  assert.equal(unreadableResponse.body.code, 'QUESTION_AI_EMPTY_LESSON');
  assert.equal(providerCalls, 0);
  assert.equal(readyForReview, false);
});

test('lesson upload generates exactly the requested staged questions through the server-side OpenAI call', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-upload-success-test-'));
  const uploadName = `lesson-success-${Date.now()}.pdf`;
  const tempPdf = path.join(tempDir, uploadName);
  const uploadsDir = path.join(__dirname, 'uploads');
  const uploadsBefore = new Set(fs.readdirSync(uploadsDir));
  fs.writeFileSync(tempPdf, '%PDF-1.4\nLesson about basic addition');
  const priorKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'server-test-key';
  parsedPdfText = 'Addition combines quantities using counters.';
  nextUploadedFile = {
    path: tempPdf,
    originalname: uploadName,
    mimetype: 'application/pdf',
    size: fs.statSync(tempPdf).size,
  };
  t.after(async () => {
    nextUploadedFile = null;
    parsedPdfText = '';
    global.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf);
    for (const entry of fs.readdirSync(uploadsDir)) {
      const candidate = path.join(uploadsDir, entry);
      if (!uploadsBefore.has(entry) && entry.endsWith(`_${uploadName}`) && fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    }
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let openAiRequest = null;
  const storedQuestionParams = [];
  let learningFileInsertParams = null;
  global.fetch = async (url, options) => {
    if (url === 'https://api.openai.com/v1/responses') {
      openAiRequest = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({
          questions: [
            { question: 'What is 1 + 1?', options: ['1', '2', '3', '4'], correct_answer: '2' },
            { question: 'What is 2 + 1?', options: ['2', '3', '4', '5'], correct_answer: '3' },
          ],
        }) }),
      };
    }
    return originalFetch(url, options);
  };
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('insert into public.learning_files')) {
      learningFileInsertParams = params;
      return resultRows([{
        id: 202,
        title: 'Addition lesson',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        topic_id: 'basic_addition',
        math_topic: 'Basic Addition',
        file_type: 'lesson',
        published: false,
      }]);
    }
    if (sql.startsWith('insert into public.questions')) {
      storedQuestionParams.push(params);
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/upload', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'successful-generation' },
    body: JSON.stringify({
      title: 'Addition lesson',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      topic_id: 'basic_addition',
      math_topic: 'Basic Addition',
      file_type: 'lesson',
      expected_question_count: '2',
      uploaded_by: '999',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(openAiRequest.model, 'gpt-5-mini');
  assert.equal(openAiRequest.text.format.schema.properties.questions.maxItems, 2);
  assert.equal(response.body.learningFile.question_count, 2);
  assert.equal(response.body.learningFile.published, false);
  assert.equal(storedQuestionParams.length, 2);
  assert.equal(storedQuestionParams.every((params) => params.includes('basic_addition')), true);
  assert.equal(learningFileInsertParams.includes('basic_addition'), true);
  assert.equal(learningFileInsertParams[6], 'basic_addition');
  assert.equal(learningFileInsertParams[7], null);
  assert.equal(learningFileInsertParams[10], 'lesson');
  assert.equal(learningFileInsertParams[11], 1);
});

test('lesson generation coalesces concurrent duplicate uploads and replays the completed idempotency key', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-idempotency-test-'));
  const uploadNames = ['lesson-a.pdf', 'lesson-b.pdf', 'lesson-replay.pdf', 'lesson-conflict.pdf'];
  const uploadPaths = uploadNames.map((name) => path.join(tempDir, name));
  const uploadsDir = path.join(__dirname, 'uploads');
  const uploadsBefore = new Set(fs.readdirSync(uploadsDir));
  for (const uploadPath of uploadPaths) fs.writeFileSync(uploadPath, '%PDF-1.4\nLesson about basic addition');
  const priorKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'server-test-key';
  parsedPdfText = 'Addition combines quantities using counters.';
  queuedUploadedFiles = uploadPaths.slice(0, 2).map((uploadPath, index) => ({
    path: uploadPath,
    originalname: uploadNames[index],
    mimetype: 'application/pdf',
    size: fs.statSync(uploadPath).size,
  }));

  t.after(async () => {
    nextUploadedFile = null;
    queuedUploadedFiles = [];
    parsedPdfText = '';
    global.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    for (const uploadPath of uploadPaths) {
      if (fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath);
    }
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    for (const entry of fs.readdirSync(uploadsDir)) {
      if (!uploadsBefore.has(entry) && uploadNames.some((name) => entry.endsWith(`_${name}`))) {
        const candidate = path.join(uploadsDir, entry);
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      }
    }
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const records = [];
  let providerCalls = 0;
  let releaseFirstProvider;
  let notifyFirstProviderStarted;
  const firstProviderStarted = new Promise((resolve) => {
    notifyFirstProviderStarted = resolve;
  });
  global.fetch = async (url, requestOptions) => {
    if (url !== 'https://api.openai.com/v1/responses') return originalFetch(url, requestOptions);
    providerCalls += 1;
    if (providerCalls === 1) {
      notifyFirstProviderStarted();
      return new Promise((resolve) => {
        releaseFirstProvider = () => resolve({
          ok: true,
          json: async () => ({ output_text: JSON.stringify({
            questions: [
              { question: 'What is 1 + 1?', options: ['1', '2', '3', '4'], correct_answer: '2' },
              { question: 'What is 2 + 1?', options: ['2', '3', '4', '5'], correct_answer: '3' },
            ],
          }) }),
        });
      });
    }
    return {
      ok: true,
      json: async () => ({ output_text: JSON.stringify({
        questions: [
          { question: 'What is 1 + 1?', options: ['1', '2', '3', '4'], correct_answer: '2' },
          { question: 'What is 2 + 1?', options: ['2', '3', '4', '5'], correct_answer: '3' },
        ],
      }) }),
    };
  };
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
    if (sql.includes('generation_idempotency_key') && sql.startsWith('select')) {
      const [actorId, key] = params;
      return resultRows(records.filter((record) => record.uploaded_by === actorId && record.generation_idempotency_key === key));
    }
    if (sql.includes('generation_request_fingerprint') && sql.startsWith('select')) {
      const [actorId, fingerprint] = params;
      return resultRows(records.filter((record) => record.uploaded_by === actorId && record.generation_request_fingerprint === fingerprint && record.generation_status === 'generating'));
    }
    if (sql.startsWith('insert into public.learning_files')) {
      const record = {
        id: 800 + records.length,
        title: 'Addition lesson',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        file_type: 'lesson',
        source: 'lesson',
        published: false,
        uploaded_by: params[11],
        generation_status: 'generating',
        generation_idempotency_key: params[16],
        generation_request_fingerprint: params[17],
      };
      records.push(record);
      return resultRows([record]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes("generation_status = 'ready_for_review'")) {
      const record = records.find((item) => item.id === params[0]);
      record.generation_status = 'ready_for_review';
      return resultRows([record]);
    }
    if (sql.startsWith('insert into public.questions')) return emptyResult;
    return emptyResult;
  });

  const body = {
    title: 'Addition lesson',
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: 'Basic Addition',
    file_type: 'lesson',
    expected_question_count: '2',
  };
  const options = {
    method: 'POST',
    headers: { 'Idempotency-Key': 'same-logical-generation' },
    body: JSON.stringify(body),
  };
  const firstRequest = requestJson(baseUrl, '/api/learning-files/upload', options);
  await Promise.race([
    firstProviderStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('First provider call did not start.')), 2_000)),
  ]);
  const secondRequest = requestJson(baseUrl, '/api/learning-files/upload', options);
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseFirstProvider();
  const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);

  assert.equal(firstResponse.status, 201);
  assert.ok([200, 202].includes(secondResponse.status));
  assert.equal(providerCalls, 1);
  assert.equal(records.length, 1);

  nextUploadedFile = {
    path: uploadPaths[2],
    originalname: uploadNames[2],
    mimetype: 'application/pdf',
    size: fs.statSync(uploadPaths[2]).size,
  };
  const replayResponse = await requestJson(baseUrl, '/api/learning-files/upload', options);
  assert.equal(replayResponse.status, 200);
  assert.equal(providerCalls, 1);
  assert.equal(records.length, 1);

  nextUploadedFile = {
    path: uploadPaths[3],
    originalname: uploadNames[3],
    mimetype: 'application/pdf',
    size: fs.statSync(uploadPaths[3]).size,
  };
  const topicCompatibilityResponse = await requestJson(baseUrl, '/api/learning-files/upload', {
    ...options,
    body: JSON.stringify({ ...body, math_topic: 'Shapes' }),
  });
  assert.equal(topicCompatibilityResponse.status, 200);
  assert.equal(providerCalls, 1);
  assert.equal(records.length, 1);
});

test('relationship lookup returns the authoritative game Student ID for linked students', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let relationshipSql = '';
  setQueryHandler(async (sql) => {
    if (sql.includes('from public.teacher_student_relationships')) {
      relationshipSql = sql;
      return resultRows([{
        id: 12,
        student_id: 99,
        student_name: 'Linked Student',
        student_email: 'student@example.com',
        game_student_id: '001234',
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/teacher-student-relationships?teacherId=8');

  assert.equal(response.status, 200);
  assert.match(relationshipSql, /s\.game_student_id/);
  assert.equal(response.body.relationships[0].game_student_id, '001234');
});

test('learning file question preview returns staged structured questions without publishing them', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1') && params[0] === 77) {
      return resultRows([{
        id: 77,
        title: 'Basic Addition Review',
        file_name: 'basic-addition.docx',
        file_url: '/uploads/basic-addition.docx',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        requested_question_count: null,
        generation_status: 'not_applicable',
        publish_status: 'pending',
        source: 'fixed',
      }]);
    }
    if (sql.includes('from public.questions') && params[0] === 77) {
      return resultRows([{
        id: 101,
        learning_file_id: 77,
        question: 'What is 2 + 3?',
        options: ['4', '5', '6'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        source: 'ai',
        published: false,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/77/questions');

  assert.equal(response.status, 200);
  assert.equal(response.body.questions.length, 1);
  assert.equal(response.body.questions[0].question, 'What is 2 + 3?');
  assert.equal(response.body.questions[0].published, false);
  assert.equal(response.body.file.title, 'Basic Addition Review');
  assert.equal(response.body.file.file_url, '/uploads/basic-addition.docx');
  assert.equal(response.body.file.lifecycle.label, 'Pending');
  assert.equal(response.body.validation.is_valid, false);
  assert.match(response.body.review_fingerprint || '', /^[a-f0-9]{64}$/);
});

test('Fixed Question upload accepts a Grade and Difficulty scope with no Topic metadata', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-question-scope-test-'));
  const uploadName = `selected-shapes-${Date.now()}.docx`;
  const tempDocx = path.join(tempDir, uploadName);
  const sourceDocx = path.join(__dirname, '../docs/teacher-fixed-question-documents/grade1-easy-basic-addition-set-b.docx');
  const uploadsDir = path.join(__dirname, 'uploads');
  const uploadsBefore = new Set(fs.readdirSync(uploadsDir));
  fs.copyFileSync(sourceDocx, tempDocx);
  nextUploadedFile = {
    path: tempDocx,
    originalname: uploadName,
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: fs.statSync(tempDocx).size,
  };
  const storedQuestionParams = [];
  let learningFileInsertParams = null;
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('insert into public.learning_files')) {
      learningFileInsertParams = params;
      return resultRows([{
        id: 350,
        title: 'Grade 1 Easy Mixed Set',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        topic_id: null,
        math_topic: null,
        file_type: 'fixed_questions',
        approval_status: 'review_required',
        published: false,
      }]);
    }
    if (sql.startsWith('insert into public.questions')) {
      storedQuestionParams.push(params);
      return emptyResult;
    }
    return emptyResult;
  });
  t.after(async () => {
    nextUploadedFile = null;
    parsedPdfText = '';
    setQueryHandler(async () => emptyResult);
    if (fs.existsSync(tempDocx)) fs.unlinkSync(tempDocx);
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    for (const entry of fs.readdirSync(uploadsDir)) {
      const candidate = path.join(uploadsDir, entry);
      if (!uploadsBefore.has(entry) && entry.endsWith(`_${uploadName}`) && fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
    await close(server);
  });

  const response = await requestJson(baseUrl, '/api/learning-files/upload', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Grade 1 Easy Mixed Set',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      file_type: 'fixed_questions',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(learningFileInsertParams[5], null);
  assert.equal(learningFileInsertParams[6], null);
  assert.equal(storedQuestionParams.length, 5);
  assert.deepEqual(storedQuestionParams.map((params) => params[7]), [null, null, null, null, null]);
});

test('approval rejects a question set that is no longer review-required', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let approvalUpdateAttempted = false;
  setQueryHandler(async (sql) => {
    if (sql === 'begin' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      return resultRows([{
        id: 360,
        title: 'Already approved set',
        file_type: 'fixed_questions',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        topic_id: 'basic_addition',
        math_topic: 'Basic Addition',
        approval_status: 'approved',
        published: false,
        publish_status: 'staged',
      }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes("approval_status = 'approved'")) approvalUpdateAttempted = true;
    return emptyResult;
  });
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const response = await requestJson(baseUrl, '/api/learning-files/360/approve', { method: 'POST' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'QUESTION_SET_REVIEW_STATUS_INVALID');
  assert.equal(approvalUpdateAttempted, false);
});

test('Godot question endpoint routes by Grade and Difficulty when Topic is omitted or supplied as compatibility metadata', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const queryCalls = [];
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.learning_files') || sql.includes('from public.questions q')) {
      queryCalls.push(params);
      return resultRows([]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=Grade%201&difficulty=Easy');

  assert.equal(response.status, 200);
  assert.equal(queryCalls.every((params) => !params.includes('basic_addition') && !params.includes('Basic Addition')), true);
  assert.deepEqual(response.body.scope, {
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    question_set_id: null,
  });
});

test('Godot question endpoint returns one active Grade and Difficulty set while preserving optional traceability metadata', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const queryCalls = [];
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.questions q')) {
      queryCalls.push({ sql, params });
      return resultRows([{
        id: 501,
        learning_file_id: 83,
        question: 'What is 2 + 3?',
        options: ['4', '5', '6', '7'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        topic_id: 'basic_addition',
        math_topic: 'Basic Addition',
        source: 'fixed',
        published: true,
      }]);
    }
    if (sql.includes('from public.learning_files')) {
      queryCalls.push({ sql, params });
      return resultRows([{
        id: 83,
        title: 'First Bandit Basics',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        topic_id: 'basic_addition',
        math_topic: 'Basic Addition',
        file_type: 'fixed_questions',
        published: true,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=1&difficulty=Easy&topic_id=basic_addition');

  assert.equal(response.status, 200);
  assert.equal(queryCalls.length, 3);
  assert.deepEqual(queryCalls[0].params, ['Grade 1', 'Easy']);
  assert.deepEqual(queryCalls.slice(1).map((call) => call.params), [[83], [83]]);
  assert.equal(queryCalls.every((call) => !call.params.includes('basic_addition')), true);
  assert.equal(response.body.learning_files[0].topic_id, 'basic_addition');
  assert.equal(response.body.learning_files[0].math_topic, 'Basic Addition');
  assert.equal(response.body.questions[0].topic_id, 'basic_addition');
  assert.equal(response.body.questions[0].learning_file_id, 83);
  assert.deepEqual(response.body.scope, {
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    question_set_id: 83,
  });
});

test('Godot question endpoint rejects a scope missing Grade or Difficulty without widening the query', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let queryCount = 0;
  setQueryHandler(async () => {
    queryCount += 1;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=Grade%201');

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'QUESTION_SCOPE_REQUIRED');
  assert.equal(queryCount, 0);
});

test('Godot question endpoint remains available without a Lesson Manager session', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async () => emptyResult);
  const response = await fetch(`${baseUrl}/api/game/questions?grade_level=Grade%201&difficulty=Easy&math_topic=Basic%20Addition`);

  assert.equal(response.status, 200);
});

test('Godot question endpoint maps legacy Medium and Hard requests to canonical Normal and Difficult scopes', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const queryCalls = [];
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.learning_files') || sql.includes('from public.questions q')) {
      queryCalls.push({ sql, params });
      return resultRows([]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=Grade%201&difficulty=Medium&topic=Addition');

  assert.equal(response.status, 200);
  assert.deepEqual(queryCalls[0].params, ['Grade 1', 'Normal']);
  assert.equal(queryCalls.length, 1);
  assert.match(queryCalls[0].sql, /normal/i);
});

test('Godot question endpoint normalizes numeric grade aliases without Topic routing', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  const queryCalls = [];
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.learning_files') || sql.includes('from public.questions q')) {
      queryCalls.push({ sql, params });
      return resultRows([]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=1&difficulty=Easy&topic=Basic%20Addition');

  assert.equal(response.status, 200);
  assert.deepEqual(queryCalls[0].params, ['Grade 1', 'Easy']);
  assert.equal(queryCalls.length, 1);
  assert.match(queryCalls[0].sql, /limit 2/);
});

test('Godot question endpoint can serve a Grade and Difficulty active legacy row without Topic metadata', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.includes('from public.learning_files')) {
      return resultRows([{
        id: 42,
        title: 'easy',
        file_name: 'restored-questions-easy.docx',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: null,
        file_type: 'fixed_questions',
        source: 'restored_import',
        published: true,
      }]);
    }
    if (sql.includes('from public.questions q')) {
      return resultRows([{
        id: 91,
        learning_file_id: 42,
        question: '5 + 2 = ?',
        options: ['8', '7', '6', '9'],
        correct_answer: '7',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: null,
        source: 'restored_import',
        published: true,
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=Grade%201&difficulty=Easy&topic=Basic%20Addition');

  assert.equal(response.status, 200);
  assert.equal(response.body.questions.length, 1);
  assert.equal(response.body.questions[0].question_set_id, 42);
});

test('Godot question endpoint fails closed when legacy active sets make a Grade and Difficulty pool ambiguous', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let questionQueryStarted = false;
  setQueryHandler(async (sql) => {
    if (sql.includes('from public.learning_files')) {
      return resultRows([
        { id: 41, grade_level: 'Grade 1', difficulty: 'Easy', math_topic: 'Addition' },
        { id: 42, grade_level: 'Grade 1', difficulty: 'Easy', math_topic: 'Shapes' },
      ]);
    }
    if (sql.includes('from public.questions q')) questionQueryStarted = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=Grade%201&difficulty=Easy');

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'QUESTION_POOL_AMBIGUOUS');
  assert.equal(questionQueryStarted, false);
});

test('Lesson and Question Manager receives restored-import learning files through its existing endpoint', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.includes('from public.learning_files lf') && sql.includes('where lf.deleted_at is null')) {
      return resultRows([{
        id: 42,
        title: 'easy',
        file_name: 'restored-questions-easy.docx',
        file_url: '/uploads/restored-questions-easy.docx',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: null,
        file_type: 'fixed_questions',
        source: 'restored_import',
        published: false,
        folder_name: null,
        uploaded_by_name: 'Unknown',
      }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files');

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].id, 42);
  assert.equal(response.body[0].source, 'restored_import');
  assert.equal(response.body[0].folder_name, 'Questions/Grade 1/Easy');
  assert.equal(response.body[0].difficulty, 'Easy');
});

test('Lesson and Question Manager storage summary uses backend-managed bytes without inventing a quota', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let storageSql = '';
  setQueryHandler(async (sql) => {
    if (sql.includes('source_file_bytes') && sql.includes('question_content_bytes')) {
      storageSql = sql;
      return resultRows([{ source_file_bytes: '480', question_content_bytes: '121' }]);
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/storage-summary');

  assert.equal(response.status, 200);
  assert.equal(response.body.used_bytes, 601);
  assert.equal(response.body.source_file_bytes, 480);
  assert.equal(response.body.question_content_bytes, 121);
  assert.equal(response.body.quota_bytes, undefined);
  assert.match(storageSql, /jsonb_build_object/);
});

test('active question sets cannot be moved to trash before a replacement is published', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let destructiveUpdateCalled = false;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.learning_files where id = $1')) {
      return resultRows([{
        id: Number(params[0]),
        title: 'Active Addition Set',
        published: true,
        publish_status: 'active',
        deleted_at: null,
      }]);
    }
    if (sql.startsWith('update public.learning_files') && sql.includes('deleted_at')) {
      destructiveUpdateCalled = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/44', { method: 'DELETE' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED');
  assert.match(response.body.error, /active.*remove.*game/i);
  assert.equal(destructiveUpdateCalled, false);
});

test('active question sets cannot be permanently deleted', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let destructiveDeleteCalled = false;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.learning_files where id = $1') && sql.includes('deleted_at is not null')) {
      return resultRows([{
        id: Number(params[0]),
        title: 'Active Trashed Set',
        published: true,
        publish_status: 'active',
        deleted_at: '2026-09-01T00:00:00.000Z',
      }]);
    }
    if (sql.startsWith('delete from public.questions') || sql.startsWith('delete from public.learning_files')) {
      destructiveDeleteCalled = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/44/permanent', { method: 'DELETE' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED');
  assert.match(response.body.error, /remove from game/i);
  assert.equal(destructiveDeleteCalled, false);
});

test('emptying trash validates every selected set before permanently deleting any of them', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let destructiveDeleteCalled = false;
  let rollbackCalled = false;
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin') return emptyResult;
    if (sql === 'rollback') {
      rollbackCalled = true;
      return emptyResult;
    }
    if (sql.includes('from public.learning_files') && sql.includes('id = any($1)') && sql.includes('for update')) {
      assert.deepEqual(params, [[44, 45]]);
      return resultRows([
        { id: 44, title: 'Replaced Set', published: false, publish_status: 'superseded', deleted_at: '2026-09-01T00:00:00.000Z' },
        { id: 45, title: 'Historical Set', published: false, publish_status: 'staged', deleted_at: '2026-09-01T00:00:00.000Z' },
      ]);
    }
    if (sql.includes('from public.game_results') && sql.includes('question_set_id = any($1)')) {
      assert.deepEqual(params, [[44, 45]]);
      return resultRows([{ question_set_id: 45 }]);
    }
    if (sql.startsWith('delete from public.questions') || sql.startsWith('delete from public.learning_files')) {
      destructiveDeleteCalled = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/trash', {
    method: 'DELETE',
    body: JSON.stringify({ file_ids: [44, 45] }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'QUESTION_SET_HISTORY_PREVENTS_PERMANENT_DELETE');
  assert.deepEqual(response.body.blocked_file_ids, [45]);
  assert.equal(rollbackCalled, true);
  assert.equal(destructiveDeleteCalled, false);
});

test('emptying trash blocks every selected target when one is still active', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let destructiveDeleteCalled = false;
  setQueryHandler(async (sql) => {
    if (sql === 'begin' || sql === 'rollback') return emptyResult;
    if (sql.includes('from public.learning_files') && sql.includes('id = any($1)') && sql.includes('for update')) {
      return resultRows([
        { id: 44, title: 'Active Set', published: true, publish_status: 'active', deleted_at: '2026-09-01T00:00:00.000Z' },
        { id: 45, title: 'Other Trashed Set', published: false, publish_status: 'staged', deleted_at: '2026-09-01T00:00:00.000Z' },
      ]);
    }
    if (sql.startsWith('delete from public.questions') || sql.startsWith('delete from public.learning_files')) {
      destructiveDeleteCalled = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/trash', {
    method: 'DELETE',
    body: JSON.stringify({ file_ids: [44, 45] }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED');
  assert.deepEqual(response.body.blocked_file_ids, [44]);
  assert.equal(destructiveDeleteCalled, false);
});

test('historically referenced question sets cannot be permanently deleted', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let destructiveDeleteCalled = false;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select * from public.learning_files where id = $1') && sql.includes('deleted_at is not null')) {
      return resultRows([{
        id: Number(params[0]),
        title: 'Replaced Addition Set',
        file_url: '/uploads/replaced-addition.json',
        published: false,
        publish_status: 'superseded',
        deleted_at: '2026-08-16T00:00:00.000Z',
      }]);
    }
    if (sql.startsWith('select 1 from public.game_results where question_set_id = $1')) {
      assert.deepEqual(params, [44]);
      return resultRows([{ referenced: 1 }]);
    }
    if (sql.startsWith('delete from public.questions') || sql.startsWith('delete from public.learning_files')) {
      destructiveDeleteCalled = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/44/permanent', { method: 'DELETE' });

  assert.equal(response.status, 409);
  assert.match(response.body.error, /historical.*results/i);
  assert.equal(destructiveDeleteCalled, false);
});

test('a folder with an active question set cannot be permanently deleted', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let destructiveDeleteCalled = false;
  setQueryHandler(async (sql) => {
    if (sql.includes('from public.learning_files') && sql.includes('folder_id = $1') && sql.includes('publish_status = \'active\'')) {
      return resultRows([{
        id: 71,
        title: 'Active Folder Set',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        published: true,
        publish_status: 'active',
      }]);
    }
    if (sql.startsWith('delete from public.questions') || sql.startsWith('delete from public.learning_files') || sql.startsWith('delete from public.folders')) {
      destructiveDeleteCalled = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/folders/13/permanent', { method: 'DELETE' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED');
  assert.equal(response.body.blocked_question_set.id, 71);
  assert.equal(destructiveDeleteCalled, false);
});

test('a folder with historically referenced trashed question sets cannot be permanently deleted', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let destructiveDeleteCalled = false;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select 1 as active_question_set from public.learning_files')) return emptyResult;
    if (sql.includes('from public.game_results gr') && sql.includes('question_set_id')) {
      assert.deepEqual(params, [13]);
      return resultRows([{ referenced: 1 }]);
    }
    if (sql.startsWith('delete from public.questions') || sql.startsWith('delete from public.learning_files') || sql.startsWith('delete from public.folders')) {
      destructiveDeleteCalled = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/folders/13/permanent', { method: 'DELETE' });

  assert.equal(response.status, 409);
  assert.match(response.body.error, /historical.*results/i);
  assert.equal(destructiveDeleteCalled, false);
});

test('legacy folder deletion cannot unpublish an active question set', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let destructiveUpdateCalled = false;
  setQueryHandler(async (sql, params) => {
    if (sql.includes('from public.learning_files') && sql.includes('folder_id = $1')) {
      return resultRows([{
        id: 71,
        title: 'Active Folder Set',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        published: true,
        publish_status: 'active',
      }]);
    }
    if (sql.startsWith('update public.folders') || sql.startsWith('update public.learning_files')) {
      destructiveUpdateCalled = true;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/folders/13', { method: 'DELETE' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED');
  assert.equal(response.body.blocked_question_set.id, 71);
  assert.equal(response.body.blocked_question_set.title, 'Active Folder Set');
  assert.match(response.body.error, /active.*remove.*game/i);
  assert.equal(destructiveUpdateCalled, false);
});

test('moving a folder to Trash preserves a replaced question set lifecycle for delayed result traceability', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let lifecycleUpdate = null;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select 1 as active_question_set from public.learning_files')) return emptyResult;
    if (sql.startsWith('update public.folders set deleted_at')) return resultRows([{ id: 13 }]);
    if (sql.startsWith('update public.learning_files') && sql.includes('set deleted_at')) {
      lifecycleUpdate = { sql, params };
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/folders/13', { method: 'DELETE' });

  assert.equal(response.status, 200);
  assert.ok(lifecycleUpdate);
  assert.match(lifecycleUpdate.sql, /when lower\(coalesce\(publish_status, ''\)\) = 'superseded' then 'superseded'/i);
  assert.deepEqual(lifecycleUpdate.params, [13]);
});

test('Godot question responses record an active set fetch only after active questions are returned', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let fetchMetadataUpdate = null;
  setQueryHandler(async (sql, params) => {
    if (sql.startsWith('select id, grade_level, difficulty') && sql.includes('from public.learning_files')) {
      return resultRows([{ id: 71, grade_level: 'Grade 1', difficulty: 'Normal' }]);
    }
    if (sql.startsWith('select * from public.learning_files')) {
      return resultRows([{
        id: 71,
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
        file_type: 'fixed_questions',
        source: 'fixed',
        published: true,
      }]);
    }
    if (sql.startsWith('select q.*') && sql.includes('from public.questions q')) {
      return resultRows([{
        id: 901,
        learning_file_id: 71,
        question: 'What is 1 + 1?',
        options: ['1', '2', '3'],
        correct_answer: '2',
        grade_level: 'Grade 1',
        difficulty: 'Normal',
        math_topic: 'Addition',
        source: 'fixed',
      }]);
    }
    if (sql.startsWith('update public.learning_files set last_fetched_at')) {
      fetchMetadataUpdate = { sql, params };
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=1&difficulty=Normal&topic=Addition');

  assert.equal(response.status, 200);
  assert.equal(response.body.questions.length, 1);
  assert.deepEqual(fetchMetadataUpdate.params, [[71]]);
});

test('empty Godot question responses do not mark a question set as fetched', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let fetchMetadataUpdate = false;
  setQueryHandler(async (sql) => {
    if (sql.startsWith('select lf.*') || sql.startsWith('select q.*')) return emptyResult;
    if (sql.startsWith('update public.learning_files set last_fetched_at')) fetchMetadataUpdate = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=1&difficulty=Easy&topic=Basic%20Addition');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.questions, []);
  assert.deepEqual(response.body.availability, {
    available: false,
    code: 'QUESTION_POOL_EXHAUSTED',
    message: 'No published questions are available for this Grade and Difficulty yet.',
    expected_question_count: 5,
    available_question_count: 0,
  });
  assert.equal(fetchMetadataUpdate, false);
});

test('undersized Godot question pools are explicitly reported without discarding the remote questions', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  setQueryHandler(async (sql) => {
    if (sql.startsWith('select id, grade_level, difficulty') && sql.includes('from public.learning_files')) {
      return resultRows([{ id: 71, grade_level: 'Grade 1', difficulty: 'Easy' }]);
    }
    if (sql.startsWith('select * from public.learning_files')) {
      return resultRows([{ id: 71, title: 'Small Basic Addition', published: true }]);
    }
    if (sql.startsWith('select q.*') && sql.includes('from public.questions q')) {
      return resultRows([{
        id: 901,
        learning_file_id: 71,
        question: 'What is 1 + 1?',
        options: ['1', '2', '3', '4'],
        correct_answer: '2',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        source: 'fixed',
      }]);
    }
    if (sql.startsWith('update public.learning_files set last_fetched_at')) return emptyResult;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/game/questions?grade=1&difficulty=Easy&topic=Basic%20Addition');

  assert.equal(response.status, 200);
  assert.equal(response.body.questions.length, 1);
  assert.deepEqual(response.body.availability, {
    available: false,
    code: 'QUESTION_POOL_UNDERSIZED',
    message: 'The published question pool has fewer questions than this encounter requires.',
    expected_question_count: 5,
    available_question_count: 1,
  });
});

test('a reusable mixed-topic Lesson source creates Grade and Difficulty children without Topic routing or a live provider call', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sourceFileName = `lesson-source-${Date.now()}.pdf`;
  const sourceFilePath = path.join(__dirname, 'uploads', sourceFileName);
  const source = {
    id: 801,
    title: 'Reusable arithmetic lesson',
    file_name: 'reusable-arithmetic.pdf',
    file_url: `/uploads/${sourceFileName}`,
    file_size: 42,
    folder_id: null,
    source_content_fingerprint: 'a'.repeat(64),
    source_file_mime_type: 'application/pdf',
    content_role: 'lesson_source',
    deleted_at: null,
  };
  const priorKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  const generationRequests = [];
  const insertedChildren = [];
  fs.writeFileSync(sourceFilePath, '%PDF-1.4\nReusable arithmetic lesson');
  process.env.OPENAI_API_KEY = 'server-test-key';
  parsedPdfText = 'Use addition and subtraction examples from this lesson.';
  global.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const request = JSON.parse(options.body);
    generationRequests.push(request);
    return {
      ok: true,
      headers: { get: () => null },
      json: async () => ({ output_text: JSON.stringify({
        questions: [{
          question: 'What is 2 + 3?',
          options: ['4', '5', '6', '7'],
          correct_answer: '5',
        }],
      }) }),
    };
  };
  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes("content_role = 'lesson_source'")) {
      return resultRows([source]);
    }
    if (sql.startsWith('select lf.*, count(q.id)::integer as question_count')) return emptyResult;
    if (sql.startsWith('insert into public.learning_files')) {
      const child = {
        id: 900 + insertedChildren.length,
        title: params[0],
        file_name: params[1],
        file_url: params[2],
        grade_level: params[3],
        difficulty: params[4],
        math_topic: params[5],
        topic_id: params[6],
        requested_question_count: params[9],
        source_learning_file_id: params[11],
        source_content_fingerprint: params[12],
        generation_idempotency_key: params[13],
        generation_request_fingerprint: params[14],
        content_role: 'question_set',
      };
      insertedChildren.push(child);
      return resultRows([child]);
    }
    if (sql.startsWith('insert into public.questions')) return emptyResult;
    if (sql.startsWith('update public.learning_files') && sql.includes("generation_status = 'ready_for_review'")) {
      return resultRows([{ ...insertedChildren.at(-1), generation_status: 'ready_for_review' }]);
    }
    return emptyResult;
  });
  t.after(async () => {
    setQueryHandler(async () => emptyResult);
    parsedPdfText = '';
    global.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    if (fs.existsSync(sourceFilePath)) fs.unlinkSync(sourceFilePath);
    await close(server);
  });

  const addition = await requestJson(baseUrl, '/api/learning-files/lesson-sources/801/generate', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'lesson-source-addition-key-0001' },
    body: JSON.stringify({
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      expected_question_count: 1,
    }),
  });
  const subtraction = await requestJson(baseUrl, '/api/learning-files/lesson-sources/801/generate', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'lesson-source-subtract-key-0001' },
    body: JSON.stringify({
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      expected_question_count: 1,
    }),
  });

  assert.equal(addition.status, 201);
  assert.equal(subtraction.status, 201);
  assert.equal(insertedChildren.length, 2);
  assert.deepEqual(insertedChildren.map((child) => child.source_learning_file_id), [801, 801]);
  assert.deepEqual(insertedChildren.map((child) => child.math_topic), [null, null]);
  assert.deepEqual(insertedChildren.map((child) => child.topic_id), [null, null]);
  assert.equal(generationRequests.length, 2);
  assert.match(generationRequests[0].input[1].content[0].text, /Grade: Grade 1\.\nDifficulty: Easy\./);
  assert.doesNotMatch(generationRequests[0].input[1].content[0].text, /Topic ID:|Topic:/);
  assert.doesNotMatch(generationRequests[1].input[1].content[0].text, /Topic ID:|Topic:/);
});
