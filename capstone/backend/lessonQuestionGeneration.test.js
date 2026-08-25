const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QUESTION_GENERATION_MODEL,
  QuestionGenerationError,
  generateLessonQuestions,
} = require('./lessonQuestionGeneration');

const validQuestions = [
  {
    question: 'What is 3 + 4?',
    options: ['5', '6', '7', '8'],
    correct_answer: '7',
  },
  {
    question: 'What is 5 + 2?',
    options: ['6', '7', '8', '9'],
    correct_answer: '7',
  },
];

test('lesson generation fails with a configuration error before calling OpenAI when the server key is absent', async () => {
  let called = false;

  await assert.rejects(
    generateLessonQuestions({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      mathTopic: 'Basic Addition',
      questionCount: 2,
      apiKey: '',
      fetchImpl: async () => {
        called = true;
      },
    }),
    (error) => error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_NOT_CONFIGURED'
  );

  assert.equal(called, false);
});

test('lesson generation sends only lesson context to the server-side Responses API and validates the requested count', async () => {
  let request;
  const questions = await generateLessonQuestions({
    lessonText: 'Addition combines two quantities. Use counters to find sums.',
    title: 'Addition lesson',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
    mathTopic: 'Basic Addition',
    questionCount: 2,
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ questions: validQuestions }) }),
      };
    },
  });

  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  const requestBody = JSON.parse(request.options.body);
  assert.equal(requestBody.model, QUESTION_GENERATION_MODEL);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.schema.properties.questions.minItems, 2);
  assert.equal(requestBody.text.format.schema.properties.questions.maxItems, 2);
  assert.match(JSON.stringify(requestBody.input), /Addition combines two quantities/);
  assert.deepEqual(questions, validQuestions);
});

test('lesson generation rejects a provider response that does not produce exactly the requested number of usable questions', async () => {
  await assert.rejects(
    generateLessonQuestions({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      mathTopic: 'Basic Addition',
      questionCount: 2,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ questions: [validQuestions[0]] }) }),
      }),
    }),
    (error) => error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_INVALID_RESPONSE'
  );
});

test('lesson generation rejects a two-question response when either question lacks four distinct choices', async () => {
  const threeChoiceQuestion = {
    ...validQuestions[0],
    options: ['5', '6', '7'],
  };

  await assert.rejects(
    generateLessonQuestions({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      mathTopic: 'Basic Addition',
      questionCount: 2,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ questions: [threeChoiceQuestion, validQuestions[1]] }) }),
      }),
    }),
    (error) => error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_INVALID_RESPONSE'
  );
});

test('lesson generation captures only safe OpenAI failure metadata for quota diagnostics', async () => {
  const sensitiveProviderMessage = 'Never log this uploaded lesson text or API credential.';

  await assert.rejects(
    generateLessonQuestions({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      mathTopic: 'Basic Addition',
      questionCount: 2,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        headers: {
          get: (name) => (name === 'x-request-id' ? 'req_safe-123' : null),
        },
        json: async () => ({
          error: {
            type: 'insufficient_quota',
            code: 'insufficient_quota',
            message: sensitiveProviderMessage,
          },
        }),
      }),
    }),
    (error) => {
      assert.equal(error.code, 'QUESTION_AI_GENERATION_FAILED');
      assert.deepEqual(error.providerDiagnostics, {
        http_status: 429,
        category: 'quota_or_rate_limit',
        provider_type: 'insufficient_quota',
        provider_code: 'insufficient_quota',
        request_id: 'req_safe-123',
      });
      assert.doesNotMatch(JSON.stringify(error.providerDiagnostics), /Never log|credential|lesson text/i);
      return true;
    }
  );
});
