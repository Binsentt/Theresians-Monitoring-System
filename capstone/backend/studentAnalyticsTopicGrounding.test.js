const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GROUNDING_POLICY_VERSION,
  buildGroundedClaimCatalog,
  renderValidatedClaimSelection,
} = require('./studentAnalyticsGrounding.utils');

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
    { topic_id: 'subtraction', grade_level: 'Grade 1', correct_answers: 1, incorrect_answers: 3, total_questions: 4 },
    { topic_id: 'multiplication', grade_level: 'Grade 1', correct_answers: 4, incorrect_answers: 0, total_questions: 4 },
    { topic_id: 'multiplication', grade_level: 'Grade 2', correct_answers: 4, incorrect_answers: 0, total_questions: 4 },
  ],
};

test('weakness and recommendation are grounded in the exact canonical Grade-topic evidence', () => {
  const catalog = buildGroundedClaimCatalog(baseInput);

  assert.deepEqual(catalog.permittedClaimIds.weakness, ['topic_grade_1_subtraction_weakness']);
  assert.deepEqual(catalog.permittedClaimIds.recommendation, ['practice_topic_grade_1_subtraction']);
  assert.equal(catalog.permittedClaimIds.weakness.some((id) => id.includes('difficulty') || id.includes('overall')), false);

  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['topic_grade_1_subtraction_accuracy'],
    strength_claim_ids: ['topic_grade_1_multiplication_strength', 'topic_grade_2_multiplication_strength'],
    weakness_claim_ids: ['topic_grade_1_subtraction_weakness'],
  }, catalog);

  assert.match(insight.weaknesses[0], /Grade 1/);
  assert.match(insight.weaknesses[0], /Subtraction/);
  assert.match(insight.weaknesses[0], /3 incorrect/);
  assert.match(insight.recommendations[0], /Grade 1 Subtraction/);
  assert.match(insight.recommendations[0], /3 recorded incorrect/);
  assert.equal(insight.weaknesses.some((text) => /Easy|Normal|Difficult|overall/i.test(text)), false);
});

test('incorrect overall answers without canonical topic evidence do not invent a topic weakness', () => {
  const catalog = buildGroundedClaimCatalog({
    ...baseInput,
    topic_performance: [],
    difficulty_accuracy: { easy: 0, medium: null, hard: null },
  });

  assert.deepEqual(catalog.weakness, []);
  assert.deepEqual(catalog.recommendation, []);
  assert.ok(catalog.performance.some((claim) => /no validated Grade\/topic-linked/i.test(claim.text)));
});

test('free-text legacy math topic cannot create a canonical weakness', () => {
  const catalog = buildGroundedClaimCatalog({
    ...baseInput,
    topic_performance: [{ topic: 'Fractions', accuracy: 0, correct_answers: 0, total_questions: 8 }],
  });

  assert.deepEqual(catalog.weakness, []);
  assert.deepEqual(catalog.recommendation, []);
});
