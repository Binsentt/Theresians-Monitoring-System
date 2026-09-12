const crypto = require('crypto');
const {
  QuestionGenerationError,
  buildProviderDiagnostics,
} = require('./lessonQuestionGeneration');
const {
  AI_PAUSED_CODE,
  AI_PAUSED_MESSAGE,
  isAiGenerationEnabled,
} = require('./aiRuntimePolicy');
const {
  GROUNDING_POLICY_VERSION,
  INSIGHT_VALIDATION_STAGES,
  buildGroundedClaimCatalog,
  buildClaimSelectionSchema,
  renderValidatedClaimSelection,
} = require('./studentAnalyticsGrounding.utils');

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const ANALYTICS_INSIGHT_MODEL = 'gpt-5-mini';
// Grounded insights contain only a compact claim-selection object; this budget
// leaves room for model reasoning while bounding provider output cost.
const ANALYTICS_INSIGHT_MAX_OUTPUT_TOKENS = 1200;
const INSIGHT_RESPONSE_EXTRACTION_STAGES = Object.freeze({
  TOP_LEVEL_OUTPUT_TEXT: 'TOP_LEVEL_OUTPUT_TEXT',
  NESTED_OUTPUT_CONTENT_TEXT: 'NESTED_OUTPUT_CONTENT_TEXT',
  RESPONSE_TEXT_MISSING: 'RESPONSE_TEXT_MISSING',
  RESPONSE_JSON_PARSE_FAILED: 'RESPONSE_JSON_PARSE_FAILED',
});
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

const safeTopLevelKeys = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((key) => /^[A-Za-z0-9_.-]{1,80}$/.test(key))
    .slice(0, 30);
};

const safeEnvelopeCode = (value) => {
  const normalized = asText(value);
  return /^[A-Za-z0-9_.-]{1,120}$/.test(normalized) ? normalized : null;
};

const safeTypeList = (values) => values
  .map((value) => safeEnvelopeCode(value))
  .filter(Boolean)
  .slice(0, 40);

const buildResponseEnvelopeDiagnostics = (responseBody) => {
  const outputItems = Array.isArray(responseBody?.output) ? responseBody.output : [];
  const contentItems = outputItems.flatMap((item) => (Array.isArray(item?.content) ? item.content : []));
  const incompleteDetails = responseBody?.incomplete_details && typeof responseBody.incomplete_details === 'object'
    ? responseBody.incomplete_details
    : {};
  return {
    responseStatus: safeEnvelopeCode(responseBody?.status),
    incompleteReason: safeEnvelopeCode(incompleteDetails.reason),
    incompleteCode: safeEnvelopeCode(incompleteDetails.code),
    outputItemTypes: safeTypeList(outputItems.map((item) => item?.type)),
    contentItemTypes: safeTypeList(contentItems.map((content) => content?.type)),
    refusalContentPresent: contentItems.some((content) => content?.type === 'refusal'),
  };
};

const claimCountsFor = (selection) => ({
  performance: Array.isArray(selection?.performance_claim_ids) ? selection.performance_claim_ids.length : 0,
  strengths: Array.isArray(selection?.strength_claim_ids) ? selection.strength_claim_ids.length : 0,
  weaknesses: Array.isArray(selection?.weakness_claim_ids) ? selection.weakness_claim_ids.length : 0,
  recommendations: Array.isArray(selection?.recommendation_claim_ids) ? selection.recommendation_claim_ids.length : 0,
  trends: 0,
});

const extractOutputTextWithDiagnostics = (responseBody) => {
  const outputItems = Array.isArray(responseBody?.output) ? responseBody.output : [];
  const nestedTextItems = outputItems
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((content) => typeof content?.text === 'string');
  const outputTextPresent = typeof responseBody?.output_text === 'string';
  const nestedOutputContentTextPresent = nestedTextItems.length > 0;
  const outputText = outputTextPresent
    ? responseBody.output_text
    : nestedTextItems.map((content) => content.text).join('\n');
  const responseExtractionStage = outputTextPresent
    ? INSIGHT_RESPONSE_EXTRACTION_STAGES.TOP_LEVEL_OUTPUT_TEXT
    : nestedOutputContentTextPresent
      ? INSIGHT_RESPONSE_EXTRACTION_STAGES.NESTED_OUTPUT_CONTENT_TEXT
      : INSIGHT_RESPONSE_EXTRACTION_STAGES.RESPONSE_TEXT_MISSING;
  return {
    outputText,
    responseExtractionStage,
    outputTextPresent,
    nestedOutputContentTextPresent,
    outputItemCount: outputItems.length,
    textContentItemCount: nestedTextItems.length,
  };
};

const extractOutputText = (responseBody) => extractOutputTextWithDiagnostics(responseBody).outputText;

const createInsightDiagnostics = (response, responseBody, extraction = {}) => ({
  providerHttpStatus: Number.isInteger(Number(response?.status)) ? Number(response.status) : null,
  responseExtractionStage: extraction.responseExtractionStage || INSIGHT_RESPONSE_EXTRACTION_STAGES.RESPONSE_TEXT_MISSING,
  outputTextPresent: extraction.outputTextPresent === true,
  nestedOutputContentTextPresent: extraction.nestedOutputContentTextPresent === true,
  outputItemCount: Number.isInteger(extraction.outputItemCount) ? extraction.outputItemCount : 0,
  textContentItemCount: Number.isInteger(extraction.textContentItemCount) ? extraction.textContentItemCount : 0,
  ...buildResponseEnvelopeDiagnostics(responseBody),
  jsonParseSucceeded: null,
  validationStage: null,
  topLevelKeys: [],
  claimCounts: { performance: 0, strengths: 0, weaknesses: 0, recommendations: 0, trends: 0 },
  unknownClaimCount: 0,
  duplicateClaimCount: 0,
  unsupportedClaimCount: 0,
  renderedOutputValidation: null,
  persistenceSucceeded: null,
});

