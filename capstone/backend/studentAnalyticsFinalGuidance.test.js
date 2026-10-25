const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GROUNDING_POLICY_VERSION,
  buildGroundedClaimCatalog,
  renderValidatedClaimSelection,
} = require('./studentAnalyticsGrounding.utils');

const topic = (topicId, correct, total, task = 'oakleaf-bandits') => ({
  canonical_task_id: task,
  topic_id: topicId,
  grade_level: 'Grade 1',
  correct_answers: correct,
  total_questions: total,
});

const insightFor = ({ topics = [], correct = 0, incorrect = 0, completedQuests = 3 } = {}) => {
  const topicLinkedEvidenceCount = topics.reduce((sum, item) => sum + item.total_questions, 0);
  const topicLinkedIncorrectAnswers = topics.reduce((sum, item) => (
    sum + item.total_questions - item.correct_answers
  ), 0);
  const catalog = buildGroundedClaimCatalog({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    grade: 'Grade 1',
    correct_answers: correct,
    incorrect_answers: incorrect,
    total_questions: correct + incorrect,
    results_recorded: correct + incorrect,
    completed_quests: completedQuests,
    topic_performance: topics,
    topic_linked_evidence_count: topicLinkedEvidenceCount,
    unmapped_topic_incorrect_answers: Math.max(0, incorrect - topicLinkedIncorrectAnswers),
    unmapped_quest_topic_incorrect_answers: Math.max(0, incorrect - topics.reduce((sum, item) => sum + item.total_questions - item.correct_answers, 0)),
  });
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['answer_counts'],
    strength_claim_ids: [],
    weakness_claim_ids: [],
  }, catalog);
  return { catalog, insight };
};

test('completed quests never become Math strengths; five verified answers at 80 percent do', () => {
  const { catalog, insight } = insightFor({
    topics: [topic('addition', 4, 5)], correct: 4, incorrect: 1,
  });
  assert.equal(catalog.strength.some((claim) => claim.id === 'completed_quests_strength'), false);
  assert.equal(insight.strengths.length, 1);
  assert.match(insight.strengths[0], /Addition.*4 of 5.*80%/);
  assert.doesNotMatch(insight.strengths.join(' '), /completed quest/i);
});

test('four perfect topic answers are insufficient to assert a Math strength', () => {
  const { insight } = insightFor({ topics: [topic('addition', 4, 4)], correct: 4 });
  assert.deepEqual(insight.strengths, []);
});

for (const misses of [1, 2, 3]) {
  test(`${misses} verified topic miss(es) yield limited-evidence guidance, not persistent weakness`, () => {
    const { insight } = insightFor({
      topics: [topic('subtraction', 0, misses)], incorrect: misses,
    });
    assert.equal(insight.weaknesses.length, 1);
    assert.match(insight.weaknesses[0], new RegExp(`${misses} incorrect answer`));
    assert.match(insight.weaknesses[0], /Subtraction.*limited evidence/i);
    assert.match(insight.weaknesses[0], /does not yet show a persistent weakness/i);
    assert.match(insight.recommendations[0], /Subtraction.*review/i);
  });
}

test('three misses across two verified topics remain limited and topic-specific', () => {
  const { insight } = insightFor({
    topics: [topic('addition', 0, 1), topic('subtraction', 0, 2, 'pinehill-bandits')],
    incorrect: 3,
  });
  assert.equal(insight.weaknesses.length, 2);
  assert.match(insight.weaknesses.join(' '), /Addition/);
  assert.match(insight.weaknesses.join(' '), /Subtraction/);
  assert.ok(insight.weaknesses.every((value) => /limited evidence/i.test(value)));
});

test('four or more verified misses below 75 percent support persistent weakness and matched advice', () => {
  const { insight } = insightFor({
    topics: [topic('multiplication', 9, 15)], correct: 9, incorrect: 6,
  });
  assert.match(insight.weaknesses[0], /Multiplication.*6 of 15.*60%/);
  assert.match(insight.recommendations[0], /Grade 1 Multiplication.*6 recorded incorrect answers/i);
});

test('one unlinked miss gets honest generic practice advice without inventing a topic', () => {
  const { insight } = insightFor({ incorrect: 1 });
  assert.match(insight.weaknesses[0], /1 incorrect answer.*limited evidence/i);
  assert.match(insight.recommendations[0], /Review the 1 missed question.*topic-linked results/i);
  assert.doesNotMatch(insight.weaknesses.join(' '), /Addition|Subtraction|Division/);
});

test('linked topic evidence remains useful when older unlinked answers also exist', () => {
  const { insight } = insightFor({
    topics: [topic('addition', 7, 10)], correct: 8, incorrect: 4,
  });
  assert.match(insight.weaknesses[0], /Addition/);
  assert.match(insight.performance_insight, /without validated Grade\/topic metadata/i);
});

test('perfect results create no weakness or recommendation', () => {
  const { insight } = insightFor({ topics: [topic('addition', 5, 5)], correct: 5 });
  assert.deepEqual(insight.weaknesses, []);
  assert.deepEqual(insight.recommendations, []);
  assert.equal(insight.strengths.length, 1);
});
