const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAccountHealthCheckResponse, serializeUser } = require('./accountResponse.utils');

test('serializeUser removes password and OTP fields from account responses', () => {
  const user = serializeUser({
    id: 1,
    email: 'admin@example.com',
    password: 'hashed-password',
    otp_code: '123456',
    otp_expires_at: new Date().toISOString(),
    is_archived: false,
    must_change_password: true,
    session_version: 3,
  });

  assert.equal(user.password, undefined);
  assert.equal(user.otp_code, undefined);
  assert.equal(user.otp_expires_at, undefined);
  assert.equal(user.session_version, undefined);
  assert.equal(user.mustChangePassword, true);
  assert.equal(user.isArchived, false);
  assert.equal(user.requiresInitialPasswordSetup, false);
});

test('serializes initial-password eligibility only for active issued temporary credentials', () => {
  const now = Date.now();
  const activeTemporaryAccount = serializeUser({
    id: 2,
    must_change_password: true,
    temporary_password_issued_at: new Date(now - 60_000).toISOString(),
    temporary_password_expires_at: new Date(now + 60_000).toISOString(),
  });
  const permanentAccount = serializeUser({ id: 3, must_change_password: false });
  const legacyAccountWithoutCredentialMetadata = serializeUser({ id: 4, must_change_password: true });
  const expiredTemporaryAccount = serializeUser({
    id: 5,
    must_change_password: true,
    temporary_password_issued_at: new Date(now - 120_000).toISOString(),
    temporary_password_expires_at: new Date(now - 60_000).toISOString(),
  });

  assert.equal(activeTemporaryAccount.requiresInitialPasswordSetup, true);
  assert.equal(permanentAccount.requiresInitialPasswordSetup, false);
  assert.equal(legacyAccountWithoutCredentialMetadata.requiresInitialPasswordSetup, false);
  assert.equal(expiredTemporaryAccount.requiresInitialPasswordSetup, false);
  assert.equal(activeTemporaryAccount.temporary_password_issued_at, undefined);
  assert.equal(activeTemporaryAccount.temporary_password_expires_at, undefined);
});

test('health check account payload does not expose account records', () => {
  const response = buildAccountHealthCheckResponse([
    {
      id: 1,
      email: 'admin@example.com',
      password: 'hashed-password',
      otp_code: '123456',
      otp_expires_at: new Date().toISOString(),
      is_archived: false,
      must_change_password: false,
    },
  ]);

  assert.equal(response.status, 'Connected');
  assert.equal(response.total, 1);
  assert.equal(response.accounts, undefined);
});
