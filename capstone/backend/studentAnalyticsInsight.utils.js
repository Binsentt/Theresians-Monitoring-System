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
  WEAK_PERFORMANCE_THRESHOLD,
  INSIGHT_VALIDATION_STAGES,
  buildGroundedClaimCatalog,
  buildClaimSelectionSchema,
  renderValidatedClaimSelection,
} = require('./studentAnalyticsGrounding.utils');
const { SCOPES, getTopicById, normalizeGradeLevel, normalizeTopicId } = require('./curriculumScopeRegistry');
const {
  canonicalTaskDisplayLabel,
  canonicalTaskRequiresGradedEvidence,
  PLAYER_FACING_TASKS,
} = require('./questGraph.utils');
const CANONICAL_TASK_SET = new Set(['tutorial', ...PLAYER_FACING_TASKS]);

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

const buildQuestEvidence = ({ activityLogs = [], quizSessions = [] } = {}) => {
  const groups = new Map();
  const seenResultEventIds = new Set();
  const getGroup = (taskId) => {
    const canonicalTaskId = asText(taskId).toLowerCase();
    if (!CANONICAL_TASK_SET.has(canonicalTaskId)) return null;
    if (!groups.has(canonicalTaskId)) groups.set(canonicalTaskId, {
      canonical_task_id: canonicalTaskId,
      label: canonicalTaskDisplayLabel(canonicalTaskId),
      map_id: null,
      duration_seconds: null,
      correct_answers: 0,
      incorrect_answers: 0,
      total_questions: 0,
      accuracy: null,
      average_response_seconds: null,
      completion_status: 'unknown',
      requires_graded_questions: canonicalTaskRequiresGradedEvidence(canonicalTaskId),
      _response_seconds_total: 0,
      _response_seconds_count: 0,
    });
    return groups.get(canonicalTaskId);
  };
  (Array.isArray(activityLogs) ? activityLogs : []).forEach((row) => {
    const group = getGroup(row?.canonical_task_id);
    if (!group) return;
    const activityId = asText(row?.canonical_activity_id).toLowerCase();
    if (activityId === 'task_completed' || activityId === 'quest_completed') {
      group.completion_status = 'completed';
    } else if (activityId === 'task_triggered' && group.completion_status !== 'completed') {
      group.completion_status = 'started';
    } else if (group.completion_status === 'unknown') {
      // A canonical task row without an explicit lifecycle verb proves that
      // the task was observed, but never that it was completed.
      group.completion_status = 'observed';
    }
    const label = asText(row?.current_quest);
    if (label) group.label = label;
    const mapId = asText(row?.map_id);
    if (mapId) group.map_id = mapId;
    const duration = Number(row?.duration_seconds);
    if (Number.isInteger(duration) && duration >= 0) {
      group.duration_seconds = Math.max(group.duration_seconds ?? 0, duration);
    }
  });
  (Array.isArray(quizSessions) ? quizSessions : []).forEach((row) => {
    const eventId = asText(row?.result_event_id);
    if (eventId && seenResultEventIds.has(eventId)) return;
    if (eventId) seenResultEventIds.add(eventId);
    const group = getGroup(row?.canonical_task_id);
    const score = Number(row?.score);
    const total = Number(row?.total_items ?? row?.totalItems);
    if (!group || !Number.isInteger(score) || !Number.isInteger(total) || total <= 0 || score < 0 || score > total) return;
    group.correct_answers += score;
    group.incorrect_answers += total - score;
    group.total_questions += total;
    const responseSeconds = Number(row?.response_time_seconds);
    if (Number.isInteger(responseSeconds) && responseSeconds >= 0) {
      group._response_seconds_total += responseSeconds;
      group._response_seconds_count += 1;
    }
  });
  return [...groups.values()]
    .map((group) => ({
      canonical_task_id: group.canonical_task_id,
      label: group.label,
      map_id: group.map_id,
      duration_seconds: group.duration_seconds,
      correct_answers: group.correct_answers,
      incorrect_answers: group.incorrect_answers,
      total_questions: group.total_questions,
      accuracy: group.total_questions > 0 ? Number(((group.correct_answers / group.total_questions) * 100).toFixed(2)) : null,
      average_response_seconds: group._response_seconds_count > 0
        ? Number((group._response_seconds_total / group._response_seconds_count).toFixed(2)) : null,
      completion_status: group.completion_status,
      requires_graded_questions: group.requires_graded_questions,
    }))
    .sort((left, right) => left.canonical_task_id.localeCompare(right.canonical_task_id));
};

