const ACTIVE_GENERATION_STATUSES = new Set(['queued', 'extracting', 'generating', 'validating', 'saving']);
const normalizeQuestionText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

const getQuestionCountState = (learningFile = {}, currentQuestionCount = 0) => {
  const requested = Number(learningFile.requested_question_count);
  const current = Math.max(0, Number(currentQuestionCount) || 0);
  const applies = String(learningFile.file_type || '').toLowerCase() === 'lesson' && Number.isInteger(requested) && requested > 0;
  if (!applies) return { applies: false, requested: null, current, missing: 0 };
  return { applies: true, requested, current, missing: Math.max(0, requested - current) };
};

const buildQuestionCountEligibility = (learningFile = {}, currentQuestionCount = 0, action = 'approval') => {
  const state = getQuestionCountState(learningFile, currentQuestionCount);
  if (!state.applies || state.missing === 0) return { eligible: true, code: 'ELIGIBLE', state };
  const noun = state.missing === 1 ? 'question' : 'questions';
  const actionLabel = action === 'publication' ? 'Push to Game' : 'approval';
  return { eligible: false, code: 'QUESTION_COUNT_INCOMPLETE', state, message: `${state.current} of ${state.requested} questions are currently available. Add ${state.missing} ${noun} before ${actionLabel}.` };
};

const findDuplicateQuestion = (questions = [], questionText, { excludeId = null } = {}) => {
  const normalized = normalizeQuestionText(questionText);
  if (!normalized) return null;
  return (Array.isArray(questions) ? questions : []).find((question) => Number(question.id) !== Number(excludeId) && normalizeQuestionText(question.question) === normalized) || null;
};
const isQuestionGenerationActive = (status) => ACTIVE_GENERATION_STATUSES.has(String(status || '').trim().toLowerCase());

module.exports = { ACTIVE_GENERATION_STATUSES, buildQuestionCountEligibility, findDuplicateQuestion, getQuestionCountState, isQuestionGenerationActive, normalizeQuestionText };
