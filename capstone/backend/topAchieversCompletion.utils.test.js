const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isQualifyingTopAchieverActivity,
  hasQualifyingTopAchieverActivity,
  resolveTopAchieverCompletion,
  normalizeTopAchieverRow,
  rankTopAchieverRows,
  QUALIFYING_ACTIVITY_DESCRIPTION,
  TOP_ACHIEVER_TELEMETRY_VERSION,
  QUEST_GRAPH_VERSION,
} = require('./topAchieversCompletion.utils');
const { PLAYER_FACING_TASKS, calculateJourneyProgress, calculateWeightedCompletion } = require('./questGraph.utils');

const context = {
  studentId: 42,
  learningCycleVersion: 3,
  cycleStartedAt: '2026-09-01T00:00:00.000Z',
};

const eligibleActivity = (overrides = {}) => ({
  student_id: 42,
  session_id: 'session-42',
  session_record_id: 'session-42',
  session_student_id: 42,
  session_learning_cycle_version: 3,
  activity_event_id: 'event-42-1',
  activity_description: `${QUALIFYING_ACTIVITY_DESCRIPTION} — go-to-school`,
  canonical_task_id: 'go-to-school',
  telemetry_contract_version: TOP_ACHIEVER_TELEMETRY_VERSION,
  quest_graph_version: QUEST_GRAPH_VERSION,
  is_player_facing: true,
  activity_timestamp: '2026-09-02T10:00:00.000Z',
  ...overrides,
});

test('no milestones and no qualifying current-cycle activity means completion is unavailable', () => {
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: false }), null);
  assert.equal(hasQualifyingTopAchieverActivity([], context), false);
});

test('a current-cycle player-facing allowlisted task trigger establishes observed zero, not completion', () => {
  const activity = eligibleActivity();
  assert.equal(isQualifyingTopAchieverActivity(activity, context), true);
  assert.equal(hasQualifyingTopAchieverActivity([activity], context), true);
  assert.equal(resolveTopAchieverCompletion({ hasQualifyingActivity: true }), 0);
});

test('canonical milestone evidence preserves zero, partial, and complete weighted percentages', () => {
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true, weightedCompletionPercentage: 0 }), 0);
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true, weightedCompletionPercentage: 37.5 }), 37.5);
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true, weightedCompletionPercentage: 100 }), 100);
  const cityPartial = calculateWeightedCompletion(['tutorial', 'go-to-city-of-knowledge']);
  assert(cityPartial > 0 && cityPartial < 100);
});

test('City or Pinehill location alone never implies canonical objective completion', () => {
  for (const currentMap of ['city_of_knowledge', 'pinehill_village']) {
    assert.equal(resolveTopAchieverCompletion({
      hasCanonicalMilestones: false,
      hasQualifyingActivity: false,
      currentMap,
    }), null);
  }
  const cityMilestoneProgress = calculateWeightedCompletion(['go-to-city-of-knowledge']);
  assert(cityMilestoneProgress > 0 && cityMilestoneProgress < 100);
  assert.equal(PLAYER_FACING_TASKS.includes('talk-to-old-man'), true);

  const pinehillArrival = eligibleActivity({
    activity_description: `${QUALIFYING_ACTIVITY_DESCRIPTION} — pinehill-arrival`,
    canonical_task_id: 'pinehill-arrival',
  });
  assert.equal(resolveTopAchieverCompletion({
    hasCanonicalMilestones: false,
    hasQualifyingActivity: isQualifyingTopAchieverActivity(pinehillArrival, context),
    currentMap: 'pinehill_village',
  }), 0);
});

test('arbitrary task IDs and user-authored labels cannot establish activity evidence', () => {
  assert.equal(isQualifyingTopAchieverActivity(eligibleActivity({
    canonical_task_id: 'invented-task',
    activity_description: `${QUALIFYING_ACTIVITY_DESCRIPTION} — invented-task`,
  }), context), false);
  assert.equal(isQualifyingTopAchieverActivity(eligibleActivity({
    activity_description: 'I completed a quest in Pinehill',
  }), context), false);
  assert.equal(isQualifyingTopAchieverActivity(eligibleActivity({
    activity_description: 'Task Completed — go-to-school',
  }), context), false);
});

test('stale-cycle, stale-time, unrelated-student, mismatched-session, and ineligible events are rejected', () => {
  const invalidActivities = [
    eligibleActivity({ session_learning_cycle_version: 2 }),
    eligibleActivity({ activity_timestamp: '2026-08-31T23:59:59.000Z' }),
    eligibleActivity({ student_id: 99 }),
    eligibleActivity({ session_student_id: 99 }),
    eligibleActivity({ session_id: null }),
    eligibleActivity({ session_record_id: 'another-session' }),
    eligibleActivity({ activity_event_id: null }),
    eligibleActivity({ is_player_facing: false }),
    eligibleActivity({ is_player_facing: null }),
    eligibleActivity({ telemetry_contract_version: '1.0' }),
    eligibleActivity({ quest_graph_version: 'legacy-map-flow' }),
    eligibleActivity({ canonical_task_id: 'deep-forest-bandits.bandit_1' }),
    eligibleActivity({ activity_timestamp: 'not-a-date' }),
  ];
  for (const activity of invalidActivities) {
    assert.equal(isQualifyingTopAchieverActivity(activity, context), false);
  }
  assert.equal(hasQualifyingTopAchieverActivity(invalidActivities, context), false);
});

