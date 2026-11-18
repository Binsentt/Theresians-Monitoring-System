const { randomBytes: secureRandomBytes } = require('node:crypto');
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const QUESTION_GENERATION_MODEL = 'gpt-5-mini';
const MAX_LESSON_TEXT_CHARS = 24000;
// Five structured questions plus model reasoning can legitimately exceed a
// short request deadline. Keep one bounded provider-call deadline so the
// request remains cancellable without making generation wait indefinitely.
const QUESTION_GENERATION_TIMEOUT_MS = 120000;
const MAX_GENERATION_BATCH_SIZE = 25;
// Reserve a predictable output budget for the structured JSON plus model reasoning.
// The per-question allowance preserves the existing 1-50 request range without
// imposing a small fixed cap that could truncate larger requested sets.
const QUESTION_GENERATION_OUTPUT_BASE_TOKENS = 1000;
const QUESTION_GENERATION_OUTPUT_TOKENS_PER_QUESTION = 500;
const getQuestionGenerationMaxOutputTokens = (questionCount) => (
  QUESTION_GENERATION_OUTPUT_BASE_TOKENS
  + (Number.isInteger(questionCount) && questionCount > 0 ? questionCount : 1)
    * QUESTION_GENERATION_OUTPUT_TOKENS_PER_QUESTION
);
const {
  AI_PAUSED_CODE,
  AI_PAUSED_MESSAGE,
  isAiGenerationEnabled,
} = require('./aiRuntimePolicy');

class QuestionGenerationError extends Error {
  constructor(code, message, providerDiagnostics = null) {
    super(message);
    this.name = 'QuestionGenerationError';
    this.code = code;
    this.providerDiagnostics = providerDiagnostics;
  }
}

const toQuestionGenerationHttpFailure = (error) => {
  if (!(error instanceof QuestionGenerationError)) return null;
  if (error.code === AI_PAUSED_CODE) {
    return {
      status: 503,
      code: AI_PAUSED_CODE,
      error: AI_PAUSED_MESSAGE,
    };
  }
  if (error.providerDiagnostics?.category === 'quota_or_rate_limit') {
    return {
      status: 503,
      code: error.code,
      error: 'Question AI is temporarily unavailable. No questions were created. Please try again after the service is restored.',
    };
  }

  const sourceValidationCodes = [
    'QUESTION_AI_PDF_INVALID',
    'QUESTION_AI_PDF_NO_TEXT',
    'QUESTION_AI_PDF_EXTRACTION_FAILED',
    'QUESTION_AI_DOCX_INVALID',
    'QUESTION_AI_DOCX_NO_TEXT',
    'QUESTION_AI_DOCX_EXTRACTION_FAILED',
    'QUESTION_AI_PPTX_INVALID',
    'QUESTION_AI_SOURCE_INVALID',
  ];
  const status = error.code === 'QUESTION_AI_NOT_CONFIGURED' ? 503
    : error.code === 'QUESTION_AI_TIMEOUT' ? 504
      : ['QUESTION_AI_EMPTY_LESSON', 'QUESTION_AI_LESSON_TOO_LARGE', 'QUESTION_AI_INVALID_REQUEST', 'QUESTION_AI_INVALID_RESPONSE', ...sourceValidationCodes].includes(error.code) ? 422
        : 502;
  const message = error.code === 'QUESTION_AI_NOT_CONFIGURED'
    ? 'Question AI is temporarily unavailable. Please contact the administrator.'
    : error.code === 'QUESTION_AI_TIMEOUT'
      ? 'Question generation timed out. Please try again.'
      : error.code === 'QUESTION_AI_EMPTY_LESSON'
        ? 'No readable lesson text was found in this source.'
      : error.code === 'QUESTION_AI_LESSON_TOO_LARGE'
          ? 'The readable lesson text exceeds the safe size limit.'
          : sourceValidationCodes.includes(error.code)
            ? error.message
          : error.code === 'QUESTION_AI_INVALID_RESPONSE'
            ? 'Question generation returned unusable question data. Please try again.'
            : 'Question generation could not be completed. Please review the lesson source and try again.';
  return { status, code: error.code, error: message };
};

const asTrimmedString = (value) => String(value || '').trim();
const SAFE_PROVIDER_DIAGNOSTIC_VALUE = /^[A-Za-z0-9._:-]{1,160}$/;

