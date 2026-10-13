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
  grounding_policy_version: GROUNDING_POLICY_VERSION,
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
  topic_performance: [
    { topic_id: 'fractions', grade_level: 'Grade 3', correct_answers: 3, total_questions: 5 },
    { topic_id: 'multiplication', grade_level: 'Grade 3', correct_answers: 4, total_questions: 4 },
  ],
  playtime_minutes: 24,
};

const validSelection = {
  grounding_policy_version: GROUNDING_POLICY_VERSION,
  performance_claim_ids: ['overall_accuracy', 'answer_counts', 'current_quest'],
  strength_claim_ids: [],
  weakness_claim_ids: [],
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

  assert.equal(GROUNDING_POLICY_VERSION, 'grounded-claims-v4');
  assert.match(insight.performance_insight, /60%/);
  assert.match(insight.performance_insight, /3 correct answers and 2 incorrect answers/);
  assert.match(insight.performance_insight, /Current quest: Fraction Forest\./);
  assert.deepEqual(insight.strengths, []);
  assert.deepEqual(insight.weaknesses, [
    'Recorded Grade 3 Fractions accuracy is 60% (3 of 5 correct; 2 incorrect), below the current 75% evidence boundary.',
  ]);
  assert.deepEqual(insight.recommendations, [
    'For Grade 3 Fractions, review the 2 recorded incorrect answers and practice additional Fractions problems; the recorded result was 3 of 5 correct (60%).',
  ]);
});

test('difficulty remains descriptive while canonical Grade-topic evidence supports weaknesses', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['difficulty_easy_accuracy', 'difficulty_normal_accuracy', 'topic_grade_3_fractions_accuracy'],
    strength_claim_ids: ['topic_grade_3_multiplication_strength'],
    weakness_claim_ids: ['topic_grade_3_fractions_weakness'],
  }), catalog);

  assert.match(insight.performance_insight, /Easy accuracy is 100%/);
  assert.match(insight.performance_insight, /Normal accuracy is 50%/);
  assert.match(insight.performance_insight, /Grade 3 Fractions accuracy is 60%/);
  assert.deepEqual(insight.strengths, ['Recorded Grade 3 Multiplication accuracy is 100% (4 of 4 correct), meeting the current positive-evidence boundary.']);
  assert.deepEqual(insight.weaknesses, ['Recorded Grade 3 Fractions accuracy is 60% (3 of 5 correct; 2 incorrect), below the current 75% evidence boundary.']);
  assert.deepEqual(insight.recommendations, ['For Grade 3 Fractions, review the 2 recorded incorrect answers and practice additional Fractions problems; the recorded result was 3 of 5 correct (60%).']);
});

test('difficulty no-data remains descriptive while topic recommendation uses recorded evidence', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['difficulty_difficult_no_data'],
  }), catalog);

  assert.equal(insight.weaknesses.length, 1);
  assert.equal(insight.recommendations.length, 1);
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

test('positive topic evidence does not turn overall misses or difficulty into weaknesses', () => {
  const catalog = buildGroundedClaimCatalog({
    ...input,
    correct_answers: 4,
    incorrect_answers: 1,
    accuracy: 80,
    difficulty_accuracy: { easy: 80, medium: null, hard: null },
    topic_performance: [{ topic_id: 'fractions', grade_level: 'Grade 3', correct_answers: 4, total_questions: 5 }],
  });
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: [
      'results_recorded',
      'answer_counts',
      'overall_accuracy',
      'current_quest',
      'difficulty_normal_no_data',
    ],
    strength_claim_ids: [
      'completed_quests_strength',
      'topic_grade_3_fractions_strength',
    ],
    weakness_claim_ids: [],
  }, catalog);

  assert.equal(insight.performance_insight.length > 0, true);
  assert.equal(insight.strengths.length, 2);
  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, []);
});

test('selected weakness deterministically enables its matching recommendation', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['overall_accuracy'],
    weakness_claim_ids: ['topic_grade_3_fractions_weakness'],
  }), catalog);

  assert.deepEqual(insight.recommendations, [
    'For Grade 3 Fractions, review the 2 recorded incorrect answers and practice additional Fractions problems; the recorded result was 3 of 5 correct (60%).',
  ]);
});

