const QUESTION_LINE = /^\s*(?:question\s*)?(\d+)\s*[.)]\s*(.+?)\s*$/i;
const OPTION_LINE = /^\s*([A-Z])\s*[.)]\s*(.*?)\s*$/i;
const ANSWER_LINE = /^\s*(?:correct\s+)?answer\s*:\s*(.*?)\s*$/i;
const TOPIC_ID_LINE = /^\s*topic(?:\s+id|_id)\s*:\s*([a-z0-9_]+)\s*$/i;
const {
  isValidDifficulty,
  isValidGradeLevel,
  isValidMathTopicForGradeDifficulty,
  normalizeDifficultyValue,
} = require('./learningContentRules.utils');

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME_TYPE = 'application/pdf';

const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeChoiceKey = (value) => normalizeText(value).toLocaleLowerCase();

const getFixedQuestionDocumentContentFormat = (content) => {
  if (!Buffer.isBuffer(content)) return null;
  if (content.subarray(0, 5).toString('utf8') === '%PDF-') return 'pdf';
  if (
    content.subarray(0, 2).toString('utf8') === 'PK'
    && content.includes(Buffer.from('word/document.xml'))
  ) {
    return 'docx';
  }
  return null;
};

const getFixedQuestionDocumentMimeFormat = (file) => {
  const mimetype = String(file?.mimetype || '').trim().toLowerCase();
  if (mimetype === PDF_MIME_TYPE) return 'pdf';
  if (mimetype === DOCX_MIME_TYPE) return 'docx';
  return null;
};

const getUnambiguousFilenameFormat = (file) => {
  const originalName = String(file?.originalname || '').trim().toLowerCase();
  if (/\.(?:docx|pdf)\.(?:docx|pdf)$/i.test(originalName)) return null;
  if (originalName.endsWith('.docx')) return 'docx';
  if (originalName.endsWith('.pdf')) return 'pdf';
  return null;
};

const detectFixedQuestionDocumentFormat = (file, content) => {
  const contentFormat = getFixedQuestionDocumentContentFormat(content);
  const mimeFormat = getFixedQuestionDocumentMimeFormat(file);
  const filenameFormat = getUnambiguousFilenameFormat(file);

  if (!contentFormat || contentFormat !== mimeFormat) return null;
  if (filenameFormat && filenameFormat !== contentFormat) return null;
  return contentFormat;
};

const resolveFixedQuestionDocumentMetadata = ({
  documentText,
  selectedGradeLevel,
  selectedDifficulty,
} = {}) => {
  const lines = String(documentText || '').replace(/\r\n?/g, '\n').split('\n');
  const selectedGrade = normalizeText(selectedGradeLevel);
  const selectedLevel = normalizeDifficultyValue(selectedDifficulty);
  const extractedLessonMatch = lines.map((line) => line.match(
    /^\s*(easy|normal|medium|difficult|hard)\s*(?:[-–—]\s*)?(?:lesson|topic)\s*:\s*(.+?)\s*$/i
  )).find(Boolean);
  const documentTopic = extractedLessonMatch ? normalizeText(extractedLessonMatch[2]) : '';
  const mathTopic = documentTopic
    && isValidMathTopicForGradeDifficulty(selectedGrade, selectedLevel, documentTopic)
    ? documentTopic
    : null;

  return {
    document_topic: documentTopic || null,
    math_topic: mathTopic,
    // Source headings remain readable provenance only. The selected
    // Grade/Difficulty scope is authoritative for this set.
    metadata_error: '',
  };
};

const validateFixedQuestionDocumentPublicationScope = ({
} = {}) => {
  // Compatibility export: document headings are display metadata, never a
  // publication precondition for a declared canonical scope.
  return '';
};

const tokenizeFixedQuestionText = (documentText) => String(documentText || '')
  .replace(/\r\n?/g, '\n')
  // DOCX/PDF text extraction can flatten a visual bullet and its option onto
  // the preceding question line. Split only recognized bullet-option markers.
  .replace(/[●•▪◦]\s*(?=[A-D]\s*[.)])/gi, '\n')
  // Keep answer markers as their own logical token without splitting arbitrary
  // punctuation in question text.
  .replace(/([^\n])\s+((?:correct\s+)?answer\s*:)/gi, '$1\n$2')
  // A flattened following question is safe to split only after a recognized
  // answer marker has completed the prior question.
  .replace(/((?:correct\s+)?answer\s*:[^\n]*?)\s+(?=(?:question\s*)?\d+\s*[.)]\s+)/gi, '$1\n');

