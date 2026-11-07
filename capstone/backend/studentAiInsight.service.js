const {
  buildGroundedClaimCatalog,
  deriveSupportedRecommendationIds,
  renderQuestInsights,
} = require('./studentAnalyticsGrounding.utils');
const {
  buildGroundedInsightInput,
  buildInsightFingerprint,
  generateGroundedStudentInsight,
} = require('./studentAnalyticsInsight.utils');
const {
  AI_PAUSED_CODE,
  AI_PAUSED_MESSAGE,
  isAiGenerationEnabled,
} = require('./aiRuntimePolicy');

const SUFFICIENT_INSIGHT_RESULT_COUNT = 5;

const resolveDataLevel = (validResultCount) => {
  if (validResultCount <= 0) return 'no_data';
  if (validResultCount < SUFFICIENT_INSIGHT_RESULT_COUNT) return 'limited_data';
  return 'sufficient_data';
};

const buildBaseState = (metrics = {}) => {
  const validResultCount = Number.isInteger(metrics.validResultCount) ? metrics.validResultCount : 0;
  const dataLevel = resolveDataLevel(validResultCount);
  return {
    data_level: dataLevel,
    valid_result_count: validResultCount,
    sufficient_result_count: SUFFICIENT_INSIGHT_RESULT_COUNT,
    preliminary: dataLevel === 'limited_data',
    total_question_count: Number.isInteger(metrics.totalQuestions) ? metrics.totalQuestions : 0,
    topic_linked_evidence_count: Number.isInteger(metrics.topicLinkedEvidenceCount) ? metrics.topicLinkedEvidenceCount : 0,
    quest_topic_linked_evidence_count: Number.isInteger(metrics.questTopicLinkedEvidenceCount)
      ? metrics.questTopicLinkedEvidenceCount : 0,
  };
};

const readCachedInsight = async (queryClient, studentId) => {
  const result = await queryClient.query(
    `SELECT input_fingerprint, insight, generated_at, stale_at
     FROM public.student_ai_insights
     WHERE student_id = $1
     LIMIT 1`,
    [studentId]
  );
  return result.rows[0] || null;
};

const isCurrentCache = (cachedInsight, inputFingerprint) => Boolean(
  cachedInsight
  && cachedInsight.input_fingerprint === inputFingerprint
  && !cachedInsight.stale_at
);

const buildCurrentTopicEvidence = (input, { generalEvidenceAvailable = false } = {}) => {
  const catalog = buildGroundedClaimCatalog(input);
  // The grounding catalog has a legacy fallback for one-to-three unlinked
  // misses. Once the current-cycle deterministic general evidence is available,
  // keep that fallback in the general list instead of duplicating it as a
  // topic-specific finding.
  const topicWeaknesses = generalEvidenceAvailable
    ? catalog.weakness.filter((claim) => claim.id !== 'unlinked_limited_errors')
    : catalog.weakness;
  const weaknessIds = topicWeaknesses.map((claim) => claim.id);
  const recommendationIds = deriveSupportedRecommendationIds({
    performance_claim_ids: [],
    weakness_claim_ids: weaknessIds,
  }, catalog);
  return {
    topicEvidenceStatus: catalog.topicEvidenceStatus,
    strengths: catalog.strength.map((claim) => claim.text),
    weaknesses: weaknessIds.map((id) => catalog.weakness.find((claim) => claim.id === id).text),
    recommendations: recommendationIds.map((id) => catalog.recommendation.find((claim) => claim.id === id).text),
    questInsights: renderQuestInsights(input?.quest_evidence),
  };
};

const toDeterministicEvidence = (topicEvidence, generalEvidence) => {
  const generalPerformance = {
    ...generalEvidence,
    strengths: [...generalEvidence.strengths],
    weaknesses: [...generalEvidence.weaknesses],
    recommendations: [...generalEvidence.recommendations],
    map_observations: [...generalEvidence.map_observations],
    recent_trend: generalEvidence.recent_trend ? { ...generalEvidence.recent_trend } : null,
  };
  const topicSpecific = {
    strengths: [...topicEvidence.strengths],
    weaknesses: [...topicEvidence.weaknesses],
    recommendations: [...topicEvidence.recommendations],
  };
  return {
    topic_evidence_status: topicEvidence.topicEvidenceStatus,
    general_performance: generalPerformance,
    topic_specific: topicSpecific,
    strengths: [...generalPerformance.strengths, ...topicSpecific.strengths],
    weaknesses: [...generalPerformance.weaknesses, ...topicSpecific.weaknesses],
    recommendations: [...generalPerformance.recommendations, ...topicSpecific.recommendations],
    quest_insights: [...topicEvidence.questInsights],
  };
};

