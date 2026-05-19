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
  });

  assert.equal(user.password, undefined);
  assert.equal(user.otp_code, undefined);
  assert.equal(user.otp_expires_at, undefined);
  assert.equal(user.mustChangePassword, true);
  assert.equal(user.isArchived, false);
});

test('health check account payload never exposes password or OTP fields', () => {
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
  assert.equal(response.accounts[0].password, undefined);
  assert.equal(response.accounts[0].otp_code, undefined);
  assert.equal(response.accounts[0].otp_expires_at, undefined);
});
