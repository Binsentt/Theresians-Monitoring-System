const test = require('node:test');
const assert = require('node:assert/strict');

const { buildStudentAnalyticsMetrics } = require('./studentAnalyticsMetrics.utils');

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
      { score: 1, total_items: 1, difficulty: 'Easy', math_topic: 'Fractions' },
      { score: 0, total_items: 1, difficulty: 'Normal', math_topic: 'Fractions' },
      { score: 1, total_items: 1, difficulty: 'Difficult', math_topic: 'Decimals' },
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
    { topic: 'Decimals', correctAnswers: 1, totalQuestions: 1, accuracy: 100 },
    { topic: 'Fractions', correctAnswers: 1, totalQuestions: 2, accuracy: 50 },
  ]);
  assert.equal(metrics.playtimeMinutes, 20);
  assert.equal(metrics.totalProgress, 63);
  assert.equal(metrics.gameScore, 25);
  assert.equal(metrics.completedQuests, 2);
  assert.equal(metrics.currentQuest, 'Fraction Forest');
  assert.equal(metrics.questCompletionPercentage, null);
});

test('uses the saved progress snapshot only when there is no valid result history', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: { correct_answers: 4, total_questions: 5, accuracy_rate: 80, score: 0 },
    quizSessions: [{ score: 2, total_items: 1, difficulty: 'Easy' }],
    playtimeSessions: [],
  });

  assert.equal(metrics.validResultCount, 0);
  assert.equal(metrics.answerSource, 'progress_snapshot');
  assert.equal(metrics.correctAnswers, 4);
  assert.equal(metrics.incorrectAnswers, 1);
  assert.equal(metrics.accuracy, 80);
  assert.equal(metrics.difficultyBreakdown.easy.accuracy, null);
  assert.equal(metrics.difficultyBreakdown.medium.accuracy, null);
  assert.equal(metrics.difficultyBreakdown.hard.accuracy, null);
  assert.deepEqual(metrics.topicPerformance, []);
  assert.equal(metrics.playtimeMinutes, null);
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
