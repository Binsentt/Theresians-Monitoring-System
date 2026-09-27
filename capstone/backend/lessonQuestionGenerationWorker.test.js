const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_BATCH_SIZE, runQuestionGenerationJob } = require('./lessonQuestionGenerationWorker');
const { MAX_GENERATION_BATCH_SIZE } = require('./lessonQuestionGeneration');

assert.equal(MAX_BATCH_SIZE, MAX_GENERATION_BATCH_SIZE);

const makeQuestion = (index) => ({
  question: `What is ${index} + 1?`,
  options: [`${index}`, `${index + 1}`, `${index + 2}`, `${index + 3}`],
  correct_answer: `${index + 1}`,
});

function createStore(requestedCount, existingQuestions = []) {
  const job = {
    id: 91,
    title: 'Persisted lesson title',
    grade_level: 'Grade 3',
    difficulty: 'Normal',
    requested_question_count: requestedCount,
    generation_status: 'queued',
    generation_completed_count: existingQuestions.length,
    generation_remaining_count: requestedCount - existingQuestions.length,
  };
  const questions = [...existingQuestions];
  const progress = [];
  return {
    job,
    questions,
    progress,
    async getJob(id) {
      assert.equal(id, job.id);
      return { ...job, actual_question_count: questions.length };
    },
    async listQuestions(id) {
      assert.equal(id, job.id);
      return questions.map((question) => ({ ...question }));
    },
    async setStage(id, status) {
      assert.equal(id, job.id);
      job.generation_status = 'generating';
      job.generation_stage = status;
    },
    async completeIfExact(id) {
      assert.equal(id, job.id);
      if (questions.length !== requestedCount) return null;
      job.generation_status = 'ready_for_review';
      job.generation_stage = 'completed';
      job.generation_completed_count = questions.length;
      job.generation_remaining_count = 0;
      return { ...job, actual_question_count: questions.length };
    },
    async persistBatchAndProgress(id, batch) {
      assert.equal(id, job.id);
      questions.push(...batch.map((question) => ({ ...question })));
      const actual = questions.length;
      const remaining = Math.max(0, requestedCount - actual);
      job.generation_completed_count = actual;
      job.generation_remaining_count = remaining;
      job.generation_status = actual === requestedCount ? 'ready_for_review' : 'generating';
      job.generation_stage = actual === requestedCount ? 'completed' : 'generating';
      progress.push({ actual, remaining, status: job.generation_status });
      return { actualQuestionCount: actual, requestedCount, remainingQuestionCount: remaining };
    },
    async markFailed(id, failureCode) {
      assert.equal(id, job.id);
      job.generation_status = questions.length ? 'partial_failed' : 'failed';
      job.generation_stage = job.generation_status;
      job.generation_completed_count = questions.length;
      job.generation_remaining_count = Math.max(0, requestedCount - questions.length);
      job.generation_error_code = failureCode;
      return {
        actualQuestionCount: questions.length,
        requestedCount,
        remainingQuestionCount: job.generation_remaining_count,
        status: job.generation_status,
      };
    },
  };
}

test('provider batch metadata is read from the exact persisted question-file row', async () => {
  const store = createStore(1);
  let providerContext;
  await runQuestionGenerationJob({
    learningFileId: 91,
    store,
    generateBatch: async (_count, _batchIndex, context) => {
      providerContext = context;
      return [makeQuestion(1)];
    },
  });

  assert.equal(providerContext.job.title, 'Persisted lesson title');
  assert.equal(providerContext.job.grade_level, 'Grade 3');
  assert.equal(providerContext.job.difficulty, 'Normal');
  assert.equal(providerContext.job.requested_question_count, 1);
});

test('requested counts 5, 7, 17, 25, 37, and 50 persist exactly within the established provider batch cap', async (t) => {
  for (const requestedCount of [5, 7, 17, 25, 37, 50]) {
    await t.test(`requested ${requestedCount}`, async () => {
      const store = createStore(requestedCount);
      const batchSizes = [];
      let nextQuestion = 1;
      const result = await runQuestionGenerationJob({
        learningFileId: 91,
        store,
        generateBatch: async (count) => {
          batchSizes.push(count);
          return Array.from({ length: count }, () => makeQuestion(nextQuestion++));
        },
      });

      assert.deepEqual(batchSizes, Array.from({ length: Math.ceil(requestedCount / MAX_BATCH_SIZE) }, (_, index) => (
        index === Math.ceil(requestedCount / MAX_BATCH_SIZE) - 1 && requestedCount % MAX_BATCH_SIZE
          ? requestedCount % MAX_BATCH_SIZE
          : MAX_BATCH_SIZE
      )));
      assert.equal(store.questions.length, requestedCount);
      assert.equal(result.completedCount, requestedCount);
      assert.equal(result.remainingCount, 0);
      assert.equal(result.status, 'ready_for_review');
      assert.equal(store.job.generation_status, 'ready_for_review');
      assert.equal(store.progress.at(-1).actual, requestedCount);
      assert.equal(store.progress.at(-1).remaining, 0);
      assert.ok(store.progress.slice(0, -1).every((entry) => entry.status !== 'ready_for_review'));
    });
  }
});

