const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEmailTransportConfig,
  buildEmailFromAddress,
  buildMailDiagnostics,
  buildResendEmailConfig,
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

test('enables Resend only when API key and sender address are configured', () => {
  assert.deepEqual(buildResendEmailConfig({}), {
    enabled: false,
    apiKey: null,
    from: null,
    reason: 'RESEND_API_KEY and EMAIL_FROM or SMTP_FROM are required for Resend email delivery.',
  });

  assert.deepEqual(buildResendEmailConfig({
    RESEND_API_KEY: 're_secret_api_key',
  }), {
    enabled: false,
    apiKey: null,
    from: null,
    reason: 'RESEND_API_KEY and EMAIL_FROM or SMTP_FROM are required for Resend email delivery.',
  });

  const config = buildResendEmailConfig({
    RESEND_API_KEY: 're_secret_api_key',
    EMAIL_FROM: 'noreply@theresiansquest.com',
    EMAIL_FROM_NAME: 'Saint Therese School',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.apiKey, 're_secret_api_key');
  assert.equal(config.from, '"Saint Therese School" <noreply@theresiansquest.com>');
  assert.equal(config.reason, null);
});

test('Resend accepts SMTP_FROM as a Railway sender fallback', () => {
  const config = buildResendEmailConfig({
    RESEND_API_KEY: 're_secret_api_key',
    SMTP_FROM: 'Saint Therese School <noreply@theresiansquest.com>',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.from, 'Saint Therese School <noreply@theresiansquest.com>');
  assert.equal(config.reason, null);
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

test('keeps an already formatted sender address valid for Resend', () => {
  assert.equal(
    buildEmailFromAddress({
      EMAIL_FROM: 'Saint Therese School <noreply@theresiansquest.com>',
      EMAIL_FROM_NAME: 'Saint Therese School',
    }),
    'Saint Therese School <noreply@theresiansquest.com>'
  );
});

test('diagnostics report only safe mail configuration state', () => {
  const diagnostics = buildMailDiagnostics({
    RESEND_API_KEY: 're_secret_api_key',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    EMAIL_USER: 'mailer@example.com',
    EMAIL_PASS: 'secret-app-password',
    EMAIL_FROM: 'noreply@example.com',
    SMTP_FROM: 'fallback@example.com',
    APP_URL: 'https://theresiansquest.com/login',
  });

  assert.deepEqual(diagnostics, {
    primaryProvider: 'resend',
    resendEnabled: true,
    hasResendApiKey: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    smtpService: null,
    hasEmailUser: true,
    hasEmailPass: true,
    hasEmailFrom: true,
    appUrl: 'https://theresiansquest.com/login',
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-app-password|re_secret_api_key/);
});

test('diagnostics treats SMTP_FROM as an email sender', () => {
  const diagnostics = buildMailDiagnostics({
    RESEND_API_KEY: 're_secret_api_key',
    SMTP_FROM: 'Saint Therese School <noreply@theresiansquest.com>',
  });

  assert.equal(diagnostics.primaryProvider, 'resend');
  assert.equal(diagnostics.resendEnabled, true);
  assert.equal(diagnostics.hasEmailFrom, true);
});
