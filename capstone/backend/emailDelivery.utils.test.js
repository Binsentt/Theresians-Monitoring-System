const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isProductionEmailRuntime,
  sendEmailWithProviders,
  shouldUseSmtpFallback,
} = require('./emailDelivery.utils');

const baseMessage = {
  to: 'admin@example.com',
  subject: 'Login Verification Code',
  html: '<p>Your verification code is <b>123456</b></p>',
};

const createLogger = () => {
  const entries = [];
  return {
    entries,
    logger: {
      info: (...args) => entries.push(['info', ...args]),
      warn: (...args) => entries.push(['warn', ...args]),
      error: (...args) => entries.push(['error', ...args]),
    },
  };
};

const createMockResendClient = ({ onSend }) => {
  const calls = [];

  class MockResend {
    constructor(apiKey) {
      calls.push({ type: 'constructor', apiKey });
      this.emails = {
        send: async (payload) => {
          calls.push({ type: 'send', payload });
          return onSend ? onSend(payload) : { data: { id: 'email-id' }, error: null };
        },
      };
    }
  }

  return { calls, MockResend };
};

test('sends OTP email through the Resend SDK when Resend is configured', async () => {
  const { entries, logger } = createLogger();
  const { calls, MockResend } = createMockResendClient({});

  const result = await sendEmailWithProviders({
    env: {
      RESEND_API_KEY: 're_secret_api_key',
      EMAIL_FROM: 'noreply@theresiansquest.com',
      EMAIL_FROM_NAME: 'Saint Therese School',
    },
    logger,
    message: baseMessage,
    ResendClient: MockResend,
    timeoutMs: 50,
  });

  assert.equal(result.sent, true);
  assert.equal(result.provider, 'resend');
  assert.deepEqual(calls, [
    { type: 'constructor', apiKey: 're_secret_api_key' },
    {
      type: 'send',
      payload: {
        from: '"Saint Therese School" <noreply@theresiansquest.com>',
        to: 'admin@example.com',
        subject: 'Login Verification Code',
        html: '<p>Your verification code is <b>123456</b></p>',
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(entries), /re_secret_api_key|123456/);
});

test('requires Resend configuration and ignores SMTP transporters in production', async () => {
  let smtpCalled = false;
  const { entries, logger } = createLogger();

  const result = await sendEmailWithProviders({
    env: {
      NODE_ENV: 'production',
      EMAIL_USER: 'school@gmail.com',
      EMAIL_PASS: 'gmail-app-password',
      EMAIL_FROM: 'noreply@theresiansquest.com',
    },
    logger,
    message: baseMessage,
    smtpTransporter: {
      sendMail: async () => {
        smtpCalled = true;
      },
    },
    timeoutMs: 50,
  });

  const serializedEntries = JSON.stringify(entries);
  assert.equal(result.sent, false);
  assert.equal(result.provider, 'resend');
  assert.equal(result.reason, 'not_configured');
  assert.equal(smtpCalled, false);
  assert.match(serializedEntries, /Resend email delivery is not configured/);
  assert.doesNotMatch(serializedEntries, /gmail-app-password|123456/);
});

test('does not fall back to SMTP in Railway production when Resend fails', async () => {
  let smtpCalled = false;
  const { entries, logger } = createLogger();
  const { MockResend } = createMockResendClient({
    onSend: async () => ({
      data: null,
      error: {
        name: 'validation_error',
        message: 'sender domain is not verified re_secret_api_key',
        statusCode: 403,
      },
    }),
  });

  const result = await sendEmailWithProviders({
    env: {
      RAILWAY_ENVIRONMENT: 'production',
      RESEND_API_KEY: 're_secret_api_key',
      EMAIL_FROM: 'unverified@example.com',
      EMAIL_USER: 'school@gmail.com',
      EMAIL_PASS: 'gmail-app-password',
    },
    logger,
    message: baseMessage,
    ResendClient: MockResend,
    smtpTransporter: {
      sendMail: async () => {
        smtpCalled = true;
      },
    },
    timeoutMs: 50,
  });

  const serializedEntries = JSON.stringify(entries);
  assert.equal(result.sent, false);
  assert.equal(result.provider, 'resend');
  assert.equal(result.reason, 'status_403');
  assert.equal(smtpCalled, false);
  assert.match(serializedEntries, /Resend email delivery failed/);
  assert.doesNotMatch(serializedEntries, /re_secret_api_key|gmail-app-password|123456|sender domain/);
});

test('Resend timeout returns false quickly without exposing the OTP', async () => {
  const { entries, logger } = createLogger();
  const { MockResend } = createMockResendClient({
    onSend: async () => new Promise(() => {}),
  });

  const startedAt = Date.now();
  const result = await sendEmailWithProviders({
    env: {
      RESEND_API_KEY: 're_secret_api_key',
      EMAIL_FROM: 'noreply@theresiansquest.com',
    },
    logger,
    message: baseMessage,
    ResendClient: MockResend,
    timeoutMs: 5,
  });

  assert.equal(result.sent, false);
  assert.equal(result.provider, 'resend');
  assert.equal(result.reason, 'timeout');
  assert.ok(Date.now() - startedAt < 250);
  assert.doesNotMatch(JSON.stringify(entries), /re_secret_api_key|123456/);
  assert.match(JSON.stringify(entries), /timeout/);
});

test('safe diagnostics omit provider secrets and email body content', async () => {
  const { entries, logger } = createLogger();
  const { MockResend } = createMockResendClient({
    onSend: async () => {
      throw Object.assign(new Error('bad api key re_secret_api_key'), {
        name: 'authentication_error',
        statusCode: 401,
      });
    },
  });

  const result = await sendEmailWithProviders({
    env: {
      RESEND_API_KEY: 're_secret_api_key',
      EMAIL_FROM: 'noreply@theresiansquest.com',
      EMAIL_USER: 'school@gmail.com',
      EMAIL_PASS: 'gmail-app-password',
    },
    logger,
    message: baseMessage,
    ResendClient: MockResend,
    timeoutMs: 50,
  });

  const serializedEntries = JSON.stringify(entries);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'status_401');
  assert.doesNotMatch(serializedEntries, /re_secret_api_key|gmail-app-password|123456/);
  assert.match(serializedEntries, /hasResendApiKey/);
  assert.match(serializedEntries, /hasEmailPass/);
  assert.match(serializedEntries, /status_401/);
});

test('production runtime disables SMTP fallback', () => {
  assert.equal(isProductionEmailRuntime({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionEmailRuntime({ RAILWAY_ENVIRONMENT: 'production' }), true);
  assert.equal(isProductionEmailRuntime({ NODE_ENV: 'development' }), false);
  assert.equal(shouldUseSmtpFallback({ NODE_ENV: 'production' }), false);
  assert.equal(shouldUseSmtpFallback({ RAILWAY_SERVICE_ID: 'service-id' }), false);
  assert.equal(shouldUseSmtpFallback({ NODE_ENV: 'development' }), true);
  assert.equal(shouldUseSmtpFallback({ DISABLE_SMTP_FALLBACK: 'true' }), false);
});
