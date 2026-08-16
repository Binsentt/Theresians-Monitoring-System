const crypto = require('crypto');

const TEMPORARY_PASSWORD_TTL_MS = 30 * 60 * 1000;
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()_+-=[]{}|;:,.<>?';
const ALL_CHARACTERS = `${UPPERCASE}${LOWERCASE}${DIGITS}${SYMBOLS}`;

const pick = (characters, randomInt) => characters[randomInt(characters.length)];

const createTemporaryPassword = (randomInt = crypto.randomInt) => {
  let password = [
    pick(UPPERCASE, randomInt),
    pick(LOWERCASE, randomInt),
    pick(DIGITS, randomInt),
    pick(SYMBOLS, randomInt),
  ].join('');

  while (password.length < 14) {
    password += pick(ALL_CHARACTERS, randomInt);
  }

  return password;
};

const getTemporaryPasswordExpiry = (issuedAt = new Date()) => (
  new Date(new Date(issuedAt).getTime() + TEMPORARY_PASSWORD_TTL_MS)
);

const isTemporaryPasswordExpired = (expiresAt, now = new Date()) => {
  if (!expiresAt) return true;
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return true;
  return expiry.getTime() <= new Date(now).getTime();
};

module.exports = {
  TEMPORARY_PASSWORD_TTL_MS,
  createTemporaryPassword,
  getTemporaryPasswordExpiry,
  isTemporaryPasswordExpired,
};
