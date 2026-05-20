const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEmailTransportConfig,
  buildEmailFromAddress,
  buildMailDiagnostics,
} = require('./emailTransport.utils');

test('builds explicit SMTP transport from Railway environment variables', () => {
  const config = buildEmailTransportConfig({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    EMAIL_USER: 'mailer@example.com',
    EMAIL_PASS: 'app-password',
    SMTP_CONNECTION_TIMEOUT_MS: '9000',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.options.host, 'smtp.example.com');
  assert.equal(config.options.port, 587);
  assert.equal(config.options.secure, false);
  assert.deepEqual(config.options.auth, {
    user: 'mailer@example.com',
    pass: 'app-password',
  });
  assert.equal(config.options.connectionTimeout, 9000);
});

test('uses Gmail service only when email credentials are configured', () => {
  const config = buildEmailTransportConfig({
    EMAIL_USER: 'school@gmail.com',
    EMAIL_PASS: 'gmail-app-password',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.options.service, 'gmail');
  assert.deepEqual(config.options.auth, {
    user: 'school@gmail.com',
    pass: 'gmail-app-password',
  });
});

test('does not fall back to bundled email credentials', () => {
  const config = buildEmailTransportConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.options, null);
  assert.match(config.reason, /EMAIL_USER/);
  assert.match(config.reason, /EMAIL_PASS/);
});

test('builds sender address without exposing credentials', () => {
  assert.equal(
    buildEmailFromAddress({
      EMAIL_FROM: 'noreply@example.com',
      EMAIL_FROM_NAME: 'Saint Therese School',
      EMAIL_USER: 'mailer@example.com',
    }),
    '"Saint Therese School" <noreply@example.com>'
  );

  assert.equal(
    buildEmailFromAddress({
      EMAIL_FROM_NAME: 'Saint Therese School',
      EMAIL_USER: 'mailer@example.com',
    }),
    '"Saint Therese School" <mailer@example.com>'
  );
});

test('diagnostics report only safe mail configuration state', () => {
  const diagnostics = buildMailDiagnostics({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    EMAIL_USER: 'mailer@example.com',
    EMAIL_PASS: 'secret-app-password',
    EMAIL_FROM: 'noreply@example.com',
    APP_URL: 'https://theresiansquest.com/login',
  });

  assert.deepEqual(diagnostics, {
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    smtpService: null,
    hasEmailUser: true,
    hasEmailPass: true,
    hasEmailFrom: true,
    appUrl: 'https://theresiansquest.com/login',
  });
});
