const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GROUNDING_POLICY_VERSION,
  buildGroundedClaimCatalog,
  buildClaimSelectionSchema,
  validateClaimSelection,
  renderValidatedClaimSelection,
} = require('./studentAnalyticsGrounding.utils');

const input = {
  grounding_policy_version: 'grounded-claims-v1',
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
};

const validSelection = {
  grounding_policy_version: 'grounded-claims-v1',
  performance_claim_ids: ['overall_accuracy', 'answer_counts', 'current_quest'],
  strength_claim_ids: [],
  weakness_claim_ids: [],
  recommendation_claim_ids: [],
};

const selection = (overrides = {}) => ({
  ...validSelection,
  ...overrides,
});

test('unverified legacy completion never becomes a permitted grounded progress claim', () => {
  const catalog = buildGroundedClaimCatalog({ ...input, total_progress: 75, total_progress_verified: false });
  assert.equal(catalog.permittedClaimIds.performance.includes('total_progress'), false);
});

test('catalog renders exact supported percentage, count, and current quest facts', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(validSelection, catalog);

  assert.equal(GROUNDING_POLICY_VERSION, 'grounded-claims-v1');
  assert.match(insight.performance_insight, /60%/);
  assert.match(insight.performance_insight, /3 correct answers and 2 incorrect answers/);
  assert.match(insight.performance_insight, /Current quest: Fraction Forest\./);
  assert.deepEqual(insight.strengths, []);
  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, []);
});

test('catalog permits recorded difficulty, observed topic, and evidence-linked claims', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['difficulty_easy_accuracy', 'difficulty_normal_accuracy', 'topic_fractions_accuracy'],
    strength_claim_ids: ['difficulty_easy_strength'],
    weakness_claim_ids: ['difficulty_normal_weakness'],
    recommendation_claim_ids: ['practice_difficulty_normal'],
  }), catalog);

  assert.match(insight.performance_insight, /Easy accuracy is 100%/);
  assert.match(insight.performance_insight, /Normal accuracy is 50%/);
  assert.match(insight.performance_insight, /Fractions accuracy is 60%/);
  assert.deepEqual(insight.strengths, ['Recorded Easy accuracy is 100%, meeting the current positive-evidence boundary.']);
  assert.deepEqual(insight.weaknesses, ['Recorded Normal accuracy is 50%, below the current 75% evidence boundary.']);
  assert.deepEqual(insight.recommendations, ['Provide additional Normal practice based on the recorded 50% accuracy.']);
});

test('catalog permits a no-data recommendation without turning no data into a weakness', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['difficulty_difficult_no_data'],
    recommendation_claim_ids: ['collect_difficulty_difficult_data'],
  }), catalog);

  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, ['Record more Difficult gameplay to establish performance evidence.']);
  assert.match(insight.performance_insight, /No recorded Difficult performance data is available yet/);
});

test('catalog rejects invented numeric, count, quest, topic, and trend claims', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const invalidSelections = [
    selection({ performance_claim_ids: ['accuracy_85_percent'] }),
    selection({ performance_claim_ids: ['answer_counts_4'] }),
    selection({ performance_claim_ids: ['completed_wizard_tower'] }),
    selection({ performance_claim_ids: ['topic_subtraction_accuracy'] }),
    selection({ performance_claim_ids: ['improving_accuracy'] }),
  ];

  invalidSelections.forEach((candidate) => {
    assert.throws(() => validateClaimSelection(candidate, catalog), /claim|grounding/i);
  });
});

test('catalog rejects no-data weakness, unsupported strength, wrong category, duplicates, and stale policy', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const invalidSelections = [
    selection({ weakness_claim_ids: ['difficulty_difficult_weakness'] }),
    selection({ strength_claim_ids: ['overall_accuracy_60_strength'] }),
    selection({ strength_claim_ids: ['overall_accuracy'] }),
    selection({ performance_claim_ids: ['overall_accuracy', 'overall_accuracy'] }),
    selection({ grounding_policy_version: 'grounded-claims-v0' }),
  ];

  invalidSelections.forEach((candidate) => {
    assert.throws(() => validateClaimSelection(candidate, catalog), /claim|grounding|policy|duplicate/i);
  });
});

test('catalog rejects a recommendation that is not linked to selected supporting evidence', () => {
  const catalog = buildGroundedClaimCatalog(input);
  assert.throws(() => validateClaimSelection(selection({
    recommendation_claim_ids: ['practice_difficulty_normal'],
  }), catalog), /support/i);
  assert.throws(() => validateClaimSelection(selection({
    performance_claim_ids: ['overall_accuracy'],
    recommendation_claim_ids: ['collect_difficulty_difficult_data'],
  }), catalog), /support/i);
});

test('dynamic provider schema allows only catalog ids and no free-text properties', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const schema = buildClaimSelectionSchema(catalog);

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'grounding_policy_version',
    'performance_claim_ids',
    'strength_claim_ids',
    'weakness_claim_ids',
    'recommendation_claim_ids',
  ]);
  assert.deepEqual(schema.properties.grounding_policy_version.enum, [GROUNDING_POLICY_VERSION]);
  assert.equal(schema.properties.performance_claim_ids.items.enum.includes('overall_accuracy'), true);
  assert.equal(schema.properties.performance_claim_ids.items.enum.includes('improving_accuracy'), false);
  assert.equal(schema.properties.strength_claim_ids.items.enum.includes('difficulty_easy_strength'), true);
  assert.equal(schema.properties.weakness_claim_ids.items.enum.includes('difficulty_difficult_weakness'), false);
});