test('overall accuracy with one recorded miss is not mislabeled as a math-topic weakness', () => {
  const catalog = buildGroundedClaimCatalog({
    ...input,
    results_recorded: 4,
    correct_answers: 3,
    incorrect_answers: 1,
    total_questions: 4,
    accuracy: 75,
    difficulty_accuracy: { easy: 75, medium: null, hard: null },
    topic_performance: [],
  });

  assert.deepEqual(catalog.weakness, []);
  assert.deepEqual(catalog.recommendation, []);
  assert.ok(catalog.performance.some((claim) => /no validated Grade\/topic-linked/i.test(claim.text)));
});

test('duration evidence alone never creates a weakness or recommendation', () => {
  const catalog = buildGroundedClaimCatalog({
    ...input,
    results_recorded: 0,
    correct_answers: 0,
    incorrect_answers: 0,
    total_questions: 0,
    accuracy: null,
    difficulty_accuracy: { easy: null, medium: null, hard: null },
    topic_performance: [],
    playtime_minutes: 180,
  });
  assert.equal(catalog.weakness.length, 0);
  assert.equal(catalog.recommendation.some((claim) => /duration|playtime/i.test(claim.text)), false);
});

test('an isolated recorded miss without topic linkage does not invent a subject recommendation', () => {
  const catalog = buildGroundedClaimCatalog({
    ...input,
    results_recorded: 5,
    correct_answers: 4,
    incorrect_answers: 1,
    total_questions: 5,
    accuracy: 80,
    difficulty_accuracy: { easy: 80, medium: null, hard: null },
    topic_performance: [],
  });

  assert.deepEqual(catalog.weakness, []);
  assert.deepEqual(catalog.recommendation, []);
});

test('recorded topic weaknesses and matching recommendations do not depend on provider selection', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['overall_accuracy'],
    weakness_claim_ids: [],
  }), catalog);

  assert.equal(insight.weaknesses.length, 1);
  assert.equal(insight.recommendations.length, 1);
  assert.equal(insight.topic_evidence_status, 'weaknesses_identified');
});

test('selected weakness deterministically enables its matching topic recommendation', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['topic_grade_3_fractions_accuracy'],
    weakness_claim_ids: ['topic_grade_3_fractions_weakness'],
  }), catalog);

  assert.deepEqual(insight.recommendations, ['For Grade 3 Fractions, review the 2 recorded incorrect answers and practice additional Fractions problems; the recorded result was 3 of 5 correct (60%).']);
});

test('topic weaknesses and recommendations are deterministic even when provider selects none', () => {
  const gradeOneInput = {
    ...input,
    grade: 'Grade 1',
    difficulty_accuracy: { easy: 20, medium: 90, hard: null },
    topic_performance: [
      { topic_id: 'addition', grade_level: 'Grade 1', correct_answers: 3, total_questions: 10 },
      { topic_id: 'subtraction', grade_level: 'Grade 1', correct_answers: 9, total_questions: 10 },
    ],
  };
  const catalog = buildGroundedClaimCatalog(gradeOneInput);
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['results_recorded', 'answer_counts', 'overall_accuracy'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.deepEqual(insight.weaknesses, [
    'Recorded Grade 1 Addition accuracy is 30% (3 of 10 correct; 7 incorrect), below the current 75% evidence boundary.',
  ]);
  assert.deepEqual(insight.recommendations, [
    'For Grade 1 Addition, review the 7 recorded incorrect answers and practice additional Addition problems; the recorded result was 3 of 10 correct (30%).',
  ]);
  assert.equal(insight.weaknesses.some((value) => /Easy|overall accuracy/i.test(value)), false);
});

test('multiple supported weak topics are ordered by topic accuracy and strong topics stay out', () => {
  const catalog = buildGroundedClaimCatalog({
    ...input,
    grade: 'Grade 1',
    topic_performance: [
      { topic_id: 'multiplication', grade_level: 'Grade 1', correct_answers: 9, total_questions: 10 },
      { topic_id: 'subtraction', grade_level: 'Grade 1', correct_answers: 11, total_questions: 20 },
      { topic_id: 'addition', grade_level: 'Grade 1', correct_answers: 3, total_questions: 10 },
    ],
  });
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['results_recorded'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.match(insight.weaknesses[0], /Addition accuracy is 30%/);
  assert.match(insight.weaknesses[1], /Subtraction accuracy is 55%/);
  assert.equal(insight.weaknesses.some((value) => /Multiplication/.test(value)), false);
  assert.match(insight.recommendations[0], /practice additional Addition problems/);
  assert.match(insight.recommendations[1], /practice additional Subtraction problems/);
});

test('low topic accuracy with fewer than five attempts is reported as insufficient, not as a weakness', () => {
  const catalog = buildGroundedClaimCatalog({
    ...input,
    grade: 'Grade 1',
    topic_performance: [
      { topic_id: 'addition', grade_level: 'Grade 1', correct_answers: 0, total_questions: 1 },
    ],
  });
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['results_recorded'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, []);
  assert.equal(insight.topic_evidence_status, 'insufficient_topic_attempts');
  assert.ok(insight.performance_insight.includes('not enough attempts'));
});

test('incorrect answers without canonical topic metadata return an explicit evidence-gap state', () => {
  const catalog = buildGroundedClaimCatalog({
    ...input,
    grade: 'Grade 1',
    incorrect_answers: 12,
    topic_performance: [],
    topic_evidence_status: 'topic_metadata_unavailable',
  });
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['topic_evidence_unavailable'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);

  assert.equal(insight.topic_evidence_status, 'topic_metadata_unavailable');
  assert.match(insight.performance_insight, /incorrect answers are recorded, but no validated Grade\/topic-linked/i);
  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, []);
});

test('deterministic topic recommendation does not depend on selected performance claims', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['overall_accuracy'],
  }), catalog);

  assert.equal(insight.recommendations.length, 1);
});

