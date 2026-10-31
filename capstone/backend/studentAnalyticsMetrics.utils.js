const { resolveCurrentDifficulty } = require('./progressScene.utils');
const { countUniqueCompletedMilestones } = require('./questMilestones.utils');
const { canonicalPlaytimeSeconds } = require('./playtimeAggregation.utils');
const {
  calculateJourneyProgress,
  calculateWeightedCompletion,
  canonicalTaskDisplayLabel,
  QUEST_GRAPH_VERSION,
  PLAYER_FACING_TASKS,
} = require('./questGraph.utils');
const {
  getTopicById,
  isValidScope,
  normalizeScope,
  resolveLegacyDisplayTopic,
} = require('./curriculumScopeRegistry');

const CANONICAL_CAMPAIGN_TASK_IDS = new Set(['tutorial', ...PLAYER_FACING_TASKS]);

const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toNonNegativeInteger = (value) => {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed < 0 || !Number.isInteger(parsed)) return null;
  return parsed;
};

const toPercentage = (correctAnswers, totalQuestions) => {
  if (!Number.isFinite(correctAnswers) || !Number.isFinite(totalQuestions) || totalQuestions <= 0) return null;
  return Number(((correctAnswers / totalQuestions) * 100).toFixed(2));
};

const aggregateStudentAccuracy = (rows = []) => {
  const totals = (Array.isArray(rows) ? rows : []).reduce((aggregate, row) => {
    const metrics = row?.metrics || row || {};
    const correctAnswers = toNonNegativeInteger(metrics.correctAnswers ?? metrics.correct_answers);
    const totalQuestions = toNonNegativeInteger(metrics.totalQuestions ?? metrics.total_questions);
    if (correctAnswers === null || totalQuestions === null || correctAnswers > totalQuestions) return aggregate;
    aggregate.correctAnswers += correctAnswers;
    aggregate.totalQuestions += totalQuestions;
    return aggregate;
  }, { correctAnswers: 0, totalQuestions: 0 });
  return { ...totals, accuracy: toPercentage(totals.correctAnswers, totals.totalQuestions) };
};

const normalizeDifficulty = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'easy') return 'easy';
  if (['normal', 'medium', 'average', 'normal / average'].includes(normalized)) return 'medium';
  if (['difficult', 'hard'].includes(normalized)) return 'hard';
  return null;
};

const normalizeTopic = (value) => String(value || '').trim();

const distinctNonEmptyStrings = (values) => [...new Set((Array.isArray(values) ? values : [])
  .map((value) => String(value ?? '').trim())
  .filter(Boolean))];

const resolveValidatedTopicScope = (gradeLevel, difficulty, topicId) => {
  const scope = normalizeScope({ grade_level: gradeLevel, difficulty, topic_id: topicId });
  return scope && isValidScope(scope.grade_level, scope.difficulty, scope.topic_id) ? scope : null;
};

const resolveStoredTopicScope = ({ gradeLevel, difficulty, topicId, mathTopic }) => {
  const directTopicId = String(topicId || '').trim();
  if (directTopicId) return resolveValidatedTopicScope(gradeLevel, difficulty, directTopicId);
  const displayLabel = String(mathTopic || '').trim();
  if (!displayLabel) return null;
  const resolvedTopicId = resolveLegacyDisplayTopic(gradeLevel, difficulty, displayLabel);
  return resolvedTopicId ? resolveValidatedTopicScope(gradeLevel, difficulty, resolvedTopicId) : null;
};

