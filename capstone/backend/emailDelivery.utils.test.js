const test = require('node:test');
const assert = require('node:assert/strict');

const { sendEmailWithProviders } = require('./emailDelivery.utils');

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

test('sends email through Resend when Resend is configured', async () => {
  let request;
  const { entries, logger } = createLogger();
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'email-id' }),
    };
  };
  const smtpTransporter = {
    sendMail: async () => {
      throw new Error('SMTP fallback should not be called');
    },
  };

  const result = await sendEmailWithProviders({
    env: {
      RESEND_API_KEY: 're_secret_api_key',
      EMAIL_FROM: 'noreply@theresiansquest.com',
      EMAIL_FROM_NAME: 'Saint Therese School',
    },
    fetchImpl,
    logger,
    message: baseMessage,
    smtpTransporter,
    timeoutMs: 50,
  });

  assert.equal(result.sent, true);
  assert.equal(result.provider, 'resend');
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer re_secret_api_key');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.headers['User-Agent'], 'theresian-portal/1.0');
  assert.deepEqual(JSON.parse(request.options.body), {
    from: '"Saint Therese School" <noreply@theresiansquest.com>',
    to: 'admin@example.com',
    subject: 'Login Verification Code',
    html: '<p>Your verification code is <b>123456</b></p>',
  });
  assert.doesNotMatch(JSON.stringify(entries), /re_secret_api_key|123456/);
});

test('falls back to SMTP when Resend fails and SMTP is configured', async () => {
  let smtpMessage;
  const { logger } = createLogger();
  const fetchImpl = async () => ({
    ok: false,
    status: 422,
    text: async () => 'invalid sender',
  });
  const smtpTransporter = {
    sendMail: async (message) => {
      smtpMessage = message;
    },
  };

  const result = await sendEmailWithProviders({
    env: {
      RESEND_API_KEY: 're_secret_api_key',
      EMAIL_FROM: 'noreply@theresiansquest.com',
      EMAIL_USER: 'school@gmail.com',
      EMAIL_PASS: 'gmail-app-password',
    },
    fetchImpl,
    logger,
    message: baseMessage,
    smtpTransporter,
    timeoutMs: 50,
  });

  assert.equal(result.sent, true);
  assert.equal(result.provider, 'smtp');
  assert.deepEqual(smtpMessage, {
    from: '"Saint Therese School" <noreply@theresiansquest.com>',
    to: 'admin@example.com',
    subject: 'Login Verification Code',
    html: '<p>Your verification code is <b>123456</b></p>',
  });
});

test('Resend timeout returns false quickly without exposing the OTP', async () => {
  const { entries, logger } = createLogger();
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  const startedAt = Date.now();
  const result = await sendEmailWithProviders({
    env: {
      RESEND_API_KEY: 're_secret_api_key',
      EMAIL_FROM: 'noreply@theresiansquest.com',
    },
    fetchImpl,
    logger,
    message: baseMessage,
    timeoutMs: 5,
  });

  assert.equal(result.sent, false);
  assert.equal(result.provider, null);
  assert.ok(Date.now() - startedAt < 250);
  assert.doesNotMatch(JSON.stringify(entries), /re_secret_api_key|123456/);
  assert.match(JSON.stringify(entries), /timeout/);
});

test('safe diagnostics omit provider secrets and email body content', async () => {
  const { entries, logger } = createLogger();
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => 'bad api key re_secret_api_key',
  });
  const smtpTransporter = {
    sendMail: async () => {
      throw new Error('bad smtp password gmail-app-password');
    },
  };

  const result = await sendEmailWithProviders({
    env: {
      RESEND_API_KEY: 're_secret_api_key',
      EMAIL_FROM: 'noreply@theresiansquest.com',
      EMAIL_USER: 'school@gmail.com',
      EMAIL_PASS: 'gmail-app-password',
    },
    fetchImpl,
    logger,
    message: baseMessage,
    smtpTransporter,
    timeoutMs: 50,
  });

  const serializedEntries = JSON.stringify(entries);
  assert.equal(result.sent, false);
  assert.doesNotMatch(serializedEntries, /re_secret_api_key|gmail-app-password|123456/);
  assert.match(serializedEntries, /hasResendApiKey/);
  assert.match(serializedEntries, /hasEmailPass/);
  assert.match(serializedEntries, /status_401/);
});
