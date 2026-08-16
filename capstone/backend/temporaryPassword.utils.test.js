const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TEMPORARY_PASSWORD_TTL_MS,
  createTemporaryPassword,
  isTemporaryPasswordExpired,
} = require('./temporaryPassword.utils');

test('temporary passwords use supplied cryptographic random values and meet the account policy shape', () => {
  const values = Array(14).fill(0);
  const password = createTemporaryPassword((upperBound) => {
    assert.equal(upperBound > 0, true);
    return values.shift();
  });

  assert.equal(password.length, 14);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /\d/);
  assert.match(password, /[^A-Za-z0-9]/);
});

test('temporary password expiry is valid immediately before the 30-minute boundary and expired at the boundary', () => {
  const issuedAt = new Date('2026-08-16T02:00:00.000Z');
  const expiresAt = new Date(issuedAt.getTime() + TEMPORARY_PASSWORD_TTL_MS);

  assert.equal(
    isTemporaryPasswordExpired(expiresAt, new Date(expiresAt.getTime() - 1)),
    false
  );
  assert.equal(isTemporaryPasswordExpired(expiresAt, expiresAt), true);
  assert.equal(isTemporaryPasswordExpired(null, issuedAt), true);
});