const applyCurrentTopicEvidence = (insight, topicEvidence, generalEvidence) => {
  if (!insight || typeof insight !== 'object' || Array.isArray(insight)) return insight;
  const deterministicEvidence = toDeterministicEvidence(topicEvidence, generalEvidence);
  return {
    ...insight,
    topic_evidence_status: topicEvidence.topicEvidenceStatus,
    strengths: deterministicEvidence.strengths,
    weaknesses: deterministicEvidence.weaknesses,
    recommendations: deterministicEvidence.recommendations,
    quest_insights: topicEvidence.questInsights,
  };
};

const buildCachedState = ({ baseState, cachedInsight, topicEvidence, generalEvidence }) => ({
  ...baseState,
  topic_evidence_status: topicEvidence.topicEvidenceStatus,
  deterministic_evidence: toDeterministicEvidence(topicEvidence, generalEvidence),
  status: 'cached',
  is_stale: false,
  generated_at: cachedInsight.generated_at || null,
  insight: applyCurrentTopicEvidence(cachedInsight.insight, topicEvidence, generalEvidence),
});

const buildUnavailableState = ({ baseState, cachedInsight, topicEvidence, generalEvidence }) => ({
  ...baseState,
  topic_evidence_status: topicEvidence.topicEvidenceStatus,
  deterministic_evidence: toDeterministicEvidence(topicEvidence, generalEvidence),
  status: 'unavailable',
  is_stale: Boolean(cachedInsight?.insight),
  generated_at: cachedInsight?.generated_at || null,
  insight: applyCurrentTopicEvidence(cachedInsight?.insight, topicEvidence, generalEvidence) || null,
  message: cachedInsight?.insight
    ? 'New evidence is available, but the insight service is unavailable. The prior insight is shown as stale.'
    : 'Grounded AI Insights are unavailable right now. Recorded analytics remain available.',
});

const buildPausedState = ({ baseState, cachedInsight, topicEvidence, generalEvidence, isStale = Boolean(cachedInsight?.insight) }) => ({
  ...baseState,
  topic_evidence_status: topicEvidence.topicEvidenceStatus,
  deterministic_evidence: toDeterministicEvidence(topicEvidence, generalEvidence),
  status: 'paused',
  code: AI_PAUSED_CODE,
  is_stale: isStale,
  generated_at: cachedInsight?.generated_at || null,
  insight: applyCurrentTopicEvidence(cachedInsight?.insight, topicEvidence, generalEvidence) || null,
  message: AI_PAUSED_MESSAGE,
});