test('multiple topic recommendations are unique and deterministic', () => {
  const catalog = buildGroundedClaimCatalog({
    ...input,
    topic_performance: [
      { topic_id: 'fractions', grade_level: 'Grade 3', correct_answers: 3, total_questions: 5 },
      { topic_id: 'division', grade_level: 'Grade 3', correct_answers: 2, total_questions: 5 },
    ],
  });
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['topic_grade_3_fractions_accuracy', 'topic_grade_3_division_accuracy'],
    weakness_claim_ids: ['topic_grade_3_fractions_weakness', 'topic_grade_3_division_weakness'],
  }), catalog);

  assert.deepEqual(insight.recommendations, [
    'For Grade 3 Division, review the 3 recorded incorrect answers and practice additional Division problems; the recorded result was 2 of 5 correct (40%).',
    'For Grade 3 Fractions, review the 2 recorded incorrect answers and practice additional Fractions problems; the recorded result was 3 of 5 correct (60%).',
  ]);
});

test('supported topic recommendation remains present in a valid grounded insight', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection(selection({
    performance_claim_ids: ['results_recorded'],
  }), catalog);

  assert.equal(insight.recommendations.length, 1);
});

test('provider recommendation claim IDs are rejected as an unsupported output property', () => {
  const catalog = buildGroundedClaimCatalog(input);
  assert.throws(() => validateClaimSelection(selection({
    recommendation_claim_ids: ['practice_difficulty_normal'],
  }), catalog), /claim|grounding|property/i);
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
  ]);
  assert.deepEqual(schema.properties.grounding_policy_version.enum, [GROUNDING_POLICY_VERSION]);
  assert.equal(schema.properties.performance_claim_ids.items.enum.includes('overall_accuracy'), true);
  assert.equal(schema.properties.performance_claim_ids.items.enum.includes('improving_accuracy'), false);
  assert.equal(schema.properties.strength_claim_ids.items.enum.includes('topic_grade_3_multiplication_strength'), true);
  assert.equal(schema.properties.weakness_claim_ids.items.enum.includes('difficulty_difficult_weakness'), false);
  assert.equal(schema.properties.weakness_claim_ids.minItems, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, 'recommendation_claim_ids'), false);
});

test('dynamic provider schema uses only strict-compatible JSON Schema keywords', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const schema = buildClaimSelectionSchema(catalog);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    assert.equal(Object.prototype.hasOwnProperty.call(node, 'uniqueItems'), false);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(Object.keys(node.properties || {}).sort(), [...(node.required || [])].sort());
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
});

test('marks a rendered-output failure with a safe diagnostic stage', () => {
  const catalog = {
    policyVersion: GROUNDING_POLICY_VERSION,
    performance: [{ id: 'performance', text: 'x'.repeat(901) }],
    strength: [],
    weakness: [],
    recommendation: [],
  };
  assert.throws(
    () => renderValidatedClaimSelection({
      grounding_policy_version: GROUNDING_POLICY_VERSION,
      performance_claim_ids: ['performance'],
      strength_claim_ids: [],
      weakness_claim_ids: [],
    }, catalog),
    (error) => error.code === 'ANALYTICS_AI_GROUNDING_FAILED'
      && error.stage === 'RENDERED_OUTPUT_INVALID'
  );
});