const resolveCorrectAnswer = (rawAnswer, optionsWithLabels) => {
  const answer = normalizeText(rawAnswer);
  if (!answer) return '';

  const labelMatch = answer.match(/^([A-Z])(?:[.)]|\s|$)/i);
  if (labelMatch) {
    const labelledOption = optionsWithLabels.find((option) => option.label === labelMatch[1].toUpperCase());
    if (labelledOption) return labelledOption.value;
  }

  const answerKey = normalizeChoiceKey(answer);
  const matchingOptions = optionsWithLabels.filter((option) => normalizeChoiceKey(option.value) === answerKey);
  return matchingOptions.length === 1 ? matchingOptions[0].value : answer;
};

const finalizeQuestion = (draft) => {
  if (!draft) return null;
  const options = draft.options.map((option) => normalizeText(option.value));
  return {
    source_index: draft.source_index,
    question: normalizeText(draft.questionParts.join(' ')),
    ...(draft.topic_id ? { topic_id: draft.topic_id } : {}),
    options,
    correct_answer: resolveCorrectAnswer(draft.rawAnswer, draft.options),
  };
};

const parseFixedQuestionText = (documentText) => {
  const lines = tokenizeFixedQuestionText(documentText).split('\n');
  const questions = [];
  let currentQuestion = null;

  const pushCurrentQuestion = () => {
    const parsedQuestion = finalizeQuestion(currentQuestion);
    if (parsedQuestion) questions.push(parsedQuestion);
    currentQuestion = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    const questionMatch = line.match(QUESTION_LINE);
    if (questionMatch) {
      pushCurrentQuestion();
      currentQuestion = {
        source_index: Number(questionMatch[1]),
        questionParts: [questionMatch[2]],
        options: [],
        rawAnswer: '',
        topic_id: '',
      };
      continue;
    }

    if (!currentQuestion) continue;

    const topicIdMatch = line.match(TOPIC_ID_LINE);
    if (topicIdMatch) {
      currentQuestion.topic_id = normalizeText(topicIdMatch[1]);
      continue;
    }

    const optionMatch = line.match(OPTION_LINE);
    if (optionMatch) {
      currentQuestion.options.push({ label: optionMatch[1].toUpperCase(), value: optionMatch[2] });
      continue;
    }

    const answerMatch = line.match(ANSWER_LINE);
    if (answerMatch) {
      currentQuestion.rawAnswer = answerMatch[1];
      continue;
    }

    if (currentQuestion.options.length === 0 && !currentQuestion.rawAnswer) {
      currentQuestion.questionParts.push(line);
    }
  }

  pushCurrentQuestion();
  return questions;
};

const validateFixedQuestion = (question) => {
  const options = Array.isArray(question?.options)
    ? question.options.map((option) => normalizeText(option))
    : [];
  const correctAnswer = normalizeText(question?.correct_answer);
  const validationErrors = [];

  if (!normalizeText(question?.question)) validationErrors.push('Question text is required.');
  if (options.length !== 4) validationErrors.push('Exactly four answer choices are required.');
  if (options.some((option) => !option)) validationErrors.push('All four answer choices must be nonempty.');
  if (new Set(options.map(normalizeChoiceKey)).size !== options.length) validationErrors.push('Answer choices must be distinct.');
  if (!correctAnswer) validationErrors.push('A correct answer is required.');
  if (correctAnswer && options.filter((option) => normalizeChoiceKey(option) === normalizeChoiceKey(correctAnswer)).length !== 1) {
    validationErrors.push('The correct answer must match one of the four choices.');
  }

  return {
    ...question,
    question: normalizeText(question?.question),
    options,
    correct_answer: correctAnswer,
    validation_errors: validationErrors,
    is_valid: validationErrors.length === 0,
  };
};

const validateFixedQuestions = (questions) => {
  const validatedQuestions = (Array.isArray(questions) ? questions : []).map(validateFixedQuestion);
  return {
    isValid: validatedQuestions.length > 0 && validatedQuestions.every((question) => question.is_valid),
    document_errors: validatedQuestions.length === 0 ? ['No numbered questions could be extracted from this document.'] : [],
    questions: validatedQuestions,
  };
};

