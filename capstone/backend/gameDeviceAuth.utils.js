'use strict';

const crypto = require('node:crypto');

const CREDENTIAL_KINDS = new Set(['pairing', 'access', 'refresh']);
const CREDENTIAL_PATTERN = /^tq_(pairing|access|refresh)_v1_([A-Za-z0-9_-]{43})$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Issue an opaque 256-bit credential. The returned plaintext is for one-time
 * delivery only; callers must persist only credentialHash.
 */
const issueOpaqueCredential = (kind) => {
  if (!CREDENTIAL_KINDS.has(kind)) throw new TypeError('Unsupported credential kind.');
  const credential = `tq_${kind}_v1_${crypto.randomBytes(32).toString('base64url')}`;
  return Object.freeze({ credential, credentialHash: hashOpaqueCredential(credential, kind) });
};

const hashOpaqueCredential = (credential, expectedKind = null) => {
  const match = typeof credential === 'string' ? CREDENTIAL_PATTERN.exec(credential) : null;
  if (!match || (expectedKind !== null && match[1] !== expectedKind)) {
    throw new TypeError('Malformed or unexpected device credential.');
  }
  return crypto.createHash('sha256').update(credential, 'utf8').digest('hex');
};

/** Compare a presented secret to a stored SHA-256 digest without early exit. */
const verifyOpaqueCredential = (credential, storedHash, expectedKind = null) => {
  if (typeof storedHash !== 'string' || !SHA256_HEX_PATTERN.test(storedHash)) return false;
  let presentedHash;
  try {
    presentedHash = hashOpaqueCredential(credential, expectedKind);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(presentedHash, 'hex'), Buffer.from(storedHash, 'hex'));
};

const deny = (code) => Object.freeze({ authorized: false, code });

/**
 * Pure fail-closed policy for a request after the route has loaded the device,
 * parent, relationship, student and current cycle from authoritative storage.
 * It never treats request-body IDs as authority and never changes the database.
 */
const authorizeDeviceWrite = ({ device, parent, relationship, student, request = {}, nowMs = Date.now() } = {}) => {
  if (!Number.isFinite(nowMs) || !device || !parent || !relationship || !student) return deny('AUTH_CONTEXT_MISSING');
  if (device.active !== true || device.revokedAt !== null) return deny('DEVICE_REVOKED');
  const expiresAtMs = typeof device.expiresAt === 'number' ? device.expiresAt : Date.parse(device.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return deny('CREDENTIAL_EXPIRED');
  if (parent.active !== true || relationship.active !== true || student.active !== true) return deny('ACCOUNT_SCOPE_INACTIVE');

  const deviceStudentId = String(device.studentId ?? '').trim();
  const canonicalStudentId = String(student.id ?? '').trim();
  const parentStudentId = String(relationship.studentId ?? '').trim();
  const relationshipParentId = String(relationship.parentId ?? '').trim();
  const deviceParentId = String(device.parentId ?? '').trim();
  const canonicalParentId = String(parent.id ?? '').trim();
  if (!deviceStudentId || !canonicalStudentId || !canonicalParentId
      || deviceStudentId !== canonicalStudentId || parentStudentId !== canonicalStudentId
      || relationshipParentId !== canonicalParentId || deviceParentId !== canonicalParentId) {
    return deny('DEVICE_SCOPE_MISMATCH');
  }

  const submittedStudentId = request.studentId == null ? '' : String(request.studentId).trim();
  if (submittedStudentId && submittedStudentId !== canonicalStudentId) return deny('DEVICE_SCOPE_MISMATCH');

  const currentCycle = student.currentLearningCycleVersion;
  const requestedCycle = request.learningCycleVersion;
  if (!Number.isSafeInteger(currentCycle) || !Number.isSafeInteger(requestedCycle)) return deny('LEARNING_CYCLE_INVALID');
  if (requestedCycle !== currentCycle) return deny('LEARNING_CYCLE_CHANGED');

  return Object.freeze({
    authorized: true,
    code: 'AUTHORIZED',
    studentId: canonicalStudentId,
    parentId: canonicalParentId,
    learningCycleVersion: currentCycle,
  });
};

module.exports = {
  authorizeDeviceWrite,
  hashOpaqueCredential,
  issueOpaqueCredential,
  verifyOpaqueCredential,
};