const toSafeProviderDiagnosticValue = (value) => {
  const normalized = asTrimmedString(value);
  return SAFE_PROVIDER_DIAGNOSTIC_VALUE.test(normalized) ? normalized : null;
};

const getResponseHeader = (response, name) => {
  try {
    return toSafeProviderDiagnosticValue(response?.headers?.get?.(name));
  } catch {
    return null;
  }
};

const classifyProviderFailure = ({ httpStatus, providerType, providerCode }) => {
  const details = `${providerType || ''} ${providerCode || ''}`.toLowerCase();
  if (httpStatus === 401 || details.includes('invalid_api_key') || details.includes('authentication')) return 'authentication';
  if (details.includes('model') || details.includes('unsupported_model')) return 'model_access';
  if (httpStatus === 403 || details.includes('permission') || details.includes('access_denied')) return 'authorization';
  if (httpStatus === 429 || details.includes('quota') || details.includes('rate_limit')) return 'quota_or_rate_limit';
  if (httpStatus >= 500) return 'provider_server';
  if (httpStatus >= 400) return 'invalid_request';
  return 'provider_error';
};

const buildProviderDiagnostics = (response, responseBody, fallbackCategory = null) => {
  const status = Number(response?.status);
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const providerType = toSafeProviderDiagnosticValue(responseBody?.error?.type);
  const providerCode = toSafeProviderDiagnosticValue(responseBody?.error?.code);
  const requestId = getResponseHeader(response, 'x-request-id');
  const category = fallbackCategory || classifyProviderFailure({ httpStatus, providerType, providerCode });

  return {
    ...(httpStatus ? { http_status: httpStatus } : {}),
    category,
    ...(providerType ? { provider_type: providerType } : {}),
    ...(providerCode ? { provider_code: providerCode } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  };
};

const buildQuestionSchema = (questionCount) => ({
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: questionCount,
      maxItems: questionCount,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options', 'correct_answer'],
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'string' },
          },
          correct_answer: { type: 'string' },
        },
      },
    },
  },
});

const extractOutputText = (responseBody) => {
  if (typeof responseBody?.output_text === 'string') return responseBody.output_text;

  const textParts = (responseBody?.output || []).flatMap((item) => (
    (item?.content || []).map((content) => content?.text).filter((text) => typeof text === 'string')
  ));
  return textParts.join('\n');
};

const normalizeGeneratedQuestion = (item) => {
  const question = asTrimmedString(item?.question);
  const options = Array.isArray(item?.options)
    ? item.options.map(asTrimmedString)
    : [];
  const correctAnswer = asTrimmedString(item?.correct_answer);
  const distinctOptions = new Set(options.map((option) => option.toLocaleLowerCase())).size === options.length;
  const correctAnswerMatchesExactlyOnce = options.filter((option) => option === correctAnswer).length === 1;

  if (!question || options.length !== 4 || options.some((option) => !option) || !distinctOptions || !correctAnswer || !correctAnswerMatchesExactlyOnce) {
    return null;
  }

  return {
    question,
    options,
    correct_answer: correctAnswer,
  };
};

const questionContentKey = (value) => asTrimmedString(value)
  .toLocaleLowerCase()
  .replace(/\s+/gu, ' ');

const randomBelow = (exclusiveLimit, randomBytesImpl = secureRandomBytes) => {
  const limit = BigInt(exclusiveLimit);
  if (limit <= 0n) throw new RangeError('A random range must be positive.');
  if (limit === 1n) return 0n;
  const bitCount = (limit - 1n).toString(2).length;
  const byteCount = Math.ceil(bitCount / 8);
  const mask = (1n << BigInt(bitCount)) - 1n;
  for (;;) {
    const bytes = randomBytesImpl(byteCount);
    if (!Buffer.isBuffer(bytes) || bytes.length !== byteCount) {
      throw new TypeError('The random source must return the requested number of bytes.');
    }
    const candidate = BigInt(`0x${bytes.toString('hex')}`) & mask;
    if (candidate < limit) return candidate;
  }
};

