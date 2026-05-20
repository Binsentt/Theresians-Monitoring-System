const DEFAULT_OTP_EMAIL_TIMEOUT_MS = 12000;
const OTP_EMAIL_FAILURE_WARNING = 'Verification code could not be sent. Please resend the code or contact an administrator.';

const normalizeLoginEmail = (value) => String(value || '').toLowerCase().trim();

const buildLoginAccountLookup = (email) => ({
  text: 'SELECT * FROM public.accounts WHERE LOWER(TRIM(email)) = $1 LIMIT 1',
  values: [normalizeLoginEmail(email)],
});

const resolveOtpEmailDelivery = async (
  sendEmail,
  timeoutMs = DEFAULT_OTP_EMAIL_TIMEOUT_MS
) => {
  let timeoutId;
  const delay = Math.max(1, Number(timeoutMs) || DEFAULT_OTP_EMAIL_TIMEOUT_MS);
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), delay);
  });

  try {
    return Boolean(await Promise.race([sendEmail(), timeout]));
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
};

const buildLoginOtpResponse = ({ user, expiresAt, emailSent }) => {
  const response = {
    success: true,
    step: 2,
    userId: user.id,
    email: user.email,
    otpExpiresAt: expiresAt,
    emailSent: Boolean(emailSent),
  };

  if (!emailSent) {
    response.warning = OTP_EMAIL_FAILURE_WARNING;
  }

  return response;
};

const buildResendOtpResponse = ({ expiresAt, emailSent }) => {
  const response = {
    success: true,
    otpExpiresAt: expiresAt,
    emailSent: Boolean(emailSent),
  };

  if (!emailSent) {
    response.warning = OTP_EMAIL_FAILURE_WARNING;
  }

  return response;
};

module.exports = {
  buildLoginAccountLookup,
  buildLoginOtpResponse,
  buildResendOtpResponse,
  normalizeLoginEmail,
  resolveOtpEmailDelivery,
};
