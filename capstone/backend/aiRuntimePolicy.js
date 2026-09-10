const AI_PAUSED_CODE = 'AI_PAUSED';
const AI_PAUSED_MESSAGE = 'AI generation is temporarily paused. Recorded data and available questions remain accessible.';

const isAiGenerationEnabled = (value = process.env.AI_GENERATION_ENABLED) => (
  value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')
);

const getAiRuntimeState = (value = process.env.AI_GENERATION_ENABLED) => (
  isAiGenerationEnabled(value)
    ? { enabled: true, status: 'enabled' }
    : {
      enabled: false,
      status: 'paused',
      code: AI_PAUSED_CODE,
      message: AI_PAUSED_MESSAGE,
    }
);

module.exports = {
  AI_PAUSED_CODE,
  AI_PAUSED_MESSAGE,
  getAiRuntimeState,
  isAiGenerationEnabled,
};
