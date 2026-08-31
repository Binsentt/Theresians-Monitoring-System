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
  const hasAddition = /\d\s*\+\s*\d|\b(add|adds|adding|addition|plus|sum|total)\b/.test(text);
  const hasSubtraction = /\d\s*-\s*\d|\b(subtract|subtracts|subtracting|subtraction|minus|difference|take away)\b/.test(text);

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
    if (!detectedTopicId) {
      return assessmentWithSourceIndex({
        status: 'unverified',
        code: 'QUESTION_TOPIC_UNVERIFIED',
      }, sourceIndex);
    }
    if (detectedTopicId === selectedScope.topic_id) {
      return assessmentWithSourceIndex({ status: 'match' }, sourceIndex);
    }
    return assessmentWithSourceIndex({
      status: 'mismatch',
      detected_topic: getTopicById(detectedTopicId).display_label,
      code: 'QUESTION_TOPIC_MISMATCH',
    }, sourceIndex);
  }

  const rawTopicId = normalizeText(question.topic_id);
  if (!rawTopicId) {
    return assessmentWithSourceIndex({
      status: 'unverified',
      code: 'QUESTION_TOPIC_METADATA_REQUIRED',
    }, sourceIndex);
  }
  const questionTopicId = normalizeTopicId(rawTopicId);
  if (!questionTopicId || !isValidScope(selectedScope.grade_level, selectedScope.difficulty, questionTopicId)) {
    return assessmentWithSourceIndex({
      status: 'unverified',
      code: 'QUESTION_TOPIC_METADATA_UNSUPPORTED',
    }, sourceIndex);
  }
  if (questionTopicId !== selectedScope.topic_id) {
    return assessmentWithSourceIndex({
      status: 'mismatch',
      detected_topic: getTopicById(questionTopicId).display_label,
      code: 'QUESTION_TOPIC_MISMATCH',
    }, sourceIndex);
  }
  return assessmentWithSourceIndex({ status: 'match' }, sourceIndex);
};

const buildQuestionScopeMessage = (assessment, selectedTopic) => {
  const questionLabel = assessment.source_index ? `Question ${assessment.source_index}` : 'A question';
  if (assessment.code === 'QUESTION_TOPIC_MISMATCH') {
    return `${questionLabel} is ${assessment.detected_topic} but the selected Topic is ${selectedTopic}.`;
  }
  if (assessment.code === 'QUESTION_TOPIC_METADATA_REQUIRED') {
    return `${questionLabel} requires explicit topic_id metadata for the selected Topic ${selectedTopic}.`;
  }
  if (assessment.code === 'QUESTION_TOPIC_METADATA_UNSUPPORTED') {
    return `${questionLabel} has unsupported topic_id metadata for the selected Grade, Difficulty, and Topic.`;
  }
  if (assessment.code === 'QUESTION_SCOPE_INVALID') {
    return 'The selected Grade, Difficulty, and Topic scope is not supported by the canonical curriculum registry.';
  }
  return `${questionLabel} could not be verified as ${selectedTopic}.`;
};

const validateQuestionSetScope = ({
  selected_scope: selectedScopeInput = {},
  document_topic: documentTopic,
  require_document_topic: requireDocumentTopic = true,
  questions,
} = {}) => {
  const normalizedDocumentTopic = normalizeText(documentTopic);
  if (requireDocumentTopic && !normalizedDocumentTopic) {
    return {
      isValid: false,
      code: 'MISSING_DOCUMENT_TOPIC',
      message: 'The Fixed Question document does not provide a topic. Review the document topic before Push to Game.',
      question_errors: [],
    };
  }

  const documentGrade = normalizeGradeLevel(selectedScopeInput.grade_level || selectedScopeInput.grade);
  const documentDifficulty = normalizeDifficulty(selectedScopeInput.difficulty);
  const documentTopicId = resolveLegacyDisplayTopic(
    documentGrade,
    documentDifficulty,
    normalizedDocumentTopic,
  );
  if (requireDocumentTopic && !documentTopicId && (/[,;&]/.test(normalizedDocumentTopic) || /\band\b/i.test(normalizedDocumentTopic))) {
    return {
      isValid: false,
      code: 'MULTI_TOPIC_DOCUMENT',
      message: 'This Fixed Question document contains multiple topics. Game publication requires one controlled encounter topic.',
      question_errors: [],
    };
  }

  const selectedScope = resolveSelectedScope(selectedScopeInput);
  if (!selectedScope) {
    return {
      isValid: false,
      code: 'QUESTION_SCOPE_INVALID',
      message: 'The selected Grade, Difficulty, and Topic scope is not supported by the canonical curriculum registry.',
      question_errors: [],
    };
  }

  if (requireDocumentTopic && documentTopicId !== selectedScope.topic_id) {
    return {
      isValid: false,
      code: 'DOCUMENT_TOPIC_MISMATCH',
      message: 'The Fixed Question document topic does not match its selected game publication topic.',
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
