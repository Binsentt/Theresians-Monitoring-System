const crypto = require('crypto');
const {
  QuestionGenerationError,
  buildProviderDiagnostics,
} = require('./lessonQuestionGeneration');

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const ANALYTICS_INSIGHT_MODEL = 'gpt-5-mini';
const MAX_LIST_ITEMS = 5;
const MAX_ITEM_LENGTH = 280;
const MAX_INSIGHT_LENGTH = 900;

const asText = (value) => String(value || '').trim();

function buildGroundedInsightInput({ gradeLevel, metrics = {} } = {}) {
  const difficulty = metrics.difficultyBreakdown || {};
  return {
    grade: asText(gradeLevel) || null,
    results_recorded: metrics.validResultCount ?? null,
    correct_answers: metrics.correctAnswers ?? null,
    incorrect_answers: metrics.incorrectAnswers ?? null,
    total_questions: metrics.totalQuestions ?? null,
    accuracy: metrics.accuracy ?? null,
    game_score: metrics.gameScore ?? null,
    total_progress: metrics.totalProgress ?? null,
    completed_quests: metrics.completedQuests ?? null,
    current_quest: metrics.currentQuest ?? null,
    difficulty_accuracy: {
      easy: difficulty.easy?.accuracy ?? null,
      medium: difficulty.medium?.accuracy ?? null,
      hard: difficulty.hard?.accuracy ?? null,
    },
    topic_performance: (Array.isArray(metrics.topicPerformance) ? metrics.topicPerformance : []).map((topic) => ({
      topic: asText(topic.topic),
      accuracy: topic.accuracy ?? null,
      correct_answers: topic.correctAnswers ?? null,
      total_questions: topic.totalQuestions ?? null,
    })),
    playtime_minutes: metrics.playtimeMinutes ?? null,
  };
}

function buildInsightFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function validateStringList(value, field) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new QuestionGenerationError('ANALYTICS_AI_INVALID_RESPONSE', `Analytics insight returned an invalid ${field} list.`);
  }
  const normalized = value.map(asText);
  if (normalized.some((item) => !item || item.length > MAX_ITEM_LENGTH)) {
    throw new QuestionGenerationError('ANALYTICS_AI_INVALID_RESPONSE', `Analytics insight returned an invalid ${field} item.`);
  }
  return normalized;
}

function validateGroundedInsight(value) {
  const performanceInsight = asText(value?.performance_insight);
  if (!performanceInsight || performanceInsight.length > MAX_INSIGHT_LENGTH) {
    throw new QuestionGenerationError('ANALYTICS_AI_INVALID_RESPONSE', 'Analytics insight returned an invalid performance insight.');
  }
  return {
    performance_insight: performanceInsight,
    strengths: validateStringList(value?.strengths, 'strengths'),
    weaknesses: validateStringList(value?.weaknesses, 'weaknesses'),
    recommendations: validateStringList(value?.recommendations, 'recommendations'),
  };
}

const extractOutputText = (responseBody) => {
  if (typeof responseBody?.output_text === 'string') return responseBody.output_text;
  return (responseBody?.output || [])
    .flatMap((item) => (item?.content || []).map((content) => content?.text).filter((text) => typeof text === 'string'))
    .join('\n');
};

const buildInsightSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['performance_insight', 'strengths', 'weaknesses', 'recommendations'],
  properties: {
    performance_insight: { type: 'string' },
    strengths: { type: 'array', maxItems: MAX_LIST_ITEMS, items: { type: 'string' } },
    weaknesses: { type: 'array', maxItems: MAX_LIST_ITEMS, items: { type: 'string' } },
    recommendations: { type: 'array', maxItems: MAX_LIST_ITEMS, items: { type: 'string' } },
  },
});

async function generateGroundedStudentInsight({ input, apiKey = process.env.OPENAI_API_KEY, fetchImpl = global.fetch, timeoutMs = 25000 } = {}) {
  if (!asText(apiKey)) {
    throw new QuestionGenerationError('ANALYTICS_AI_NOT_CONFIGURED', 'Grounded AI Insights are not configured on the backend service.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new QuestionGenerationError('ANALYTICS_AI_UNAVAILABLE', 'Grounded AI Insights are unavailable on this backend.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: ANALYTICS_INSIGHT_MODEL,
        input: [
          {
            role: 'system',
            content: [{
              type: 'input_text',
              text: 'You are an educational analytics interpreter. Use only the supplied deterministic metrics. Do not calculate, alter, or invent percentages, scores, topic results, difficulty results, quest completion, progress, or events. Do not identify the student. If a metric is null, say it is unavailable rather than inferring it. Keep each point concise and grounded in the supplied facts.',
            }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: JSON.stringify(input) }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'grounded_student_insight',
            strict: true,
            schema: buildInsightSchema(),
          },
        },
      }),
    });
  } catch {
    throw new QuestionGenerationError(
      'ANALYTICS_AI_GENERATION_FAILED',
      'Grounded AI Insights are unavailable right now.',
      { category: 'network_error' }
    );
  } finally {
    clearTimeout(timeout);
  }

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    // The safe status diagnostics below are enough for a failed provider response.
  }
  if (!response.ok) {
    throw new QuestionGenerationError(
      'ANALYTICS_AI_GENERATION_FAILED',
      'Grounded AI Insights are unavailable right now.',
      buildProviderDiagnostics(response, responseBody)
    );
  }

  const outputText = extractOutputText(responseBody);
  if (!outputText) {
    throw new QuestionGenerationError(
      'ANALYTICS_AI_INVALID_RESPONSE',
      'Grounded AI Insights returned no structured output.',
      buildProviderDiagnostics(response, responseBody, 'invalid_provider_response')
    );
  }
  try {
    return validateGroundedInsight(JSON.parse(outputText));
  } catch (error) {
    if (error instanceof QuestionGenerationError) {
      if (!error.providerDiagnostics) error.providerDiagnostics = buildProviderDiagnostics(response, responseBody, 'invalid_provider_response');
      throw error;
    }
    throw new QuestionGenerationError(
      'ANALYTICS_AI_INVALID_RESPONSE',
      'Grounded AI Insights returned invalid structured output.',
      buildProviderDiagnostics(response, responseBody, 'invalid_provider_response')
    );
  }
}

module.exports = {
  ANALYTICS_INSIGHT_MODEL,
  buildGroundedInsightInput,
  buildInsightFingerprint,
  generateGroundedStudentInsight,
  validateGroundedInsight,
};
