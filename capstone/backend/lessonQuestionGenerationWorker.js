const { MAX_GENERATION_BATCH_SIZE } = require('./lessonQuestionGeneration');

const MAX_BATCH_SIZE = MAX_GENERATION_BATCH_SIZE;

const normalizeQuestionText = (question) => String(question || '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ')
  .toLocaleLowerCase();

const normalizeQuestion = (value) => {
  const question = String(value?.question || '').trim().replace(/\s+/g, ' ');
  const options = Array.isArray(value?.options)
    ? value.options.map((option) => String(option || '').trim())
    : [];
  const correctAnswer = String(value?.correct_answer || '').trim();
  const distinctOptions = new Set(options.map((option) => option.toLocaleLowerCase())).size === options.length;
  const answerMatchesOnce = options.filter((option) => option === correctAnswer).length === 1;

  if (!question || options.length !== 4 || options.some((option) => !option) || !distinctOptions || !answerMatchesOnce) {
    return null;
  }

  return { ...value, question, options, correct_answer: correctAnswer };
};

const makeResult = ({ status, requestedCount, completedCount, failureCode = null }) => ({
  status,
  requestedCount,
  completedCount,
  remainingCount: Math.max(0, requestedCount - completedCount),
  failureCode,
});

const normalizeFailureCode = (error) => {
  const code = String(error?.code || '').trim();
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'QUESTION_AI_BATCH_FAILED';
};

async function runQuestionGenerationJob({
  learningFileId,
  store,
  generateBatch,
  batchSize = MAX_BATCH_SIZE,
  maxDuplicateBatches = 3,
}) {
  if (!Number.isSafeInteger(Number(learningFileId)) || Number(learningFileId) < 1) {
    throw new TypeError('learningFileId must be a positive integer');
  }
  if (!store || typeof store.getJob !== 'function' || typeof store.listQuestions !== 'function'
    || typeof store.setStage !== 'function' || typeof store.persistBatchAndProgress !== 'function'
    || typeof store.completeIfExact !== 'function' || typeof store.markFailed !== 'function') {
    throw new TypeError('store must implement the row-backed generation persistence contract');
  }
  if (typeof generateBatch !== 'function') throw new TypeError('generateBatch must be a function');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be a positive integer');
  if (!Number.isInteger(maxDuplicateBatches) || maxDuplicateBatches < 1) {
    throw new TypeError('maxDuplicateBatches must be a positive integer');
  }

  const rowId = Number(learningFileId);
  const boundedBatchSize = Math.min(batchSize, MAX_BATCH_SIZE);
  let job = await store.getJob(rowId);
  if (!job) throw new Error('Question generation row was not found');

  const requestedCount = Number(job.requested_question_count);
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) {
    throw new Error('Question generation row has an invalid requested count');
  }

  let completedCount = Number(job.actual_question_count);
  if (!Number.isSafeInteger(completedCount) || completedCount < 0) {
    throw new Error('Question generation row has an invalid saved question count');
  }

  const finishIfExact = async () => {
    const readyRow = await store.completeIfExact(rowId);
    if (!readyRow) return null;
    const actual = Number(readyRow.actual_question_count ?? readyRow.generation_completed_count);
    if (actual !== requestedCount) return null;
    return makeResult({
      status: 'ready_for_review',
      requestedCount,
      completedCount: actual,
    });
  };

  let batchIndex = 0;
  let failedBatchIndex = null;

  const fail = async (error) => {
    const failureCode = normalizeFailureCode(error);
    const failedRow = await store.markFailed(rowId, failureCode, failedBatchIndex);
    const actual = Number(failedRow?.actualQuestionCount ?? failedRow?.generation_completed_count ?? completedCount);
    const status = failedRow?.status || failedRow?.generation_status || (actual > 0 ? 'partial_failed' : 'failed');
    if (status === 'ready_for_review' && actual === requestedCount) {
      return makeResult({ status, requestedCount, completedCount: actual });
    }
    return makeResult({ status, requestedCount, completedCount: actual, failureCode });
  };

  if (completedCount > requestedCount) {
    return fail(Object.assign(new Error('Saved question count exceeds the requested count'), {
      code: 'QUESTION_AI_COUNT_OVERFLOW',
    }));
  }

  const alreadyComplete = await finishIfExact();
  if (alreadyComplete) return alreadyComplete;

  let savedQuestions = await store.listQuestions(rowId);
  let knownQuestions = new Set(savedQuestions.map((question) => normalizeQuestionText(question?.question)).filter(Boolean));
  let duplicateBatches = 0;

  while (completedCount < requestedCount) {
    const requestedBatchCount = Math.min(boundedBatchSize, requestedCount - completedCount);
    try {
      failedBatchIndex = batchIndex;
      await store.setStage(rowId, 'generating');
      const generated = await generateBatch(requestedBatchCount, batchIndex, {
        existingQuestions: savedQuestions,
        requestedCount,
        completedCount,
        job,
      });
      if (!Array.isArray(generated) || generated.length !== requestedBatchCount) {
        throw Object.assign(new Error('Provider batch did not contain the requested number of questions'), {
          code: 'QUESTION_AI_INVALID_RESPONSE',
        });
      }

      await store.setStage(rowId, 'validating');
      const batchFingerprints = new Set();
      const accepted = [];
      for (const candidate of generated) {
        const normalized = normalizeQuestion(candidate);
        if (!normalized) {
          throw Object.assign(new Error('Provider batch contained an invalid question'), {
            code: 'QUESTION_AI_INVALID_RESPONSE',
          });
        }
        const fingerprint = normalizeQuestionText(normalized.question);
        if (knownQuestions.has(fingerprint) || batchFingerprints.has(fingerprint)) continue;
        batchFingerprints.add(fingerprint);
        accepted.push(normalized);
      }

      if (accepted.length === 0) {
        duplicateBatches += 1;
        if (duplicateBatches >= maxDuplicateBatches) {
          throw Object.assign(new Error('Provider repeatedly returned questions already saved for this set'), {
            code: 'QUESTION_AI_DUPLICATE_BATCH',
          });
        }
        batchIndex += 1;
        continue;
      }

      duplicateBatches = 0;
      await store.setStage(rowId, 'saving');
      await store.persistBatchAndProgress(rowId, accepted);
      job = await store.getJob(rowId);
      completedCount = Number(job?.actual_question_count);
      if (!Number.isSafeInteger(completedCount) || completedCount < 0) {
        throw Object.assign(new Error('Unable to read persisted question count'), {
          code: 'QUESTION_AI_PROGRESS_UNAVAILABLE',
        });
      }
      if (completedCount > requestedCount) {
        throw Object.assign(new Error('Saved question count exceeds the requested count'), {
          code: 'QUESTION_AI_COUNT_OVERFLOW',
        });
      }

      savedQuestions = await store.listQuestions(rowId);
      knownQuestions = new Set(savedQuestions.map((question) => normalizeQuestionText(question?.question)).filter(Boolean));
      const complete = await finishIfExact();
      if (complete) return complete;
      batchIndex += 1;
    } catch (error) {
      return fail(error);
    }
  }

  const complete = await finishIfExact();
  return complete || fail(Object.assign(new Error('Exact saved question count was not confirmed'), {
    code: 'QUESTION_AI_COUNT_MISMATCH',
  }));
}

module.exports = {
  MAX_BATCH_SIZE,
  normalizeQuestion,
  normalizeQuestionText,
  runQuestionGenerationJob,
};