const emitDiagnostics = async (onDiagnostics, diagnostics) => {
  if (typeof onDiagnostics !== 'function') return;
  try {
    await onDiagnostics(Object.freeze({
      ...diagnostics,
      topLevelKeys: Object.freeze((diagnostics.topLevelKeys || []).slice()),
      claimCounts: Object.freeze({ ...diagnostics.claimCounts }),
    }));
  } catch {
    // Diagnostics must never change normal user-facing generation behavior.
  }
};

const withInsightDiagnostics = (response, responseBody, analyticsDiagnostics) => ({
  ...buildProviderDiagnostics(response, responseBody, 'invalid_provider_response'),
  analytics: analyticsDiagnostics,
});

async function generateGroundedStudentInsight({
  input,
  aiGenerationEnabled = isAiGenerationEnabled(),
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = global.fetch,
  timeoutMs = 25000,
  onDiagnostics = null,
} = {}) {
  if (!aiGenerationEnabled) {
    throw new QuestionGenerationError(AI_PAUSED_CODE, AI_PAUSED_MESSAGE);
  }
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
        max_output_tokens: ANALYTICS_INSIGHT_MAX_OUTPUT_TOKENS,
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

  const extraction = extractOutputTextWithDiagnostics(responseBody);
  const analyticsDiagnostics = createInsightDiagnostics(response, responseBody, extraction);
  const outputText = extraction.outputText;
  if (!outputText) {
    analyticsDiagnostics.validationStage = INSIGHT_RESPONSE_EXTRACTION_STAGES.RESPONSE_TEXT_MISSING;
    await emitDiagnostics(onDiagnostics, analyticsDiagnostics);
    throw new QuestionGenerationError(
      'ANALYTICS_AI_INVALID_RESPONSE',
      'Grounded AI Insights returned no structured output.',
      withInsightDiagnostics(response, responseBody, analyticsDiagnostics)
    );
  }
  let selection;
  try {
    selection = JSON.parse(outputText);
    analyticsDiagnostics.jsonParseSucceeded = true;
    analyticsDiagnostics.topLevelKeys = safeTopLevelKeys(selection);
    analyticsDiagnostics.claimCounts = claimCountsFor(selection);
  } catch {
    analyticsDiagnostics.jsonParseSucceeded = false;
    analyticsDiagnostics.validationStage = INSIGHT_RESPONSE_EXTRACTION_STAGES.RESPONSE_JSON_PARSE_FAILED;
    await emitDiagnostics(onDiagnostics, analyticsDiagnostics);
    throw new QuestionGenerationError(
      'ANALYTICS_AI_INVALID_RESPONSE',
      'Grounded AI Insights returned invalid structured data.',
      withInsightDiagnostics(response, responseBody, analyticsDiagnostics)
    );
  }
  try {
    const insight = renderValidatedClaimSelection(selection, catalog);
    analyticsDiagnostics.validationStage = INSIGHT_VALIDATION_STAGES.VALIDATION_PASSED;
    analyticsDiagnostics.renderedOutputValidation = true;
    await emitDiagnostics(onDiagnostics, analyticsDiagnostics);
    return insight;
  } catch (error) {
    analyticsDiagnostics.validationStage = error?.stage || INSIGHT_VALIDATION_STAGES.RESPONSE_SHAPE_INVALID;
    analyticsDiagnostics.unknownClaimCount = Number(error?.details?.unknownClaimCount) || 0;
    analyticsDiagnostics.duplicateClaimCount = Number(error?.details?.duplicateClaimCount) || 0;
    analyticsDiagnostics.unsupportedClaimCount = Number(error?.details?.unsupportedClaimCount) || 0;
    analyticsDiagnostics.renderedOutputValidation = analyticsDiagnostics.validationStage === INSIGHT_VALIDATION_STAGES.RENDERED_OUTPUT_INVALID
      ? false
      : null;
    await emitDiagnostics(onDiagnostics, analyticsDiagnostics);
    if (error instanceof QuestionGenerationError) {
      if (!error.providerDiagnostics) error.providerDiagnostics = withInsightDiagnostics(response, responseBody, analyticsDiagnostics);
      throw error;
    }
    throw new QuestionGenerationError(
      'ANALYTICS_AI_INVALID_RESPONSE',
      'Grounded AI Insights returned an invalid grounded claim selection.',
      withInsightDiagnostics(response, responseBody, analyticsDiagnostics)
    );
  }
}

module.exports = {
  ANALYTICS_INSIGHT_MODEL,
  ANALYTICS_INSIGHT_MAX_OUTPUT_TOKENS,
  INSIGHT_RESPONSE_EXTRACTION_STAGES,
  buildGroundedInsightInput,
  buildInsightFingerprint,
  createInsightDiagnostics,
  extractOutputTextWithDiagnostics,
  generateGroundedStudentInsight,
};
