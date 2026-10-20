const { PLAYER_FACING_TASKS, QUEST_GRAPH_VERSION, calculateJourneyProgress } = require('./questGraph.utils');

const TOP_ACHIEVER_TELEMETRY_VERSION = '2.0';
const QUALIFYING_ACTIVITY_DESCRIPTION = 'Task Triggered';
const CANONICAL_ACTIVITY_TASK_IDS = new Set(['tutorial', ...PLAYER_FACING_TASKS]);

const normalizeTaskId = (value) => String(value || '').trim().toLowerCase();

const isQualifyingTopAchieverActivity = (activity = {}, {
  studentId,
  learningCycleVersion,
  cycleStartedAt = null,
} = {}) => {
  const taskId = normalizeTaskId(activity.canonical_task_id);
  const expectedStudentId = Number(studentId);
  const activityStudentId = Number(activity.student_id);
  const sessionStudentId = Number(activity.session_student_id);
  const expectedCycle = Number(learningCycleVersion);
  const sessionCycle = Number(activity.session_learning_cycle_version);
  const activityTime = new Date(activity.activity_timestamp).getTime();
  const cycleStartTime = cycleStartedAt === null || cycleStartedAt === undefined
    ? null
    : new Date(cycleStartedAt).getTime();

  if (!Number.isInteger(expectedStudentId) || expectedStudentId <= 0
    || activityStudentId !== expectedStudentId || sessionStudentId !== expectedStudentId) return false;
  if (!Number.isInteger(expectedCycle) || expectedCycle < 0 || sessionCycle !== expectedCycle) return false;
  if (!activity.session_id
    || String(activity.session_id) !== String(activity.session_record_id)
    || !activity.activity_event_id
    || activity.is_player_facing !== true) return false;
  if (!CANONICAL_ACTIVITY_TASK_IDS.has(taskId)) return false;
  if (activity.telemetry_contract_version !== TOP_ACHIEVER_TELEMETRY_VERSION
    || activity.quest_graph_version !== QUEST_GRAPH_VERSION) return false;
  if (activity.activity_description !== `${QUALIFYING_ACTIVITY_DESCRIPTION} — ${taskId}`) return false;
  if (!Number.isFinite(activityTime)) return false;
  if (cycleStartTime !== null && (!Number.isFinite(cycleStartTime) || activityTime < cycleStartTime)) return false;
  return true;
};

const hasQualifyingTopAchieverActivity = (activities = [], context = {}) => (
  Array.isArray(activities) && activities.some((activity) => isQualifyingTopAchieverActivity(activity, context))
);

const resolveTopAchieverCompletion = ({
  completedTaskIds = [],
  reachedTaskIds = [],
  currentTaskId = null,
  hasCanonicalMilestones = false,
  weightedCompletionPercentage,
  hasQualifyingActivity = false,
} = {}) => {
  const journey = calculateJourneyProgress({ completedTaskIds, reachedTaskIds, currentTaskId });
  if (journey !== null) return journey;
  if (hasCanonicalMilestones) {
    if (weightedCompletionPercentage === null || weightedCompletionPercentage === undefined || weightedCompletionPercentage === '') return null;
    const percentage = Number(weightedCompletionPercentage);
    return Number.isFinite(percentage) && percentage >= 0 && percentage <= 100
      ? percentage
      : null;
  }
  return hasQualifyingActivity === true ? 0 : null;
};

