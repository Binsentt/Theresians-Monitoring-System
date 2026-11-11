const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_LESSON_TEXT_CHARS,
  QUESTION_GENERATION_MODEL,
  getQuestionGenerationMaxOutputTokens,
  QuestionGenerationError,
  generateLessonQuestions: generateLessonQuestionsWithPolicy,
  toQuestionGenerationHttpFailure,
} = require('./lessonQuestionGeneration');

const generateLessonQuestions = (input) => generateLessonQuestionsWithPolicy({
  aiGenerationEnabled: true,
  ...input,
});

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

test('paused lesson generation returns AI_PAUSED before any provider request', async () => {
  let providerCalls = 0;

  await assert.rejects(
    generateLessonQuestions({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      mathTopic: 'Basic Addition',
      questionCount: 2,
      aiGenerationEnabled: false,
      apiKey: 'provider-key-must-not-be-used',
      fetchImpl: async () => {
        providerCalls += 1;
      },
    }),
    (error) => error instanceof QuestionGenerationError && error.code === 'AI_PAUSED'
  );

  assert.equal(providerCalls, 0);
  assert.deepEqual(
    toQuestionGenerationHttpFailure(new QuestionGenerationError('AI_PAUSED', 'internal detail')),
    {
      status: 503,
      code: 'AI_PAUSED',
      error: 'AI generation is temporarily paused. Recorded data and available questions remain accessible.',
    }
  );
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
  assert.ok(Number.isInteger(requestBody.max_output_tokens));
  assert.equal(requestBody.max_output_tokens, getQuestionGenerationMaxOutputTokens(2));
  assert.ok(requestBody.max_output_tokens >= 2000);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.schema.properties.questions.minItems, 2);
  assert.equal(requestBody.text.format.schema.properties.questions.maxItems, 2);
  assert.match(JSON.stringify(requestBody.input), /Addition combines two quantities/);
  assert.deepEqual(questions.map((question) => question.question), validQuestions.map((question) => question.question));
  assert.deepEqual(questions.map((question) => question.correct_answer), validQuestions.map((question) => question.correct_answer));
  questions.forEach((question, index) => {
    assert.deepEqual(new Set(question.options), new Set(validQuestions[index].options));
    assert.equal(question.options.filter((option) => option === question.correct_answer).length, 1);
  });
  assert.equal(new Set(questions.map((question) => question.options.indexOf(question.correct_answer))).size, 2);
});

