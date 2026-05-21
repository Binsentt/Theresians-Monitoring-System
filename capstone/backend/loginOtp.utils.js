const DEFAULT_OTP_EMAIL_TIMEOUT_MS = 12000;
const OTP_EMAIL_FAILURE_WARNING = 'Verification code could not be sent. Please resend the code or contact an administrator.';
const MAX_LOGIN_DEVICE_ID_LENGTH = 160;

const normalizeLoginEmail = (value) => String(value || '').toLowerCase().trim();
const normalizeLoginDeviceId = (value) => {
  const deviceId = String(value || '').trim();
  return deviceId.length <= MAX_LOGIN_DEVICE_ID_LENGTH ? deviceId : '';
};

const buildLoginAccountLookup = (email) => ({
  text: 'SELECT * FROM public.accounts WHERE LOWER(TRIM(email)) = $1 LIMIT 1',
  values: [normalizeLoginEmail(email)],
});

const buildLoginDeviceSkipLookup = (userId, deviceId) => ({
  text: `SELECT otp_skipped_until
         FROM public.login_otp_device_skips
         WHERE user_id = $1
           AND device_id = $2
           AND otp_skipped_until > CURRENT_TIMESTAMP
         LIMIT 1`,
  values: [userId, normalizeLoginDeviceId(deviceId)],
});

const buildLoginDeviceSkipUpsert = (userId, deviceId, expiresAt) => ({
  text: `INSERT INTO public.login_otp_device_skips (user_id, device_id, otp_skipped_until)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, device_id)
         DO UPDATE SET otp_skipped_until = EXCLUDED.otp_skipped_until,
                       updated_at = CURRENT_TIMESTAMP
         RETURNING user_id, device_id, otp_skipped_until`,
  values: [userId, normalizeLoginDeviceId(deviceId), expiresAt],
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
  buildLoginDeviceSkipLookup,
  buildLoginDeviceSkipUpsert,
  buildLoginAccountLookup,
  buildLoginOtpResponse,
  buildResendOtpResponse,
  normalizeLoginDeviceId,
  normalizeLoginEmail,
  resolveOtpEmailDelivery,
};
