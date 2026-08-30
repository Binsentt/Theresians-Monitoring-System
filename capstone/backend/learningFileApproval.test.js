const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLearningFileApprovalFingerprint,
  buildPublicationApprovalEligibility,
  isApprovalCurrent,
} = require('./learningFileApproval.utils');

const validFile = {
  id: 91,
  file_type: 'fixed_questions',
  grade_level: 'Grade 1',
  difficulty: 'Easy',
  math_topic: 'Basic Addition',
  document_topic: 'Basic Addition',
};

const validQuestions = [
  {
    question: 'What is 2 + 3?',
    options: ['3', '4', '5', '6'],
    correct_answer: '5',
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: 'Basic Addition',
  },
];

test('approval fingerprints are stable for the reviewed question set and change when a question changes', () => {
  const fingerprint = buildLearningFileApprovalFingerprint(validFile, validQuestions);

  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, buildLearningFileApprovalFingerprint(validFile, validQuestions));
  assert.notEqual(fingerprint, buildLearningFileApprovalFingerprint(validFile, [{
    ...validQuestions[0],
    correct_answer: '6',
  }]));
});

test('publication requires a current explicit approval after structural review succeeds', () => {
  const fingerprint = buildLearningFileApprovalFingerprint(validFile, validQuestions);
  const baseEligibility = { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' };

  assert.deepEqual(
    buildPublicationApprovalEligibility({ ...validFile, approval_status: 'review_required' }, fingerprint, baseEligibility),
    {
      eligible: false,
      code: 'REVIEW_APPROVAL_REQUIRED',
      message: 'Approve this reviewed question set before Push to Game.',
    }
  );
  assert.equal(isApprovalCurrent({ ...validFile, approval_status: 'approved', approved_content_fingerprint: fingerprint }, fingerprint), true);
  assert.equal(isApprovalCurrent({ ...validFile, approval_status: 'approved', approved_content_fingerprint: 'stale' }, fingerprint), false);
});

test('already active legacy content remains available without granting a new pending publication a bypass', () => {
  const fingerprint = buildLearningFileApprovalFingerprint(validFile, validQuestions);
  const baseEligibility = { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' };

  assert.equal(
    buildPublicationApprovalEligibility({ ...validFile, approval_status: 'legacy_active', published: true }, fingerprint, baseEligibility).eligible,
    true
  );
  assert.equal(
    buildPublicationApprovalEligibility({ ...validFile, approval_status: 'legacy_active', published: false }, fingerprint, baseEligibility).eligible,
    false
  );
});