test('lesson generation prompt uses an explicitly selected canonical Mathematics topic', async () => {
  let request;

  await generateLessonQuestions({
    lessonText: 'Addition combines two quantities.',
    title: 'Addition lesson',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
    mathTopic: 'Basic Addition',
    questionCount: 2,
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ questions: validQuestions }) }),
      };
    },
  });

  const input = JSON.stringify(request.input);
  assert.match(input, /Grade: Grade 1/);
  assert.match(input, /Difficulty: Easy/);
  assert.match(input, /Selected canonical Mathematics topic: Basic Addition/);
  assert.doesNotMatch(input, /Topic ID:/);
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
  let providerCalls = 0;

  await assert.rejects(
    generateLessonQuestions({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      mathTopic: 'Basic Addition',
      questionCount: 2,
      apiKey: 'test-key',
      fetchImpl: async () => {
        providerCalls += 1;
        return {
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
        };
      },
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

  assert.equal(providerCalls, 1);
});

test('quota exhaustion becomes a truthful retryable service error without blaming the PPTX source', () => {
  const failure = toQuestionGenerationHttpFailure(new QuestionGenerationError(
    'QUESTION_AI_GENERATION_FAILED',
    'provider failure',
    { category: 'quota_or_rate_limit', provider_code: 'credit_balance_exhausted' }
  ));

  assert.deepEqual(failure, {
    status: 503,
    code: 'QUESTION_AI_GENERATION_FAILED',
    error: 'Question AI is temporarily unavailable. No questions were created. Please try again after the service is restored.',
  });
  assert.doesNotMatch(JSON.stringify(failure), /credit_balance|provider failure/i);
});

test('lesson generation rejects an empty lesson before making a provider request', async () => {
  let called = false;

  await assert.rejects(
    generateLessonQuestions({
      lessonText: '',
      title: '',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      mathTopic: 'Basic Addition',
      questionCount: 2,
      apiKey: 'test-key',
      fetchImpl: async () => {
        called = true;
      },
    }),
    (error) => error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_EMPTY_LESSON'
  );

  assert.equal(called, false);
});

test('lesson generation never substitutes a title for missing lesson text or silently truncates it', async () => {
  let called = false;
  const input = {
    title: 'A title is not lesson text',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
    topicId: 'basic_addition',
    mathTopic: 'Basic Addition',
    questionCount: 2,
    apiKey: 'test-key',
    fetchImpl: async () => {
      called = true;
    },
  };

  await assert.rejects(
    generateLessonQuestions({ ...input, lessonText: '' }),
    (error) => error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_EMPTY_LESSON'
  );
  await assert.rejects(
    generateLessonQuestions({ ...input, lessonText: 'x'.repeat(MAX_LESSON_TEXT_CHARS + 1) }),
    (error) => error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_LESSON_TOO_LARGE'
  );
  assert.equal(called, false);
});

test('lesson generation rejects every malformed provider output shape without accepting a partial question set', async () => {
  const malformedOutputs = [
    JSON.stringify({ questions: [validQuestions[0]] }),
    JSON.stringify({ questions: [...validQuestions, validQuestions[0]] }),
    JSON.stringify({ questions: [{ ...validQuestions[0], options: ['5', '6', '7'] }, validQuestions[1]] }),
    JSON.stringify({ questions: [{ ...validQuestions[0], options: ['5', '5', '7', '8'] }, validQuestions[1]] }),
    JSON.stringify({ questions: [{ ...validQuestions[0], question: '' }, validQuestions[1]] }),
    JSON.stringify({ questions: [{ question: validQuestions[0].question, options: validQuestions[0].options }, validQuestions[1]] }),
    JSON.stringify({ questions: [{ ...validQuestions[0], correct_answer: 'not an option' }, validQuestions[1]] }),
    '{not valid json',
  ];

  for (const outputText of malformedOutputs) {
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
          json: async () => ({ output_text: outputText }),
        }),
      }),
      (error) => error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_INVALID_RESPONSE'
    );
  }
});

