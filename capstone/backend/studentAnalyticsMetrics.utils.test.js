const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateStudentAccuracy, buildStudentAnalyticsMetrics } = require('./studentAnalyticsMetrics.utils');

test('aggregates cohort accuracy from authoritative answer totals instead of averaging student percentages', () => {
  assert.deepEqual(aggregateStudentAccuracy([
    { metrics: { correctAnswers: 8, totalQuestions: 10, accuracy: 80 } },
    { metrics: { correctAnswers: 1, totalQuestions: 2, accuracy: 50 } },
  ]), { correctAnswers: 9, totalQuestions: 12, accuracy: 75 });
});

test('keeps no attempts distinct from a real zero-percent cohort', () => {
  assert.deepEqual(aggregateStudentAccuracy([{ metrics: { correctAnswers: 0, totalQuestions: 0, accuracy: null } }]), {
    correctAnswers: 0,
    totalQuestions: 0,
    accuracy: null,
  });
  assert.equal(aggregateStudentAccuracy([{ metrics: { correctAnswers: 0, totalQuestions: 3, accuracy: 0 } }]).accuracy, 0);
});

test('calculates factual accuracy, difficulty, topic, and playtime from valid result history', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: {
      score: 25,
      progress_percentage: 63,
      total_quests_completed: 2,
      current_quest: 'Fraction Forest',
      correct_answers: 99,
      total_questions: 99,
    },
    quizSessions: [
      { score: 1, total_items: 1, difficulty: 'Easy', math_topic: 'Fractions', canonical_topic_id: 'addition_of_money', canonical_grade_level: 'Grade 3', canonical_difficulty: 'Easy' },
      { score: 0, total_items: 1, difficulty: 'Normal', math_topic: 'Fractions', canonical_topic_id: 'fractions', canonical_grade_level: 'Grade 3', canonical_difficulty: 'Normal' },
      { score: 1, total_items: 1, difficulty: 'Difficult', math_topic: 'Decimals', canonical_topic_id: 'multi_step_problem_solving', canonical_grade_level: 'Grade 3', canonical_difficulty: 'Difficult' },
      { score: 3, total_items: 1, difficulty: 'Hard', math_topic: 'Ignored invalid result' },
    ],
    playtimeSessions: [
      { total_playtime_minutes: 12, status: 'Completed' },
      { total_playtime_minutes: 8, status: 'Stopped' },
      { total_playtime_minutes: 99, status: 'Playing' },
    ],
  });

  assert.equal(metrics.validResultCount, 3);
  assert.equal(metrics.correctAnswers, 2);
  assert.equal(metrics.incorrectAnswers, 1);
  assert.equal(metrics.totalQuestions, 3);
  assert.equal(metrics.accuracy, 66.67);
  assert.equal(metrics.difficultyBreakdown.easy.accuracy, 100);
  assert.equal(metrics.difficultyBreakdown.medium.accuracy, 0);
  assert.equal(metrics.difficultyBreakdown.hard.accuracy, 100);
  assert.deepEqual(metrics.topicPerformance, [
    { topicId: 'addition_of_money', topic: 'Addition of Money', gradeLevel: 'Grade 3', correctAnswers: 1, incorrectAnswers: 0, totalQuestions: 1, accuracy: 100 },
    { topicId: 'fractions', topic: 'Fractions', gradeLevel: 'Grade 3', correctAnswers: 0, incorrectAnswers: 1, totalQuestions: 1, accuracy: 0 },
    { topicId: 'multi_step_problem_solving', topic: 'Multi-step Problem Solving', gradeLevel: 'Grade 3', correctAnswers: 1, incorrectAnswers: 0, totalQuestions: 1, accuracy: 100 },
  ]);
  assert.equal(metrics.playtimeMinutes, 20);
  assert.equal(metrics.totalProgress, null);
  assert.equal(metrics.reportedTotalProgress, 63);
  assert.equal(metrics.totalProgressVerified, false);
  assert.equal(metrics.gameScore, 2);
  assert.equal(metrics.completedQuests, 2);
  assert.equal(metrics.currentQuest, 'Fraction Forest');
  assert.equal(metrics.questCompletionPercentage, null);
});

test('does not treat ungraded progress snapshots as graded accuracy evidence', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: { correct_answers: 4, total_questions: 5, accuracy_rate: 80, score: 0 },
    quizSessions: [{ score: 2, total_items: 1, difficulty: 'Easy' }],
    playtimeSessions: [],
  });

  assert.equal(metrics.validResultCount, 0);
  assert.equal(metrics.answerSource, 'no_graded_answers');
  assert.equal(metrics.correctAnswers, 0);
  assert.equal(metrics.incorrectAnswers, 0);
  assert.equal(metrics.totalQuestions, 0);
  assert.equal(metrics.gameScore, 0);
  assert.equal(metrics.accuracy, null);
  assert.equal(metrics.difficultyBreakdown.easy.accuracy, null);
  assert.equal(metrics.difficultyBreakdown.medium.accuracy, null);
  assert.equal(metrics.difficultyBreakdown.hard.accuracy, null);
  assert.deepEqual(metrics.topicPerformance, []);
  assert.equal(metrics.playtimeMinutes, null);
});