const fisherYatesShuffle = (values, randomBytesImpl = secureRandomBytes) => {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Number(randomBelow(BigInt(index + 1), randomBytesImpl));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

const getStoredAnswerPositions = (existingQuestions) => {
  const positions = [];
  for (const question of Array.isArray(existingQuestions) ? existingQuestions : []) {
    const hasOptions = Object.prototype.hasOwnProperty.call(question || {}, 'options');
    const hasAnswer = Object.prototype.hasOwnProperty.call(question || {}, 'correct_answer');
    if (!hasOptions && !hasAnswer) continue;
    const normalized = normalizeGeneratedQuestion(question);
    if (!normalized) {
      throw new QuestionGenerationError('QUESTION_AI_EXISTING_ANSWER_INVALID', 'A saved question has an invalid option/answer mapping and was not changed. Review it before generating more questions.');
    }
    positions.push(normalized.options.indexOf(normalized.correct_answer));
  }
  return positions;
};

const getBalancedTargetVectors = (totalCount, existingCounts) => {
  const baseCount = Math.floor(totalCount / 4);
  const remainder = totalCount % 4;
  const candidates = [];
  for (let mask = 0; mask < 16; mask += 1) {
    const labels = [0, 1, 2, 3].filter((position) => Boolean(mask & (1 << position)));
    if (labels.length !== remainder) continue;
    const target = [baseCount, baseCount, baseCount, baseCount];
    labels.forEach((position) => { target[position] += 1; });
    if (existingCounts.every((count, position) => count <= target[position])) candidates.push(target);
  }
  return candidates;
};

const factorial = (value) => {
  let result = 1n;
  for (let number = 2; number <= value; number += 1) result *= BigInt(number);
  return result;
};

const countDistinctPositionOrders = (counts) => {
  const total = counts.reduce((sum, count) => sum + count, 0);
  return factorial(total) / counts.reduce((product, count) => product * factorial(count), 1n);
};

const violatesNewPositionSequenceRules = (existingPositions, newPositions) => {
  const combined = [...existingPositions, ...newPositions];
  let trailingRun = 0;
  for (let index = 0; index < combined.length; index += 1) {
    trailingRun = index > 0 && combined[index] === combined[index - 1] ? trailingRun + 1 : 1;
    if (index >= existingPositions.length && trailingRun > 2) return true;
    if (index < Math.max(4, existingPositions.length)) continue;
    const previousCycle = combined.slice(index - 4, index);
    if (new Set(previousCycle).size === 4 && combined[index] === combined[index - 4]) return true;
  }
  return false;
};

const buildBalancedAnswerPositionPlan = (questionCount, { existingQuestions = [], randomBytesImpl = secureRandomBytes } = {}) => {
  if (!Number.isSafeInteger(questionCount) || questionCount < 0) {
    throw new QuestionGenerationError('QUESTION_AI_INVALID_REQUEST', 'Question Count must be a nonnegative whole number.');
  }
  if (questionCount === 0) return [];
  const existingPositions = getStoredAnswerPositions(existingQuestions);
  const existingCounts = [0, 0, 0, 0];
  existingPositions.forEach((position) => { existingCounts[position] += 1; });
  const candidates = getBalancedTargetVectors(existingPositions.length + questionCount, existingCounts)
    .map((target) => ({
      target,
      remaining: target.map((count, position) => count - existingCounts[position]),
      ways: countDistinctPositionOrders(target.map((count, position) => count - existingCounts[position])),
    }));
  const totalWays = candidates.reduce((sum, candidate) => sum + candidate.ways, 0n);
  if (totalWays === 0n) {
    throw new QuestionGenerationError('QUESTION_AI_ANSWER_BALANCE_IMPOSSIBLE', 'The remaining questions cannot be balanced without changing saved questions. Review the saved set before retrying.');
  }
  // Weight each balanced remainder by its number of distinct orders, then
  // Fisher-Yates shuffle without modulo bias. Rejection-sampling disallowed
  // runs/cycles leaves a uniform distribution over the acceptable plans.
  for (let attempt = 0; attempt < 2048; attempt += 1) {
    let selection = randomBelow(totalWays, randomBytesImpl);
    const selected = candidates.find(({ ways }) => {
      if (selection < ways) return true;
      selection -= ways;
      return false;
    });
    if (!selected) break;
    const positions = selected.remaining.flatMap((count, position) => Array.from({ length: count }, () => position));
    const plan = fisherYatesShuffle(positions, randomBytesImpl);
    if (plan.length === questionCount && !violatesNewPositionSequenceRules(existingPositions, plan)) return plan;
  }
  throw new QuestionGenerationError('QUESTION_AI_ANSWER_BALANCE_IMPOSSIBLE', 'The remaining questions cannot meet the balanced answer-position and nonrepeating-sequence rules without changing saved questions. Review the saved set before retrying.');
};

const partitionAnswerPositionPlan = (plan, counts) => {
  if (!Array.isArray(plan) || !Array.isArray(counts)
    || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || counts.reduce((sum, count) => sum + count, 0) !== plan.length
    || plan.some((position) => !Number.isInteger(position) || position < 0 || position > 3)) {
    throw new QuestionGenerationError('QUESTION_AI_ANSWER_BALANCE_IMPOSSIBLE', 'The generated answer-position plan does not match its topic batches.');
  }
  let offset = 0;
  return counts.map((count) => {
    const batchPlan = plan.slice(offset, offset + count);
    offset += count;
    return batchPlan;
  });
};

const balanceCorrectAnswerPositions = (questions, positionPlan, randomBytesImpl = secureRandomBytes) => questions.map((question, index) => {
  const correctAnswer = question.correct_answer;
  const distractors = fisherYatesShuffle(question.options.filter((option) => option !== correctAnswer), randomBytesImpl);
  const options = [...distractors];
  options.splice(positionPlan[index], 0, correctAnswer);
  return { ...question, options };
});

const parseGeneratedQuestions = (outputText, expectedCount) => {
  let payload;
  try {
    payload = JSON.parse(outputText);
  } catch {
    throw new QuestionGenerationError('QUESTION_AI_INVALID_RESPONSE', 'Question generation returned invalid structured data.');
  }

  const generated = Array.isArray(payload) ? payload : payload?.questions;
  if (!Array.isArray(generated)) {
    throw new QuestionGenerationError('QUESTION_AI_INVALID_RESPONSE', 'Question generation did not return a question list.');
  }

  const questions = generated.map(normalizeGeneratedQuestion).filter(Boolean);
  if (questions.length !== expectedCount) {
    throw new QuestionGenerationError('QUESTION_AI_INVALID_RESPONSE', 'Question generation did not return the requested number of valid questions.');
  }

  const fingerprints = questions.map((question) => questionContentKey(question.question));
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new QuestionGenerationError('QUESTION_AI_INVALID_RESPONSE', 'Question generation returned duplicate questions.');
  }

  return questions;
};

