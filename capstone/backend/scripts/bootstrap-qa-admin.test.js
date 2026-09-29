const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const test = require('node:test');
const bcrypt = require('bcrypt');
const { runQaAdminBootstrap } = require('./bootstrap-qa-admin');

const makeEnv = (overrides = {}) => ({
  NODE_ENV: 'test',
  RAILWAY_ENVIRONMENT_NAME: 'qa-owner-testing',
  RAILWAY_PROJECT_ID: 'dd2c27df-22e4-4ee0-82dc-a1c510b07d0c',
  RAILWAY_ENVIRONMENT_ID: '0ab9cd4e-5281-4a4b-a9c7-a521616194f1',
  QA_ADMIN_BOOTSTRAP_APPROVED: 'true',
  QA_ADMIN_EMAIL: `qa-admin-${randomUUID()}@example.invalid`,
  QA_ADMIN_PASSWORD: randomBytes(24).toString('base64url'),
  DATABASE_URL: 'postgres://qa.invalid/example',
  ...overrides,
});

const createPool = ({ existing = [], insertRows = [{ id: 41 }] } = {}) => {
  const statements = [];
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), values });
          if (/^SELECT id, role, is_archived/i.test(String(sql).trim())) return { rows: existing };
          if (/^INSERT INTO public\.accounts/i.test(String(sql).trim())) return { rows: insertRows };
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
  return { pool, statements };
};

test('QA admin bootstrap rejects production before opening a database connection', async () => {
  let opened = false;
  await assert.rejects(
    runQaAdminBootstrap({
      env: makeEnv({ NODE_ENV: 'production' }),
      poolFactory: () => { opened = true; throw new Error('must not open'); },
    }),
    /refuses production/i,
  );
  assert.equal(opened, false);
});

test('QA admin bootstrap rejects the wrong Railway environment before database access', async () => {
  let opened = false;
  await assert.rejects(
    runQaAdminBootstrap({
      env: makeEnv({ RAILWAY_ENVIRONMENT_NAME: 'production' }),
      poolFactory: () => { opened = true; throw new Error('must not open'); },
    }),
    /qa-owner-testing/i,
  );
  assert.equal(opened, false);
});

test('QA admin bootstrap rejects a different Railway project or environment ID before database access', async () => {
  for (const overrides of [
    { RAILWAY_PROJECT_ID: 'another-project' },
    { RAILWAY_ENVIRONMENT_ID: 'another-environment' },
  ]) {
    let opened = false;
    await assert.rejects(
      runQaAdminBootstrap({
        env: makeEnv(overrides),
        poolFactory: () => { opened = true; throw new Error('must not open'); },
      }),
      /verified QA project and environment/i,
    );
    assert.equal(opened, false);
  }
});

test('QA admin bootstrap requires the explicit one-time approval flag', async () => {
  let opened = false;
  await assert.rejects(
    runQaAdminBootstrap({
      env: makeEnv({ QA_ADMIN_BOOTSTRAP_APPROVED: undefined }),
      poolFactory: () => { opened = true; throw new Error('must not open'); },
    }),
    /approval/i,
  );
  assert.equal(opened, false);
});

test('QA admin bootstrap refuses an existing non-admin account without inserting', async () => {
  const { pool, statements } = createPool({ existing: [{ id: 5, role: 'teacher', is_archived: false }] });
  const output = [];
  const result = await runQaAdminBootstrap({ env: makeEnv(), pool, logger: { log: (line) => output.push(line) } });

  assert.deepEqual(result, { created: false, reason: 'email-in-use' });
  assert.equal(statements.some(({ sql }) => sql.startsWith('INSERT INTO public.accounts')), false);
  assert.deepEqual(output, []);
});

test('QA admin bootstrap does not create another row for an existing active admin', async () => {
  const { pool, statements } = createPool({ existing: [{ id: 5, role: 'admin', is_archived: false }] });
  const output = [];
  const result = await runQaAdminBootstrap({ env: makeEnv(), pool, logger: { log: (line) => output.push(line) } });

  assert.deepEqual(result, { created: false, reason: 'already-exists' });
  assert.equal(statements.some(({ sql }) => sql.startsWith('INSERT INTO public.accounts')), false);
  assert.deepEqual(output, ['QA Admin already exists.']);
});

test('QA admin bootstrap inserts one active admin with the existing bcrypt rounds and never logs the password', async () => {
  const env = makeEnv();
  const { pool, statements } = createPool();
  const output = [];
  const result = await runQaAdminBootstrap({ env, pool, logger: { log: (line) => output.push(line) }, bcrypt });
  const insert = statements.find(({ sql }) => sql.startsWith('INSERT INTO public.accounts'));

  assert.deepEqual(result, { created: true, reason: 'created' });
  assert.ok(insert);
  assert.equal(insert.values[0], 'QA Operator');
  assert.equal(insert.values[1], env.QA_ADMIN_EMAIL.trim().toLowerCase());
  assert.equal(insert.values[3], 'admin');
  assert.equal(insert.values[4], 'Offline');
  assert.equal(insert.values[5], false);
  assert.equal(insert.values[6], false);
  assert.notEqual(insert.values[2], env.QA_ADMIN_PASSWORD);
  assert.equal(await bcrypt.compare(env.QA_ADMIN_PASSWORD, insert.values[2]), true);
  assert.deepEqual(output, ['QA Admin created.']);
  assert.equal(output.join('\n').includes(env.QA_ADMIN_PASSWORD), false);
});
