const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLoginDeviceSkipLookup,
  buildLoginDeviceSkipUpsert,
  buildLoginAccountLookup,
  buildLoginOtpResponse,
  normalizeLoginDeviceId,
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

test('OTP device skip queries stay bound to a normalized user device pair', () => {
  assert.equal(normalizeLoginDeviceId('  browser-device-123  '), 'browser-device-123');
  assert.equal(normalizeLoginDeviceId(''), '');

  const lookup = buildLoginDeviceSkipLookup(42, '  browser-device-123  ');
  assert.match(lookup.text, /FROM public\.login_otp_device_skips/i);
  assert.match(lookup.text, /otp_skipped_until > CURRENT_TIMESTAMP/i);
  assert.deepEqual(lookup.values, [42, 'browser-device-123']);

  const expiresAt = new Date('2026-06-20T00:00:00.000Z');
  const upsert = buildLoginDeviceSkipUpsert(42, 'browser-device-123', expiresAt);
  assert.match(upsert.text, /INSERT INTO public\.login_otp_device_skips/i);
  assert.match(upsert.text, /ON CONFLICT \(user_id, device_id\)/i);
  assert.deepEqual(upsert.values, [42, 'browser-device-123', expiresAt]);
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
