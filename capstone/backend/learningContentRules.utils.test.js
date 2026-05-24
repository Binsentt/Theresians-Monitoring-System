const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_DIFFICULTIES,
  ALLOWED_MATH_TOPICS,
  GRADE_TOPIC_MAP,
  getMathTopicsForGrade,
  getMathTopicsForGradeDifficulty,
  isValidDifficulty,
  isValidMathTopicForGrade,
  isValidMathTopicForGradeDifficulty,
  parseExpectedQuestionCount,
  validateLearningMetadata,
  validateExpectedQuestionCount,
} = require('./learningContentRules.utils');

test('stores the approved lesson difficulties exactly', () => {
  assert.deepEqual(ALLOWED_DIFFICULTIES, ['Easy', 'Normal', 'Difficult']);
});

test('maps math topics by grade and difficulty', () => {
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 1', 'Easy'), [
    'Basic Addition',
    'Subtraction',
    'Shapes',
    'Place Value',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 2', 'Difficult'), [
    'Problem Solving',
    'Multiplication',
    'Division',
    'Fractions',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 3', 'Normal'), [
    'Multiplication',
    'Division',
    'Fractions',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 6', 'Difficult'), [
    'Rational Numbers',
    'Geometric Measurements',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 6', 'Average'), [
    'Number Sense and Operations',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 6', 'Hard'), []);
  assert.deepEqual(GRADE_TOPIC_MAP['Grade 5'].Normal, [
    'Number Theory',
    'Basic Arithmetic',
  ]);
});

test('keeps grade topic helpers constrained to configured topics', () => {
  assert.equal(getMathTopicsForGrade('Grade 4').includes('Number Theory'), true);
  assert.equal(getMathTopicsForGrade('Grade 4').includes('Division'), false);
  assert.equal(isValidMathTopicForGrade('Grade 4', 'Number Theory'), true);
  assert.equal(isValidMathTopicForGrade('Grade 4', 'Division'), false);
  assert.equal(ALLOWED_MATH_TOPICS.includes('Formulas'), false);
});

test('validates topic combinations against grade and difficulty', () => {
  assert.equal(isValidDifficulty('Easy'), true);
  assert.equal(isValidDifficulty('Hard'), false);
  assert.equal(
    isValidMathTopicForGradeDifficulty(
      'Grade 1',
      'Normal',
      'Addition'
    ),
    true
  );
  assert.equal(
    isValidMathTopicForGradeDifficulty(
      'Grade 1',
      'Easy',
      'Addition'
    ),
    false
  );
  assert.equal(
    validateLearningMetadata({
      grade_level: 'Grade 2',
      difficulty: 'Normal',
      math_topic: 'Multiplication',
    }),
    ''
  );
  assert.equal(
    validateLearningMetadata({
      grade_level: 'Grade 2',
      difficulty: 'Medium',
      math_topic: 'Multiplication',
    }),
    'Difficulty must be Easy, Normal, or Difficult.'
  );
  assert.equal(
    validateLearningMetadata({
      grade_level: 'Grade 2',
      difficulty: 'Normal',
      math_topic: 'Measurement',
    }),
    'Topic must match the selected grade level and difficulty.'
  );
});

test('parses and validates fixed question counts for uploaded question bundles', () => {
  assert.equal(parseExpectedQuestionCount('12'), 12);
  assert.equal(parseExpectedQuestionCount(''), null);
  assert.equal(parseExpectedQuestionCount('0'), null);
  assert.equal(validateExpectedQuestionCount([{ question: 'A' }, { question: 'B' }], '2'), null);
  assert.equal(
    validateExpectedQuestionCount([{ question: 'A' }], '2'),
    'File contains 1 questions but you specified 2. Please check your file.'
  );
});
