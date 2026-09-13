const { resolveCurrentDifficulty } = require('./progressScene.utils');
const { canonicalPlaytimeSeconds } = require('./playtimeAggregation.utils');
const { calculateWeightedCompletion } = require('./questGraph.utils');

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
    resultEventId: String(row.result_event_id || '').trim() || null,
    mapId: String(row.map_id || '').trim() || null,
    canonicalTaskId: String(row.canonical_task_id || '').trim() || null,
    isPerQuestion: totalQuestions === 1 && (correctAnswers === 0 || correctAnswers === 1),
  };
};

const emptyDifficultyBreakdown = () => ({
  easy: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
  medium: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
  hard: { correctAnswers: 0, totalQuestions: 0, accuracy: null },
});

function buildStudentAnalyticsMetrics({ progress = {}, quizSessions = [], playtimeSessions = [] } = {}) {
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
  const validResultCount = validResults.filter((result) => result.isPerQuestion).length;
  const difficultyBreakdown = emptyDifficultyBreakdown();
  const topicTotals = new Map();

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
  });

  Object.values(difficultyBreakdown).forEach((entry) => {
    entry.accuracy = toPercentage(entry.correctAnswers, entry.totalQuestions);
  });

  const resultCorrectAnswers = validResults.reduce((total, result) => total + result.correctAnswers, 0);
  const resultTotalQuestions = validResults.reduce((total, result) => total + result.totalQuestions, 0);
  const snapshotCorrectAnswers = toNonNegativeInteger(progress.correct_answers);
  const snapshotTotalQuestions = toNonNegativeInteger(progress.total_questions);
  const hasResultHistory = resultTotalQuestions > 0;
  const correctAnswers = hasResultHistory ? resultCorrectAnswers : snapshotCorrectAnswers;
  const totalQuestions = hasResultHistory ? resultTotalQuestions : snapshotTotalQuestions;
  const incorrectAnswers = totalQuestions === null || correctAnswers === null
    ? null
    : Math.max(0, totalQuestions - correctAnswers);
  const accuracy = hasResultHistory
    ? toPercentage(correctAnswers, totalQuestions)
    : toPercentage(correctAnswers, totalQuestions);

  const totalProgressValue = toFiniteNumber(progress.progress_percentage);
  const canonicalCompletedTaskIds = Array.isArray(progress.completed_player_facing_task_ids)
    ? progress.completed_player_facing_task_ids
    : null;
  const completedQuests = canonicalCompletedTaskIds
    ? canonicalCompletedTaskIds.length
    : toNonNegativeInteger(progress.total_quests_completed);
  const gameScore = toFiniteNumber(progress.score);
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

  return {
    answerSource: hasResultHistory ? 'game_results' : 'progress_snapshot',
    validResultCount,
    correctAnswers,
    incorrectAnswers,
    totalQuestions,
    accuracy,
    gameScore,
    // The preserved legacy client percentage has no verified full-game milestone
    // denominator. Keep it traceable without presenting it as game completion.
    totalProgress: null,
    reportedTotalProgress: totalProgressValue === null ? null : Number(totalProgressValue.toFixed(2)),
    totalProgressSource: totalProgressValue === null ? 'unavailable' : 'legacy_client_snapshot',
    totalProgressVerified: false,
    totalProgressUnavailableReason: 'full_game_milestones_unverified',
    completedQuests,
    // There is no authoritative total-quest denominator in the current data model.
    questCompletionPercentage: canonicalCompletedTaskIds
      ? calculateWeightedCompletion(canonicalCompletedTaskIds)
      : null,
    currentQuest,
    currentDifficulty: currentDifficulty === 'Unknown' ? null : currentDifficulty,
    difficultyBreakdown,
    topicPerformance,
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
