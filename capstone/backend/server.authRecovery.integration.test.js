const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const databaseUrl = process.env.AUTH_RECOVERY_TEST_DATABASE_URL;

const requestJson = async (baseUrl, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    body: contentType.includes('application/json') ? await response.json() : { text: await response.text() },
  };
};

const compactSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
const extractCode = (message) => {
  const matches = String(message?.html || '').match(/\b\d{6}\b/g) || [];
  return matches.at(-1) || null;
};

test('recovery and login OTP contracts pass against isolated PostgreSQL with captured mail', { skip: !databaseUrl }, async (t) => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = 'isolated-auth-recovery-test-secret';
  process.env.NODE_ENV = 'test';
  const bootstrap = new Client({ connectionString: databaseUrl });
  await bootstrap.connect();
  await bootstrap.query(`
    CREATE TABLE IF NOT EXISTS public.accounts (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      mobile_number VARCHAR(20),
      role VARCHAR(50) NOT NULL DEFAULT 'Parent',
      parent_id VARCHAR(6),
      employee_id VARCHAR(50),
      otp_code VARCHAR(10),
      otp_expires_at TIMESTAMPTZ,
      is_archived BOOLEAN DEFAULT false,
      must_change_password BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      address VARCHAR(255), birthday DATE, gender VARCHAR(20), status VARCHAR(20) DEFAULT 'Offline',
      session_version INTEGER DEFAULT 0
    );
  `);
  await bootstrap.end();

  const capturedMessages = [];
  const emailDeliveryStub = {
    buildSafeEmailLogDetails: ({ emailType, role, message, result = {} }) => ({
      emailType,
      role,
      recipientDomain: String(message?.to || '').split('@')[1] || null,
      provider: result.provider || 'test',
      statusCode: result.statusCode || null,
      reason: result.reason || null,
      sanitizedResendErrorMessage: result.sanitizedResendErrorMessage || null,
      hasEmailFrom: true,
      hasSmtpFrom: false,
      hasAppUrl: true,
    }),
    getEmailSendTimeoutMs: () => 5,
    sendEmailWithProviders: async ({ message }) => {
      capturedMessages.push(message);
      return { sent: true, provider: 'local-capture' };
    },
  };
  const originalLoad = Module._load;
  Module._load = function loadEmailCapture(request, parent, isMain) {
    if (request === './emailDelivery.utils') return emailDeliveryStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  let serverExports;
  try {
    serverExports = require('./server');
  } finally {
    Module._load = originalLoad;
  }
  await serverExports.schemaReady;

  const db = require('./database/db');
  const migration = await fs.readFile(`${__dirname}/migrations/020_add_auth_otp_challenge_security.sql`, 'utf8');
  await db.query(migration);
  await db.query('TRUNCATE public.accounts RESTART IDENTITY CASCADE');
  const passwordHash = await bcrypt.hash('OldPass1!', 4);
  await db.query(
    `INSERT INTO public.accounts (id, name, email, password, role, status, is_archived, must_change_password, session_version)
     VALUES (10, 'Test Parent', 'parent@example.test', $1, 'parent', 'Offline', false, false, 0),
            (11, 'Test Teacher', 'teacher@example.test', $1, 'teacher', 'Offline', false, false, 0),
            (12, 'Archived Teacher', 'archived@example.test', $1, 'teacher', 'Offline', true, false, 0)`,
    [passwordHash]
  );

  const listener = await new Promise((resolve) => {
    const server = serverExports.app.listen(0, () => resolve(server));
  });
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;
  const { createOtpChallenge, hashOtpCode } = require('./authChallenge.utils');
  const seedChallenge = async (accountId, { purpose, code, challengeId, expiresAt = new Date(Date.now() + 600_000), sentAt = new Date(Date.now() - 60_000) }) => {
    await db.query(
      `UPDATE public.accounts
       SET otp_code = NULL, otp_code_hash = $1, otp_purpose = $2, otp_attempts = 0,
           otp_sent_at = $3, otp_challenge_id = $4, otp_expires_at = $5
       WHERE id = $6`,
      [hashOtpCode(code, challengeId, process.env.JWT_SECRET), purpose, sentAt, challengeId, expiresAt, accountId]
    );
  };
  const recoveryRequest = async (email = 'teacher@example.test') => requestJson(baseUrl, '/api/reset-password/send-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const loginRequest = async (email = 'parent@example.test', password = 'OldPass1!') => requestJson(baseUrl, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: email, password }),
  });

  t.after(async () => {
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    await db.end();
  });

  const malformed = await recoveryRequest('not-an-email');
  assert.equal(malformed.status, 400);
  const unknown = await recoveryRequest('unknown@example.test');
  assert.equal(unknown.status, 200);
  assert.match(unknown.body.message, /If an eligible account matches this email/i);
  assert.equal(capturedMessages.length, 0);

  const recoverySent = await recoveryRequest();
  assert.equal(recoverySent.status, 200);
  assert.match(recoverySent.body.message, /If an eligible account matches this email/i);
  const recoveryMessage = capturedMessages.at(-1);
  assert.equal(recoveryMessage.to, 'teacher@example.test');
  const recoveryCode = extractCode(recoveryMessage);
  assert.match(recoveryCode, /^\d{6}$/);

  const cooldown = await recoveryRequest();
  assert.equal(cooldown.status, 200);
  assert.equal(capturedMessages.length, 1);

  await seedChallenge(11, { purpose: 'recovery', code: '012345', challengeId: 'recovery-leading-zero' });
  const mismatch = await requestJson(baseUrl, '/api/reset-password/verify', {
    method: 'POST',
    body: JSON.stringify({ email: 'teacher@example.test', otp: '012345', newPassword: 'ValidPass1!', confirmPassword: 'Different1!' }),
  });
  assert.equal(mismatch.status, 400);
  const tooShort = await requestJson(baseUrl, '/api/reset-password/verify', {
    method: 'POST',
    body: JSON.stringify({ email: 'teacher@example.test', otp: '012345', newPassword: 'short', confirmPassword: 'short' }),
  });
  assert.equal(tooShort.status, 400);
  const sessionCredential = 'a'.repeat(64);
  await db.query(
    `INSERT INTO public.website_sessions (account_id, credential_hash, expires_at)
     VALUES (11, $1, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
    [sessionCredential]
  );
  const reset = await requestJson(baseUrl, '/api/reset-password/verify', {
    method: 'POST',
    body: JSON.stringify({ email: 'teacher@example.test', otp: '012345', newPassword: 'ValidPass1!', confirmPassword: 'ValidPass1!' }),
  });
  assert.equal(reset.status, 200);
  const resetState = await db.query('SELECT session_version FROM public.accounts WHERE id = 11');
  assert.equal(Number(resetState.rows[0].session_version), 1);
  const revoked = await db.query('SELECT revoked_at FROM public.website_sessions WHERE account_id = 11');
  assert.ok(revoked.rows[0].revoked_at);
  const replay = await requestJson(baseUrl, '/api/reset-password/verify', {
    method: 'POST',
    body: JSON.stringify({ email: 'teacher@example.test', otp: '012345', newPassword: 'AnotherPass1!', confirmPassword: 'AnotherPass1!' }),
  });
  assert.equal(replay.status, 401);

  const oldPassword = await loginRequest('teacher@example.test', 'OldPass1!');
  assert.equal(oldPassword.status, 401);
  const newPassword = await loginRequest('teacher@example.test', 'ValidPass1!');
  assert.equal(newPassword.status, 200);
  assert.equal(newPassword.body.step, 2);
  const loginMessage = capturedMessages.at(-1);
  const loginCode = extractCode(loginMessage);
  assert.match(loginCode, /^\d{6}$/);
  assert.ok(newPassword.body.challengeId);
  const loginCooldown = await requestJson(baseUrl, '/api/login/resend-otp', {
    method: 'POST',
    body: JSON.stringify({ challengeId: newPassword.body.challengeId }),
  });
  assert.equal(loginCooldown.status, 429);
  await db.query('UPDATE public.accounts SET otp_sent_at = CURRENT_TIMESTAMP - INTERVAL \'1 minute\' WHERE id = 11');
  const resent = await requestJson(baseUrl, '/api/login/resend-otp', {
    method: 'POST',
    body: JSON.stringify({ challengeId: newPassword.body.challengeId }),
  });
  assert.equal(resent.status, 200);
  assert.notEqual(resent.body.challengeId, newPassword.body.challengeId);
  const oldChallenge = await requestJson(baseUrl, '/api/login/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ challengeId: newPassword.body.challengeId, otp: loginCode }),
  });
  assert.equal(oldChallenge.status, 401);
  const latestLoginCode = extractCode(capturedMessages.at(-1));
  const loginVerified = await requestJson(baseUrl, '/api/login/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ challengeId: resent.body.challengeId, otp: latestLoginCode }),
  });
  assert.equal(loginVerified.status, 200);
  const loginReplay = await requestJson(baseUrl, '/api/login/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ challengeId: resent.body.challengeId, otp: latestLoginCode }),
  });
  assert.equal(loginReplay.status, 401);

  const expiredId = 'expired-recovery';
  await seedChallenge(11, { purpose: 'recovery', code: '111111', challengeId: expiredId, expiresAt: new Date(Date.now() - 1) });
  const expired = await requestJson(baseUrl, '/api/reset-password/verify', {
    method: 'POST',
    body: JSON.stringify({ email: 'teacher@example.test', otp: '111111', newPassword: 'ValidPass2!', confirmPassword: 'ValidPass2!' }),
  });
  assert.equal(expired.status, 401);

  const wrongPurposeId = 'wrong-purpose';
  await seedChallenge(10, { purpose: 'recovery', code: '222222', challengeId: wrongPurposeId });
  const wrongPurpose = await requestJson(baseUrl, '/api/login/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ challengeId: wrongPurposeId, otp: '222222' }),
  });
  assert.equal(wrongPurpose.status, 401);

  const expiredLogin = await loginRequest('archived@example.test', 'OldPass1!');
  assert.equal(expiredLogin.status, 403);
  const malformedOtp = await requestJson(baseUrl, '/api/login/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ challengeId: 'not-real', otp: '12345' }),
  });
  assert.equal(malformedOtp.status, 400);
});

test('OTP helper preserves leading-zero format and server timing inputs', () => {
  const { createOtpChallenge, generateOtpCode, isOtpCodeFormatValid, isOtpExpired, isOtpResendCoolingDown } = require('./authChallenge.utils');
  assert.match(generateOtpCode(), /^\d{6}$/);
  assert.equal(isOtpCodeFormatValid('012345'), true);
  assert.equal(isOtpCodeFormatValid('12345'), false);
  const challenge = createOtpChallenge({ purpose: 'recovery', ttlMs: 1000, now: new Date('2026-01-01T00:00:00Z'), secret: 'test' });
  assert.equal(challenge.code.length, 6);
  assert.equal(isOtpExpired(challenge.expiresAt, new Date('2026-01-01T00:00:00.999Z')), false);
  assert.equal(isOtpExpired(challenge.expiresAt, new Date('2026-01-01T00:00:01Z')), true);
  assert.equal(isOtpResendCoolingDown(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:29Z'), 30_000), true);
});
