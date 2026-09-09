const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const empty = { rows: [] };
let queryHandler = async () => empty;
let authenticatedAccount = null;
const compact = (sql) => String(sql?.text || sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const query = async (sql, params = []) => {
  const rawParams = Array.isArray(sql?.values) ? sql.values : params;
  const normalized = compact(sql);
  if (normalized.startsWith('select * from public.accounts where id = $1') && authenticatedAccount) {
    return { rows: [authenticatedAccount] };
  }
  return (await queryHandler(normalized, rawParams, sql)) || empty;
};
const mockPool = { query, connect: async () => ({ query, release() {} }) };
const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const middleware = () => (req, res, next) => next();
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => `hashed:${value}` };
  if (request === 'cors') return () => middleware();
  if (request === 'jsonwebtoken') return { sign: () => 'token', verify: () => ({ userId: 1, sessionVersion: 0 }) };
  if (request === 'multer') return () => ({ single: middleware, array: middleware, fields: middleware });
  if (request === 'pdf-parse') return async () => ({ text: '' });
  if (request === './emailDelivery.utils') return {
    buildSafeEmailLogDetails: () => ({}), getEmailSendTimeoutMs: () => 5,
    sendEmailWithProviders: async () => ({ sent: true, provider: 'test' }),
  };
  return originalLoad.call(this, request, parent, isMain);
};
let app;
try { ({ app } = require('./server')); } finally { Module._load = originalLoad; }

const validCreateChild = (studentId, firstName = 'Ava') => ({
  operation: 'create', first_name: firstName, last_name: 'Santos', middle_initial: 'M',
  grade_level: 'Grade 1', section: 'Amethyst', student_id: studentId,
});
const parentPayload = (children) => ({ name: 'Paula Parent', email: 'paula@example.com', role: 'parent', children });
const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const requestJson = async (base, body) => {
  const response = await fetch(`${base}/api/accounts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

test('Admin creates a Parent and one or multiple new children in one transaction', async (t) => {
  authenticatedAccount = { id: 1, name: 'Ada Admin', email: 'admin@example.com', role: 'admin', session_version: 0, is_archived: false };
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const ids of [['00123456'], ['00123456', '00123457']]) {
    const events = [];
    let nextStudentId = 40;
    queryHandler = async (sql, params) => {
      if (['begin', 'commit', 'rollback'].includes(sql)) { events.push(sql); return empty; }
      if (sql.includes('select 1 from public.accounts where parent_id')) return empty;
      if (sql.startsWith('insert into public.accounts') && !sql.includes('first_name')) {
        return { rows: [{ id: 19, name: params[0], email: params[1], role: params[3], parent_id: params[11], must_change_password: true }] };
      }
      if (sql.includes('game_student_id') && sql.includes('for update')) return empty;
      if (sql.startsWith('insert into public.accounts') && sql.includes('first_name')) {
        nextStudentId += 1;
        return { rows: [{ id: nextStudentId, name: params[0], first_name: params[1], last_name: params[2], middle_initial: params[3], grade_level: params[4], section: params[5], game_student_id: params.at(-1), role: 'student' }] };
      }
      if (sql.startsWith('select id from public.teacher_student_relationships')) return empty;
      if (sql.startsWith('insert into public.teacher_student_relationships')) return { rows: [{ id: 90 }] };
      return empty;
    };
    const response = await requestJson(base, parentPayload(ids.map((id, index) => validCreateChild(id, index ? 'Noah' : 'Ava'))));
    assert.equal(response.status, 201);
    assert.deepEqual(response.body.children.map((child) => child.game_student_id), ids);
    assert.deepEqual(events, ['begin', 'commit']);
  }
});

test('Admin Parent creation rejects duplicate child IDs before database writes', async (t) => {
  authenticatedAccount = { id: 1, role: 'admin', session_version: 0, is_archived: false };
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let writes = 0;
  queryHandler = async (sql) => { if (/^(insert|update|delete|begin)/.test(sql)) writes += 1; return empty; };
  const response = await requestJson(base, parentPayload([validCreateChild('00123456'), validCreateChild('00123456', 'Noah')]));
  assert.equal(response.status, 400);
  assert.match(response.body.error, /duplicate student id/i);
  assert.equal(writes, 0);
});

test('Admin links an unparented legacy Student but rejects an existing active Parent relationship', async (t) => {
  authenticatedAccount = { id: 1, role: 'admin', session_version: 0, is_archived: false };
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let activeParent = false;
  let studentInsertCount = 0;
  let parentInsertCount = 0;
  queryHandler = async (sql, params) => {
    if (sql.includes('select 1 from public.accounts where parent_id')) return empty;
    if (sql.startsWith('insert into public.accounts') && !sql.includes('first_name')) {
      parentInsertCount += 1;
      return { rows: [{ id: 19, name: params[0], email: params[1], role: params[3], parent_id: params[11] }] };
    }
    if (sql.startsWith('insert into public.accounts') && sql.includes('first_name')) studentInsertCount += 1;
    if (sql.includes('from public.accounts') && sql.includes('game_student_id') && sql.includes('for update')) {
      return { rows: [{ id: 44, name: 'Legacy Student', role: 'student', game_student_id: '001234', grade_level: 'Grade 1', section: 'Amethyst', is_archived: false }] };
    }
    if (sql.includes('active_parent_relationship')) return activeParent ? { rows: [{ active_parent_relationship: true }] } : empty;
    if (sql.startsWith('select id from public.teacher_student_relationships')) return empty;
    if (sql.startsWith('insert into public.teacher_student_relationships')) return { rows: [{ id: 91 }] };
    return empty;
  };
  const linked = await requestJson(base, parentPayload([{ operation: 'link', student_id: '001234' }]));
  assert.equal(linked.status, 201);
  assert.equal(linked.body.children[0].game_student_id, '001234');
  assert.equal(studentInsertCount, 0);
  activeParent = true;
  const rejected = await requestJson(base, { ...parentPayload([{ operation: 'link', student_id: '001234' }]), email: 'second@example.com' });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, 'This Student is already linked to a Parent account.');
  assert.equal(parentInsertCount, 1, 'the rejected second Parent must be detected before any Parent insert');
});

test('Admin Parent creation rolls back when a later child operation fails', async (t) => {
  authenticatedAccount = { id: 1, role: 'admin', session_version: 0, is_archived: false };
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const events = [];
  let childInsert = 0;
  queryHandler = async (sql, params) => {
    if (['begin', 'commit', 'rollback'].includes(sql)) { events.push(sql); return empty; }
    if (sql.includes('select 1 from public.accounts where parent_id')) return empty;
    if (sql.startsWith('insert into public.accounts') && !sql.includes('first_name')) return { rows: [{ id: 19, name: params[0], email: params[1], role: 'parent' }] };
    if (sql.includes('game_student_id') && sql.includes('for update')) return empty;
    if (sql.startsWith('insert into public.accounts') && sql.includes('first_name')) {
      childInsert += 1;
      if (childInsert === 2) throw new Error('simulated child write failure');
      return { rows: [{ id: 44, name: params[0], game_student_id: params.at(-1) }] };
    }
    if (sql.startsWith('select id from public.teacher_student_relationships')) return empty;
    if (sql.startsWith('insert into public.teacher_student_relationships')) return { rows: [{ id: 92 }] };
    return empty;
  };
  const response = await requestJson(base, parentPayload([validCreateChild('00123456'), validCreateChild('00123457', 'Noah')]));
  assert.equal(response.status, 500);
  assert.deepEqual(events, ['begin', 'rollback']);
});
