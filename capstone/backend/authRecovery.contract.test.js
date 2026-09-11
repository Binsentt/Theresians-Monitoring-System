const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('auth challenge storage and routes are purpose-bound and server-controlled', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const challenge = fs.readFileSync(path.join(__dirname, 'authChallenge.utils.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, 'migrations', '020_add_auth_otp_challenge_security.sql'), 'utf8');
  const allSource = `${source}\n${challenge}\n${migration}`;
  assert.match(allSource, /otp_code_hash/i);
  assert.match(allSource, /otp_purpose/i);
  assert.match(allSource, /otp_attempts/i);
  assert.match(allSource, /otp_sent_at/i);
  assert.match(allSource, /crypto\.randomInt/);
  assert.match(allSource, /createHmac\(['"]sha256/);
  assert.match(source, /challengeId|otp_challenge_id/);
  assert.match(source, /app\.post\('\/api\/reset-password\/send-code'/);
  assert.match(source, /If an eligible account matches this email, recovery instructions will be sent/i);
  assert.match(source, /app\.post\('\/api\/login\/verify-otp'/);
  assert.match(source, /purpose.*login|otp_purpose.*login/i);
  assert.match(source, /purpose.*recovery|otp_purpose.*recovery/i);
  assert.match(source, /attempt limit|OTP_ATTEMPT|otp_attempts/i);
  assert.match(source, /cooldown|OTP_RESEND/i);
});

test('password recovery consumes proof atomically and invalidates sessions', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf("app.post('/api/reset-password/verify'");
  const end = source.indexOf("app.post('/api/request-password-change-otp'", start);
  const route = source.slice(start, end);
  assert.match(route, /BEGIN/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /session_version\s*=\s*COALESCE\(session_version, 0\) \+ 1/i);
  assert.match(route, /revokeAllWebsiteSessions/);
  assert.match(route, /login_otp_device_skips/);
  assert.match(route, /ROLLBACK/);
  assert.match(route, /otp_code_hash|otp_code/);
});