const resolveLinkedQuestionSetScope = (row) => {
  const gradeLevel = row.canonical_grade_level;
  const difficulty = row.canonical_difficulty;
  const hasQuestionSetId = row.question_set_id !== null && row.question_set_id !== undefined && row.question_set_id !== '';
  const hasExactQuestionId = row.question_id !== null && row.question_id !== undefined && row.question_id !== '';
  if (hasExactQuestionId && String(row.resolved_question_id) !== String(row.question_id)) return null;
  const fileScope = resolveStoredTopicScope({
    gradeLevel,
    difficulty,
    topicId: row.canonical_topic_id,
    mathTopic: row.canonical_math_topic,
  });
  // The evidence loader supplies canonical_* fields only from server-owned
  // question-set metadata. Keep that already-resolved evidence usable for
  // callers that provide the normalized row directly.
  if (!hasQuestionSetId) return fileScope;

  // A resolved question ID is the most precise server-side relationship.
  // A generic legacy label on its parent set (for example, "Mathematics") is
  // not a topic and must not discard that exact canonical question evidence.
  if (hasExactQuestionId) {
    const exactQuestionScope = resolveStoredTopicScope({
      gradeLevel,
      difficulty,
      topicId: row.exact_question_topic_id,
      mathTopic: row.exact_question_math_topic,
    });
    if (exactQuestionScope && fileScope
      && exactQuestionScope.topic_id !== fileScope.topic_id) return null;
    return exactQuestionScope || fileScope;
  }

  // Without an exact question ID, a set can support one topic only when all
  // server-stored per-question metadata agrees, or the set itself has a
  // validated canonical topic. Never choose from a mixed question set.
  const questionTopicIds = distinctNonEmptyStrings(row.question_topic_ids);
  const questionTopicScopes = questionTopicIds
    .map((topicId) => resolveValidatedTopicScope(gradeLevel, difficulty, topicId));
  if (questionTopicScopes.some((scope) => !scope) || new Set(questionTopicScopes.map((scope) => scope?.topic_id)).size > 1) {
    return null;
  }
  const questionLabels = distinctNonEmptyStrings(row.question_math_topics);
  const questionLabelScopes = questionLabels
    .map((label) => resolveStoredTopicScope({ gradeLevel, difficulty, mathTopic: label }));
  if (questionLabelScopes.some((scope) => !scope) || new Set(questionLabelScopes.map((scope) => scope?.topic_id)).size > 1) {
    return null;
  }
  const sources = [questionTopicScopes[0], questionLabelScopes[0], fileScope].filter(Boolean);
  if (sources.length === 0 || new Set(sources.map((scope) => scope.topic_id)).size !== 1) return null;
  return sources[0];
};

const normalizeResult = (row = {}) => {
  const totalQuestions = toNonNegativeInteger(row.total_items ?? row.totalItems);
  const correctAnswers = toNonNegativeInteger(row.score);
  if (totalQuestions === null || totalQuestions < 1 || correctAnswers === null || correctAnswers > totalQuestions) {
    return null;
  }

  const linkedScope = resolveLinkedQuestionSetScope(row);
  const canonicalTopic = linkedScope ? getTopicById(linkedScope.topic_id) : null;

  return {
    correctAnswers,
    totalQuestions,
    // When a result is linked to a server-owned question set, that set's
    // difficulty is authoritative. Older valid rows can lack their copied
    // result difficulty even though their canonical question metadata remains.
    difficulty: normalizeDifficulty(row.canonical_difficulty) || normalizeDifficulty(row.difficulty),
    topicId: canonicalTopic ? linkedScope.topic_id : null,
    topic: canonicalTopic?.display_label || null,
    gradeLevel: canonicalTopic ? linkedScope.grade_level : null,
    currentMap: normalizeTopic(row.current_map ?? row.currentMap ?? row.map ?? row.map_name),
    mapId: normalizeTopic(row.map_id),
    resultEventId: normalizeTopic(row.result_event_id),
    canonicalTaskId: (!row.quest_graph_version || row.quest_graph_version === QUEST_GRAPH_VERSION)
      && PLAYER_FACING_TASKS.includes(normalizeTopic(row.canonical_task_id).toLowerCase())
      ? normalizeTopic(row.canonical_task_id).toLowerCase() : null,
    isPerQuestion: totalQuestions === 1 && (correctAnswers === 0 || correctAnswers === 1),
  };
};

