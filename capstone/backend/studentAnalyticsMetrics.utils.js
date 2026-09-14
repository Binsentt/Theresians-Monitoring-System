const { resolveCurrentDifficulty } = require('./progressScene.utils');
const { countUniqueCompletedMilestones } = require('./questMilestones.utils');
const { canonicalPlaytimeSeconds } = require('./playtimeAggregation.utils');
const { calculateWeightedCompletion, PLAYER_FACING_TASKS } = require('./questGraph.utils');

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

const normalizeDifficulty = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'easy') return 'easy';
  if (['normal', 'medium', 'average', 'normal / average'].includes(normalized)) return 'medium';
  if (['difficult', 'hard'].includes(normalized)) return 'hard';
  return null;
};

const normalizeTopic = (value) => String(value || '').trim();

const normalizeResult = (row = {}) => {
  const totalQuestions = toNonNegativeInteger(row.total_items ?? row.totalItems);
  const correctAnswers = toNonNegativeInteger(row.score);
  if (totalQuestions === null || totalQuestions < 1 || correctAnswers === null || correctAnswers > totalQuestions) {
    return null;
  }

  return {
    correctAnswers,
    totalQuestions,
    difficulty: normalizeDifficulty(row.difficulty),
    topic: normalizeTopic(row.math_topic ?? row.mathTopic),
    currentMap: normalizeTopic(row.current_map ?? row.currentMap ?? row.map ?? row.map_name),
    mapId: normalizeTopic(row.map_id),
    resultEventId: normalizeTopic(row.result_event_id),
    canonicalTaskId: normalizeTopic(row.canonical_task_id),
    isPerQuestion: totalQuestions === 1 && (correctAnswers === 0 || correctAnswers === 1),
  };
};

const emptyDifficultyBreakdown = () => ({
  easy: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
  medium: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
  hard: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
});

function buildStudentAnalyticsMetrics({ progress = {}, quizSessions = [], playtimeSessions = [], completedMilestones = null } = {}) {
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
  const difficultyBreakdown = emptyDifficultyBreakdown();
  const topicTotals = new Map();
  const mapTotals = new Map();

  validResults.forEach((result) => {
    if (result.difficulty) {
      const current = difficultyBreakdown[result.difficulty];
      current.correctAnswers += result.correctAnswers;
      current.totalQuestions += result.totalQuestions;
    }
    if (result.topic) {
      const current = topicTotals.get(result.topic) || { correctAnswers: 0, totalQuestions: 0 };
      current.correctAnswers += result.correctAnswers;
      current.totalQuestions += result.totalQuestions;
      topicTotals.set(result.topic, current);
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
  const currentQuest = normalizeTopic(progress.current_quest) || null;
  const currentDifficulty = resolveCurrentDifficulty(progress);
  const playtimeSeconds = canonicalPlaytimeSeconds(playtimeSessions, { includePlaying: false });
  const playtimeMinutes = playtimeSeconds > 0 ? Number((playtimeSeconds / 60).toFixed(2)) : null;

  const topicPerformance = Array.from(topicTotals.entries())
    .map(([topic, totals]) => ({
      topic,
      correctAnswers: totals.correctAnswers,
      totalQuestions: totals.totalQuestions,
      accuracy: toPercentage(totals.correctAnswers, totals.totalQuestions),
    }))
    .sort((left, right) => left.topic.localeCompare(right.topic));

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
    correctAnswers,
    incorrectAnswers,
    totalQuestions,
    accuracy,
    gameScore,
    // The preserved legacy client percentage has no verified full-game milestone
    // denominator. Keep it traceable without presenting it as game completion.
    totalProgress: hasCanonicalMilestoneState ? calculateWeightedCompletion(canonicalCompletedTaskIds || []) : null,
    reportedTotalProgress: totalProgressValue === null ? null : Number(totalProgressValue.toFixed(2)),
    totalProgressSource: hasCanonicalMilestoneState ? 'canonical_quest_milestones' : 'unavailable',
    totalProgressVerified: hasCanonicalMilestoneState,
    totalProgressUnavailableReason: hasCanonicalMilestoneState ? null : 'full_game_milestones_unverified',
    completedQuests,
    // There is no authoritative total-quest denominator in the current data model.
    questCompletionPercentage: hasCanonicalMilestoneState
      ? calculateWeightedCompletion(canonicalCompletedTaskIds || [])
      : null,
    currentQuest,
    currentDifficulty: currentDifficulty === 'Unknown' ? null : currentDifficulty,
    difficultyBreakdown,
    topicPerformance,
    mapBreakdown,
    playtimeMinutes,
    playtimeSeconds: playtimeSeconds > 0 ? playtimeSeconds : null,
  };
}

module.exports = {
  buildStudentAnalyticsMetrics,
  normalizeDifficulty,
  normalizeResult,
  toPercentage,
};
