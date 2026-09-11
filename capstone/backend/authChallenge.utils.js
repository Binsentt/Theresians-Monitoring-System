const crypto = require('crypto');

const OTP_LENGTH = 6;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;
const DEFAULT_OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const LOGIN_OTP_TTL_MS = 3 * 60 * 1000;
const RECOVERY_OTP_TTL_MS = 10 * 60 * 1000;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getOtpMaxAttempts = (env = process.env) => parsePositiveInt(env.OTP_MAX_ATTEMPTS, DEFAULT_OTP_MAX_ATTEMPTS);
const getOtpResendCooldownMs = (env = process.env) => parsePositiveInt(env.OTP_RESEND_COOLDOWN_MS, DEFAULT_OTP_RESEND_COOLDOWN_MS);

const normalizeOtpCode = (value) => String(value ?? '').trim();
const isOtpCodeFormatValid = (value) => /^\d{6}$/.test(normalizeOtpCode(value));

const generateOtpCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0');

const hashOtpCode = (code, challengeId, secret = process.env.JWT_SECRET || 'change-this-in-production') => crypto
  .createHmac('sha256', secret)
  .update(`${String(challengeId)}:${normalizeOtpCode(code)}`)
  .digest('hex');

const createOtpChallenge = ({ purpose, ttlMs, now = new Date(), secret } = {}) => {
  const challengeId = crypto.randomUUID();
  const code = generateOtpCode();
  const issuedAt = now instanceof Date ? now : new Date(now);
  const expiresAt = new Date(issuedAt.getTime() + Number(ttlMs || LOGIN_OTP_TTL_MS));
  return {
    purpose: String(purpose || '').trim(),
    challengeId,
    code,
    codeHash: hashOtpCode(code, challengeId, secret),
    issuedAt,
    expiresAt,
  };
};

const isOtpExpired = (value, now = new Date()) => {
  const expiresAt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(expiresAt.getTime()) || expiresAt <= now;
};

const isOtpResendCoolingDown = (sentAt, now = new Date(), cooldownMs = DEFAULT_OTP_RESEND_COOLDOWN_MS) => {
  if (!sentAt) return false;
  const issuedAt = sentAt instanceof Date ? sentAt : new Date(sentAt);
  if (Number.isNaN(issuedAt.getTime())) return false;
  return now.getTime() - issuedAt.getTime() < Number(cooldownMs);
};

module.exports = {
  DEFAULT_OTP_MAX_ATTEMPTS,
  DEFAULT_OTP_RESEND_COOLDOWN_MS,
  LOGIN_OTP_TTL_MS,
  RECOVERY_OTP_TTL_MS,
  createOtpChallenge,
  generateOtpCode,
  getOtpMaxAttempts,
  getOtpResendCooldownMs,
  hashOtpCode,
  isOtpCodeFormatValid,
  isOtpExpired,
  isOtpResendCoolingDown,
  normalizeOtpCode,
};
