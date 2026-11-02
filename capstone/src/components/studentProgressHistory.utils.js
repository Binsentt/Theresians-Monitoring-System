import {
  clampPercent,
  normalizeDifficultyDisplay,
  safeDisplayText,
} from './studentProgress.utils';

const toOptionalFiniteNumber = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveTimestamp = (record = {}) => {
  const raw = record.played_at || record.activity_timestamp || record.completed_at
    || record.started_at || record.created_at || null;
  if (!raw) return { raw: null, value: Number.NEGATIVE_INFINITY };
  const value = new Date(raw).getTime();
  return Number.isFinite(value) ? { raw, value } : { raw: null, value: Number.NEGATIVE_INFINITY };
};

const buildScoreTimeline = (sessions = []) => {
  if (!Array.isArray(sessions)) return [];

  const valid = sessions
    .map((session, index) => ({ session, index, percentage: toOptionalFiniteNumber(session?.percentage) }))
    .filter(({ percentage }) => percentage !== null && percentage >= 0 && percentage <= 100)
    .sort((left, right) => {
      const leftTime = resolveTimestamp(left.session).value;
      const rightTime = resolveTimestamp(right.session).value;
      return leftTime - rightTime || left.index - right.index;
    })
    .slice(-20);

  return valid.map(({ session }, index) => {
    const score = toOptionalFiniteNumber(session.score);
    const totalItems = toOptionalFiniteNumber(session.total_items ?? session.totalItems);
    const hasAuthoritativeScore = score !== null && totalItems !== null
      && Number.isInteger(score) && score >= 0
      && Number.isInteger(totalItems) && totalItems > 0 && score <= totalItems;
    const timestamp = resolveTimestamp(session);
    return {
      label: 'Q' + (index + 1),
      percentage: clampPercent(toOptionalFiniteNumber(session.percentage), 0),
      topic: safeDisplayText(session.math_topic, 'Topic unavailable'),
      difficulty: normalizeDifficultyDisplay(session.difficulty, 'Difficulty unavailable'),
      playedAt: timestamp.raw,
      resultId: session.id ?? null,
      sessionId: session.session_id ?? null,
      ...(hasAuthoritativeScore ? { score, totalItems } : {}),
    };
  });
};

const buildLatestActivity = (activities = []) => {
  if (!Array.isArray(activities)) return [];
  return activities
    .map((activity, index) => ({ activity, index, timestamp: resolveTimestamp(activity).value }))
    .sort((left, right) => right.timestamp - left.timestamp || left.index - right.index)
    .slice(0, 5)
    .map(({ activity }) => activity);
};

const isGradedActivity = (activity = {}) => {
  const description = (activity.canonical_activity_id || '') + ' ' + (activity.activity_description || '');
  const score = toOptionalFiniteNumber(activity.score);
  const totalItems = toOptionalFiniteNumber(activity.total_items ?? activity.totalItems);
  const percentage = toOptionalFiniteNumber(activity.percentage ?? activity.accuracy);
  return (score !== null && totalItems !== null && totalItems > 0)
    || (percentage !== null && /quiz|battle|answer|result/i.test(description));
};

const formatLatestActivityScore = (activity = {}) => {
  if (!isGradedActivity(activity)) return 'Not graded';
  const score = toOptionalFiniteNumber(activity.score);
  const totalItems = toOptionalFiniteNumber(activity.total_items ?? activity.totalItems);
  if (score !== null && totalItems !== null && totalItems > 0) return score + ' / ' + totalItems;
  const percentage = toOptionalFiniteNumber(activity.percentage ?? activity.accuracy);
  return percentage !== null ? percentage.toFixed(0) + '%' : 'Not graded';
};

export { buildLatestActivity, buildScoreTimeline, formatLatestActivityScore };