const validateQuestionSetForReview = ({
  questions,
  grade_level,
  difficulty,
} = {}) => {
  const questionValidation = validateFixedQuestions(questions);
  const normalizedGrade = normalizeText(grade_level);
  const normalizedDifficulty = normalizeDifficultyValue(difficulty);
  const documentErrors = [...questionValidation.document_errors];

  if (!isValidGradeLevel(normalizedGrade)) {
    documentErrors.push('Grade level must be one of Grade 1 through Grade 6.');
  }
  if (!isValidDifficulty(normalizedDifficulty)) {
    documentErrors.push('Difficulty must be Easy, Normal, or Difficult.');
  }
  const validatedQuestions = questionValidation.questions.map((question) => {
    const validationErrors = [...question.validation_errors];
    if (normalizeText(question.grade_level) !== normalizedGrade) validationErrors.push('Question grade must match the selected Grade.');
    if (normalizeDifficultyValue(question.difficulty) !== normalizedDifficulty) validationErrors.push('Question difficulty must match the selected Difficulty.');
    return {
      ...question,
      validation_errors: validationErrors,
      is_valid: validationErrors.length === 0,
    };
  });

  return {
    isValid: documentErrors.length === 0 && validatedQuestions.length > 0 && validatedQuestions.every((question) => question.is_valid),
    document_errors: documentErrors,
    questions: validatedQuestions,
  };
};

const validateQuestionSetForPublication = ({
  questions,
  grade_level,
  difficulty,
} = {}) => {
  const reviewValidation = validateQuestionSetForReview({
    questions,
    grade_level,
    difficulty,
  });

  return {
    isValid: reviewValidation.isValid,
    document_errors: reviewValidation.document_errors,
    questions: reviewValidation.questions,
    scope_validation: null,
  };
};

const validateFixedQuestionUploadFile = (file, header = Buffer.alloc(0)) => {
  const contentFormat = getFixedQuestionDocumentContentFormat(header);
  const mimeFormat = getFixedQuestionDocumentMimeFormat(file);
  const filenameFormat = getUnambiguousFilenameFormat(file);

  if (!contentFormat) {
    return 'Fixed Questions support a valid PDF or DOCX document with the expected file signature.';
  }
  if (mimeFormat !== contentFormat) {
    return 'Fixed Question file MIME type does not match its document content.';
  }
  if (filenameFormat && filenameFormat !== contentFormat) {
    return 'Fixed Question filename extension does not match its document content.';
  }
  return '';
};

const extractFixedQuestionDocument = async (file, {
  extractDocxText,
  extractPdfText,
} = {}) => {
  const content = Buffer.isBuffer(file?.buffer)
    ? file.buffer
    : require('fs').readFileSync(file.path);
  const documentFormat = detectFixedQuestionDocumentFormat(file, content);
  let extractedText = '';

  if (documentFormat === 'docx') {
    const extract = extractDocxText || (async (inputPath) => {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: inputPath });
      return result.value;
    });
    extractedText = await extract(file.path);
  } else if (documentFormat === 'pdf') {
    const extract = extractPdfText || (async (inputPath) => {
      const pdfParse = require('pdf-parse');
      const result = await pdfParse(require('fs').readFileSync(inputPath));
      return result.text;
    });
    extractedText = await extract(file.path);
  } else {
    throw new Error('Unsupported fixed question document format');
  }

  const normalizedText = String(extractedText || '').trim();
  if (!normalizedText) throw new Error('The uploaded Fixed Question document does not contain readable text.');
  return {
    ...validateFixedQuestions(parseFixedQuestionText(normalizedText)),
    document_text: normalizedText,
  };
};

module.exports = {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  detectFixedQuestionDocumentFormat,
  extractFixedQuestionDocument,
  parseFixedQuestionText,
  resolveFixedQuestionDocumentMetadata,
  tokenizeFixedQuestionText,
  validateFixedQuestionDocumentPublicationScope,
  validateFixedQuestion,
  validateFixedQuestionUploadFile,
  validateFixedQuestions,
  validateQuestionSetForReview,
  validateQuestionSetForPublication,
};
