const crypto = require('crypto');
const {
  QuestionGenerationError,
  buildProviderDiagnostics,
} = require('./lessonQuestionGeneration');
const {
  GROUNDING_POLICY_VERSION,
  buildGroundedClaimCatalog,
  buildClaimSelectionSchema,
  renderValidatedClaimSelection,
} = require('./studentAnalyticsGrounding.utils');

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const ANALYTICS_INSIGHT_MODEL = 'gpt-5-mini';
const asText = (value) => String(value || '').trim();

function buildGroundedInsightInput({ gradeLevel, metrics = {} } = {}) {
  const difficulty = metrics.difficultyBreakdown || {};
  return {
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    metrics_definition_version: 'student-metrics-v2',
    grade: asText(gradeLevel) || null,
    results_recorded: metrics.validResultCount ?? null,
    correct_answers: metrics.correctAnswers ?? null,
    incorrect_answers: metrics.incorrectAnswers ?? null,
    total_questions: metrics.totalQuestions ?? null,
    accuracy: metrics.accuracy ?? null,
    game_score: metrics.gameScore ?? null,
    total_progress: metrics.totalProgressVerified === true ? metrics.totalProgress ?? null : null,
    total_progress_verified: metrics.totalProgressVerified === true,
    total_progress_source: metrics.totalProgressSource || 'unavailable',
    completed_quests: metrics.completedQuests ?? null,
    current_quest: metrics.currentQuest ?? null,
    current_difficulty: metrics.currentDifficulty ?? null,
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

const extractOutputText = (responseBody) => {
  if (typeof responseBody?.output_text === 'string') return responseBody.output_text;
  return (responseBody?.output || [])
    .flatMap((item) => (item?.content || []).map((content) => content?.text).filter((text) => typeof text === 'string'))
    .join('\n');
};

async function generateGroundedStudentInsight({ input, apiKey = process.env.OPENAI_API_KEY, fetchImpl = global.fetch, timeoutMs = 25000 } = {}) {
  if (!asText(apiKey)) {
    throw new QuestionGenerationError('ANALYTICS_AI_NOT_CONFIGURED', 'Grounded AI Insights are not configured on the backend service.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new QuestionGenerationError('ANALYTICS_AI_UNAVAILABLE', 'Grounded AI Insights are unavailable on this backend.');
  }

  let catalog;
  try {
    catalog = buildGroundedClaimCatalog(input);
  } catch {
    throw new QuestionGenerationError(
      'ANALYTICS_AI_INVALID_RESPONSE',
      'Grounded AI Insights could not build a valid evidence catalog.'
    );
  }
  const providerInput = {
    grounding_policy_version: catalog.policyVersion,
    evidence: catalog.providerEvidence,
    permitted_claim_ids: catalog.permittedClaimIds,
  };

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
              text: 'You are an educational analytics interpreter. Select only the permitted claim IDs supported by the supplied deterministic evidence. Return the required JSON selection object only: no prose, no additional properties, no calculated values, no trends, no inferred topics, and no invented quest events. A null difficulty is no recorded data, never a weakness.',
            }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: JSON.stringify(providerInput) }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'grounded_student_insight',
            strict: true,
            schema: buildClaimSelectionSchema(catalog),
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
    return renderValidatedClaimSelection(JSON.parse(outputText), catalog);
  } catch (error) {
    if (error instanceof QuestionGenerationError) {
      if (!error.providerDiagnostics) error.providerDiagnostics = buildProviderDiagnostics(response, responseBody, 'invalid_provider_response');
      throw error;
    }
    throw new QuestionGenerationError(
      'ANALYTICS_AI_INVALID_RESPONSE',
      'Grounded AI Insights returned an invalid grounded claim selection.',
      buildProviderDiagnostics(response, responseBody, 'invalid_provider_response')
    );
  }
}

module.exports = {
  ANALYTICS_INSIGHT_MODEL,
  buildGroundedInsightInput,
  buildInsightFingerprint,
  generateGroundedStudentInsight,
};
