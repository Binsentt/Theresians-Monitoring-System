const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGroundedInsightInput,
  buildInsightFingerprint,
  validateGroundedInsight,
} = require('./studentAnalyticsInsight.utils');

const metrics = {
  validResultCount: 5,
  correctAnswers: 3,
  incorrectAnswers: 2,
  totalQuestions: 5,
  accuracy: 60,
  gameScore: 12,
  totalProgress: 42,
  completedQuests: 1,
  questCompletionPercentage: null,
  currentQuest: 'Fraction Forest',
  difficultyBreakdown: {
    easy: { accuracy: 100 },
    medium: { accuracy: 50 },
    hard: { accuracy: null },
  },
  topicPerformance: [{ topic: 'Fractions', accuracy: 60, correctAnswers: 3, totalQuestions: 5 }],
  playtimeMinutes: 24,
};

test('uses only minimized deterministic facts in the grounded insight input', () => {
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics, studentId: 44, name: 'Do not include' });

  assert.deepEqual(input, {
    grade: 'Grade 3',
    results_recorded: 5,
    correct_answers: 3,
    incorrect_answers: 2,
    total_questions: 5,
    accuracy: 60,
    game_score: 12,
    total_progress: 42,
    completed_quests: 1,
    current_quest: 'Fraction Forest',
    difficulty_accuracy: { easy: 100, medium: 50, hard: null },
    topic_performance: [{ topic: 'Fractions', accuracy: 60, correct_answers: 3, total_questions: 5 }],
    playtime_minutes: 24,
  });
  assert.equal(JSON.stringify(input).includes('Do not include'), false);
  assert.equal(JSON.stringify(input).includes('44'), false);
});

test('uses a stable cache fingerprint and changes it when meaningful results change', () => {
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics });
  const changed = buildGroundedInsightInput({
    gradeLevel: 'Grade 3',
    metrics: { ...metrics, correctAnswers: 4, accuracy: 80 },
  });

  assert.equal(buildInsightFingerprint(input), buildInsightFingerprint(input));
  assert.notEqual(buildInsightFingerprint(input), buildInsightFingerprint(changed));
});

test('accepts only complete bounded grounded insight content', () => {
  const insight = validateGroundedInsight({
    performance_insight: 'Recorded results show mixed accuracy, with more review needed before moving to harder questions.',
    strengths: ['Easy questions have the strongest recorded accuracy.'],
    weaknesses: ['Fractions needs more practice based on the recorded attempts.'],
    recommendations: ['Review fraction examples, then try another short set of questions.'],
  });

  assert.equal(insight.strengths.length, 1);
  assert.throws(
    () => validateGroundedInsight({ performance_insight: '', strengths: [], weaknesses: [], recommendations: [] }),
    /invalid/i
  );
});
