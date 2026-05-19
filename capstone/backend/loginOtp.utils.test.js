const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLoginAccountLookup,
  buildLoginOtpResponse,
  normalizeLoginEmail,
  resolveOtpEmailDelivery,
} = require('./loginOtp.utils');

test('login email normalization trims and lowercases the address', () => {
  assert.equal(normalizeLoginEmail('  Teacher.User@GMAIL.COM  '), 'teacher.user@gmail.com');
});

test('login account lookup uses the public accounts table and trims stored email values', () => {
  const lookup = buildLoginAccountLookup('  Parent.User@GMAIL.COM  ');

  assert.match(lookup.text, /FROM public\.accounts/i);
  assert.match(lookup.text, /LOWER\(TRIM\(email\)\) = \$1/i);
  assert.deepEqual(lookup.values, ['parent.user@gmail.com']);
});

test('OTP email delivery resolves false when sending stalls past the timeout', async () => {
  const result = await resolveOtpEmailDelivery(
    () => new Promise(() => {}),
    5
  );

  assert.equal(result, false);
});

test('login OTP response never exposes the OTP code when delivery fails', () => {
  const expiresAt = new Date('2026-05-20T01:23:00.000Z');
  const response = buildLoginOtpResponse({
    user: { id: 12, email: 'teacher@gmail.com', otp_code: '123456' },
    expiresAt,
    emailSent: false,
  });

  assert.deepEqual(response, {
    success: true,
    step: 2,
    userId: 12,
    email: 'teacher@gmail.com',
    otpExpiresAt: expiresAt,
    emailSent: false,
    warning: 'Verification code could not be sent. Please resend the code or contact an administrator.',
  });
  assert.equal(response.otp, undefined);
  assert.equal(response.otp_code, undefined);
});
