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

const sanitizeProviderMessage = (value) => {
  const lower = String(value || '').toLowerCase();
  if (lower.includes('testing') && lower.includes('own email')) {
    return 'Resend account is restricted to verified test recipients.';
  }
  if (lower.includes('domain') && (lower.includes('not verified') || lower.includes('verify'))) {
    return 'Sender domain is not verified by Resend.';
  }
  if (lower.includes('from') && (lower.includes('invalid') || lower.includes('sender'))) {
    return 'Sender address is invalid.';
  }
  if (lower.includes('recipient') && (lower.includes('invalid') || lower.includes('not allowed'))) {
    return 'Recipient address is invalid or not allowed.';
  }

  const message = String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/re_[A-Za-z0-9_/-]+/g, '[resend_api_key]')
    .replace(/\b\d{6}\b/g, '[six_digit_code]')
    .replace(/\s+/g, ' ')
    .trim();

  return message ? message.slice(0, 180) : null;
};

const extractStatusCode = (error) => (
  error?.statusCode
  || error?.status_code
  || error?.status
  || error?.response?.status
  || null
);

const extractProviderMessage = (error) => (
  error?.message || error?.error || error?.response?.data?.message || null
);

const classifySafeProviderMessage = (error) => {
  const message = String(extractProviderMessage(error) || '').toLowerCase();
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

const extractRecipientDomain = (email) => {
  const value = String(email || '').trim().toLowerCase();
  const atIndex = value.lastIndexOf('@');
  if (atIndex < 0 || atIndex === value.length - 1) return null;
  const domain = value.slice(atIndex + 1).replace(/[^a-z0-9.-]/g, '');
  return domain || null;
};

const hasAny = (...values) => values.some((value) => String(value || '').trim() !== '');

const normalizeEmailRole = (role) => {
  const normalized = sanitizeReason(role, 'unknown');
  return normalized === 'parent_teacher' ? 'parent_teacher' : normalized;
};

const resolveSafeEmailFailureReason = ({ env = {}, result = {} }) => {
  if (result.sent) return null;
  if (result.sent !== false) return null;
  if (!hasAny(env.RESEND_API_KEY)) return 'missing_resend_api_key';
  if (!hasAny(env.EMAIL_FROM, env.MAIL_FROM, env.SMTP_FROM)) return 'missing_email_from';

  const knownReasons = new Set([
    'sender_domain_not_verified',
    'resend_testing_recipient_restricted',
    'invalid_sender',
    'invalid_recipient',
    'timeout',
    'sdk_unavailable',
  ]);
  if (knownReasons.has(result.reason)) return result.reason;
  if (String(result.provider || '').toLowerCase() === 'resend') return 'unknown_resend_error';
  return sanitizeReason(result.reason, 'unknown_resend_error');
};

const buildSafeEmailLogDetails = ({
  env = {},
  emailType = 'unknown',
  role = 'unknown',
  message = {},
  result = {},
}) => {
  const diagnostics = buildMailDiagnostics(env);
  return {
    emailType: sanitizeReason(emailType, 'unknown'),
    role: normalizeEmailRole(role),
    recipientDomain: extractRecipientDomain(message.to),
    provider: result.provider || diagnostics.primaryProvider || 'none',
    statusCode: result.statusCode || null,
    reason: resolveSafeEmailFailureReason({ env, result }),
    sanitizedResendErrorMessage: result.sanitizedResendErrorMessage || null,
    hasEmailFrom: Boolean(hasAny(env.EMAIL_FROM, env.MAIL_FROM)),
    hasSmtpFrom: Boolean(hasAny(env.SMTP_FROM)),
    hasAppUrl: Boolean(hasAny(env.APP_URL, env.FRONTEND_URL, env.PUBLIC_URL)),
  };
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
        sanitizedResendErrorMessage: sanitizeProviderMessage(extractProviderMessage(error)),
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
      sanitizedResendErrorMessage: sanitizeProviderMessage(extractProviderMessage(error)),
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
    sanitizedResendErrorMessage: resendResult.sanitizedResendErrorMessage || null,
    diagnostics,
  });

  return {
    sent: false,
    provider: 'resend',
    reason: resendResult.reason,
    statusCode: resendResult.statusCode || null,
    sanitizedResendErrorMessage: resendResult.sanitizedResendErrorMessage || null,
  };
};

module.exports = {
  buildSafeEmailLogDetails,
  DEFAULT_EMAIL_SEND_TIMEOUT_MS,
  RESEND_EMAILS_URL,
  getEmailSendTimeoutMs,
  isProductionEmailRuntime,
  sendEmailWithProviders,
  shouldUseSmtpFallback,
};
