const crypto = require('node:crypto');

const SAVE_COMMIT_ID_MAX_LENGTH = 128;
const SAVE_COMMIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

function inspectSaveCommitId(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'save_commit_id')) {
    return { provided: false, valid: true, value: null };
  }

  const value = body.save_commit_id;
  const valid = typeof value === 'string'
    && value.length > 0
    && value.length <= SAVE_COMMIT_ID_MAX_LENGTH
    && SAVE_COMMIT_ID_PATTERN.test(value);
  return { provided: true, valid, value: valid ? value : null };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hashProgressSavePayload(payload) {
  return sha256(JSON.stringify(canonicalize(payload)));
}

function hashSaveCommitId(commitId) {
  return sha256(commitId);
}

function buildProgressActivityEventKey(learningCycleVersion, commitIdHash) {
  return `game-progress-save:${learningCycleVersion}:${commitIdHash}`;
}

module.exports = {
  SAVE_COMMIT_ID_MAX_LENGTH,
  inspectSaveCommitId,
  hashProgressSavePayload,
  hashSaveCommitId,
  buildProgressActivityEventKey,
};
