const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const getQuestionIndex = (question = {}) => {
  const value = Number(question.source_index);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const detectArithmeticTopic = (questionText) => {
  const text = normalizeText(questionText).toLowerCase();
  const hasAddition = /\d\s*\+\s*\d|\b(add|adds|adding|addition|plus|sum|total)\b/.test(text);
  const hasSubtraction = /\d\s*-\s*\d|\b(subtract|subtracts|subtracting|subtraction|minus|difference|take away)\b/.test(text);

  if (hasAddition && !hasSubtraction) return 'Basic Addition';
  if (hasSubtraction && !hasAddition) return 'Subtraction';
  return '';
};

const assessQuestionScope = (question = {}, scope = {}) => {
  const sourceIndex = getQuestionIndex(question);
  const selectedTopic = normalizeText(scope.math_topic || scope.topic);
  const detectedTopic = detectArithmeticTopic(question.question);

  if (!detectedTopic) {
    return {
      status: 'unverified',
      code: 'QUESTION_TOPIC_UNVERIFIED',
      ...(sourceIndex ? { source_index: sourceIndex } : {}),
    };
  }

  if (detectedTopic === selectedTopic) {
    return {
      status: 'match',
      ...(sourceIndex ? { source_index: sourceIndex } : {}),
    };
  }

  return {
    status: 'mismatch',
    detected_topic: detectedTopic,
    code: 'QUESTION_TOPIC_MISMATCH',
    ...(sourceIndex ? { source_index: sourceIndex } : {}),
  };
};

const buildQuestionScopeMessage = (assessment, selectedTopic) => {
  const questionLabel = assessment.source_index ? `Question ${assessment.source_index}` : 'A question';
  if (assessment.code === 'QUESTION_TOPIC_MISMATCH') {
    return `${questionLabel} is ${assessment.detected_topic} but the selected Topic is ${selectedTopic}.`;
  }
  return `${questionLabel} could not be verified as ${selectedTopic}.`;
};

const validateQuestionSetScope = ({
  selected_scope: selectedScope = {},
  document_topic: documentTopic,
  require_document_topic: requireDocumentTopic = true,
  questions,
} = {}) => {
  const selectedTopic = normalizeText(selectedScope.math_topic || selectedScope.topic);
  const normalizedDocumentTopic = normalizeText(documentTopic);

  if (requireDocumentTopic && !normalizedDocumentTopic) {
    return {
      isValid: false,
      code: 'MISSING_DOCUMENT_TOPIC',
      message: 'The Fixed Question document does not provide a topic. Review the document topic before Push to Game.',
      question_errors: [],
    };
  }

  if (requireDocumentTopic && /[,;&]|\band\b/i.test(normalizedDocumentTopic)) {
    return {
      isValid: false,
      code: 'MULTI_TOPIC_DOCUMENT',
      message: 'This Fixed Question document contains multiple topics. Game publication requires one controlled encounter topic.',
      question_errors: [],
    };
  }

  if (requireDocumentTopic && normalizedDocumentTopic !== selectedTopic) {
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
      message: buildQuestionScopeMessage(assessment, selectedTopic),
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
  validateQuestionSetScope,
};
