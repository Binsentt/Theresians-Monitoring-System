const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_PAUSED_CODE,
  AI_PAUSED_MESSAGE,
  getAiRuntimeState,
  isAiGenerationEnabled,
} = require('./aiRuntimePolicy');

test('AI generation is safely paused unless the server explicitly enables it', () => {
  for (const value of [undefined, null, '', 'false', '0', 'yes', false]) {
    assert.equal(isAiGenerationEnabled(value), false);
  }
  assert.equal(isAiGenerationEnabled(true), true);
  assert.equal(isAiGenerationEnabled('true'), true);
  assert.equal(isAiGenerationEnabled(' TRUE '), true);
});

test('paused runtime state uses the stable public contract', () => {
  assert.deepEqual(getAiRuntimeState(undefined), {
    enabled: false,
    status: 'paused',
    code: AI_PAUSED_CODE,
    message: AI_PAUSED_MESSAGE,
  });
  assert.equal(AI_PAUSED_CODE, 'AI_PAUSED');
  assert.equal(
    AI_PAUSED_MESSAGE,
    'AI generation is temporarily paused. Recorded data and available questions remain accessible.'
  );
  assert.deepEqual(getAiRuntimeState('true'), { enabled: true, status: 'enabled' });
});
