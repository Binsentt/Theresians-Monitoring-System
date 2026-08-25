const QUESTION_LINE = /^\s*(?:question\s*)?(\d+)\s*[.)]\s*(.+?)\s*$/i;
const OPTION_LINE = /^\s*([A-Z])\s*[.)]\s*(.*?)\s*$/i;
const ANSWER_LINE = /^\s*(?:correct\s+)?answer\s*:\s*(.*?)\s*$/i;

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME_TYPE = 'application/pdf';

const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeChoiceKey = (value) => normalizeText(value).toLocaleLowerCase();

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
    options,
    correct_answer: resolveCorrectAnswer(draft.rawAnswer, draft.options),
  };
};

const parseFixedQuestionText = (documentText) => {
  const lines = String(documentText || '').replace(/\r\n?/g, '\n').split('\n');
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
      };
      continue;
    }

    if (!currentQuestion) continue;

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

const validateQuestionSetForPublication = ({
  questions,
  grade_level,
  difficulty,
  math_topic,
  metadata_error = '',
} = {}) => {
  const questionValidation = validateFixedQuestions(questions);
  const normalizedGrade = normalizeText(grade_level);
  const normalizedDifficulty = normalizeText(difficulty);
  const normalizedTopic = normalizeText(math_topic);
  const validatedQuestions = questionValidation.questions.map((question) => {
    const validationErrors = [...question.validation_errors];
    if (normalizeText(question.grade_level) !== normalizedGrade) validationErrors.push('Question grade must match the selected Grade.');
    if (normalizeText(question.difficulty) !== normalizedDifficulty) validationErrors.push('Question difficulty must match the selected Difficulty.');
    if (normalizeText(question.math_topic) !== normalizedTopic) validationErrors.push('Question topic must match the selected Topic.');
    return {
      ...question,
      validation_errors: validationErrors,
      is_valid: validationErrors.length === 0,
    };
  });

  return {
    isValid: !metadata_error && validatedQuestions.length > 0 && validatedQuestions.every((question) => question.is_valid),
    document_errors: [
      ...questionValidation.document_errors,
      ...(metadata_error ? [metadata_error] : []),
    ],
    questions: validatedQuestions,
  };
};

const validateFixedQuestionUploadFile = (file, header = Buffer.alloc(0)) => {
  const originalName = String(file?.originalname || '').trim().toLowerCase();
  const mimetype = String(file?.mimetype || '').trim().toLowerCase();
  const signature = Buffer.isBuffer(header) ? header.subarray(0, 5).toString('utf8') : '';

  if (originalName.endsWith('.docx')) {
    if (mimetype !== DOCX_MIME_TYPE || !Buffer.isBuffer(header) || header.subarray(0, 2).toString('utf8') !== 'PK') {
      return 'Fixed Question DOCX files must be uploaded as a valid DOCX document.';
    }
    return '';
  }

  if (originalName.endsWith('.pdf')) {
    if (mimetype !== PDF_MIME_TYPE || signature !== '%PDF-') {
      return 'Fixed Question PDF files must be uploaded as a valid PDF.';
    }
    return '';
  }

  return 'Fixed Questions support DOCX or PDF documents.';
};

const extractFixedQuestionDocument = async (file, {
  extractDocxText,
  extractPdfText,
} = {}) => {
  const originalName = String(file?.originalname || '').trim().toLowerCase();
  let extractedText = '';

  if (originalName.endsWith('.docx')) {
    const extract = extractDocxText || (async (inputPath) => {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: inputPath });
      return result.value;
    });
    extractedText = await extract(file.path);
  } else if (originalName.endsWith('.pdf')) {
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
  return validateFixedQuestions(parseFixedQuestionText(normalizedText));
};

module.exports = {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  extractFixedQuestionDocument,
  parseFixedQuestionText,
  validateFixedQuestion,
  validateFixedQuestionUploadFile,
  validateFixedQuestions,
  validateQuestionSetForPublication,
};
