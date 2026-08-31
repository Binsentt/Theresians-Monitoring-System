const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CANONICAL_DIFFICULTIES,
  CANONICAL_GRADES,
  REGISTRY_VERSION,
  SCOPES,
  TOPICS,
  getPublicRegistrySnapshot,
  getTopicById,
  isValidScope,
  normalizeDifficulty,
  normalizeGradeLevel,
  normalizeScope,
  resolveLegacyDisplayTopic,
} = require('./curriculumScopeRegistry');

const EXPECTED_SCOPE_TOPICS = {
  'Grade 1|Easy': ['basic_addition', 'subtraction', 'shapes', 'place_value'],
  'Grade 1|Normal': ['addition', 'multiplication', 'word_problems'],
  'Grade 1|Difficult': ['problem_solving_addition_subtraction'],
  'Grade 2|Easy': ['shapes', 'ordinal_numbers', 'basic_addition_subtraction'],
  'Grade 2|Normal': ['multiplication', 'division', 'word_problems'],
  'Grade 2|Difficult': ['problem_solving', 'multiplication', 'division', 'fractions'],
  'Grade 3|Easy': ['addition_of_money', 'whole_numbers'],
  'Grade 3|Normal': ['multiplication', 'division', 'fractions'],
  'Grade 3|Difficult': ['multi_step_problem_solving'],
  'Grade 4|Easy': ['number_theory'],
  'Grade 4|Normal': ['place_value_of_whole_numbers'],
  'Grade 4|Difficult': ['reading_writing_comparing_whole_numbers'],
  'Grade 5|Easy': ['number_theory', 'basic_arithmetic'],
  'Grade 5|Normal': ['number_theory', 'basic_arithmetic'],
  'Grade 5|Difficult': ['time_conversion', 'number_theory', 'word_problems', 'order_of_operations'],
  'Grade 6|Easy': ['number_sense_and_operations'],
  'Grade 6|Normal': ['number_sense_and_operations'],
  'Grade 6|Difficult': ['rational_numbers', 'geometric_measurements'],
};

test('registry exposes the approved six grades, three difficulties, 25 topics, and 18 memberships', () => {
  assert.equal(REGISTRY_VERSION, '2026-08-31');
  assert.deepEqual(CANONICAL_GRADES, ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6']);
  assert.deepEqual(CANONICAL_DIFFICULTIES, ['Easy', 'Normal', 'Difficult']);
  assert.equal(TOPICS.length, 25);
  assert.equal(new Set(TOPICS.map((topic) => topic.topic_id)).size, 25);
  assert.equal(SCOPES.length, 18);

  const actualScopeTopics = Object.fromEntries(SCOPES.map((scope) => [
    `${scope.grade_level}|${scope.difficulty}`,
    scope.topic_ids,
  ]));
  assert.deepEqual(actualScopeTopics, EXPECTED_SCOPE_TOPICS);

  assert.equal(getTopicById('basic_addition').display_label, 'Basic Addition');
  assert.equal(getTopicById('addition').display_label, 'Addition');
  assert.equal(getTopicById('basic_addition_subtraction').display_label, 'Basic Addition/Subtraction');
  assert.notEqual(getTopicById('basic_addition').topic_id, getTopicById('addition').topic_id);
  assert.notEqual(getTopicById('addition').topic_id, getTopicById('basic_addition_subtraction').topic_id);
});

test('registry normalizes only approved Grade and Difficulty aliases into one scope', () => {
  assert.equal(normalizeGradeLevel('1'), 'Grade 1');
  assert.equal(normalizeGradeLevel('grade1'), 'Grade 1');
  assert.equal(normalizeGradeLevel('Grade 1'), 'Grade 1');
  assert.equal(normalizeGradeLevel('Grade 7'), null);

  assert.equal(normalizeDifficulty('Easy'), 'Easy');
  assert.equal(normalizeDifficulty('Medium'), 'Normal');
  assert.equal(normalizeDifficulty('Average'), 'Normal');
  assert.equal(normalizeDifficulty('Hard'), 'Difficult');
  assert.equal(normalizeDifficulty('Expert'), null);

  assert.deepEqual(
    normalizeScope({ grade_level: 'grade1', difficulty: 'Medium', topic_id: 'basic_addition' }),
    { grade_level: 'Grade 1', difficulty: 'Normal', topic_id: 'basic_addition' },
  );
  assert.equal(isValidScope('Grade 1', 'Easy', 'basic_addition'), true);
  assert.equal(isValidScope('Grade 1', 'Easy', 'addition'), false);
  assert.equal(isValidScope('Grade 1', 'Easy', 'unknown_topic'), false);
});

test('registry resolves legacy display labels only through exact scoped membership', () => {
  assert.equal(resolveLegacyDisplayTopic('Grade 1', 'Easy', 'Basic Addition'), 'basic_addition');
  assert.equal(resolveLegacyDisplayTopic('Grade 2', 'Easy', 'Basic Addition/Subtraction'), 'basic_addition_subtraction');
  assert.equal(resolveLegacyDisplayTopic('Grade 1', 'Easy', 'Addition'), null);
  assert.equal(resolveLegacyDisplayTopic('Grade 1', 'Easy', 'math'), null);
  assert.equal(resolveLegacyDisplayTopic('Grade 1', 'Easy', 'basic addition'), 'basic_addition');
});

test('public registry snapshot contains only static canonical metadata', () => {
  const snapshot = getPublicRegistrySnapshot();

  assert.deepEqual(Object.keys(snapshot).sort(), ['difficulties', 'grades', 'scopes', 'topics', 'version']);
  assert.equal(snapshot.version, REGISTRY_VERSION);
  assert.equal(snapshot.topics.every((topic) => Object.hasOwn(topic, 'topic_id') && Object.hasOwn(topic, 'display_label')), true);
  assert.equal(snapshot.scopes.every((scope) => (
    Object.hasOwn(scope, 'grade_level')
    && Object.hasOwn(scope, 'difficulty')
    && Object.hasOwn(scope, 'topic_ids')
  )), true);
});
