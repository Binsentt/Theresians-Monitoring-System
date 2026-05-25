const {
  buildMailDiagnostics,
  buildResendEmailConfig,
} = require('./emailTransport.utils');

// Kept for compatibility with older tests/imports; delivery now uses the Resend SDK.
const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const DEFAULT_EMAIL_SEND_TIMEOUT_MS = 8000;

let cachedResendClient = null;

const parsePositiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const getEmailSendTimeoutMs = (env = {}) => (
  parsePositiveInt(env.EMAIL_SEND_TIMEOUT_MS ?? env.RESEND_TIMEOUT_MS, DEFAULT_EMAIL_SEND_TIMEOUT_MS)
);

const isProductionEmailRuntime = (env = {}) => (
  String(env.NODE_ENV || '').toLowerCase() === 'production'
  || Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID)
);

const shouldUseSmtpFallback = (env = {}) => (
  !isProductionEmailRuntime(env) && String(env.DISABLE_SMTP_FALLBACK || '').toLowerCase() !== 'true'
);

const loadResendClient = async () => {
  if (!cachedResendClient) {
    const resendModule = await import('resend');
    cachedResendClient = resendModule.Resend;
  }

  if (typeof cachedResendClient !== 'function') {
    const error = new Error('Resend SDK client is unavailable');
    error.code = 'RESEND_SDK_UNAVAILABLE';
    throw error;
  }

  return cachedResendClient;
};

const sanitizeReason = (value, fallback = 'send_failed') => {
  const reason = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return reason || fallback;
};

const extractStatusCode = (error) => (
  error?.statusCode
  || error?.status_code
  || error?.status
  || error?.response?.status
  || null
);

const classifySafeProviderMessage = (error) => {
  const message = String(error?.message || error?.error || error?.response?.data?.message || '').toLowerCase();
  if (!message) return null;

  if (message.includes('testing') && message.includes('own email')) {
    return 'resend_testing_recipient_restricted';
  }
  if (message.includes('domain') && (message.includes('not verified') || message.includes('verify'))) {
    return 'sender_domain_not_verified';
  }
  if (message.includes('from') && (message.includes('invalid') || message.includes('sender'))) {
    return 'invalid_sender';
  }
  if (message.includes('recipient') && (message.includes('invalid') || message.includes('not allowed'))) {
    return 'invalid_recipient';
  }

  return null;
};

const classifySendError = (error) => {
  if (!error) return 'send_failed';
  if (error.name === 'AbortError') return 'timeout';

  const safeProviderReason = classifySafeProviderMessage(error);
  if (safeProviderReason) return safeProviderReason;

  const statusCode = extractStatusCode(error);
  if (statusCode) return `status_${statusCode}`;

  if (['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'RESEND_SDK_UNAVAILABLE'].includes(error.code)) {
    return 'sdk_unavailable';
  }
  if (error.code) return sanitizeReason(error.code);
  if (error.name) return sanitizeReason(error.name);

  return 'send_failed';
};

const createTimeoutResult = (timeoutMs) => {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(
      () => resolve({ timedOut: true }),
      Math.max(1, Number(timeoutMs) || DEFAULT_EMAIL_SEND_TIMEOUT_MS)
    );
  });

  return {
    clear: () => clearTimeout(timeoutId),
    timeout,
  };
};

const withTimeout = async (operation, timeoutMs) => {
  const { clear, timeout } = createTimeoutResult(timeoutMs);

  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      timeout,
    ]);
    return result?.timedOut ? { timedOut: true, value: null } : { timedOut: false, value: result };
  } finally {
    clear();
  }
};

const logSafe = (logger, level, message, details) => {
  const log = logger && typeof logger[level] === 'function' ? logger[level] : null;
  if (log) log.call(logger, message, details);
};

const sendViaResend = async ({ config, message, ResendClient, timeoutMs }) => {
  if (!config.enabled) {
    return { sent: false, provider: 'resend', reason: 'not_configured' };
  }

  try {
    const Client = ResendClient || await loadResendClient();
    const resend = new Client(config.apiKey);
    const result = await withTimeout(
      () => resend.emails.send({
        from: config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      }),
      timeoutMs
    );

    if (result.timedOut) {
      return { sent: false, provider: 'resend', reason: 'timeout' };
    }

    const { data, error } = result.value || {};
    if (error) {
      return {
        sent: false,
        provider: 'resend',
        reason: classifySendError(error),
        statusCode: extractStatusCode(error),
      };
    }

    return {
      sent: true,
      provider: 'resend',
      messageIdPresent: Boolean(data?.id),
    };
  } catch (error) {
    return {
      sent: false,
      provider: 'resend',
      reason: classifySendError(error),
      statusCode: extractStatusCode(error),
    };
  }
};

const sendEmailWithProviders = async ({
  env = process.env,
  fetchImpl: _fetchImpl = globalThis.fetch,
  logger = console,
  message,
  ResendClient = null,
  smtpTransporter: _smtpTransporter = null,
  timeoutMs = getEmailSendTimeoutMs(env),
}) => {
  const resendConfig = buildResendEmailConfig(env);
  const diagnostics = {
    ...buildMailDiagnostics(env),
    productionEmailRuntime: isProductionEmailRuntime(env),
    smtpFallbackAllowed: shouldUseSmtpFallback(env),
  };

  if (!resendConfig.enabled) {
    logSafe(logger, 'warn', 'Resend email delivery is not configured', {
      provider: 'resend',
      reason: resendConfig.reason || 'not_configured',
      diagnostics,
    });
    return {
      sent: false,
      provider: 'resend',
      reason: 'not_configured',
    };
  }

  const resendResult = await sendViaResend({
    config: resendConfig,
    message,
    ResendClient,
    timeoutMs,
  });

  if (resendResult.sent) {
    logSafe(logger, 'info', 'Email sent', {
      provider: 'resend',
      messageIdPresent: Boolean(resendResult.messageIdPresent),
      diagnostics,
    });
    return resendResult;
  }

  logSafe(logger, 'warn', 'Resend email delivery failed', {
    provider: 'resend',
    reason: resendResult.reason,
    statusCode: resendResult.statusCode || null,
    diagnostics,
  });

  return {
    sent: false,
    provider: 'resend',
    reason: resendResult.reason,
    statusCode: resendResult.statusCode || null,
  };
};

module.exports = {
  DEFAULT_EMAIL_SEND_TIMEOUT_MS,
  RESEND_EMAILS_URL,
  getEmailSendTimeoutMs,
  isProductionEmailRuntime,
  sendEmailWithProviders,
  shouldUseSmtpFallback,
};