test('lesson generation aborts a provider request that exceeds its bounded timeout', async () => {
  let abortObserved = false;
  let providerCalls = 0;

  await assert.rejects(
    generateLessonQuestions({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      mathTopic: 'Basic Addition',
      questionCount: 2,
      apiKey: 'test-key',
      timeoutMs: 5,
      fetchImpl: async (_url, options = {}) => {
        providerCalls += 1;
        if (!options.signal) {
          return {
            ok: false,
            status: 599,
            headers: { get: () => null },
            json: async () => ({}),
          };
        }
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            abortObserved = true;
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    }),
    (error) => {
      assert.equal(error.code, 'QUESTION_AI_TIMEOUT');
      assert.equal(error.providerDiagnostics.category, 'timeout');
      assert.equal(error.providerDiagnostics.timeout_layer, 'provider_request');
      assert.equal(error.providerDiagnostics.timeout_ms, 5);
      assert.ok(error.providerDiagnostics.elapsed_ms >= 0);
      return true;
    }
  );

  assert.equal(abortObserved, true);
  assert.equal(providerCalls, 1);
});

test('lesson generation reserves a realistic deadline for larger exact structured sets', () => {
  const { QUESTION_GENERATION_TIMEOUT_MS, MAX_GENERATION_BATCH_SIZE } = require('./lessonQuestionGeneration');

  assert.equal(QUESTION_GENERATION_TIMEOUT_MS, 120000);
  assert.equal(MAX_GENERATION_BATCH_SIZE, 25);
});

test('lesson generation batches larger requests and only returns a complete validated set', async () => {
  const { generateLessonQuestionsInBatches } = require('./lessonQuestionGeneration');
  const calls = [];
  const progress = [];
  const questions = await generateLessonQuestionsInBatches({
    lessonText: 'A lesson about addition.',
    title: 'Addition lesson',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
    questionCount: 12,
    batchSize: 5,
    onBatchComplete: (state) => progress.push(state),
    apiKey: 'test-key',
    generateBatch: async (input) => {
      calls.push(input.questionCount);
      return Array.from({ length: input.questionCount }, (_, index) => ({
        question: `Question ${calls.length}-${index}`,
        options: ['1', '2', '3', '4'],
        correct_answer: '1',
      }));
    },
  });

  assert.deepEqual(calls, [5, 5, 2]);
  assert.deepEqual(progress, [
    { completed: 5, total: 12 },
    { completed: 10, total: 12 },
    { completed: 12, total: 12 },
  ]);
  assert.equal(questions.length, 12);
});

test('lesson generation completes the exact requested 5, 10, 20, and 25 question targets in five-question batches', async () => {
  const { generateLessonQuestionsInBatches } = require('./lessonQuestionGeneration');

  for (const target of [5, 10, 20, 25]) {
    const calls = [];
    let nextQuestionNumber = 1;
    const questions = await generateLessonQuestionsInBatches({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      questionCount: target,
      batchSize: 5,
      generateBatch: async ({ questionCount }) => {
        calls.push(questionCount);
        return Array.from({ length: questionCount }, () => {
          const value = nextQuestionNumber++;
          return {
            question: `What is ${value} + 1?`,
            options: [String(value), String(value + 1), String(value + 2), String(value + 3)],
            correct_answer: String(value + 1),
          };
        });
      },
    });

    assert.equal(questions.length, target);
    assert.deepEqual(calls, Array(target / 5).fill(5));
    questions.forEach((question) => {
      assert.equal(question.options.length, 4);
      assert.equal(new Set(question.options).size, 4);
      assert.ok(question.options.includes(question.correct_answer));
    });
  }
});

test('lesson source extraction errors remain distinct controlled client errors', () => {
  const cases = [
    ['QUESTION_AI_PDF_INVALID', 'The uploaded PDF is invalid or corrupted. Use a valid text-based PDF, PPTX, or DOCX file.'],
    ['QUESTION_AI_PDF_NO_TEXT', 'No readable text was found in this PDF. Use a text-based PDF, PPTX, or DOCX file.'],
    ['QUESTION_AI_PDF_EXTRACTION_FAILED', 'PDF text extraction failed. Re-export as a text-based PDF or use a PPTX or DOCX file.'],
    ['QUESTION_AI_DOCX_INVALID', 'The uploaded DOCX is invalid or missing required document content.'],
  ];
  for (const [code, message] of cases) {
    assert.deepEqual(toQuestionGenerationHttpFailure(new QuestionGenerationError(code, message)), {
      status: 422,
      code,
      error: message,
    });
  }
});

test('lesson generation preserves arbitrary whole-number targets and reports exact batch progress', async () => {
  const { generateLessonQuestionsInBatches } = require('./lessonQuestionGeneration');

  for (const target of [7, 13, 28]) {
    const calls = [];
    const progress = [];
    let nextQuestionNumber = 1;
    const questions = await generateLessonQuestionsInBatches({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      questionCount: target,
      batchSize: 5,
      onBatchComplete: (state) => progress.push(state),
      generateBatch: async ({ questionCount }) => {
        calls.push(questionCount);
        return Array.from({ length: questionCount }, () => {
          const value = nextQuestionNumber++;
          return {
            question: `Dynamic target ${target}: ${value} + 1?`,
            options: [String(value), String(value + 1), String(value + 2), String(value + 3)],
            correct_answer: String(value + 1),
          };
        });
      },
    });

    const expectedCalls = Array(Math.floor(target / 5)).fill(5);
    if (target % 5) expectedCalls.push(target % 5);
    const expectedProgress = expectedCalls.map((_, index) => ({
      completed: Math.min((index + 1) * 5, target),
      total: target,
    }));
    assert.deepEqual(calls, expectedCalls);
    assert.deepEqual(progress, expectedProgress);
    assert.equal(questions.length, target);
  }
});

test('lesson generation honors teacher-selected totals up to 50 while capping each provider batch at 25', async () => {
  const { generateLessonQuestionsInBatches } = require('./lessonQuestionGeneration');

  for (const target of [5, 10, 20, 25, 37, 50]) {
    const calls = [];
    let nextQuestionNumber = 1;
    const questions = await generateLessonQuestionsInBatches({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      questionCount: target,
      batchSize: target,
      generateBatch: async ({ questionCount }) => {
        calls.push(questionCount);
        return Array.from({ length: questionCount }, () => {
          const value = nextQuestionNumber++;
          return {
            question: `Exact set ${target} question ${value}`,
            options: ['1', '2', '3', '4'],
            correct_answer: '1',
          };
        });
      },
    });

    const expectedCalls = target <= 25 ? [target] : [25, target - 25];
    assert.deepEqual(calls, expectedCalls);
    assert.equal(questions.length, target);
  }
});


test('later AI batches receive prior question text and retry a duplicate batch instead of stopping at five', async () => {
  const { generateLessonQuestionsInBatches } = require('./lessonQuestionGeneration');
  const calls = [];
  let providerCall = 0;

  const questions = await generateLessonQuestionsInBatches({
    lessonText: 'A lesson about addition.',
    title: 'Addition lesson',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
    questionCount: 10,
    batchSize: 5,
    generateBatch: async ({ questionCount, avoidQuestions = [] }) => {
      providerCall += 1;
      calls.push({ providerCall, questionCount, avoidQuestions: [...avoidQuestions] });
      const start = providerCall === 1 ? 1 : providerCall === 2 ? 1 : 6;
      return Array.from({ length: questionCount }, (_, index) => {
        const value = start + index;
        return {
          question: `What is ${value} + 1?`,
          options: [String(value), String(value + 1), String(value + 2), String(value + 3)],
          correct_answer: String(value + 1),
        };
      });
    },
  });

  assert.equal(questions.length, 10);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].avoidQuestions, []);
  assert.ok(calls[1].avoidQuestions.some((question) => /what is 1 \+ 1\?/i.test(question)));
  assert.ok(calls[2].avoidQuestions.some((question) => /what is 5 \+ 1\?/i.test(question)));
  assert.equal(new Set(questions.map((question) => question.question.toLowerCase())).size, 10);
});