const buildStudentAnalyticsScoreHistory = (quizSessions = [], limit = 20) => {
  if (!Array.isArray(quizSessions)) return [];
  const maxRows = Math.max(0, Math.min(Number.parseInt(limit, 10) || 20, 20));
  const seenResultEventIds = new Set();
  const validResults = quizSessions
    .map((row, index) => ({ row, index, result: normalizeResult(row) }))
    .filter(({ result }) => Boolean(result))
    .filter(({ row }) => {
      const eventId = normalizeTopic(row.result_event_id);
      if (!eventId) return true;
      if (seenResultEventIds.has(eventId)) return false;
      seenResultEventIds.add(eventId);
      return true;
    })
    .sort((left, right) => {
      const leftTime = new Date(left.row.played_at || 0).getTime();
      const rightTime = new Date(right.row.played_at || 0).getTime();
      const safeLeftTime = Number.isFinite(leftTime) ? leftTime : 0;
      const safeRightTime = Number.isFinite(rightTime) ? rightTime : 0;
      return safeLeftTime - safeRightTime || left.index - right.index;
    })
    .slice(-maxRows);

  return validResults.map(({ row, result }) => ({
    id: row.id ?? null,
    session_id: row.session_id ?? null,
    math_topic: result.topic,
    difficulty: ({ easy: 'Easy', medium: 'Normal', hard: 'Difficult' })[result.difficulty] || null,
    score: result.correctAnswers,
    total_items: result.totalQuestions,
    percentage: Number(((result.correctAnswers / result.totalQuestions) * 100).toFixed(2)),
    played_at: row.played_at || null,
  }));
};
const emptyDifficultyBreakdown = () => ({
  easy: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
  medium: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
  hard: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
});

