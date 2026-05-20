const {
  buildEmailFromAddress,
  buildEmailTransportConfig,
  buildMailDiagnostics,
  buildResendEmailConfig,
} = require('./emailTransport.utils');

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const DEFAULT_EMAIL_SEND_TIMEOUT_MS = 8000;

const parsePositiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const getEmailSendTimeoutMs = (env = {}) => (
  parsePositiveInt(env.EMAIL_SEND_TIMEOUT_MS ?? env.RESEND_TIMEOUT_MS, DEFAULT_EMAIL_SEND_TIMEOUT_MS)
);

const createTimeoutSignal = (timeoutMs) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_EMAIL_SEND_TIMEOUT_MS));
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
};

const classifySendError = (error) => {
  if (!error) return 'send_failed';
  if (error.name === 'AbortError') return 'timeout';
  if (error.code) return String(error.code);
  return 'send_failed';
};

const logSafe = (logger, level, message, details) => {
  const log = logger && typeof logger[level] === 'function' ? logger[level] : null;
  if (log) log.call(logger, message, details);
};

const sendViaResend = async ({ config, fetchImpl, message, timeoutMs }) => {
  if (!config.enabled) {
    return { sent: false, provider: 'resend', reason: 'not_configured' };
  }

  if (typeof fetchImpl !== 'function') {
    return { sent: false, provider: 'resend', reason: 'fetch_unavailable' };
  }

  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'theresian-portal/1.0',
      },
      body: JSON.stringify({
        from: config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      }),
      signal: timeout.signal,
    });

    if (!response.ok) {
      return {
        sent: false,
        provider: 'resend',
        reason: `status_${response.status || 'unknown'}`,
        statusCode: response.status || null,
      };
    }

    return {
      sent: true,
      provider: 'resend',
      statusCode: response.status || null,
    };
  } catch (error) {
    return {
      sent: false,
      provider: 'resend',
      reason: classifySendError(error),
    };
  } finally {
    timeout.clear();
  }
};

const sendViaSmtp = async ({ config, message, smtpTransporter }) => {
  if (!config.enabled || !smtpTransporter) {
    return { sent: false, provider: 'smtp', reason: 'not_configured' };
  }

  try {
    await smtpTransporter.sendMail({
      from: buildEmailFromAddress(config.env),
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
    return { sent: true, provider: 'smtp' };
  } catch (error) {
    return {
      sent: false,
      provider: 'smtp',
      reason: classifySendError(error),
    };
  }
};

const sendEmailWithProviders = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  message,
  smtpTransporter = null,
  timeoutMs = getEmailSendTimeoutMs(env),
}) => {
  const resendConfig = buildResendEmailConfig(env);
  const smtpConfig = {
    ...buildEmailTransportConfig(env),
    env,
  };
  const diagnostics = buildMailDiagnostics(env);

  if (resendConfig.enabled) {
    const resendResult = await sendViaResend({
      config: resendConfig,
      fetchImpl,
      message,
      timeoutMs,
    });

    if (resendResult.sent) {
      logSafe(logger, 'info', 'Email sent', {
        provider: 'resend',
        statusCode: resendResult.statusCode || null,
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
  }

  const smtpResult = await sendViaSmtp({
    config: smtpConfig,
    message,
    smtpTransporter,
  });

  if (smtpResult.sent) {
    logSafe(logger, 'info', 'Email sent', {
      provider: 'smtp',
      diagnostics,
    });
    return smtpResult;
  }

  logSafe(logger, 'warn', 'Email delivery failed', {
    provider: null,
    reason: smtpResult.reason,
    diagnostics,
  });

  return {
    sent: false,
    provider: null,
    reason: smtpResult.reason,
  };
};

module.exports = {
  DEFAULT_EMAIL_SEND_TIMEOUT_MS,
  RESEND_EMAILS_URL,
  getEmailSendTimeoutMs,
  sendEmailWithProviders,
};