test('lesson generation retries only the missing questions and rejects duplicates from the retained set', async () => {
  const batches = [];
  const retained = [{
    question: 'Retained question',
    options: ['1', '2', '3', '4'],
    correct_answer: '1',
  }];
  const generated = await require('./lessonQuestionGeneration').generateLessonQuestionsInBatches({
    lessonText: 'A lesson about addition.',
    title: 'Addition lesson',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
    questionCount: 2,
    batchSize: 2,
    existingQuestions: retained,
    generateBatch: async ({ questionCount }) => Array.from({ length: questionCount }, (_, index) => ({
      question: `New question ${index + 1}`,
      options: ['1', '2', '3', '4'],
      correct_answer: '1',
    })),
    onBatch: ({ batch, batch_index }) => batches.push({ batch, batch_index }),
  });

  assert.equal(generated.length, 2);
  assert.equal(generated[0].question, 'New question 1');
  assert.deepEqual(batches.map((entry) => entry.batch_index), [0]);
});

test('single-request generation balances correct answers across A-D without changing answer mapping', async () => {
  const generated = Array.from({ length: 20 }, (_, index) => ({
    question: `Generated question ${index + 1}`,
    options: ['correct', `wrong-${index}-a`, `wrong-${index}-b`, `wrong-${index}-c`],
    correct_answer: 'correct',
  }));
  const questions = await generateLessonQuestions({
    lessonText: 'A lesson about addition.',
    title: 'Addition lesson',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
    questionCount: generated.length,
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ questions: generated }) }),
    }),
  });

  const counts = [0, 0, 0, 0];
  questions.forEach((question) => {
    counts[question.options.indexOf(question.correct_answer)] += 1;
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options).size, 4);
    assert.equal(question.options.filter((option) => option === question.correct_answer).length, 1);
  });
  assert.deepEqual(counts, [5, 5, 5, 5]);
});

