const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixturePath = path.join(__dirname, 'test-fixtures', 'qa-upload-minimal.pptx');
const uploadsDir = path.join(__dirname, 'uploads');
const adminAccount = { id: 1, role: 'admin', is_archived: false, session_version: 0, name: 'QA Admin' };
const emptyResult = { rows: [] };
let learningFileInsertParams = null;

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mockPool = {
  query: async (sql, params = []) => {
    const normalizedSql = compactSql(sql);
    if (normalizedSql.startsWith('select 1 from public.accounts where parent_id = $1')) return emptyResult;
    if (normalizedSql.startsWith('select id from public.accounts where lower(role)')) return emptyResult;
    if (normalizedSql.includes('from public.accounts')) return { rows: [adminAccount] };
    if (normalizedSql.startsWith('insert into public.learning_files')) {
      learningFileInsertParams = params;
      return { rows: [{ id: 9001, title: params[0], file_name: params[1], file_url: params[2], grade_level: '', difficulty: null, file_type: 'lesson', source: 'lesson', content_role: 'lesson_source', generation_status: 'source_ready', publish_status: 'staged', requested_question_count: null, generated_at: null }] };
    }
    return emptyResult;
  },
  connect: async () => ({ query: async (sql, params = []) => mockPool.query(sql, params), release: () => {} }),
};

const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };
const serverDependencyStubs = {
  bcrypt: { compare: async () => false, hash: async (value) => value },
  cors: () => (req, res, next) => next(),
  jsonwebtoken: { verify: () => ({ userId: 1, sessionVersion: 0 }), sign: () => 'test-token' },
};
const originalLoad = Module._load;
Module._load = function loadWithIngressStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(serverDependencyStubs, request)) return serverDependencyStubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
process.env.AI_GENERATION_ENABLED = 'false';
let serverExports;
try { serverExports = require('./server'); } finally { Module._load = originalLoad; }
const { app } = serverExports;

const listen = () => new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
const close = (server) => new Promise((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });

test('actual Lesson Manager FormData reaches the upload route with a PPTX and stops before provider work', async (t) => {
  const server = await listen();
  const beforeUploads = new Set(fs.readdirSync(uploadsDir));
  learningFileInsertParams = null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-multipart-ingress-'));
  const tempPptx = path.join(tempDir, 'qa-upload-minimal.pptx');
  fs.copyFileSync(fixturePath, tempPptx);
  t.after(async () => {
    for (const entry of fs.readdirSync(uploadsDir)) if (!beforeUploads.has(entry)) fs.rmSync(path.join(uploadsDir, entry), { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    await close(server);
  });

  const form = new FormData();
  form.append('title', 'QA PPTX lesson');
  form.append('grade_level', 'Grade 1');
  form.append('difficulty', 'Easy');
  form.append('file_type', 'lesson');
  form.append('uploaded_by', '1');
  form.append('expected_question_count', '5');
  form.append('file', new Blob([fs.readFileSync(tempPptx)], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'qa-upload-minimal.pptx');

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/learning-files/upload`, {
    method: 'POST',
    headers: { Authorization: 'Bearer qa-upload-token', 'Idempotency-Key': 'qa-upload-ingress-20260913' },
    body: form,
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.lessonSource.content_role, 'lesson_source');
  assert.equal(body.lessonSource.file_name, 'qa-upload-minimal.pptx');
  assert.ok(Array.isArray(learningFileInsertParams));
  assert.equal(learningFileInsertParams[1], 'qa-upload-minimal.pptx');
  assert.equal(learningFileInsertParams[7], 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
});

test('a manually forced multipart header without a boundary returns a safe structured ingress error', async (t) => {
  const server = await listen();
  t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/learning-files/upload`, {
    method: 'POST',
    headers: { Authorization: 'Bearer qa-upload-token', 'Content-Type': 'multipart/form-data' },
    body: 'not-a-multipart-body',
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'LEARNING_FILE_UPLOAD_INVALID');
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
});