const buildGenerationInput = ({ lessonText, title, gradeLevel, difficulty, mathTopic, questionCount, avoidQuestions = [] }) => {
  const lesson = asTrimmedString(lessonText);
  const fallbackTitle = asTrimmedString(title);
  if (!lesson) {
    throw new QuestionGenerationError('QUESTION_AI_EMPTY_LESSON', 'No readable lesson text was found for question generation.');
  }
  if (lesson.length > MAX_LESSON_TEXT_CHARS) {
    throw new QuestionGenerationError('QUESTION_AI_LESSON_TOO_LARGE', 'The readable lesson text exceeds the safe size limit.');
  }

  const normalizedAvoidQuestions = (Array.isArray(avoidQuestions) ? avoidQuestions : [])
    .map((question) => asTrimmedString(question))
    .filter(Boolean);
  const selectedMathTopic = asTrimmedString(mathTopic);

  return [
    {
      role: 'system',
      content: [{
        type: 'input_text',
        text: 'You create age-appropriate mathematics multiple-choice questions. Use only the supplied lesson content for facts, methods, and examples. Do not include explanations, markdown, or extra fields. Every question must have exactly four distinct nonempty options. Every correct_answer must exactly match one options value.',
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          `Create exactly ${questionCount} questions.`,
          `Grade: ${asTrimmedString(gradeLevel)}.`,
          `Difficulty: ${asTrimmedString(difficulty)}.`,
          ...(selectedMathTopic
            ? [
              `Selected canonical Mathematics topic: ${selectedMathTopic}.`,
              'Generate every question only about this selected topic, using only the supplied lesson material.',
            ]
            : ['The lesson can cover multiple topics. Generate only from its readable material and do not introduce unrelated material.']),
          ...(normalizedAvoidQuestions.length > 0
            ? [`Do not repeat or closely restate any of these previously generated questions:\n- ${normalizedAvoidQuestions.join('\n- ')}`]
            : []),
          `Lesson title: ${fallbackTitle || 'Untitled lesson'}.`,
          'Lesson content:',
          lesson,
        ].join('\n'),
      }],
    },
  ];
};

