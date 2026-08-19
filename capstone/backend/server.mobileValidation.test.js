const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const emptyResult = { rows: [] };
let queryHandler = async () => emptyResult;
const accounts = {
  1: { id: 1, name: 'Admin User', email: 'admin@example.com', role: 'admin', is_archived: false, session_version: 0 },
  2: { id: 2, name: 'Parent User', email: 'parent@example.com', role: 'parent', is_archived: false, session_version: 0 },
};
const tokens = {
  'admin-token': { userId: 1, sessionVersion: 0 },
  'parent-token': { userId: 2, sessionVersion: 0 },
};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const query = async (sql, params = []) => {
  const compacted = compactSql(sql);
  if (compacted.startsWith('select * from public.accounts where id = $1')) {
    const account = accounts[Number(params[0])];
    return account ? { rows: [account] } : emptyResult;
  }
  return (await queryHandler(compacted, params, sql)) || emptyResult;
};
const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query } };

const passthrough = () => (req, res, next) => next();
const originalLoad = Module._load;
Module._load = function loadWithServerStubs(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => `hashed:${value}` };
  if (request === 'cors') return () => passthrough();
  if (request === 'jsonwebtoken') return { sign: () => 'token', verify: (token) => tokens[token] || {} };
  if (request === 'multer') return () => ({ single: passthrough, array: passthrough, fields: passthrough });
  if (request === 'pdf-parse') return async () => ({ text: '' });
  return originalLoad.call(this, request, parent, isMain);
};
let app;
try {
  ({ app } = require('./server'));
} finally {
  Module._load = originalLoad;
}

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

test('account APIs enforce the Philippine mobile format server-side', async (t) => {
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    queryHandler = async () => emptyResult;
    await close(server);
  });

  await t.test('rejects invalid mobile values before an account insert', async () => {
    let inserted = false;
    queryHandler = async (sql) => {
      if (sql.startsWith('insert into public.accounts')) inserted = true;
      return emptyResult;
    };
    const response = await requestJson(baseUrl, '/api/accounts', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token' },
      body: JSON.stringify({ name: 'Valid Parent', email: 'valid.parent@example.com', role: 'parent', mobile_number: '9171234567' }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Mobile number must be in the format 09XXXXXXXXX.');
    assert.equal(inserted, false);
  });

  await t.test('stores blank optional mobile as null and preserves valid local format', async () => {
    const insertedMobiles = [];
    queryHandler = async (sql, params) => {
      if (sql.startsWith('select 1 from public.accounts where parent_id')) return emptyResult;
      if (sql.startsWith('insert into public.accounts')) {
        insertedMobiles.push(params[4]);
        return { rows: [{ id: 10, name: params[0], email: params[1], role: params[3], mobile_number: params[4], is_archived: false }] };
      }
      return emptyResult;
    };
    for (const mobile_number of ['', '09171234567']) {
      const response = await requestJson(baseUrl, '/api/accounts', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ name: 'Valid Parent', email: `valid.${mobile_number || 'blank'}@example.com`, role: 'parent', mobile_number }),
      });
      assert.equal(response.status, 201);
    }
    assert.deepEqual(insertedMobiles, [null, '09171234567']);
  });

  await t.test('rejects invalid direct profile updates before the update query', async () => {
    let updated = false;
    queryHandler = async (sql) => {
      if (sql.startsWith('update public.accounts')) updated = true;
      return emptyResult;
    };
    const response = await requestJson(baseUrl, '/api/user/2', {
      method: 'PUT',
      headers: { Authorization: 'Bearer parent-token' },
      body: JSON.stringify({ mobile_number: '0917-123-4567' }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Mobile number must be in the format 09XXXXXXXXX.');
    assert.equal(updated, false);
  });
});