function buildGroundedInsightInput({
  gradeLevel,
  learningCycleVersion = null,
  learningCycleStartedAt = null,
  metrics = {},
  activityLogs = [],
  quizSessions = [],
} = {}) {
  const difficulty = metrics.difficultyBreakdown || {};
  const studentGrade = normalizeGradeLevel(gradeLevel);
  const topicPerformance = (Array.isArray(metrics.topicPerformance) ? metrics.topicPerformance : [])
    .map((topic) => {
      const topicId = normalizeTopicId(topic?.topicId ?? topic?.topic_id);
      const gradeLevel = normalizeGradeLevel(topic?.gradeLevel ?? topic?.grade_level);
      const canonicalTopic = topicId ? getTopicById(topicId) : null;
      const belongsToGrade = Boolean(gradeLevel && topicId && SCOPES.some((scope) => (
        scope.grade_level === gradeLevel && scope.topic_ids.includes(topicId)
      )));
      const correctAnswers = Number(topic?.correctAnswers ?? topic?.correct_answers);
      const totalQuestions = Number(topic?.totalQuestions ?? topic?.total_questions);
      if (!canonicalTopic || !belongsToGrade || !Number.isInteger(correctAnswers)
        || !Number.isInteger(totalQuestions) || totalQuestions < 1
        || correctAnswers < 0 || correctAnswers > totalQuestions
        || (studentGrade && gradeLevel !== studentGrade)) return null;
      return {
        topic_id: topicId,
        grade_level: gradeLevel,
        correct_answers: correctAnswers,
        total_questions: totalQuestions,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.grade_level.localeCompare(right.grade_level)
      || left.topic_id.localeCompare(right.topic_id));
  const questTopicPerformance = (Array.isArray(metrics.questTopicPerformance) ? metrics.questTopicPerformance : [])
    .map((topic) => {
      const topicId = normalizeTopicId(topic?.topicId ?? topic?.topic_id);
      const gradeLevel = normalizeGradeLevel(topic?.gradeLevel ?? topic?.grade_level);
      const canonicalTaskId = String(topic?.canonicalTaskId ?? topic?.canonical_task_id ?? '').trim().toLowerCase();
      const canonicalTopic = topicId ? getTopicById(topicId) : null;
      const canonicalTaskLabel = PLAYER_FACING_TASKS.includes(canonicalTaskId)
        ? canonicalTaskDisplayLabel(canonicalTaskId) : null;
      const belongsToGrade = Boolean(gradeLevel && topicId && SCOPES.some((scope) => (
        scope.grade_level === gradeLevel && scope.topic_ids.includes(topicId)
      )));
      const correctAnswers = Number(topic?.correctAnswers ?? topic?.correct_answers);
      const totalQuestions = Number(topic?.totalQuestions ?? topic?.total_questions);
      if (!canonicalTopic || !canonicalTaskLabel || !belongsToGrade || !Number.isInteger(correctAnswers)
        || !Number.isInteger(totalQuestions) || totalQuestions < 1
        || correctAnswers < 0 || correctAnswers > totalQuestions
        || (studentGrade && gradeLevel !== studentGrade)) return null;
      return {
        topic_id: topicId,
        grade_level: gradeLevel,
        canonical_task_id: canonicalTaskId,
        task_label: canonicalTaskLabel,
        correct_answers: correctAnswers,
        total_questions: totalQuestions,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.grade_level.localeCompare(right.grade_level)
      || left.canonical_task_id.localeCompare(right.canonical_task_id)
      || left.topic_id.localeCompare(right.topic_id));
  const hasAggregateWeakness = topicPerformance.some((topic) => (
    (topic.correct_answers / topic.total_questions) * 100 < WEAK_PERFORMANCE_THRESHOLD
  ));
  const hasFullyLinkedTaskWeakness = topicPerformance.some((topic) => {
    const taskRows = questTopicPerformance.filter((task) => (
      task.grade_level === topic.grade_level && task.topic_id === topic.topic_id
    ));
    const taskRowsCoverTopic = taskRows.length > 0
      && taskRows.reduce((sum, task) => sum + task.correct_answers, 0) === topic.correct_answers
      && taskRows.reduce((sum, task) => sum + task.total_questions, 0) === topic.total_questions;
    return taskRowsCoverTopic && taskRows.some((task) => (
      task.correct_answers < task.total_questions
      && (task.correct_answers / task.total_questions) * 100 < WEAK_PERFORMANCE_THRESHOLD
    ));
  });
  const hasSupportedWeakness = hasAggregateWeakness || hasFullyLinkedTaskWeakness;
  const totalQuestions = Number.isInteger(metrics.totalQuestions) ? metrics.totalQuestions : 0;
  const incorrectAnswers = Number.isInteger(metrics.incorrectAnswers) ? metrics.incorrectAnswers : 0;
  const questTopicLinkedEvidenceCount = Number.isInteger(metrics.questTopicLinkedEvidenceCount)
    ? metrics.questTopicLinkedEvidenceCount : questTopicPerformance.reduce((sum, topic) => sum + topic.total_questions, 0);
  const topicLinkedEvidenceCount = Number.isInteger(metrics.topicLinkedEvidenceCount)
    ? metrics.topicLinkedEvidenceCount : topicPerformance.reduce((sum, topic) => sum + topic.total_questions, 0);
  const unmappedTopicIncorrectAnswers = Number.isInteger(metrics.unmappedTopicIncorrectAnswers)
    ? metrics.unmappedTopicIncorrectAnswers : 0;
  const hasTopicMetadataGap = incorrectAnswers > 0
    && (topicPerformance.length === 0 || unmappedTopicIncorrectAnswers > 0
      || topicPerformance.reduce((sum, topic) => sum + topic.total_questions, 0) < topicLinkedEvidenceCount);
  const topicEvidenceStatus = totalQuestions > 0 && incorrectAnswers === 0
    ? 'perfect_recorded_results'
    : hasTopicMetadataGap
      ? (topicPerformance.length > 0 ? 'topic_metadata_partial' : 'topic_metadata_unavailable')
      : hasSupportedWeakness
        ? 'weaknesses_identified'
        : topicPerformance.length > 0
          ? 'no_supported_weakness'
          : 'no_topic_evidence';
  return {
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    metrics_definition_version: 'student-metrics-v5',
    grade: studentGrade,
    learning_cycle_version: Number.isInteger(Number(learningCycleVersion)) && learningCycleVersion !== null
      ? Number(learningCycleVersion) : null,
    learning_cycle_started_at: asText(learningCycleStartedAt) || null,
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
    topic_performance: topicPerformance,
    quest_topic_performance: questTopicPerformance,
    topic_linked_evidence_count: topicLinkedEvidenceCount,
    quest_topic_linked_evidence_count: questTopicLinkedEvidenceCount,
    unmapped_quest_topic_incorrect_answers: Number.isInteger(metrics.unmappedQuestTopicIncorrectAnswers)
      ? metrics.unmappedQuestTopicIncorrectAnswers
      : (questTopicLinkedEvidenceCount < totalQuestions ? Math.max(0, incorrectAnswers) : 0),
    total_questions: totalQuestions,
    unmapped_topic_incorrect_answers: Number.isInteger(metrics.unmappedTopicIncorrectAnswers)
      ? metrics.unmappedTopicIncorrectAnswers : 0,
    topic_evidence_status: topicEvidenceStatus,
    playtime_minutes: metrics.playtimeMinutes ?? null,
    quest_evidence: buildQuestEvidence({ activityLogs, quizSessions }),
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
  recommendations: 0,
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
    permitted_claim_ids: {
      performance: catalog.permittedClaimIds.performance,
      strength: catalog.permittedClaimIds.strength,
      weakness: catalog.permittedClaimIds.weakness,
    },
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
              text: 'You are an educational analytics interpreter. Select only the permitted claim IDs supported by the supplied deterministic evidence. Return the required JSON selection object only: no prose, no additional properties, no calculated values, no trends, no inferred topics, and no invented quest events. Weaknesses and practice recommendations may only use validated Grade/topic-linked question-set evidence; overall accuracy and difficulty are descriptive evidence, not math-topic weaknesses. A null difficulty is no recorded data, never a weakness.',
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
    analyticsDiagnostics.claimCounts.recommendations = insight.recommendations.length;
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
  buildQuestEvidence,
  buildInsightFingerprint,
  createInsightDiagnostics,
  extractOutputTextWithDiagnostics,
  generateGroundedStudentInsight,
};