test('batched generation persists and returns the same globally balanced A-D answer positions', async () => {
  const persisted = [];
  let batchIndex = 0;
  const questions = await require('./lessonQuestionGeneration').generateLessonQuestionsInBatches({
    questionCount: 20,
    batchSize: 5,
    generateBatch: async ({ questionCount }) => {
      const currentBatch = batchIndex++;
      return Array.from({ length: questionCount }, (_, index) => ({
        question: `Batch ${currentBatch} question ${index + 1}`,
        options: ['correct', `wrong-${currentBatch}-${index}-a`, `wrong-${currentBatch}-${index}-b`, `wrong-${currentBatch}-${index}-c`],
        correct_answer: 'correct',
      }));
    },
    onBatch: async ({ batch }) => persisted.push(...batch),
  });

  const counts = [0, 0, 0, 0];
  questions.forEach((question) => { counts[question.options.indexOf(question.correct_answer)] += 1; });
  assert.deepEqual(counts, [5, 5, 5, 5]);
  assert.deepEqual(
    persisted.map((question) => question.options.indexOf(question.correct_answer)),
    questions.map((question) => question.options.indexOf(question.correct_answer))
  );
});

test('batched generation retries a repeated prompt after whitespace normalization', async () => {
  let calls = 0;
  const questions = await require('./lessonQuestionGeneration').generateLessonQuestionsInBatches({
    questionCount: 2,
    batchSize: 1,
    maxBatchAttempts: 2,
    generateBatch: async ({ avoidQuestions }) => {
      calls += 1;
      if (calls === 1) return [{ question: 'What is 1 + 1?', options: ['2', '1', '3', '4'], correct_answer: '2' }];
      if (calls === 2) {
        assert.ok(avoidQuestions.some((question) => (
          question.toLocaleLowerCase().trim().replace(/\s+/gu, ' ') === 'what is 1 + 1?'
        )));
        return [{ question: ' what   is 1 + 1? ', options: ['2', '1', '3', '4'], correct_answer: '2' }];
      }
      return [{ question: 'What is 2 + 2?', options: ['4', '2', '3', '5'], correct_answer: '4' }];
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(questions.map((question) => question.question), ['What is 1 + 1?', 'What is 2 + 2?']);
});

test('one provider response rejects repeated question content even when options differ', async () => {
  await assert.rejects(
    generateLessonQuestions({
      lessonText: 'A lesson about addition.',
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      questionCount: 2,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ questions: [
          { question: 'What is 1 + 1?', options: ['2', '1', '3', '4'], correct_answer: '2' },
          { question: ' what   is 1 + 1? ', options: ['3', '2', '4', '5'], correct_answer: '3' },
        ] }) }),
      }),
    }),
    (error) => error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_INVALID_RESPONSE'
  );
});

const answerPositionSeeds = Array.from({ length: 32 }, (_, index) => index + 1);
const deterministicRandomBytes = (initialSeed) => {
  const { createHash } = require('node:crypto');
  let counter = 0;
  return (size) => {
    const chunks = [];
    let total = 0;
    while (total < size) {
      const chunk = createHash('sha256').update(`${initialSeed}:${counter}`).digest();
      counter += 1;
      chunks.push(chunk);
      total += chunk.length;
    }
    const bytes = Buffer.concat(chunks, total).subarray(0, size);
    return bytes;
  };
};

const verifyControlledAnswerPositions = async (questionCount, generate) => {
  const remainderPositions = new Set();
  const sequences = new Set();
  const source = Array.from({ length: questionCount }, (_, index) => ({
    question: `Synthetic question ${index + 1}`,
    options: [`correct-${index}`, `wrong-${index}-a`, `wrong-${index}-b`, `wrong-${index}-c`],
    correct_answer: `correct-${index}`,
  }));

  for (const seed of answerPositionSeeds) {
    const questions = await generate(source, deterministicRandomBytes(seed));
    assert.equal(questions.length, questionCount);
    const counts = [0, 0, 0, 0];
    const positions = questions.map((question, index) => {
      assert.equal(question.question, source[index].question);
      assert.equal(question.correct_answer, source[index].correct_answer);
      assert.equal(question.options.length, 4);
      assert.ok(question.options.every((option) => typeof option === 'string' && option.trim()));
      assert.deepEqual(new Set(question.options), new Set(source[index].options));
      assert.equal(question.options.filter((option) => option === question.correct_answer).length, 1);
      const position = question.options.indexOf(question.correct_answer);
      counts[position] += 1;
      return position;
    });
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    for (let index = 4; index < positions.length; index += 1) {
      const previousCycle = positions.slice(index - 4, index);
      if (new Set(previousCycle).size === 4) assert.notEqual(positions[index], positions[index - 4]);
    }
    counts.forEach((count, position) => {
      if (count > Math.floor(questionCount / 4)) remainderPositions.add(position);
    });
    sequences.add(positions.join(','));
  }

  // Remainder labels vary across deterministic samples rather than following
  // a fixed A-B-C-D pattern.
  if (questionCount % 4 !== 0) {
    assert.equal(remainderPositions.size, 4);
  }
  assert.ok(sequences.size > 1, 'answer positions must vary across generated sets');
};

