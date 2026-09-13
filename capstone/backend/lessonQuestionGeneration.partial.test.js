const test = require('node:test');
const assert = require('node:assert/strict');

const { generateLessonQuestionsInBatches } = require('./lessonQuestionGeneration');

test('preserves valid batches and reports only the remaining count after a recoverable failure', async () => {
  const calls = [];
  const result = await generateLessonQuestionsInBatches({
    questionCount: 12,
    batchSize: 5,
    generateBatch: async (count, batchIndex) => {
      calls.push({ count, batchIndex });
      if (batchIndex === 1) throw new Error('synthetic provider failure');
      return Array.from({ length: count }, (_, index) => ({ question: `Q${batchIndex}-${index}` }));
    },
  });

  assert.equal(result.questions.length, 5);
  assert.equal(result.requested, 12);
  assert.equal(result.remaining, 7);
  assert.equal(result.status, 'partial_failed');
  assert.equal(result.failures[0].batch_index, 1);
  assert.deepEqual(calls, [{ count: 5, batchIndex: 0 }, { count: 5, batchIndex: 1 }]);
});
