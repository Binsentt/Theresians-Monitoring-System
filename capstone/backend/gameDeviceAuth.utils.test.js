'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authorizeDeviceWrite,
  hashOpaqueCredential,
  issueOpaqueCredential,
  verifyOpaqueCredential,
} = require('./gameDeviceAuth.utils');

const validContext = () => ({
  device: {
    active: true,
    revokedAt: null,
    expiresAt: '2030-01-01T00:00:00.000Z',
    parentId: 'parent-db-1',
    studentId: 'student-db-7',
  },
  parent: { active: true, id: 'parent-db-1' },
  relationship: { active: true, parentId: 'parent-db-1', studentId: 'student-db-7' },
  student: { active: true, id: 'student-db-7', currentLearningCycleVersion: 4 },
  request: { studentId: 'student-db-7', learningCycleVersion: 4 },
  nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
});

test('issued credentials contain 256 random bits and persistence receives only a digest', () => {
  const issued = issueOpaqueCredential('access');
  const tokenBytes = Buffer.from(issued.credential.split('_').at(-1), 'base64url');
  assert.equal(tokenBytes.length, 32);
  assert.match(issued.credentialHash, /^[a-f0-9]{64}$/);
  assert.notEqual(issued.credentialHash, issued.credential);
  assert.equal(Object.keys(issued).sort().join(','), 'credential,credentialHash');
  const persistedRecord = { credential_hash: issued.credentialHash };
  assert.equal(Object.hasOwn(persistedRecord, 'credential'), false);
  assert.equal(verifyOpaqueCredential(issued.credential, persistedRecord.credential_hash, 'access'), true);
});

test('separate credential issuance does not reuse a secret', () => {
  const first = issueOpaqueCredential('refresh');
  const second = issueOpaqueCredential('refresh');
  assert.notEqual(first.credential, second.credential);
  assert.notEqual(first.credentialHash, second.credentialHash);
});

test('credential verifier rejects tampering, kind confusion, malformed token and malformed digest', () => {
  const issued = issueOpaqueCredential('refresh');
  assert.equal(verifyOpaqueCredential(`${issued.credential}x`, issued.credentialHash, 'refresh'), false);
  assert.equal(verifyOpaqueCredential(issued.credential, issued.credentialHash, 'access'), false);
  assert.equal(verifyOpaqueCredential('tq_refresh_v1_short', issued.credentialHash), false);
  assert.equal(verifyOpaqueCredential(issued.credential, 'not-a-digest'), false);
  assert.throws(() => hashOpaqueCredential('tq_access_v1_short'), /Malformed/);
});

test('authorization succeeds only for active parent-linked device and canonical current-cycle student', () => {
  const result = authorizeDeviceWrite(validContext());
  assert.deepEqual(result, {
    authorized: true,
    code: 'AUTHORIZED',
    studentId: 'student-db-7',
    parentId: 'parent-db-1',
    learningCycleVersion: 4,
  });
});

test('authorization fails closed for missing context, expired, revoked or inactive credentials', () => {
  assert.equal(authorizeDeviceWrite().code, 'AUTH_CONTEXT_MISSING');
  const expired = validContext(); expired.device.expiresAt = expired.nowMs;
  assert.equal(authorizeDeviceWrite(expired).code, 'CREDENTIAL_EXPIRED');
  const revoked = validContext(); revoked.device.revokedAt = '2028-01-01T00:00:00Z';
  assert.equal(authorizeDeviceWrite(revoked).code, 'DEVICE_REVOKED');
  const inactive = validContext(); inactive.relationship.active = false;
  assert.equal(authorizeDeviceWrite(inactive).code, 'ACCOUNT_SCOPE_INACTIVE');
});

test('authorization rejects cross-student and cross-parent scope substitution', () => {
  const wrongStudent = validContext(); wrongStudent.request.studentId = 'student-db-8';
  assert.equal(authorizeDeviceWrite(wrongStudent).code, 'DEVICE_SCOPE_MISMATCH');
  const wrongParent = validContext(); wrongParent.device.parentId = 'parent-db-2';
  assert.equal(authorizeDeviceWrite(wrongParent).code, 'DEVICE_SCOPE_MISMATCH');
  const wrongRelationship = validContext(); wrongRelationship.relationship.studentId = 'student-db-8';
  assert.equal(authorizeDeviceWrite(wrongRelationship).code, 'DEVICE_SCOPE_MISMATCH');
});

test('authorization rejects stale learning-cycle writes without invalidating the student credential', () => {
  const stale = validContext(); stale.request.learningCycleVersion = 3;
  assert.equal(authorizeDeviceWrite(stale).code, 'LEARNING_CYCLE_CHANGED');
  const nextCycle = validContext();
  nextCycle.student.currentLearningCycleVersion = 5;
  nextCycle.request.learningCycleVersion = 5;
  assert.equal(authorizeDeviceWrite(nextCycle).authorized, true);
});

test('authorization rejects missing and non-integer cycle metadata', () => {
  const missing = validContext(); delete missing.request.learningCycleVersion;
  assert.equal(authorizeDeviceWrite(missing).code, 'LEARNING_CYCLE_INVALID');
  const fractional = validContext(); fractional.request.learningCycleVersion = 4.5;
  assert.equal(authorizeDeviceWrite(fractional).code, 'LEARNING_CYCLE_INVALID');
});