for (const questionCount of [1, 2, 3, 5, 17, 20]) {
  test(`controlled single-request answer positions cover A-D for ${questionCount} questions`, async () => {
    await verifyControlledAnswerPositions(questionCount, (source, randomBytesImpl) => generateLessonQuestions({
      lessonText: 'A synthetic addition lesson.',
      title: 'Synthetic lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      questionCount,
      randomBytesImpl,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ questions: source }) }),
      }),
    }));
  });

  test(`controlled batched answer positions preserve persisted mappings for ${questionCount} questions`, async () => {
    await verifyControlledAnswerPositions(questionCount, async (source, randomBytesImpl) => {
      let offset = 0;
      const persisted = [];
      const questions = await require('./lessonQuestionGeneration').generateLessonQuestionsInBatches({
        questionCount,
        batchSize: 5,
        randomBytesImpl,
        generateBatch: async ({ questionCount: batchCount }) => {
          const batch = source.slice(offset, offset + batchCount);
          offset += batchCount;
          return batch;
        },
        onBatch: async ({ batch }) => persisted.push(...JSON.parse(JSON.stringify(batch))),
      });
      assert.deepEqual(persisted, questions);
      return questions;
    });
  });
}

const getAnswerPositions = (questions) => questions.map((question) => {
  assert.equal(question.options.length, 4);
  assert.equal(new Set(question.options).size, 4);
  assert.equal(question.options.filter((option) => option === question.correct_answer).length, 1);
  return question.options.indexOf(question.correct_answer);
});

const assertBalancedAnswerPositions = (positions, expectedCount) => {
  const counts = [0, 0, 0, 0];
  positions.forEach((position) => { counts[position] += 1; });
  assert.equal(positions.length, expectedCount);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `expected balanced A-D counts; got ${counts}`);
  return counts;
};

test('randomizes the extra answer position across small complete sets without a fixed A bias', () => {
  const extraPositionCounts = [0, 0, 0, 0];
  const observedSequences = new Set();
  for (let seed = 1; seed <= 512; seed += 1) {
    const positions = require('./lessonQuestionGeneration').buildBalancedAnswerPositionPlan(5, {
      randomBytesImpl: deterministicRandomBytes(seed * 7919),
    });
    const counts = assertBalancedAnswerPositions(positions, 5);
    extraPositionCounts[counts.indexOf(2)] += 1;
    observedSequences.add(positions.join(','));
  }
  assert.ok(extraPositionCounts.every((count) => count >= 80 && count <= 176), `unexpected extra-position distribution: ${extraPositionCounts}`);
  assert.ok(observedSequences.size > 100, 'answer-position sequences must vary across generated sets');
});