const generateLessonQuestions = async ({
  lessonText,
  title,
  gradeLevel,
  difficulty,
  mathTopic,
  questionCount,
  avoidQuestions = [],
  aiGenerationEnabled = isAiGenerationEnabled(),
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = global.fetch,
  timeoutMs = QUESTION_GENERATION_TIMEOUT_MS,
  deferAnswerPositionBalancing = false,
  answerPositionPlan = null,
  randomBytesImpl = secureRandomBytes,
}) => {
  if (!aiGenerationEnabled) {
    throw new QuestionGenerationError(AI_PAUSED_CODE, AI_PAUSED_MESSAGE);
  }
  if (!asTrimmedString(apiKey)) {
    throw new QuestionGenerationError(
      'QUESTION_AI_NOT_CONFIGURED',
      'Question AI is not configured. Set OPENAI_API_KEY on the backend service.'
    );
  }
  if (!Number.isInteger(questionCount) || questionCount < 1) {
    throw new QuestionGenerationError('QUESTION_AI_INVALID_REQUEST', 'Question Count must be a positive whole number.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new QuestionGenerationError('QUESTION_AI_UNAVAILABLE', 'Question AI is unavailable on this backend.');
  }

  const boundedTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : QUESTION_GENERATION_TIMEOUT_MS;
  const input = buildGenerationInput({ lessonText, title, gradeLevel, difficulty, mathTopic, questionCount, avoidQuestions });
  const controller = new AbortController();
  const requestStartedAt = Date.now();
  const timeoutHandle = setTimeout(() => controller.abort(), boundedTimeoutMs);

  let response;
  let responseBody = null;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: QUESTION_GENERATION_MODEL,
        max_output_tokens: getQuestionGenerationMaxOutputTokens(questionCount),
        input,
        text: {
          format: {
            type: 'json_schema',
            name: 'lesson_questions',
            strict: true,
            schema: buildQuestionSchema(questionCount),
          },
        },
      }),
    });
    try {
      responseBody = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // The response status below still determines the safe public error.
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new QuestionGenerationError(
        'QUESTION_AI_TIMEOUT',
        'Question generation timed out. Please try again.',
        {
          category: 'timeout',
          timeout_layer: 'provider_request',
          timeout_ms: boundedTimeoutMs,
          elapsed_ms: Math.max(0, Date.now() - requestStartedAt),
        }
      );
    }
    throw new QuestionGenerationError(
      'QUESTION_AI_GENERATION_FAILED',
      'Question AI could not generate questions right now.',
      { category: 'network_error' }
    );
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    throw new QuestionGenerationError(
      'QUESTION_AI_GENERATION_FAILED',
      'Question AI could not generate questions right now.',
      buildProviderDiagnostics(response, responseBody)
    );
  }

  const outputText = extractOutputText(responseBody);
  if (!outputText) {
    throw new QuestionGenerationError(
      'QUESTION_AI_INVALID_RESPONSE',
      'Question generation returned no structured output.',
      buildProviderDiagnostics(response, responseBody, 'invalid_provider_response')
    );
  }
  try {
    const questions = parseGeneratedQuestions(outputText, questionCount);
    if (deferAnswerPositionBalancing) return questions;
    const plan = answerPositionPlan || buildBalancedAnswerPositionPlan(questions.length, { randomBytesImpl });
    if (!Array.isArray(plan) || plan.length !== questions.length) {
      throw new QuestionGenerationError('QUESTION_AI_ANSWER_BALANCE_IMPOSSIBLE', 'The generated answer-position plan does not match the returned questions.');
    }
    return balanceCorrectAnswerPositions(questions, plan, randomBytesImpl);
  } catch (error) {
    if (error instanceof QuestionGenerationError && !error.providerDiagnostics) {
      error.providerDiagnostics = buildProviderDiagnostics(response, responseBody, 'invalid_provider_response');
    }
    throw error;
  }
};