test('aggregates graded answers by map without allowing legacy percentage snapshots to override them', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: { correct_answers: 99, total_questions: 99, accuracy_rate: 100 },
    quizSessions: [
      { score: 3, total_items: 4, current_map: 'Oakleaf' },
      { score: 1, total_items: 2, current_map: 'Pinehill' },
    ],
  });
  assert.equal(metrics.validResultCount, 6);
  assert.equal(metrics.totalQuestions, 6);
  assert.equal(metrics.gameScore, 4);
  assert.equal(metrics.accuracy, 66.67);
  assert.deepEqual(metrics.mapBreakdown, {
    Oakleaf: { correctAnswers: 3, totalQuestions: 4, accuracy: 75 },
    Pinehill: { correctAnswers: 1, totalQuestions: 2, accuracy: 50 },
  });
});

test('does not fabricate quest completion or missing total progress', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: { total_quests_completed: 7, score: 0, accuracy_rate: 0 },
    quizSessions: [],
    playtimeSessions: [],
  });

  assert.equal(metrics.completedQuests, 7);
  assert.equal(metrics.questCompletionPercentage, null);
  assert.equal(metrics.totalProgress, null);
  assert.equal(metrics.accuracy, null);
});

test('keeps no-data difficulty distinct from a recorded zero-percent result', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: {},
    quizSessions: [{ score: 0, total_items: 1, difficulty: 'Easy' }],
    playtimeSessions: [],
  });

  assert.equal(metrics.difficultyBreakdown.easy.accuracy, 0);
  assert.equal(metrics.difficultyBreakdown.medium.accuracy, null);
  assert.equal(metrics.difficultyBreakdown.hard.accuracy, null);
});

test('current gameplay difficulty stays separate from historical answer performance and legacy progress', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: { current_map: 'oak_leaf_village', difficulty_level: 'Hard', progress_percentage: 75 },
    quizSessions: [{ score: 0, total_items: 1, difficulty: 'Hard' }],
  });
  assert.equal(metrics.currentDifficulty, 'Easy');
  assert.equal(metrics.difficultyBreakdown.easy.accuracy, null);
  assert.equal(metrics.difficultyBreakdown.hard.accuracy, 0);
  assert.equal(metrics.totalProgress, null);
  assert.equal(metrics.totalProgressVerified, false);
  assert.equal(metrics.reportedTotalProgress, 75);
  assert.equal(metrics.totalProgressVerified, false);
  assert.equal(metrics.totalProgressSource, 'unavailable');
});

test('legacy progress percentage is not presented as graded accuracy', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: { progress_percentage: 75, correct_answers: 3, total_questions: 4 },
  });
  assert.equal(metrics.accuracy, null);
  assert.equal(metrics.totalProgress, null);
  assert.equal(metrics.totalProgressVerified, false);
  assert.equal(metrics.reportedTotalProgress, 75);
  assert.equal(metrics.totalProgressUnavailableReason, 'full_game_milestones_unverified');
});

test('uses unique canonical milestones for quest count while accuracy stays N/A without graded answers', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: { total_quests_completed: 0 },
    completedMilestones: [
      { milestone_id: 'tutorial' },
      { milestone_id: 'tutorial' },
      { milestone_id: 'go-to-teachers-house' },
      { milestone_id: 'noncanonical-display-only-event' },
    ],
    quizSessions: [],
  });
  assert.equal(metrics.completedQuests, 2);
  assert.equal(metrics.accuracy, null);
  assert.equal(metrics.correctAnswers, 0);
  assert.equal(metrics.incorrectAnswers, 0);
  assert.equal(metrics.gameScore, 0);
});

test('excludes unknown task IDs from canonical quest counts and weighted completion', () => {
  const metrics = buildStudentAnalyticsMetrics({
    completedMilestones: [
      { canonical_task_id: 'tutorial' },
      { canonical_task_id: 'tutorial' },
      { canonical_task_id: 'go-to-teachers-house' },
      { canonical_task_id: 'display-label-only' },
    ],
  });

  assert.equal(metrics.completedQuests, 2);
  assert.equal(metrics.totalProgress, metrics.questCompletionPercentage);
});

