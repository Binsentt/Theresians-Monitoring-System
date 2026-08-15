const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
let parsedPdfText = '';

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    return (await queryHandler(compactSql(sql), params, sql)) || emptyResult;
  },
  connect: async () => ({
    query: async (sql, params = []) => (await queryHandler(compactSql(sql), params, sql)) || emptyResult,
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
const createMiddleware = () => (req, res, next) => next();
const multerStub = () => ({
  single: () => (req, res, next) => {
    if (nextUploadedFile) req.file = nextUploadedFile;
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
    verify: () => ({}),
  },
  multer: multerStub,
  'pdf-parse': async () => ({ text: parsedPdfText }),
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

test('question publishing replaces the active Godot bundle for one grade difficulty topic', async (t) => {
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

  setQueryHandler(async (sql, params) => {
    if (sql === 'begin' || sql === 'commit') return emptyResult;
    if (sql.startsWith('select * from public.learning_files') && sql.includes('where id = $1')) {
      return resultRows([{
        id: 77,
        title: 'addition-quiz',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
        subject: 'Mathematics',
        deleted_at: null,
      }]);
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
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/questions/publish/77', { method: 'POST' });

  assert.equal(response.status, 200);
  assert.deepEqual(unpublishedLearningFiles.params, ['Grade 1', 'Medium', 'Addition', 77]);
  assert.match(unpublishedLearningFiles.sql, /id <> \$4/);
  assert.deepEqual(unpublishedQuestions.params, ['Grade 1', 'Medium', 'Addition', 77]);
  assert.match(unpublishedQuestions.sql, /lf\.id <> \$4/);
  assert.deepEqual(publishedLearningFile.params, [77]);
  assert.deepEqual(publishedQuestions.params, [77]);
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
  assert.deepEqual(foldersResponse.body.grades[0].difficulties.map((item) => item.name), ['Easy', 'Medium', 'Hard']);
  assert.equal(filesResponse.status, 200);
  assert.equal(filesResponse.body.path, 'Questions/Grade 1/Medium');
  assert.equal(filesResponse.body.files[0].difficulty, 'Medium');
  assert.equal(filesResponse.body.files[0].status, 'Active in Game');
  assert.deepEqual(queryCalls[0].params, ['Grade 1', 'Medium']);
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
  assert.equal(previewResponse.body.file.difficulty, 'Hard');
  assert.equal(previewResponse.body.file.folder_name, 'Questions/Grade 2/Hard');
  assert.equal(renameResponse.status, 200);
  assert.equal(renameResponse.body.learningFile.title, 'renamed-hard');
  assert.equal(renameResponse.body.learningFile.difficulty, 'Hard');
  assert.equal(renameResponse.body.learningFile.folder_name, 'Questions/Grade 2/Hard');
});

test('lesson upload fails gracefully without OPENAI_API_KEY before it stores a staged record', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-upload-test-'));
  const tempPdf = path.join(tempDir, 'lesson.pdf');
  fs.writeFileSync(tempPdf, '%PDF-1.4\nLesson about basic addition');
  const priorKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  nextUploadedFile = {
    path: tempPdf,
    originalname: 'lesson.pdf',
    mimetype: 'application/pdf',
    size: fs.statSync(tempPdf).size,
  };
  t.after(async () => {
    nextUploadedFile = null;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf);
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    setQueryHandler(async () => emptyResult);
    await close(server);
  });

  let insertCalled = false;
  setQueryHandler(async (sql) => {
    if (sql.startsWith('insert into public.learning_files')) insertCalled = true;
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/upload', {
    method: 'POST',
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
  assert.equal(response.body.error, 'Question AI is not configured. Set OPENAI_API_KEY on the backend service.');
  assert.equal(insertCalled, false);
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
  let storedQuestions = 0;
  global.fetch = async (url, options) => {
    if (url === 'https://api.openai.com/v1/responses') {
      openAiRequest = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({
          questions: [
            { question: 'What is 1 + 1?', options: ['1', '2', '3'], correct_answer: '2' },
            { question: 'What is 2 + 1?', options: ['2', '3', '4'], correct_answer: '3' },
          ],
        }) }),
      };
    }
    return originalFetch(url, options);
  };
  setQueryHandler(async (sql) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return emptyResult;
    if (sql.startsWith('insert into public.learning_files')) {
      return resultRows([{
        id: 202,
        title: 'Addition lesson',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        file_type: 'lesson',
        published: false,
      }]);
    }
    if (sql.startsWith('insert into public.questions')) {
      storedQuestions += 1;
      return emptyResult;
    }
    return emptyResult;
  });

  const response = await requestJson(baseUrl, '/api/learning-files/upload', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Addition lesson',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'lesson',
      expected_question_count: '2',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(openAiRequest.model, 'gpt-5-mini');
  assert.equal(openAiRequest.text.format.schema.properties.questions.maxItems, 2);
  assert.equal(response.body.learningFile.question_count, 2);
  assert.equal(response.body.learningFile.published, false);
  assert.equal(storedQuestions, 2);
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
});

test('Godot question endpoint accepts grade and topic query aliases', async (t) => {
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

  const response = await requestJson(baseUrl, '/api/game/questions?grade=Grade%201&difficulty=Easy&topic=Basic%20Addition');

  assert.equal(response.status, 200);
  assert.deepEqual(queryCalls[0], ['Mathematics', 'Grade 1', 'Easy', 'Basic Addition']);
  assert.deepEqual(queryCalls[1], ['Mathematics', 'Grade 1', 'Easy', 'Basic Addition']);
});

test('Godot question endpoint maps Medium and Hard to legacy Normal and Difficult rows', async (t) => {
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
  assert.deepEqual(queryCalls[0].params, ['Mathematics', 'Grade 1', 'Medium', 'Addition']);
  assert.deepEqual(queryCalls[1].params, ['Mathematics', 'Grade 1', 'Medium', 'Addition']);
  assert.match(queryCalls[0].sql, /normal/i);
  assert.match(queryCalls[1].sql, /normal/i);
});

test('Godot question endpoint normalizes numeric grade aliases and scopes to one active source', async (t) => {
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
  assert.deepEqual(queryCalls[0].params, ['Mathematics', 'Grade 1', 'Easy', 'Basic Addition']);
  assert.deepEqual(queryCalls[1].params, ['Mathematics', 'Grade 1', 'Easy', 'Basic Addition']);
  assert.match(queryCalls[0].sql, /order by uploaded_at desc, id desc limit 1/);
  assert.match(queryCalls[1].sql, /order by active_lf\.uploaded_at desc, active_lf\.id desc limit 1/);
});

test('Godot question endpoint exposes a published restored-import record in the provider shape', async (t) => {
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

  const response = await requestJson(baseUrl, '/api/game/questions?grade=Grade%201');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.questions, [{
    id: 91,
    learning_file_id: 42,
    question: '5 + 2 = ?',
    options: ['8', '7', '6', '9'],
    correct_answer: '7',
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: null,
    source: 'restored_import',
  }]);
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
