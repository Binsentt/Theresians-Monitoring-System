const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
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

const createPool = ({ existing = [], insertRows = [{ id: 41 }], failAt, error = new Error('synthetic database failure') } = {}) => {
  const statements = [];
  const pool = {
    async connect() {
      if (failAt === 'database-connect') throw error;
      return {
        async query(sql, values = []) {
          statements.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), values });
          const normalizedSql = String(sql).trim();
          if (failAt === 'existing-account-check' && /^SELECT id, role, is_archived/i.test(normalizedSql)) throw error;
          if (failAt === 'account-insert' && /^INSERT INTO public\.accounts/i.test(normalizedSql)) throw error;
          if (failAt === 'transaction-commit' && /^COMMIT$/i.test(normalizedSql)) throw error;
          if (/^SELECT id, role, is_archived/i.test(normalizedSql)) return { rows: existing };
          if (/^INSERT INTO public\.accounts/i.test(normalizedSql)) return { rows: insertRows };
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
  return { pool, statements };
};

const makeFailureLogger = () => {
  const output = [];
  return {
    output,
    logger: {
      log: (message) => output.push({ level: 'log', message }),
      error: (message) => output.push({ level: 'error', message }),
    },
  };
};

const GENERIC_BOOTSTRAP_FAILURE = 'QA Admin bootstrap failed; no success was confirmed.';

const stageFailures = [
  {
    stage: 'qa-guard',
    expectedError: /refuses production/i,
    makeArgs: ({ pool }) => ({ env: makeEnv({ NODE_ENV: 'production' }), pool }),
  },
  {
    stage: 'credential-validation',
    expectedError: /valid QA Admin email/i,
    makeArgs: ({ pool }) => ({ env: makeEnv({ QA_ADMIN_EMAIL: 'not-an-email' }), pool }),
    expectedOutput: [
      { level: 'error', message: 'QA Admin bootstrap failed at stage: credential-validation.' },
      { level: 'error', message: 'QA Admin credential validation failed: invalid-admin-email.' },
    ],
  },
  {
    stage: 'database-connect',
    expectedError: new RegExp(GENERIC_BOOTSTRAP_FAILURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    makeArgs: ({ pool }) => ({ env: makeEnv(), pool: createPool({ failAt: 'database-connect' }).pool }),
  },
  {
    stage: 'existing-account-check',
    expectedError: new RegExp(GENERIC_BOOTSTRAP_FAILURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    makeArgs: () => ({ env: makeEnv(), pool: createPool({ failAt: 'existing-account-check' }).pool }),
  },
  {
    stage: 'password-hash',
    expectedError: new RegExp(GENERIC_BOOTSTRAP_FAILURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    makeArgs: ({ pool }) => ({ env: makeEnv(), pool, bcrypt: { hash: async () => { throw new Error('synthetic hash failure'); } } }),
  },
  {
    stage: 'account-insert',
    expectedError: new RegExp(GENERIC_BOOTSTRAP_FAILURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    makeArgs: () => ({ env: makeEnv(), pool: createPool({ failAt: 'account-insert' }).pool }),
  },
  {
    stage: 'transaction-commit',
    expectedError: new RegExp(GENERIC_BOOTSTRAP_FAILURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    makeArgs: () => ({ env: makeEnv(), pool: createPool({ failAt: 'transaction-commit' }).pool }),
  },
];

for (const { stage, expectedError, makeArgs, expectedOutput } of stageFailures) {
  test(`QA admin bootstrap reports only the safe ${stage} failure stage`, async () => {
    const { pool } = createPool();
    const { logger, output } = makeFailureLogger();
    const args = makeArgs({ pool });

    await assert.rejects(
      runQaAdminBootstrap({ ...args, logger }),
      expectedError,
    );
    assert.deepEqual(output, expectedOutput || [{ level: 'error', message: `QA Admin bootstrap failed at stage: ${stage}.` }]);
  });
}

const credentialValidationCases = [
  { reason: 'missing-database-url', overrides: { DATABASE_URL: '' } },
  { reason: 'missing-admin-email', overrides: { QA_ADMIN_EMAIL: '' } },
  { reason: 'invalid-admin-email', overrides: { QA_ADMIN_EMAIL: 'private-invalid-email-do-not-log' } },
  { reason: 'missing-admin-password', overrides: { QA_ADMIN_PASSWORD: '' } },
  { reason: 'admin-password-too-short', overrides: { QA_ADMIN_PASSWORD: 'short7!' } },
  { reason: 'admin-password-too-long', overrides: { QA_ADMIN_PASSWORD: 'x'.repeat(73) } },
];

for (const { reason, overrides } of credentialValidationCases) {
  test(`QA Admin bootstrap reports sanitized credential validation reason ${reason}`, async () => {
    const secrets = {
      QA_ADMIN_EMAIL: 'private-admin-email-sentinel@example.invalid',
      QA_ADMIN_PASSWORD: 'private-admin-password-sentinel',
      DATABASE_URL: 'postgres://private-user:private-password@qa.invalid/private-db',
    };
    const env = makeEnv({ ...secrets, ...overrides });
    const { pool } = createPool();
    const { logger, output } = makeFailureLogger();
    let thrownError;

    await assert.rejects(
      runQaAdminBootstrap({ env, pool, logger }),
      (error) => {
        thrownError = error;
        return true;
      },
    );

    assert.deepEqual(output, [
      { level: 'error', message: 'QA Admin bootstrap failed at stage: credential-validation.' },
      { level: 'error', message: `QA Admin credential validation failed: ${reason}.` },
    ]);

    const serializedLogs = JSON.stringify(output);
    for (const secret of [env.QA_ADMIN_EMAIL, env.QA_ADMIN_PASSWORD, env.DATABASE_URL].filter(Boolean)) {
      assert.equal(serializedLogs.includes(secret), false, 'logs must not contain credential values');
      assert.equal(String(thrownError).includes(secret), false, 'validation errors must not contain credential values');
    }
    assert.equal(serializedLogs.includes(String(Buffer.byteLength(env.QA_ADMIN_PASSWORD, 'utf8'))), false,
      'logs must not contain password length');
  });
}

test('QA admin bootstrap never logs credentials, database URLs, or raw database errors', async () => {
  const email = 'qa-stage-secret@example.invalid';
  const password = 'qa-stage-password-never-log';
  const databaseUrl = 'postgres://qa-user:qa-password@db.invalid/private-qa';
  const rawDatabaseError = `RAW_DATABASE_ERROR ${email} ${password} ${databaseUrl}`;
  const { pool } = createPool({ failAt: 'database-connect', error: new Error(rawDatabaseError) });
  const { logger, output } = makeFailureLogger();

  await assert.rejects(
    runQaAdminBootstrap({
      env: makeEnv({ QA_ADMIN_EMAIL: email, QA_ADMIN_PASSWORD: password, DATABASE_URL: databaseUrl }),
      pool,
      logger,
    }),
    (error) => error.message === GENERIC_BOOTSTRAP_FAILURE,
  );

  const serializedOutput = JSON.stringify(output);
  for (const sensitive of [email, password, databaseUrl, 'RAW_DATABASE_ERROR', 'qa-user', 'qa-password']) {
    assert.equal(serializedOutput.includes(sensitive), false, `output must not contain ${sensitive}`);
  }
  assert.deepEqual(output, [{ level: 'error', message: 'QA Admin bootstrap failed at stage: database-connect.' }]);
});

test('QA admin bootstrap CLI keeps the generic final failure after the safe stage diagnostic', () => {
  const secretSentinel = 'qa-bootstrap-secret-sentinel-never-log';
  const databaseUrlSentinel = 'postgres://user:private@host.invalid/db';
  const result = spawnSync(process.execPath, [path.join(__dirname, 'bootstrap-qa-admin.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      QA_ADMIN_EMAIL: secretSentinel,
      QA_ADMIN_PASSWORD: secretSentinel,
      DATABASE_URL: databaseUrlSentinel,
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), [
    'QA Admin bootstrap failed at stage: qa-guard.',
    GENERIC_BOOTSTRAP_FAILURE,
  ].join('\n'));
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(secretSentinel), false);
  assert.equal(result.stderr.includes(databaseUrlSentinel), false);
});

test('QA admin bootstrap CLI keeps the generic final failure after a sanitized credential reason', () => {
  const emailSentinel = 'qa-admin-email-sentinel@example.invalid';
  const passwordSentinel = 'qa-admin-password-sentinel-never-log';
  const result = spawnSync(process.execPath, [path.join(__dirname, 'bootstrap-qa-admin.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'qa',
      RAILWAY_ENVIRONMENT_NAME: 'qa-owner-testing',
      RAILWAY_PROJECT_ID: 'dd2c27df-22e4-4ee0-82dc-a1c510b07d0c',
      RAILWAY_ENVIRONMENT_ID: '0ab9cd4e-5281-4a4b-a9c7-a521616194f1',
      QA_ADMIN_BOOTSTRAP_APPROVED: 'true',
      QA_ADMIN_EMAIL: emailSentinel,
      QA_ADMIN_PASSWORD: passwordSentinel,
      DATABASE_URL: '',
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), [
    'QA Admin bootstrap failed at stage: credential-validation.',
    'QA Admin credential validation failed: missing-database-url.',
    GENERIC_BOOTSTRAP_FAILURE,
  ].join('\n'));
  assert.equal(result.stderr.includes(emailSentinel), false);
  assert.equal(result.stderr.includes(passwordSentinel), false);
  assert.equal(result.stdout, '');
});

test('QA admin bootstrap rejects production before opening a database connection', async () => {
  let opened = false;
  const { logger, output } = makeFailureLogger();
  await assert.rejects(
    runQaAdminBootstrap({
      env: makeEnv({ NODE_ENV: 'production' }),
      logger,
      poolFactory: () => { opened = true; throw new Error('must not open'); },
    }),
    /refuses production/i,
  );
  assert.equal(opened, false);
  assert.deepEqual(output, [{ level: 'error', message: 'QA Admin bootstrap failed at stage: qa-guard.' }]);
});

test('QA admin bootstrap rejects the wrong Railway environment before database access', async () => {
  let opened = false;
  const { logger, output } = makeFailureLogger();
  await assert.rejects(
    runQaAdminBootstrap({
      env: makeEnv({ RAILWAY_ENVIRONMENT_NAME: 'production' }),
      logger,
      poolFactory: () => { opened = true; throw new Error('must not open'); },
    }),
    /qa-owner-testing/i,
  );
  assert.equal(opened, false);
  assert.deepEqual(output, [{ level: 'error', message: 'QA Admin bootstrap failed at stage: qa-guard.' }]);
});

test('QA admin bootstrap rejects a different Railway project or environment ID before database access', async () => {
  for (const overrides of [
    { RAILWAY_PROJECT_ID: 'another-project' },
    { RAILWAY_ENVIRONMENT_ID: 'another-environment' },
  ]) {
    let opened = false;
    const { logger, output } = makeFailureLogger();
    await assert.rejects(
      runQaAdminBootstrap({
        env: makeEnv(overrides),
        logger,
        poolFactory: () => { opened = true; throw new Error('must not open'); },
      }),
      /verified QA project and environment/i,
    );
    assert.equal(opened, false);
    assert.deepEqual(output, [{ level: 'error', message: 'QA Admin bootstrap failed at stage: qa-guard.' }]);
  }
});

test('QA admin bootstrap requires the explicit one-time approval flag', async () => {
  let opened = false;
  const { logger, output } = makeFailureLogger();
  await assert.rejects(
    runQaAdminBootstrap({
      env: makeEnv({ QA_ADMIN_BOOTSTRAP_APPROVED: undefined }),
      logger,
      poolFactory: () => { opened = true; throw new Error('must not open'); },
    }),
    /approval/i,
  );
  assert.equal(opened, false);
  assert.deepEqual(output, [{ level: 'error', message: 'QA Admin bootstrap failed at stage: qa-guard.' }]);
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