test('missing or malformed weighted metadata never silently produces a misleading percentage', () => {
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true }), null);
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true, weightedCompletionPercentage: null }), null);
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true, weightedCompletionPercentage: '' }), null);
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true, weightedCompletionPercentage: 'bad' }), null);
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true, weightedCompletionPercentage: -1 }), null);
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: true, weightedCompletionPercentage: 101 }), null);
  assert.equal(resolveTopAchieverCompletion({ hasCanonicalMilestones: false, weightedCompletionPercentage: 100 }), null);
});

test('response mapping hides evidence internals and preserves unavailable completion instead of numeric rank fallback', () => {
  const row = normalizeTopAchieverRow({
    student_id: 42,
    progress_percentage: 0,
    completion_has_canonical_milestones: false,
    completion_weighted_percentage: null,
    completion_activity_evidence: null,
    completion_current_learning_cycle_version: 3,
    completion_current_learning_cycle_started_at: context.cycleStartedAt,
    game_score: 7,
  });
  assert.equal(row.completion_percentage, null);
  assert.equal(row.progress_percentage, null);
  assert.equal(row.game_score, 7);
  assert.equal(Object.hasOwn(row, 'completion_has_canonical_milestones'), false);
  assert.equal(Object.hasOwn(row, 'completion_weighted_percentage'), false);
  assert.equal(Object.hasOwn(row, 'completion_activity_evidence'), false);
  assert.equal(Object.hasOwn(row, 'completion_current_learning_cycle_version'), false);
  assert.equal(Object.hasOwn(row, 'completion_current_learning_cycle_started_at'), false);
});

test('Top Achievers follows canonical journey position when late current-cycle tasks are reached', () => {
  const completedTaskIds = ['tutorial', 'go-to-teachers-house', 'talk-to-the-teacher'];
  const reachedTaskIds = ['defeat-the-wizard', 'return-to-city-of-knowledge'];
  const expected = calculateJourneyProgress({ completedTaskIds, reachedTaskIds });
  assert(expected > 80 && expected < 100);
  assert.equal(resolveTopAchieverCompletion({ completedTaskIds, reachedTaskIds }), expected);
  assert.equal(normalizeTopAchieverRow({
    student_id: 42,
    completion_completed_task_ids: completedTaskIds,
    completion_result_task_ids: ['defeat-the-wizard'],
    completion_activity_evidence: eligibleActivity({
      activity_description: `${QUALIFYING_ACTIVITY_DESCRIPTION} — return-to-city-of-knowledge`,
      canonical_task_id: 'return-to-city-of-knowledge',
    }),
    completion_current_learning_cycle_version: 3,
    completion_current_learning_cycle_started_at: context.cycleStartedAt,
    completion_has_canonical_milestones: true,
    completion_weighted_percentage: calculateWeightedCompletion(completedTaskIds),
  }).completion_percentage, expected);
});

test('reaching Final Teacher is capped below 100 until the entire campaign is completed', () => {
  const reached = resolveTopAchieverCompletion({ reachedTaskIds: ['final-teacher'] });
  assert(reached > 90 && reached < 100);
  assert.equal(resolveTopAchieverCompletion({
    completedTaskIds: ['tutorial', ...PLAYER_FACING_TASKS],
    reachedTaskIds: ['final-teacher'],
  }), 100);
  assert.equal(resolveTopAchieverCompletion({ completedTaskIds: [], reachedTaskIds: [] }), null);
});

test('Top Achievers ranks by canonical journey first, then existing score and stable student ID', () => {
  const rows = rankTopAchieverRows([
    { student_id: 8, game_score: 99, completion_completed_task_ids: ['tutorial'], completion_result_task_ids: ['go-to-school'] },
    { student_id: 7, game_score: 4, completion_completed_task_ids: ['tutorial'], completion_result_task_ids: ['return-to-city-of-knowledge'] },
    { student_id: 9, game_score: 4, completion_completed_task_ids: ['tutorial'], completion_result_task_ids: ['return-to-city-of-knowledge'] },
    { student_id: 5, game_score: 100 },
  ]);
  assert.deepEqual(rows.map((row) => row.student_id), [7, 9, 8, 5]);
  assert.deepEqual(rows.map((row) => row.rank), [1, 2, 3, 4]);
  assert.equal(rows[3].completion_percentage, null);
  assert.equal(Object.hasOwn(rows[0], 'completion_result_task_ids'), false);
});
