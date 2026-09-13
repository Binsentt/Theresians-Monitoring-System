const test = require('node:test');
const assert = require('node:assert/strict');

const { generateLessonQuestionsInBatches } = require('./lessonQuestionGeneration');

test('preserves valid batches and reports only the remaining count after a recoverable failure', async () => {
  const calls = [];
  const persisted = [];
  const result = await generateLessonQuestionsInBatches({
    questionCount: 12,
    batchSize: 5,
    generateBatch: async (count, batchIndex) => {
      calls.push({ count, batchIndex });
      if (batchIndex === 1) throw new Error('synthetic provider failure');
      return Array.from({ length: count }, (_, index) => ({ question: `Q${batchIndex}-${index}` }));
    },
    onBatch: async ({ batch, batch_index, valid_count, requested_count }) => {
      persisted.push({ batch: batch.map((item) => item.question), batch_index, valid_count, requested_count });
    },
  });

  assert.equal(result.questions.length, 5);
  assert.equal(result.requested, 12);
  assert.equal(result.remaining, 7);
  assert.equal(result.status, 'partial_failed');
  assert.equal(result.failures[0].batch_index, 1);
  assert.deepEqual(calls, [{ count: 5, batchIndex: 0 }, { count: 5, batchIndex: 1 }]);
  assert.deepEqual(persisted, [{
    batch: ['Q0-0', 'Q0-1', 'Q0-2', 'Q0-3', 'Q0-4'],
    batch_index: 0,
    valid_count: 5,
    requested_count: 12,
  }]);
});