test('balances complete generated sets across separate topic groups and provider batches', async () => {
  const { buildBalancedAnswerPositionPlan, partitionAnswerPositionPlan } = require('./lessonQuestionGeneration');

  for (const questionCount of [4, 5, 8, 10, 20, 25, 50]) {
    const randomBytesImpl = deterministicRandomBytes(questionCount * 97);
    const plan = buildBalancedAnswerPositionPlan(questionCount, { randomBytesImpl });
    const groupCounts = [Math.ceil(questionCount / 2), Math.floor(questionCount / 2)];
    const groupPlans = partitionAnswerPositionPlan(plan, groupCounts);
    const persisted = [];
    const allQuestions = [];
    let nextQuestion = 0;

    for (let groupIndex = 0; groupIndex < groupCounts.length; groupIndex += 1) {
      const existingQuestions = [...allQuestions];
      const generated = await require('./lessonQuestionGeneration').generateLessonQuestionsInBatches({
        questionCount: groupCounts[groupIndex],
        batchSize: 5,
        existingQuestions,
        answerPositionPlan: groupPlans[groupIndex],
        randomBytesImpl,
        generateBatch: async ({ questionCount: batchCount }) => Array.from({ length: batchCount }, (_, index) => {
          const id = nextQuestion++;
          return {
            question: `Synthetic topic ${groupIndex + 1} question ${id + 1}`,
            options: [`correct-${id}`, `wrong-${id}-a`, `wrong-${id}-b`, `wrong-${id}-c`],
            correct_answer: `correct-${id}`,
          };
        }),
        onBatch: async ({ batch }) => persisted.push(...JSON.parse(JSON.stringify(batch))),
      });
      allQuestions.push(...generated);
    }

    const positions = getAnswerPositions(allQuestions);
    const counts = assertBalancedAnswerPositions(positions, questionCount);
    assert.deepEqual(persisted, allQuestions);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    for (let index = 2; index < positions.length; index += 1) {
      assert.notEqual(positions[index], positions[index - 1] === positions[index - 2] ? positions[index - 1] : -1);
    }
    for (let index = 4; index < positions.length; index += 1) {
      const previousCycle = positions.slice(index - 4, index);
      if (new Set(previousCycle).size === 4) assert.notEqual(positions[index], positions[index - 4]);
    }
  }
});

test('retry planning accounts for saved correct-answer positions without rewriting saved questions', async () => {
  const { buildBalancedAnswerPositionPlan } = require('./lessonQuestionGeneration');
  const savedPositions = [0, 0, 1, 1, 2, 2];
  const existingQuestions = savedPositions.map((position, index) => {
    const options = [`correct-${index}`, `wrong-${index}-a`, `wrong-${index}-b`, `wrong-${index}-c`];
    const [correct, ...distractors] = options;
    const arranged = [...distractors];
    arranged.splice(position, 0, correct);
    return { question: `Saved question ${index + 1}`, options: arranged, correct_answer: correct };
  });
  const existingSnapshot = JSON.parse(JSON.stringify(existingQuestions));
  const randomBytesImpl = deterministicRandomBytes(417);
  const retryPlan = buildBalancedAnswerPositionPlan(14, { existingQuestions, randomBytesImpl });
  const generated = await require('./lessonQuestionGeneration').generateLessonQuestionsInBatches({
    questionCount: 14,
    batchSize: 5,
    existingQuestions,
    answerPositionPlan: retryPlan,
    randomBytesImpl,
    generateBatch: async ({ questionCount, avoidQuestions }) => Array.from({ length: questionCount }, (_, index) => {
      const id = existingQuestions.length + avoidQuestions.length + index;
      return {
        question: `Retry question ${id}`,
        options: [`retry-correct-${id}`, `retry-wrong-${id}-a`, `retry-wrong-${id}-b`, `retry-wrong-${id}-c`],
        correct_answer: `retry-correct-${id}`,
      };
    }),
  });

  const finalQuestions = [...existingQuestions, ...generated];
  const positions = getAnswerPositions(finalQuestions);
  assert.deepEqual(assertBalancedAnswerPositions(positions, 20), [5, 5, 5, 5]);
  assert.deepEqual(existingQuestions, existingSnapshot);
  for (let index = 2; index < positions.length; index += 1) {
    assert.notEqual(positions[index], positions[index - 1] === positions[index - 2] ? positions[index - 1] : -1);
  }
  for (let index = 4; index < positions.length; index += 1) {
    const previousCycle = positions.slice(index - 4, index);
    if (new Set(previousCycle).size === 4) assert.notEqual(positions[index], positions[index - 4]);
  }
});

test('does not claim a balanced extension when saved questions make one impossible', () => {
  const { buildBalancedAnswerPositionPlan, QuestionGenerationError } = require('./lessonQuestionGeneration');
  const existingQuestions = Array.from({ length: 10 }, (_, index) => ({
    question: `Saved question ${index + 1}`,
    options: [`correct-${index}`, `wrong-${index}-a`, `wrong-${index}-b`, `wrong-${index}-c`],
    correct_answer: `correct-${index}`,
  }));

  assert.throws(() => buildBalancedAnswerPositionPlan(2, { existingQuestions }), (error) => (
    error instanceof QuestionGenerationError && error.code === 'QUESTION_AI_ANSWER_BALANCE_IMPOSSIBLE'
  ));
});