function buildStudentAnalyticsMetrics({
  progress = {}, quizSessions = [], playtimeSessions = [], completedMilestones = null, activityLogs = [],
} = {}) {
  const seenResultEventIds = new Set();
  const validResults = (Array.isArray(quizSessions) ? quizSessions : [])
    .map(normalizeResult)
    .filter(Boolean)
    .filter((result) => {
      if (!result.resultEventId) return true;
      if (seenResultEventIds.has(result.resultEventId)) return false;
      seenResultEventIds.add(result.resultEventId);
      return true;
    });
  // One aggregate game-result row can represent several graded answers.  Count
  // the authoritative graded items rather than database rows so preliminary-AI
  // thresholds and "Recorded Results" stay truthful for both payload shapes.
  const validResultCount = validResults.reduce((total, result) => total + result.totalQuestions, 0);
  const topicLinkedEvidenceCount = validResults
    .filter((result) => result.topicId && result.gradeLevel)
    .reduce((total, result) => total + result.totalQuestions, 0);
  const difficultyBreakdown = emptyDifficultyBreakdown();
  const topicTotals = new Map();
  const questTopicTotals = new Map();
  const mapTotals = new Map();

  validResults.forEach((result) => {
    if (result.difficulty) {
      const current = difficultyBreakdown[result.difficulty];
      current.correctAnswers += result.correctAnswers;
      current.totalQuestions += result.totalQuestions;
    }
    if (result.topicId && result.gradeLevel) {
      const topicKey = `${result.gradeLevel}|${result.topicId}`;
      const current = topicTotals.get(topicKey) || {
        topicId: result.topicId,
        topic: result.topic,
        gradeLevel: result.gradeLevel,
        correctAnswers: 0,
        totalQuestions: 0,
      };
      current.correctAnswers += result.correctAnswers;
      current.totalQuestions += result.totalQuestions;
      topicTotals.set(topicKey, current);
    }
    if (result.topicId && result.gradeLevel && result.canonicalTaskId) {
      const questTopicKey = `${result.gradeLevel}|${result.canonicalTaskId}|${result.topicId}`;
      const current = questTopicTotals.get(questTopicKey) || {
        canonicalTaskId: result.canonicalTaskId,
        taskLabel: canonicalTaskDisplayLabel(result.canonicalTaskId),
        topicId: result.topicId,
        topic: result.topic,
        gradeLevel: result.gradeLevel,
        correctAnswers: 0,
        totalQuestions: 0,
      };
      current.correctAnswers += result.correctAnswers;
      current.totalQuestions += result.totalQuestions;
      questTopicTotals.set(questTopicKey, current);
    }
    if (result.currentMap) {
      const current = mapTotals.get(result.currentMap) || { correctAnswers: 0, totalQuestions: 0 };
      current.correctAnswers += result.correctAnswers;
      current.totalQuestions += result.totalQuestions;
      mapTotals.set(result.currentMap, current);
    }
  });

  Object.values(difficultyBreakdown).forEach((entry) => {
    entry.accuracy = toPercentage(entry.correctAnswers, entry.totalQuestions);
  });

  const resultCorrectAnswers = validResults.reduce((total, result) => total + result.correctAnswers, 0);
  const resultTotalQuestions = validResults.reduce((total, result) => total + result.totalQuestions, 0);
  const hasResultHistory = resultTotalQuestions > 0;
  const correctAnswers = hasResultHistory ? resultCorrectAnswers : 0;
  const totalQuestions = hasResultHistory ? resultTotalQuestions : 0;
  const incorrectAnswers = hasResultHistory ? Math.max(0, totalQuestions - correctAnswers) : 0;
  const accuracy = hasResultHistory ? toPercentage(correctAnswers, totalQuestions) : null;

  const totalProgressValue = toFiniteNumber(progress.progress_percentage);
  const hasCanonicalMilestoneState = Array.isArray(progress.completed_player_facing_task_ids)
    || Array.isArray(completedMilestones);
  const rawCanonicalCompletedTaskIds = Array.isArray(progress.completed_player_facing_task_ids)
    ? progress.completed_player_facing_task_ids
    : (Array.isArray(completedMilestones)
      ? completedMilestones
        .filter((row) => row?.player_facing !== false)
        .map((row) => row?.canonical_task_id || row?.canonical_milestone_id || row?.task_id || row?.milestone_id)
        .filter(Boolean)
      : null);
  const canonicalCompletedTaskIds = rawCanonicalCompletedTaskIds === null
    ? null
    : rawCanonicalCompletedTaskIds
      .map((taskId) => String(taskId || '').trim().toLowerCase())
      .filter((taskId) => CANONICAL_CAMPAIGN_TASK_IDS.has(taskId));
  const milestoneCount = countUniqueCompletedMilestones(
    (Array.isArray(completedMilestones) ? completedMilestones : [])
      .filter((row) => row?.player_facing === true || row?.player_facing === undefined)
      .filter((row) => !/^oakleaf\.bandits\.bandit_[1-5]$/i.test(String(row?.canonical_milestone_id || row?.milestone_id || ''))),
  );
  const legacyQuestCount = toNonNegativeInteger(progress.total_quests_completed);
  const completedQuests = canonicalCompletedTaskIds
    ? new Set(canonicalCompletedTaskIds).size
    : (milestoneCount > 0 ? milestoneCount : legacyQuestCount);
  // Game Score is the current-cycle count of correct graded answers. The
  // result history is authoritative; legacy progress.score may use old point
  // formulas and must not leak into this metric.
  const gameScore = correctAnswers;
  const canonicalTaskIds = new Set(PLAYER_FACING_TASKS);
  const canonicalActivityRows = (Array.isArray(activityLogs) ? activityLogs : [])
    .map((row) => ({
      ...row,
      taskId: normalizeTopic(row?.canonical_task_id).toLowerCase(),
      timestamp: row?.completed_at || row?.started_at || row?.activity_timestamp || null,
    }))
    .filter((row) => canonicalTaskIds.has(row.taskId))
    .filter((row) => !row.quest_graph_version || row.quest_graph_version === QUEST_GRAPH_VERSION)
    .filter((row) => row.is_player_facing !== false)
    .sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')));
  const latestCanonicalActivity = [...canonicalActivityRows].reverse().find((row) => (
    String(row.canonical_activity_id || '').trim().toLowerCase() === 'task_triggered'
  )) || canonicalActivityRows.at(-1) || null;
  const latestCanonicalResult = validResults
    .filter((result) => result.canonicalTaskId)
    .at(-1) || null;
  const persistedCanonicalTaskId = [
    progress.current_canonical_task_id,
    progress.current_task_id,
    progress.canonical_task_id,
  ]
    .map((taskId) => normalizeTopic(taskId).toLowerCase())
    .find((taskId) => CANONICAL_CAMPAIGN_TASK_IDS.has(taskId)) || null;
  const currentCanonicalTaskId = persistedCanonicalTaskId
    || latestCanonicalActivity?.taskId
    || latestCanonicalResult?.canonicalTaskId
    || null;
  const activityQuest = normalizeTopic(latestCanonicalActivity?.current_quest);
  const persistedQuest = normalizeTopic(progress.current_quest);
  const hasPersistedQuest = persistedQuest && !/^n\/?a$/i.test(persistedQuest);
  const latestTriggerTime = Date.parse(String(latestCanonicalActivity?.timestamp || ''));
  const persistedSaveTime = Date.parse(String(progress.last_played || ''));
  const hasNewerCanonicalTrigger = String(latestCanonicalActivity?.canonical_activity_id || '').trim().toLowerCase() === 'task_triggered'
    && Number.isFinite(latestTriggerTime)
    && (!Number.isFinite(persistedSaveTime) || latestTriggerTime > persistedSaveTime);
  const currentQuest = persistedCanonicalTaskId
    ? canonicalTaskDisplayLabel(persistedCanonicalTaskId)
    : hasNewerCanonicalTrigger
      ? (activityQuest && !/^n\/?a$/i.test(activityQuest)
        ? activityQuest : canonicalTaskDisplayLabel(latestCanonicalActivity.taskId))
    : hasPersistedQuest
      ? persistedQuest
      : latestCanonicalActivity
        ? (activityQuest && !/^n\/?a$/i.test(activityQuest)
          ? activityQuest : canonicalTaskDisplayLabel(currentCanonicalTaskId))
        : latestCanonicalResult
          ? canonicalTaskDisplayLabel(currentCanonicalTaskId)
          : null;
  const currentQuestSource = persistedCanonicalTaskId
    ? 'canonical_current_progress_task'
    : hasNewerCanonicalTrigger
      ? 'canonical_current_cycle_activity'
    : hasPersistedQuest
      ? 'persisted_progress'
      : latestCanonicalActivity
        ? 'canonical_current_cycle_activity'
        : latestCanonicalResult
          ? 'canonical_current_cycle_result'
          : 'unavailable';
  const currentDifficulty = resolveCurrentDifficulty(progress);
  const playtimeSeconds = canonicalPlaytimeSeconds(playtimeSessions, { includePlaying: false });
  const playtimeMinutes = playtimeSeconds > 0 ? Number((playtimeSeconds / 60).toFixed(2)) : null;

  const topicPerformance = Array.from(topicTotals.values())
    .map((totals) => ({
      topicId: totals.topicId,
      topic: totals.topic,
      gradeLevel: totals.gradeLevel,
      correctAnswers: totals.correctAnswers,
      incorrectAnswers: Math.max(0, totals.totalQuestions - totals.correctAnswers),
      totalQuestions: totals.totalQuestions,
      accuracy: toPercentage(totals.correctAnswers, totals.totalQuestions),
    }))
    .sort((left, right) => left.gradeLevel.localeCompare(right.gradeLevel) || left.topic.localeCompare(right.topic));
  const questTopicPerformance = Array.from(questTopicTotals.values())
    .map((totals) => ({
      ...totals,
      incorrectAnswers: Math.max(0, totals.totalQuestions - totals.correctAnswers),
      accuracy: toPercentage(totals.correctAnswers, totals.totalQuestions),
    }))
    .sort((left, right) => left.accuracy - right.accuracy
      || right.incorrectAnswers - left.incorrectAnswers
      || right.totalQuestions - left.totalQuestions
      || left.gradeLevel.localeCompare(right.gradeLevel)
      || left.canonicalTaskId.localeCompare(right.canonicalTaskId)
      || left.topic.localeCompare(right.topic));
  const unmappedTopicQuestionCount = validResults
    .filter((result) => !result.topicId)
    .reduce((total, result) => total + result.totalQuestions, 0);
  const unmappedTopicIncorrectAnswers = validResults
    .filter((result) => !result.topicId)
    .reduce((total, result) => total + result.totalQuestions - result.correctAnswers, 0);
  const questTopicLinkedEvidenceCount = questTopicPerformance
    .reduce((total, result) => total + result.totalQuestions, 0);
  const unmappedQuestTopicQuestionCount = Math.max(0, totalQuestions - questTopicLinkedEvidenceCount);
  const unmappedQuestTopicIncorrectAnswers = validResults
    .filter((result) => !result.canonicalTaskId || !result.topicId || !result.gradeLevel)
    .reduce((total, result) => total + result.totalQuestions - result.correctAnswers, 0);
  const topicEvidenceStatus = totalQuestions > 0 && incorrectAnswers === 0
    ? 'perfect_recorded_results'
    : questTopicPerformance.length > 0 && unmappedQuestTopicIncorrectAnswers > 0
      ? 'topic_metadata_partial'
      : questTopicPerformance.length > 0
    ? 'topic_metadata_available'
    : (incorrectAnswers > 0 ? 'topic_metadata_unavailable' : 'no_topic_evidence');

  const canonicalCompletedIds = canonicalCompletedTaskIds || (Array.isArray(completedMilestones)
    ? completedMilestones
      .filter((row) => row?.player_facing !== false)
      .map((row) => row?.canonical_task_id || row?.canonical_milestone_id || row?.task_id || row?.milestone_id)
      .filter((taskId) => canonicalTaskIds.has(String(taskId || '').trim().toLowerCase()))
    : []);
  const reachedTaskIds = [
    ...canonicalActivityRows.map((row) => row.taskId),
    ...validResults.map((result) => result.canonicalTaskId).filter(Boolean),
  ];
  if (currentCanonicalTaskId) reachedTaskIds.push(currentCanonicalTaskId);
  const totalProgress = calculateJourneyProgress({
    completedTaskIds: canonicalCompletedIds || [],
    reachedTaskIds,
    currentTaskId: currentCanonicalTaskId,
  });

  const mapBreakdown = Object.fromEntries(Array.from(mapTotals.entries())
    .map(([map, totals]) => [map, {
      correctAnswers: totals.correctAnswers,
      totalQuestions: totals.totalQuestions,
      accuracy: toPercentage(totals.correctAnswers, totals.totalQuestions),
    }])
    .sort(([left], [right]) => left.localeCompare(right)));

  return {
    answerSource: hasResultHistory ? 'game_results' : 'no_graded_answers',
    validResultCount,
    topicLinkedEvidenceCount,
    correctAnswers,
    incorrectAnswers,
    totalQuestions,
    accuracy,
    gameScore,
    // The preserved legacy client percentage has no verified full-game milestone
    // denominator. Keep it traceable without presenting it as game completion.
    totalProgress,
    reportedTotalProgress: totalProgressValue === null ? null : Number(totalProgressValue.toFixed(2)),
    totalProgressSource: totalProgress !== null ? 'canonical_quest_journey_position' : 'unavailable',
    totalProgressVerified: totalProgress !== null,
    totalProgressUnavailableReason: totalProgress !== null ? null : 'no_canonical_journey_evidence',
    completedQuests,
    // There is no authoritative total-quest denominator in the current data model.
    questCompletionPercentage: hasCanonicalMilestoneState
      ? calculateWeightedCompletion(canonicalCompletedTaskIds || [])
      : null,
    currentQuest,
    currentQuestSource,
    currentCanonicalTaskId,
    currentDifficulty: currentDifficulty === 'Unknown' ? null : currentDifficulty,
    difficultyBreakdown,
    topicPerformance,
    questTopicPerformance,
    questTopicLinkedEvidenceCount,
    unmappedQuestTopicQuestionCount,
    unmappedQuestTopicIncorrectAnswers,
    unmappedTopicQuestionCount,
    unmappedTopicIncorrectAnswers,
    topicEvidenceStatus,
    mapBreakdown,
    playtimeMinutes,
    playtimeSeconds: playtimeSeconds > 0 ? playtimeSeconds : null,
  };
}

module.exports = {
  buildStudentAnalyticsScoreHistory,
  aggregateStudentAccuracy,
  buildStudentAnalyticsMetrics,
  normalizeDifficulty,
  normalizeResult,
  toPercentage,
};
