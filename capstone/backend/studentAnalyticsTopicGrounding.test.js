const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GROUNDING_POLICY_VERSION,
  buildGroundedClaimCatalog,
  renderValidatedClaimSelection,
} = require('./studentAnalyticsGrounding.utils');
const { buildStudentAnalyticsMetrics } = require('./studentAnalyticsMetrics.utils');
const { buildGroundedInsightInput } = require('./studentAnalyticsInsight.utils');

const baseInput = {
  grounding_policy_version: GROUNDING_POLICY_VERSION,
  grade: 'Grade 1',
  results_recorded: 3,
  correct_answers: 1,
  incorrect_answers: 7,
  total_questions: 8,
  accuracy: 12.5,
  game_score: 1,
  difficulty_accuracy: { easy: 0, medium: 100, hard: null },
  topic_performance: [
    { canonical_task_id: 'oakleaf-bandits', topic_id: 'subtraction', grade_level: 'Grade 1', correct_answers: 1, incorrect_answers: 3, total_questions: 4 },
    { canonical_task_id: 'oakleaf-bandits', topic_id: 'multiplication', grade_level: 'Grade 1', correct_answers: 4, incorrect_answers: 0, total_questions: 4 },
    { canonical_task_id: 'oakleaf-bandits', topic_id: 'multiplication', grade_level: 'Grade 2', correct_answers: 4, incorrect_answers: 0, total_questions: 4 },
  ],
};

test('weakness and recommendation are grounded in the exact canonical Grade-topic evidence', () => {
  const catalog = buildGroundedClaimCatalog(baseInput);

  assert.deepEqual(catalog.permittedClaimIds.weakness, ['quest_oakleaf_bandits_topic_grade_1_subtraction_weakness']);
  assert.deepEqual(catalog.permittedClaimIds.recommendation, ['practice_quest_oakleaf_bandits_topic_grade_1_subtraction']);
  assert.equal(catalog.permittedClaimIds.strength.includes('quest_oakleaf_bandits_topic_grade_2_multiplication_strength'), false);
  assert.equal(catalog.permittedClaimIds.weakness.some((id) => id.includes('difficulty') || id.includes('overall')), false);

  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['quest_oakleaf_bandits_topic_grade_1_subtraction_accuracy'],
    strength_claim_ids: [],
    weakness_claim_ids: ['quest_oakleaf_bandits_topic_grade_1_subtraction_weakness'],
  }, catalog);

  assert.match(insight.weaknesses[0], /Subtraction — Oakleaf Bandits/);
  assert.match(insight.weaknesses[0], /3 incorrect answers were recorded.*limited evidence/);
  assert.match(insight.recommendations[0], /Grade 1 Subtraction/);
  assert.match(insight.recommendations[0], /3 missed questions/);
  assert.match(insight.recommendations[0], /Oakleaf Bandits/);
  assert.equal(insight.weaknesses.some((text) => /Easy|Normal|Difficult|overall/i.test(text)), false);
});

