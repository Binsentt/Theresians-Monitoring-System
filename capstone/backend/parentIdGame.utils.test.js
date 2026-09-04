const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeParentCode,
  normalizeNewStudentCode,
  normalizeExistingStudentCode,
  normalizeGameStudentName,
  buildGameStudentEmail,
  toNullableNumber,
  resolveProgressPercentage,
  resolveAccuracyRate,
} = require('./parentIdGame.utils');

test('normalizes only exact six digit parent IDs', () => {
  assert.equal(normalizeParentCode('482915'), '482915');
  assert.equal(normalizeParentCode(' 482915 '), '482915');
  assert.equal(normalizeParentCode('48291'), null);
  assert.equal(normalizeParentCode('4829157'), null);
  assert.equal(normalizeParentCode('ABC915'), null);
});

test('separates new Student creation from legacy-compatible Student lookup', () => {
  assert.equal(normalizeNewStudentCode('00123456'), '00123456');
  for (const invalidNewCode of ['001234', '1234567', '123456789', ' 00123456 ', '12A45678', '1234-5678']) {
    assert.equal(normalizeNewStudentCode(invalidNewCode), null, invalidNewCode);
  }

  assert.equal(normalizeExistingStudentCode('001234'), '001234');
  assert.equal(normalizeExistingStudentCode('00123456'), '00123456');
  for (const invalidLookupCode of ['12345', '1234567', '123456789', ' 001234 ', '12A456']) {
    assert.equal(normalizeExistingStudentCode(invalidLookupCode), null, invalidLookupCode);
  }
});

test('normalizes game student names for duplicate matching', () => {
  assert.equal(normalizeGameStudentName('  Juan   Dela   Cruz  '), 'Juan Dela Cruz');
  assert.equal(normalizeGameStudentName(''), '');
  assert.equal(normalizeGameStudentName(null), '');
});

test('builds a deterministic non-login student email per parent and name', () => {
  assert.equal(
    buildGameStudentEmail(12, 'Juan Dela Cruz'),
    'game-student+12-juan-dela-cruz@theresian.local'
  );
  assert.equal(
    buildGameStudentEmail(12, '!!!'),
    'game-student+12-player@theresian.local'
  );
});

test('resolves numeric gameplay values without saving invalid numbers', () => {
  assert.equal(toNullableNumber('42'), 42);
  assert.equal(toNullableNumber(0), 0);
  assert.equal(toNullableNumber(''), null);
  assert.equal(toNullableNumber('abc'), null);
});

test('uses the explicit authoritative total progress before legacy progress fields', () => {
  assert.equal(resolveProgressPercentage({ progress_percentage: 72, lesson_progress: 64, quest_progress: 41 }), 72);
  assert.equal(resolveProgressPercentage({ completion_percentage: 68, lesson_progress: 64, quest_progress: 41 }), 68);
  assert.equal(resolveProgressPercentage({ lesson_progress: 64, quest_progress: 41 }), 64);
  assert.equal(resolveProgressPercentage({ quest_progress: '41' }), 41);
  assert.equal(resolveProgressPercentage({}), 0);
});

test('uses explicit accuracy or computes it from correct and total answers', () => {
  assert.equal(resolveAccuracyRate({ accuracy_rate: 88.5, correct_answers: 1, total_questions: 2 }), 88.5);
  assert.equal(resolveAccuracyRate({ correct_answers: 3, total_questions: 4 }), 75);
  assert.equal(resolveAccuracyRate({ correct_answers: 3, total_questions: 0 }), 0);
});