test('each successful batch is persisted and progress is recalculated before the next provider batch', async () => {
  const store = createStore(17);
  const requestedAtCall = [];
  let nextQuestion = 1;

  const result = await runQuestionGenerationJob({
    learningFileId: 91,
    store,
    batchSize: 5,
    generateBatch: async (count) => {
      requestedAtCall.push({ count, persistedBeforeCall: store.questions.length });
      return Array.from({ length: count }, () => makeQuestion(nextQuestion++));
    },
  });

  assert.deepEqual(requestedAtCall, [
    { count: 5, persistedBeforeCall: 0 },
    { count: 5, persistedBeforeCall: 5 },
    { count: 5, persistedBeforeCall: 10 },
    { count: 2, persistedBeforeCall: 15 },
  ]);
  assert.deepEqual(store.progress.map(({ actual, remaining }) => [actual, remaining]), [
    [5, 12], [10, 7], [15, 2], [17, 0],
  ]);
  assert.equal(result.status, 'ready_for_review');
});

test('a later provider failure preserves earlier batches and retry resumes the same row for only the remainder', async () => {
  const store = createStore(17);
  let nextQuestion = 1;
  const firstAttemptSizes = [];
  const failed = await runQuestionGenerationJob({
    learningFileId: 91,
    store,
    batchSize: 5,
    generateBatch: async (count) => {
      firstAttemptSizes.push(count);
      if (firstAttemptSizes.length === 3) {
        const error = new Error('controlled provider failure');
        error.code = 'QUESTION_AI_GENERATION_FAILED';
        throw error;
      }
      return Array.from({ length: count }, () => makeQuestion(nextQuestion++));
    },
  });

  assert.deepEqual(firstAttemptSizes, [5, 5, 5]);
  assert.equal(store.questions.length, 10);
  assert.equal(failed.status, 'partial_failed');
  assert.equal(failed.completedCount, 10);
  assert.equal(failed.remainingCount, 7);
  assert.notEqual(store.job.generation_status, 'ready_for_review');

  const retrySizes = [];
  const retried = await runQuestionGenerationJob({
    learningFileId: 91,
    store,
    batchSize: 5,
    generateBatch: async (count) => {
      retrySizes.push(count);
      return Array.from({ length: count }, () => makeQuestion(nextQuestion++));
    },
  });

  assert.deepEqual(retrySizes, [5, 2]);
  assert.equal(store.questions.length, 17);
  assert.equal(new Set(store.questions.map((question) => question.question)).size, 17);
  assert.equal(retried.status, 'ready_for_review');
  assert.equal(retried.completedCount, 17);
  assert.equal(retried.remainingCount, 0);
});

test('duplicate question text is rejected and replacement batches continue to exact count', async () => {
  const store = createStore(7);
  const first = Array.from({ length: 5 }, (_, index) => makeQuestion(index + 1));
  const duplicate = { ...first[0], question: '  WHAT IS 1 + 1?  ' };
  const batchSizes = [];
  const batches = [first, [duplicate, makeQuestion(6)], [makeQuestion(7)]];

  const result = await runQuestionGenerationJob({
    learningFileId: 91,
    store,
    batchSize: 5,
    generateBatch: async (count) => {
      batchSizes.push(count);
      return batches.shift();
    },
  });

  assert.deepEqual(batchSizes, [5, 2, 1]);
  assert.equal(store.questions.length, 7);
  assert.equal(new Set(store.questions.map((question) => question.question.trim().toLowerCase())).size, 7);
  assert.equal(result.status, 'ready_for_review');
});

test('an all-duplicate provider batch fails truthfully without deleting the saved questions', async () => {
  const existing = [makeQuestion(1)];
  const store = createStore(2, existing);
  const duplicateBatch = Array.from({ length: 1 }, () => ({ ...existing[0], question: ' WHAT IS 1 + 1? ' }));
  const result = await runQuestionGenerationJob({
    learningFileId: 91,
    store,
    batchSize: 5,
    maxDuplicateBatches: 2,
    generateBatch: async () => duplicateBatch,
  });

  assert.equal(store.questions.length, 1);
  assert.equal(result.status, 'partial_failed');
  assert.equal(result.completedCount, 1);
  assert.equal(result.remainingCount, 1);
  assert.equal(result.failureCode, 'QUESTION_AI_DUPLICATE_BATCH');
  assert.notEqual(store.job.generation_status, 'ready_for_review');
});

test('a row whose actual saved count exceeds its requested count fails closed', async () => {
  const store = createStore(1, [makeQuestion(1), makeQuestion(2)]);
  let providerCalls = 0;
  const result = await runQuestionGenerationJob({
    learningFileId: 91,
    store,
    generateBatch: async () => {
      providerCalls += 1;
      return [makeQuestion(3)];
    },
  });

  assert.equal(providerCalls, 0);
  assert.notEqual(result.status, 'ready_for_review');
  assert.equal(result.completedCount, 2);
  assert.equal(result.failureCode, 'QUESTION_AI_COUNT_OVERFLOW');
});
