const crypto = require('crypto');

const normalizeText = (value) => String(value ?? '').trim();

const buildLearningFileApprovalFingerprint = (learningFile = {}, questions = []) => {
  const payload = {
    file_type: normalizeText(learningFile.file_type),
    grade_level: normalizeText(learningFile.grade_level),
    difficulty: normalizeText(learningFile.difficulty),
    topic_id: normalizeText(learningFile.topic_id),
    math_topic: normalizeText(learningFile.math_topic),
    document_topic: normalizeText(learningFile.document_topic),
    questions: (Array.isArray(questions) ? questions : []).map((question) => ({
      question: normalizeText(question?.question),
      options: (Array.isArray(question?.options) ? question.options : []).map(normalizeText),
      correct_answer: normalizeText(question?.correct_answer),
      grade_level: normalizeText(question?.grade_level),
      difficulty: normalizeText(question?.difficulty),
      topic_id: normalizeText(question?.topic_id),
      math_topic: normalizeText(question?.math_topic),
    })),
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

const isApprovalCurrent = (learningFile = {}, currentFingerprint = '') => (
  normalizeText(learningFile.approval_status) === 'approved'
  && normalizeText(learningFile.approved_content_fingerprint) === normalizeText(currentFingerprint)
);

const buildPublicationApprovalEligibility = (learningFile = {}, currentFingerprint = '', baseEligibility = {}) => {
  if (!baseEligibility?.eligible) return baseEligibility;
  if (isApprovalCurrent(learningFile, currentFingerprint)) return baseEligibility;
  if (normalizeText(learningFile.approval_status) === 'legacy_active' && learningFile.published === true) {
    return baseEligibility;
  }
  return {
    eligible: false,
    code: 'REVIEW_APPROVAL_REQUIRED',
    message: 'Approve this reviewed question set before Push to Game.',
  };
};

module.exports = {
  buildLearningFileApprovalFingerprint,
  buildPublicationApprovalEligibility,
  isApprovalCurrent,
};
