const parsePositiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const firstPresent = (...values) => values.find((value) => String(value || '').trim() !== '');

const getMailUser = (env = {}) => firstPresent(env.EMAIL_USER, env.SMTP_USER, env.SMTP_USERNAME, env.MAIL_USER);
const getMailPass = (env = {}) => firstPresent(env.EMAIL_PASS, env.SMTP_PASS, env.SMTP_PASSWORD, env.MAIL_PASS);
const getMailHost = (env = {}) => firstPresent(env.SMTP_HOST, env.MAIL_HOST);
const getMailService = (env = {}) => firstPresent(env.SMTP_SERVICE, env.EMAIL_SERVICE, env.MAIL_SERVICE);
const getMailFrom = (env = {}) => firstPresent(env.EMAIL_FROM, env.MAIL_FROM, env.SMTP_FROM, getMailUser(env));
const getExplicitMailFrom = (env = {}) => firstPresent(env.EMAIL_FROM, env.MAIL_FROM, env.SMTP_FROM);
const getResendApiKey = (env = {}) => firstPresent(env.RESEND_API_KEY);

const resolveAppUrl = (env = {}) => (
  firstPresent(env.APP_URL, env.FRONTEND_URL, env.PUBLIC_URL) || 'https://theresiansquest.com/login'
);

const buildEmailTransportConfig = (env = {}) => {
  const user = getMailUser(env);
  const pass = getMailPass(env);
  if (!user || !pass) {
    return {
      enabled: false,
      options: null,
      reason: 'EMAIL_USER and EMAIL_PASS, or SMTP_USER and SMTP_PASS, are required for email delivery.',
    };
  }

  const host = getMailHost(env);
  const service = getMailService(env);
  const secure = parseBoolean(env.SMTP_SECURE ?? env.MAIL_SECURE, false);
  const options = {
    auth: { user, pass },
    connectionTimeout: parsePositiveInt(env.SMTP_CONNECTION_TIMEOUT_MS, 10000),
    greetingTimeout: parsePositiveInt(env.SMTP_GREETING_TIMEOUT_MS, 10000),
    socketTimeout: parsePositiveInt(env.SMTP_SOCKET_TIMEOUT_MS, 15000),
  };

  if (host) {
    options.host = host;
    options.port = parsePositiveInt(env.SMTP_PORT ?? env.MAIL_PORT, secure ? 465 : 587);
    options.secure = secure;
  } else {
    options.service = service || 'gmail';
  }

  return { enabled: true, options, reason: null };
};

const extractAddressFromFormattedSender = (value) => {
  const match = String(value || '').trim().match(/<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  return match ? match[1] : null;
};

const isFormattedSenderAddress = (value) => (
  /^[^<>\r\n]+<\s*[^<>\s]+@[^<>\s]+\s*>$/.test(String(value || '').trim())
);

const buildEmailFromAddress = (env = {}) => {
  const from = String(getMailFrom(env) || '').trim();
  if (isFormattedSenderAddress(from)) {
    return from;
  }

  const senderAddress = extractAddressFromFormattedSender(from) || from;
  const name = firstPresent(env.EMAIL_FROM_NAME, env.MAIL_FROM_NAME) || 'Saint Therese School';
  return `"${String(name).replace(/"/g, '\\"')}" <${senderAddress}>`;
};

const buildResendEmailConfig = (env = {}) => {
  const apiKey = getResendApiKey(env);
  const from = getExplicitMailFrom(env);

  if (!apiKey || !from) {
    return {
      enabled: false,
      apiKey: null,
      from: null,
      reason: 'RESEND_API_KEY and EMAIL_FROM or SMTP_FROM are required for Resend email delivery.',
    };
  }

  return {
    enabled: true,
    apiKey,
    from: buildEmailFromAddress(env),
    reason: null,
  };
};

const buildMailDiagnostics = (env = {}) => {
  const secureValue = env.SMTP_SECURE ?? env.MAIL_SECURE;
  const resendConfig = buildResendEmailConfig(env);
  const smtpConfig = buildEmailTransportConfig(env);
  return {
    primaryProvider: resendConfig.enabled ? 'resend' : smtpConfig.enabled ? 'smtp' : 'none',
    resendEnabled: resendConfig.enabled,
    hasResendApiKey: Boolean(getResendApiKey(env)),
    smtpHost: getMailHost(env) || null,
    smtpPort: env.SMTP_PORT || env.MAIL_PORT ? parsePositiveInt(env.SMTP_PORT ?? env.MAIL_PORT, null) : null,
    smtpSecure: secureValue === undefined ? null : parseBoolean(secureValue, false),
    smtpService: getMailService(env) || null,
    hasEmailUser: Boolean(getMailUser(env)),
    hasEmailPass: Boolean(getMailPass(env)),
    hasEmailFrom: Boolean(firstPresent(env.EMAIL_FROM, env.MAIL_FROM, env.SMTP_FROM)),
    appUrl: resolveAppUrl(env),
  };
};

module.exports = {
  buildEmailFromAddress,
  buildEmailTransportConfig,
  buildMailDiagnostics,
  buildResendEmailConfig,
  resolveAppUrl,
};
