const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const QUESTION_GENERATION_MODEL = 'gpt-5-mini';
const MAX_LESSON_TEXT_CHARS = 24000;

class QuestionGenerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QuestionGenerationError';
    this.code = code;
  }
}

const asTrimmedString = (value) => String(value || '').trim();

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
            minItems: 2,
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
    ? item.options.map(asTrimmedString).filter(Boolean)
    : [];
  const correctAnswer = asTrimmedString(item?.correct_answer);

  if (!question || options.length < 2 || options.length > 4 || !correctAnswer || !options.includes(correctAnswer)) {
    return null;
  }

  return {
    question,
    options,
    correct_answer: correctAnswer,
  };
};

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

  return questions;
};

const buildGenerationInput = ({ lessonText, title, gradeLevel, difficulty, mathTopic, questionCount }) => {
  const lesson = asTrimmedString(lessonText).slice(0, MAX_LESSON_TEXT_CHARS);
  const fallbackTitle = asTrimmedString(title);
  if (!lesson && !fallbackTitle) {
    throw new QuestionGenerationError('QUESTION_AI_EMPTY_LESSON', 'The lesson PDF does not contain readable text for question generation.');
  }

  return [
    {
      role: 'system',
      content: [{
        type: 'input_text',
        text: 'You create age-appropriate mathematics multiple-choice questions. Use only the supplied lesson content for facts, methods, and examples. Do not include explanations, markdown, or extra fields. Every correct_answer must exactly match one options value.',
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
          `Topic identifier: ${asTrimmedString(mathTopic)}.`,
          `Lesson title: ${fallbackTitle || 'Untitled lesson'}.`,
          'Lesson content:',
          lesson || fallbackTitle,
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
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = global.fetch,
}) => {
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

  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: QUESTION_GENERATION_MODEL,
        input: buildGenerationInput({ lessonText, title, gradeLevel, difficulty, mathTopic, questionCount }),
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
  } catch {
    throw new QuestionGenerationError('QUESTION_AI_GENERATION_FAILED', 'Question AI could not generate questions right now.');
  }

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    // The response status below still determines the safe public error.
  }

  if (!response.ok) {
    throw new QuestionGenerationError('QUESTION_AI_GENERATION_FAILED', 'Question AI could not generate questions right now.');
  }

  const outputText = extractOutputText(responseBody);
  if (!outputText) {
    throw new QuestionGenerationError('QUESTION_AI_INVALID_RESPONSE', 'Question generation returned no structured output.');
  }
  return parseGeneratedQuestions(outputText, questionCount);
};

module.exports = {
  MAX_LESSON_TEXT_CHARS,
  OPENAI_RESPONSES_URL,
  QUESTION_GENERATION_MODEL,
  QuestionGenerationError,
  generateLessonQuestions,
};