const normalizeTopAchieverRow = (row, index = 0) => {
  const {
    completion_has_canonical_milestones: hasCanonicalMilestones,
    completion_weighted_percentage: weightedCompletionPercentage,
    completion_activity_evidence: activityEvidence,
    completion_completed_task_ids: completedTaskIds,
    completion_result_task_ids: resultTaskIds,
    completion_current_task_id: currentTaskId,
    completion_current_learning_cycle_version: learningCycleVersion,
    completion_current_learning_cycle_started_at: cycleStartedAt,
    ...publicRow
  } = row;
  const hasQualifyingActivity = hasQualifyingTopAchieverActivity(
    activityEvidence ? [activityEvidence] : [],
    {
      studentId: row.student_id,
      learningCycleVersion,
      cycleStartedAt,
    }
  );
  const reachedTaskIds = Array.isArray(resultTaskIds) ? [...resultTaskIds] : [];
  if (hasQualifyingActivity) reachedTaskIds.push(activityEvidence.canonical_task_id);
  const completion = resolveTopAchieverCompletion({
    completedTaskIds: Array.isArray(completedTaskIds) ? completedTaskIds : [],
    reachedTaskIds,
    currentTaskId,
    hasCanonicalMilestones,
    weightedCompletionPercentage,
    hasQualifyingActivity,
  });
  const accuracy = row.accuracy ?? row.accuracy_rate;
  const correctAnswers = Number(row.total_correct_answers ?? row.correct_answers ?? 0);
  const totalQuestions = Number(row.total_questions_answered ?? row.total_questions ?? 0);
  const gameScore = Number(row.game_score ?? row.correct_answers ?? 0);
  const questsCompleted = Number(row.quests_completed ?? row.total_quests_completed ?? 0);
  const totalPlayTime = Number(row.total_play_time ?? row.duration_seconds ?? 0);
  const normalizedAccuracy = accuracy === null || accuracy === undefined || accuracy === '' ? null : Number(accuracy);

  return {
    ...publicRow,
    rank: index + 1,
    rank_no: index + 1,
    student_name: row.student_name || row.account_student_name || 'Unknown',
    grade_level: row.grade_level || row.grade || null,
    grade: row.grade || row.grade_level || null,
    section: row.section || null,
    completion_percentage: completion,
    progress_percentage: completion,
    accuracy: Number.isFinite(normalizedAccuracy) ? normalizedAccuracy : null,
    accuracy_rate: Number.isFinite(normalizedAccuracy) ? normalizedAccuracy : null,
    total_correct_answers: Number.isFinite(correctAnswers) ? correctAnswers : 0,
    correct_answers: Number.isFinite(correctAnswers) ? correctAnswers : 0,
    game_score: Number.isFinite(gameScore) ? Math.max(0, Math.round(gameScore)) : 0,
    score: Number.isFinite(gameScore) ? Math.max(0, Math.round(gameScore)) : 0,
    total_questions_answered: Number.isFinite(totalQuestions) ? totalQuestions : 0,
    total_questions: Number.isFinite(totalQuestions) ? totalQuestions : 0,
    quests_completed: Number.isFinite(questsCompleted) ? questsCompleted : 0,
    total_quests_completed: Number.isFinite(questsCompleted) ? questsCompleted : 0,
    total_play_time: Number.isFinite(totalPlayTime) ? totalPlayTime : 0,
    duration_seconds: Number.isFinite(totalPlayTime) ? totalPlayTime : 0,
  };
};

const rankTopAchieverRows = (rows = []) => (Array.isArray(rows) ? rows : [])
  .map((row) => normalizeTopAchieverRow(row))
  .sort((left, right) => (right.completion_percentage ?? -1) - (left.completion_percentage ?? -1)
    || right.game_score - left.game_score
    || right.correct_answers - left.correct_answers
    || right.quests_completed - left.quests_completed
    || Number(left.student_id) - Number(right.student_id))
  .map((row, index) => ({ ...row, rank: index + 1, rank_no: index + 1 }));

module.exports = {
  TOP_ACHIEVER_TELEMETRY_VERSION,
  QUEST_GRAPH_VERSION,
  QUALIFYING_ACTIVITY_DESCRIPTION,
  isQualifyingTopAchieverActivity,
  hasQualifyingTopAchieverActivity,
  resolveTopAchieverCompletion,
  normalizeTopAchieverRow,
  rankTopAchieverRows,
};