const generateLessonQuestionsInBatches = async ({
  questionCount,
  batchSize = 5,
  generateBatch = generateLessonQuestions,
  onBatchComplete = null,
  onBatch = null,
  existingQuestions = [],
  answerPositionPlan = null,
  randomBytesImpl = secureRandomBytes,
  maxBatchAttempts = 3,
  ...input
}) => {
  if (!Number.isInteger(questionCount) || questionCount < 1) {
    throw new QuestionGenerationError('QUESTION_AI_INVALID_REQUEST', 'Question Count must be a positive whole number.');
  }
  const boundedBatchSize = Number.isInteger(batchSize) && batchSize > 0
    ? Math.min(batchSize, MAX_GENERATION_BATCH_SIZE)
    : 5;
  const boundedAttempts = Number.isInteger(maxBatchAttempts) && maxBatchAttempts > 0 ? Math.min(maxBatchAttempts, 5) : 3;
  const questions = [];
  const seen = new Set();
  const plannedPositions = answerPositionPlan || buildBalancedAnswerPositionPlan(questionCount, { existingQuestions, randomBytesImpl });
  try {
    partitionAnswerPositionPlan(plannedPositions, [questionCount]);
  } catch (error) {
    if (error instanceof QuestionGenerationError) throw error;
    throw new QuestionGenerationError('QUESTION_AI_ANSWER_BALANCE_IMPOSSIBLE', 'The generated answer-position plan does not match the requested questions.');
  }
  (Array.isArray(existingQuestions) ? existingQuestions : []).forEach((question) => {
    const normalized = normalizeGeneratedQuestion(question);
    if (normalized) seen.add(questionContentKey(normalized.question));
  });
  for (let offset = 0; offset < questionCount; offset += boundedBatchSize) {
    const count = Math.min(boundedBatchSize, questionCount - offset);
    let batch = null;
    for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
      const candidate = await generateBatch({
        ...input,
        questionCount: count,
        avoidQuestions: [...seen],
        deferAnswerPositionBalancing: true,
        answerPositionPlan: plannedPositions.slice(questions.length, questions.length + count),
        randomBytesImpl,
      });
      if (!Array.isArray(candidate) || candidate.length !== count) {
        if (attempt === boundedAttempts - 1) {
          throw new QuestionGenerationError('QUESTION_AI_INVALID_RESPONSE', 'Question generation returned an incomplete batch.');
        }
        continue;
      }
      const normalizedBatch = candidate.map(normalizeGeneratedQuestion);
      const fingerprints = normalizedBatch.map((question) => questionContentKey(question?.question));
      const batchHasInvalid = normalizedBatch.some((question) => !question);
      const batchHasDuplicate = fingerprints.some((fingerprint, index) => (
        !fingerprint
        || seen.has(fingerprint)
        || fingerprints.indexOf(fingerprint) !== index
      ));
      if (batchHasInvalid || batchHasDuplicate) {
        if (attempt === boundedAttempts - 1) {
          throw new QuestionGenerationError('QUESTION_AI_INVALID_RESPONSE', 'Question generation returned duplicate or invalid questions.');
        }
        continue;
      }
      batch = balanceCorrectAnswerPositions(
        normalizedBatch,
        plannedPositions.slice(questions.length, questions.length + count),
        randomBytesImpl
      );
      break;
    }
    if (!batch) {
      throw new QuestionGenerationError('QUESTION_AI_INVALID_RESPONSE', 'Question generation returned unusable question data.');
    }
    for (const question of batch) {
      const fingerprint = questionContentKey(question.question);
      seen.add(fingerprint);
      questions.push(question);
    }
    if (typeof onBatchComplete === 'function') {
      await onBatchComplete({ completed: questions.length, total: questionCount });
    }
    if (typeof onBatch === 'function') {
      await onBatch({
        batch,
        batch_index: Math.floor((questions.length - batch.length) / boundedBatchSize),
        completed: questions.length,
        total: questionCount,
      });
    }
  }
  return questions;
};

module.exports = {
  MAX_LESSON_TEXT_CHARS,
  OPENAI_RESPONSES_URL,
  QUESTION_GENERATION_MODEL,
  QUESTION_GENERATION_TIMEOUT_MS,
  MAX_GENERATION_BATCH_SIZE,
  QUESTION_GENERATION_OUTPUT_BASE_TOKENS,
  QUESTION_GENERATION_OUTPUT_TOKENS_PER_QUESTION,
  getQuestionGenerationMaxOutputTokens,
  QuestionGenerationError,
  buildBalancedAnswerPositionPlan,
  buildProviderDiagnostics,
  buildGenerationInput,
  generateLessonQuestions,
  generateLessonQuestionsInBatches,
  partitionAnswerPositionPlan,
  toQuestionGenerationHttpFailure,
};