test('separates the same canonical topic across quests and preserves both task contexts', () => {
  const catalog = buildGroundedClaimCatalog({
    ...baseInput,
    topic_performance: [
      { canonical_task_id: 'oakleaf-bandits', topic_id: 'addition', grade_level: 'Grade 1', correct_answers: 1, total_questions: 4 },
      { canonical_task_id: 'pinehill-bandits', topic_id: 'addition', grade_level: 'Grade 1', correct_answers: 2, total_questions: 5 },
    ],
  });
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['results_recorded'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.equal(insight.weaknesses.length, 2);
  assert.match(insight.weaknesses[0], /Addition.*Oakleaf Bandits/);
  assert.match(insight.weaknesses[1], /Addition.*Pinehill Bandits/);
  assert.equal(insight.recommendations.length, 2);
});

test('requires both canonical topic and canonical quest linkage and reports missing task metadata', () => {
  const catalog = buildGroundedClaimCatalog({
    ...baseInput,
    topic_performance: [{ topic_id: 'addition', grade_level: 'Grade 1', correct_answers: 0, total_questions: 3 }],
  });
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['results_recorded', 'topic_evidence_unavailable'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, []);
  assert.equal(insight.topic_evidence_status, 'topic_metadata_unavailable');
  assert.match(insight.performance_insight, /no validated Grade\/topic\/task-linked question evidence/i);
});

test('perfect recorded scores produce an explicit no-weakness and no-practice state', () => {
  const catalog = buildGroundedClaimCatalog({
    ...baseInput,
    correct_answers: 4,
    incorrect_answers: 0,
    total_questions: 4,
    accuracy: 100,
    topic_performance: [{ canonical_task_id: 'oakleaf-bandits', topic_id: 'addition', grade_level: 'Grade 1', correct_answers: 4, total_questions: 4 }],
  });
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['results_recorded'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.equal(insight.topic_evidence_status, 'perfect_recorded_results');
  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, []);
});

test('incorrect overall answers without canonical topic evidence do not invent a topic weakness', () => {
  const catalog = buildGroundedClaimCatalog({
    ...baseInput,
    topic_performance: [],
    difficulty_accuracy: { easy: 0, medium: null, hard: null },
  });

  assert.deepEqual(catalog.weakness, []);
  assert.deepEqual(catalog.recommendation, []);
  assert.ok(catalog.performance.some((claim) => /no validated Grade\/topic\/task-linked/i.test(claim.text)));
});

test('free-text legacy math topic cannot create a canonical weakness', () => {
  const catalog = buildGroundedClaimCatalog({
    ...baseInput,
    topic_performance: [{ topic: 'Fractions', accuracy: 0, correct_answers: 0, total_questions: 8 }],
  });

  assert.deepEqual(catalog.weakness, []);
  assert.deepEqual(catalog.recommendation, []);
});

test('95 committed results with validated Grade-topic links surface the weakest topic, not difficulty', () => {
  const linkedResults = (topicId, difficulty, correctCount, totalCount, prefix) => Array.from(
    { length: totalCount },
    (_, index) => ({
      score: index < correctCount ? 1 : 0,
      total_items: 1,
      difficulty,
      question_set_id: `${prefix}-question-set`,
      canonical_task_id: 'oakleaf-bandits',
      canonical_topic_id: topicId,
      canonical_grade_level: 'Grade 1',
      canonical_difficulty: difficulty,
      result_event_id: `${prefix}-result-${index + 1}`,
    }),
  );
  const unlinkedResults = Array.from({ length: 81 }, (_, index) => ({
    score: 0,
    total_items: 1,
    difficulty: 'Easy',
    math_topic: 'Addition',
    question_set_id: null,
    result_event_id: `unlinked-result-${index + 1}`,
  }));
  const quizSessions = [
    ...linkedResults('addition', 'Normal', 1, 4, 'addition'),
    ...linkedResults('subtraction', 'Easy', 9, 10, 'subtraction'),
    ...unlinkedResults,
  ];
  const metrics = buildStudentAnalyticsMetrics({ quizSessions });
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics });
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: catalog.permittedClaimIds.performance.slice(0, 1),
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.equal(metrics.validResultCount, 95);
  assert.equal(metrics.difficultyBreakdown.easy.accuracy < 75, true);
  assert.deepEqual(metrics.topicPerformance.map(({ topicId }) => topicId), ['addition', 'subtraction']);
  assert.match(insight.weaknesses[0], /Addition — Oakleaf Bandits: 3 incorrect answers were recorded/);
  assert.match(insight.weaknesses[0], /limited evidence/i);
  assert.match(insight.recommendations[0], /Keep practicing Grade 1 Addition.*Oakleaf Bandits/);
  assert.equal(insight.weaknesses.some((text) => /Easy|Normal|Difficult/i.test(text)), false);
  assert.equal(insight.weaknesses.some((text) => /Subtraction/.test(text)), false);
});

test('95 unlinked committed results remain counted but cannot infer a weakness from legacy math-topic text', () => {
  const quizSessions = Array.from({ length: 95 }, (_, index) => ({
    score: index % 2,
    total_items: 1,
    difficulty: 'Easy',
    math_topic: 'Addition',
    question_set_id: null,
    result_event_id: `unlinked-result-${index + 1}`,
  }));
  const metrics = buildStudentAnalyticsMetrics({ quizSessions });
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics });
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['topic_evidence_unavailable'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.equal(metrics.validResultCount, 95);
  assert.ok(metrics.incorrectAnswers > 0);
  assert.deepEqual(metrics.topicPerformance, []);
  assert.equal(input.topic_evidence_status, 'topic_metadata_unavailable');
  assert.equal(insight.topic_evidence_status, 'topic_metadata_unavailable');
  assert.match(insight.performance_insight, /no validated Grade\/topic\/task-linked question evidence/i);
  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, []);
  assert.equal(insight.weaknesses.some((text) => /Addition|Easy/.test(text)), false);
});