test('uses explicit canonical milestone evidence for weighted completion', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: { total_quests_completed: 0 },
    completedMilestones: [
      { canonical_task_id: 'tutorial' },
      { canonical_task_id: 'go-to-teachers-house' },
    ],
    quizSessions: [],
  });
  assert.equal(metrics.completedQuests, 2);
  assert.equal(metrics.totalProgressVerified, true);
  assert.equal(metrics.totalProgressSource, 'canonical_quest_milestones');
  assert.equal(metrics.totalProgress, metrics.questCompletionPercentage);
  assert.ok(metrics.totalProgress > 0);
});

test('aggregates topic evidence only from canonical Grade and topic question-set metadata', () => {
  const metrics = buildStudentAnalyticsMetrics({
    quizSessions: [
      {
        score: 1,
        total_items: 4,
        difficulty: 'Easy',
        math_topic: 'Misleading free text',
        canonical_topic_id: 'subtraction',
        canonical_grade_level: 'Grade 1',
        canonical_difficulty: 'Easy',
      },
      {
        score: 4,
        total_items: 4,
        difficulty: 'Normal',
        math_topic: 'Subtraction',
        canonical_topic_id: 'subtraction',
        canonical_grade_level: 'Grade 2',
        canonical_difficulty: 'Normal',
      },
      {
        score: 0,
        total_items: 4,
        difficulty: 'Easy',
        math_topic: 'Unvalidated topic',
        canonical_topic_id: 'not_a_canonical_topic',
        canonical_grade_level: 'Grade 1',
        canonical_difficulty: 'Easy',
      },
    ],
  });

  assert.deepEqual(metrics.topicPerformance, [
    {
      topicId: 'subtraction',
      topic: 'Subtraction',
      gradeLevel: 'Grade 1',
      correctAnswers: 1,
      incorrectAnswers: 3,
      totalQuestions: 4,
      accuracy: 25,
    },
    {
      topicId: 'subtraction',
      topic: 'Subtraction',
      gradeLevel: 'Grade 2',
      correctAnswers: 4,
      incorrectAnswers: 0,
      totalQuestions: 4,
      accuracy: 100,
    },
  ]);
});

test('many valid incorrect results without linked topic metadata are counted but reported as topic metadata unavailable', () => {
  const quizSessions = Array.from({ length: 95 }, (_, index) => ({
    score: index % 2,
    total_items: 1,
    difficulty: 'Easy',
    math_topic: 'Addition',
    question_set_id: null,
    result_event_id: `unlinked-result-${index + 1}`,
  }));
  const metrics = buildStudentAnalyticsMetrics({ quizSessions });

  assert.equal(metrics.validResultCount, 95);
  assert.equal(metrics.topicLinkedEvidenceCount, 0);
  assert.ok(metrics.incorrectAnswers > 0);
  assert.deepEqual(metrics.topicPerformance, []);
  assert.equal(metrics.unmappedTopicIncorrectAnswers, metrics.incorrectAnswers);
  assert.equal(metrics.topicEvidenceStatus, 'topic_metadata_unavailable');
});

test('exact question linkage attributes only that canonical question topic and counts linked answers', () => {
  const metrics = buildStudentAnalyticsMetrics({
    quizSessions: [
      {
        question_id: 501,
        resolved_question_id: 501,
        question_set_id: 83,
        exact_question_topic_id: 'basic_addition',
        exact_question_math_topic: 'Basic Addition',
        question_topic_ids: ['addition', 'subtraction'],
        question_math_topics: ['Addition', 'Subtraction'],
        canonical_grade_level: 'Grade 1',
        canonical_difficulty: 'Easy',
        score: 0,
        total_items: 1,
        difficulty: 'Easy',
        math_topic: 'Untrusted client label',
      },
      {
        question_id: 502,
        resolved_question_id: null,
        question_set_id: 83,
        question_topic_ids: ['addition'],
        question_math_topics: ['Addition'],
        canonical_grade_level: 'Grade 1',
        canonical_difficulty: 'Easy',
        score: 0,
        total_items: 1,
        difficulty: 'Easy',
        math_topic: 'Addition',
      },
    ],
  });

  assert.equal(metrics.validResultCount, 2);
  assert.equal(metrics.topicLinkedEvidenceCount, 1);
  assert.deepEqual(metrics.topicPerformance.map(({ topicId, totalQuestions }) => ({ topicId, totalQuestions })), [
    { topicId: 'basic_addition', totalQuestions: 1 },
  ]);
  assert.equal(metrics.unmappedTopicQuestionCount, 1);
});

test('duplicate committed result event IDs do not double-count unlinked topic misses', () => {
  const metrics = buildStudentAnalyticsMetrics({
    quizSessions: [
      { result_event_id: 'same-event', score: 0, total_items: 1, math_topic: 'Addition' },
      { result_event_id: 'same-event', score: 0, total_items: 1, math_topic: 'Addition' },
    ],
  });

  assert.equal(metrics.validResultCount, 1);
  assert.equal(metrics.incorrectAnswers, 1);
  assert.equal(metrics.unmappedTopicIncorrectAnswers, 1);
});