async function resolveStudentAiInsight({
  studentId,
  gradeLevel,
  learningCycleVersion = null,
  learningCycleStartedAt = null,
  metrics = {},
  activityLogs = [],
  quizSessions = [],
  completedMilestones = [],
  actorId = null,
  aiGenerationEnabled = isAiGenerationEnabled(),
  forceRefresh = false,
  pool,
  generateInsight = generateGroundedStudentInsight,
  onInsightDiagnostics = null,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A database pool with query and connect is required.');
  }

  const baseState = buildBaseState(metrics);
  const input = buildGroundedInsightInput({
    gradeLevel,
    metrics,
    activityLogs,
    quizSessions,
    completedMilestones,
    learningCycleVersion,
    learningCycleStartedAt,
  });
  const generalEvidence = input.general_performance;
  const topicEvidence = buildCurrentTopicEvidence(input, {
    generalEvidenceAvailable: generalEvidence.weaknesses.length > 0,
  });
  if (baseState.data_level === 'no_data') {
    return {
      ...baseState,
      topic_evidence_status: topicEvidence.topicEvidenceStatus || metrics.topicEvidenceStatus || 'no_topic_evidence',
      deterministic_evidence: toDeterministicEvidence(topicEvidence, generalEvidence),
      status: 'no_data',
      is_stale: false,
      message: 'No valid gameplay results are available for grounded AI analysis yet.',
      // Canonical task completion is useful progress evidence, but it is not a
      // graded result and must not cause an AI analysis or cache write.
      insight: topicEvidence.questInsights.length > 0
        ? {
          topic_evidence_status: topicEvidence.topicEvidenceStatus,
          strengths: [],
          weaknesses: [],
          recommendations: [],
          quest_insights: topicEvidence.questInsights,
        }
        : null,
    };
  }

  const inputFingerprint = buildInsightFingerprint(input);
  const initialCache = await readCachedInsight(pool, studentId);
  if (!aiGenerationEnabled) {
    return buildPausedState({
      baseState,
      cachedInsight: initialCache,
      topicEvidence,
      generalEvidence,
      isStale: Boolean(initialCache?.insight) && !isCurrentCache(initialCache, inputFingerprint),
    });
  }
  if (!forceRefresh && isCurrentCache(initialCache, inputFingerprint)) {
    return buildCachedState({ baseState, cachedInsight: initialCache, topicEvidence, generalEvidence });
  }

  const client = await pool.connect();
  let transactionStarted = false;
  let persistenceAttempted = false;
  const emitInsightDiagnostics = async (diagnostics) => {
    if (typeof onInsightDiagnostics !== 'function') return;
    try {
      await onInsightDiagnostics(diagnostics);
    } catch {
      // Diagnostics must never change normal user-facing generation behavior.
    }
  };
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', [studentId]);

    const lockedCache = await readCachedInsight(client, studentId);
    if (!forceRefresh && isCurrentCache(lockedCache, inputFingerprint)) {
      await client.query('COMMIT');
      transactionStarted = false;
      return buildCachedState({ baseState, cachedInsight: lockedCache, topicEvidence, generalEvidence });
    }

    let insight;
    try {
      insight = await generateInsight({
        input,
        aiGenerationEnabled,
        onDiagnostics: emitInsightDiagnostics,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      if (error?.providerDiagnostics?.analytics) {
        await emitInsightDiagnostics(error.providerDiagnostics.analytics);
      }
      if (logger && typeof logger.error === 'function') {
        logger.error('Automatic grounded student insight unavailable:', error?.code || error?.message || 'unknown error');
      }
      return buildUnavailableState({ baseState, cachedInsight: lockedCache || initialCache, topicEvidence, generalEvidence });
    }

    insight = applyCurrentTopicEvidence(insight, topicEvidence, generalEvidence);

    persistenceAttempted = true;
    const savedResult = await client.query(
      `INSERT INTO public.student_ai_insights AS existing (
         student_id, input_fingerprint, insight, generated_by, generated_at, stale_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, clock_timestamp(), NULL, clock_timestamp())
       ON CONFLICT (student_id) DO UPDATE
       SET input_fingerprint = EXCLUDED.input_fingerprint,
           insight = EXCLUDED.insight,
           generated_by = EXCLUDED.generated_by,
           generated_at = GREATEST(clock_timestamp(), existing.generated_at + INTERVAL '1 millisecond'),
           stale_at = NULL,
           updated_at = clock_timestamp()
       RETURNING insight, generated_at`,
      [studentId, inputFingerprint, JSON.stringify(insight), actorId]
    );
    await client.query('COMMIT');
    transactionStarted = false;
    await emitInsightDiagnostics({
      validationStage: 'VALIDATION_PASSED',
      renderedOutputValidation: true,
      persistenceSucceeded: true,
    });
    return {
      ...baseState,
      topic_evidence_status: topicEvidence.topicEvidenceStatus,
      deterministic_evidence: toDeterministicEvidence(topicEvidence, generalEvidence),
      status: lockedCache || initialCache ? 'regenerated' : 'generated',
      is_stale: false,
      generated_at: savedResult.rows[0]?.generated_at || null,
      insight: savedResult.rows[0]?.insight || insight,
    };
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    if (persistenceAttempted) {
      await emitInsightDiagnostics({
        validationStage: 'PERSISTENCE_FAILED',
        persistenceSucceeded: false,
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  SUFFICIENT_INSIGHT_RESULT_COUNT,
  resolveDataLevel,
  resolveStudentAiInsight,
};
