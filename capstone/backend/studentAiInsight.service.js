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

const buildCachedState = ({ baseState, cachedInsight }) => ({
  ...baseState,
  status: 'cached',
  is_stale: false,
  generated_at: cachedInsight.generated_at || null,
  insight: cachedInsight.insight,
});

const buildUnavailableState = ({ baseState, cachedInsight }) => ({
  ...baseState,
  status: 'unavailable',
  is_stale: Boolean(cachedInsight?.insight),
  generated_at: cachedInsight?.generated_at || null,
  insight: cachedInsight?.insight,
  message: cachedInsight?.insight
    ? 'New evidence is available, but the insight service is unavailable. The prior insight is shown as stale.'
    : 'Grounded AI Insights are unavailable right now. Recorded analytics remain available.',
});

const buildPausedState = ({ baseState, cachedInsight, isStale = Boolean(cachedInsight?.insight) }) => ({
  ...baseState,
  status: 'paused',
  code: AI_PAUSED_CODE,
  is_stale: isStale,
  generated_at: cachedInsight?.generated_at || null,
  insight: cachedInsight?.insight || null,
  message: AI_PAUSED_MESSAGE,
});

async function resolveStudentAiInsight({
  studentId,
  gradeLevel,
  metrics = {},
  actorId = null,
  aiGenerationEnabled = isAiGenerationEnabled(),
  pool,
  generateInsight = generateGroundedStudentInsight,
  onInsightDiagnostics = null,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A database pool with query and connect is required.');
  }

  const baseState = buildBaseState(metrics);
  if (baseState.data_level === 'no_data') {
    return {
      ...baseState,
      status: 'no_data',
      is_stale: false,
      message: 'No valid gameplay results are available for grounded AI analysis yet.',
    };
  }

  const input = buildGroundedInsightInput({ gradeLevel, metrics });
  const inputFingerprint = buildInsightFingerprint(input);
  const initialCache = await readCachedInsight(pool, studentId);
  if (!aiGenerationEnabled) {
    return buildPausedState({
      baseState,
      cachedInsight: initialCache,
      isStale: Boolean(initialCache?.insight) && !isCurrentCache(initialCache, inputFingerprint),
    });
  }
  if (isCurrentCache(initialCache, inputFingerprint)) {
    return buildCachedState({ baseState, cachedInsight: initialCache });
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
    if (isCurrentCache(lockedCache, inputFingerprint)) {
      await client.query('COMMIT');
      transactionStarted = false;
      return buildCachedState({ baseState, cachedInsight: lockedCache });
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
      return buildUnavailableState({ baseState, cachedInsight: lockedCache || initialCache });
    }

    persistenceAttempted = true;
    const savedResult = await client.query(
      `INSERT INTO public.student_ai_insights (
         student_id, input_fingerprint, insight, generated_by, generated_at, stale_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT (student_id) DO UPDATE
       SET input_fingerprint = EXCLUDED.input_fingerprint,
           insight = EXCLUDED.insight,
           generated_by = EXCLUDED.generated_by,
           generated_at = CURRENT_TIMESTAMP,
           stale_at = NULL,
           updated_at = CURRENT_TIMESTAMP
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
