const {
  getTopicById,
  isValidScope,
  normalizeDifficulty,
  normalizeGradeLevel,
  normalizeTopicId,
  resolveLegacyDisplayTopic,
} = require('./curriculumScopeRegistry');

const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const getQuestionIndex = (question = {}) => {
  const value = Number(question.source_index);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const detectArithmeticTopicId = (questionText) => {
  const text = normalizeText(questionText).toLowerCase();
  // Fixed Question scope checks use only a proved, exclusive arithmetic
  // expression. Words such as "sum" or "difference" are not a safe
  // classifier and must not override the teacher's selected canonical scope.
  const hasAddition = /\d\s*\+\s*\d/.test(text);
  const hasSubtraction = /\d\s*(?:-|−)\s*\d/.test(text);

  if (hasAddition && !hasSubtraction) return 'basic_addition';
  if (hasSubtraction && !hasAddition) return 'subtraction';
  return null;
};

const resolveSelectedScope = (scope = {}) => {
  const grade_level = normalizeGradeLevel(scope.grade_level || scope.grade);
  const difficulty = normalizeDifficulty(scope.difficulty);
  const rawTopicId = normalizeText(scope.topic_id);
  const topic_id = rawTopicId
    ? normalizeTopicId(rawTopicId)
    : resolveLegacyDisplayTopic(
      grade_level,
      difficulty,
      scope.math_topic || scope.topic,
    );
  if (!grade_level || !difficulty || !topic_id || !isValidScope(grade_level, difficulty, topic_id)) return null;
  return {
    grade_level,
    difficulty,
    topic_id,
    display_label: getTopicById(topic_id).display_label,
  };
};

const assessmentWithSourceIndex = (assessment, sourceIndex) => ({
  ...assessment,
  ...(sourceIndex ? { source_index: sourceIndex } : {}),
});

const assessQuestionScope = (question = {}, scope = {}) => {
  const sourceIndex = getQuestionIndex(question);
  const selectedScope = resolveSelectedScope(scope);
  if (!selectedScope) {
    return assessmentWithSourceIndex({
      status: 'unverified',
      code: 'QUESTION_SCOPE_INVALID',
    }, sourceIndex);
  }

  if (selectedScope.topic_id === 'basic_addition' || selectedScope.topic_id === 'subtraction') {
    const detectedTopicId = detectArithmeticTopicId(question.question);
    if (detectedTopicId && detectedTopicId !== selectedScope.topic_id) {
      return assessmentWithSourceIndex({
        status: 'mismatch',
        detected_topic: getTopicById(detectedTopicId).display_label,
        code: 'QUESTION_TOPIC_MISMATCH',
      }, sourceIndex);
    }
  }

  // The selected set scope is authoritative. Optional source topic metadata
  // remains readable provenance only; it is never required or classified.
  return assessmentWithSourceIndex({ status: 'match' }, sourceIndex);
};

const buildQuestionScopeMessage = (assessment, selectedTopic) => {
  const questionLabel = assessment.source_index ? `Question ${assessment.source_index}` : 'A question';
  if (assessment.code === 'QUESTION_TOPIC_MISMATCH') {
    return `${questionLabel} conflicts with selected Topic: ${selectedTopic}.`;
  }
  if (assessment.code === 'QUESTION_SCOPE_INVALID') {
    return 'The selected Grade, Difficulty, and Topic scope is not supported by the canonical curriculum registry.';
  }
  return 'The selected Grade, Difficulty, and Topic scope is not supported by the canonical curriculum registry.';
};

const validateQuestionSetScope = ({
  selected_scope: selectedScopeInput = {},
  questions,
} = {}) => {
  const selectedScope = resolveSelectedScope(selectedScopeInput);
  if (!selectedScope) {
    return {
      isValid: false,
      code: 'QUESTION_SCOPE_INVALID',
      message: 'The selected Grade, Difficulty, and Topic scope is not supported by the canonical curriculum registry.',
      question_errors: [],
    };
  }

  const questionErrors = (Array.isArray(questions) ? questions : [])
    .map((question) => assessQuestionScope(question, selectedScope))
    .filter((assessment) => assessment.status !== 'match')
    .map((assessment) => ({
      source_index: assessment.source_index || null,
      code: assessment.code,
      message: buildQuestionScopeMessage(assessment, selectedScope.display_label),
    }));

  if (questionErrors.length > 0) {
    return {
      isValid: false,
      code: questionErrors[0].code,
      message: questionErrors[0].message,
      question_errors: questionErrors,
    };
  }

  return {
    isValid: true,
    code: 'ELIGIBLE',
    message: 'Question scope matches the selected game publication topic.',
    question_errors: [],
  };
};

module.exports = {
  assessQuestionScope,
  resolveSelectedScope,
  validateQuestionSetScope,
};
