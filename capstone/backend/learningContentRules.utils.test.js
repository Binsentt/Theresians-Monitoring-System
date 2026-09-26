const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_DIFFICULTIES,
  ALLOWED_MATH_TOPICS,
  LESSON_QUESTION_COUNT_OPTIONS,
  MAX_LESSON_QUESTION_COUNT,
  getMathTopicsForGrade,
  getMathTopicsForGradeDifficulty,
  getTopicIdsForGradeDifficulty,
  isValidDifficulty,
  isValidMathTopicForGrade,
  isValidMathTopicForGradeDifficulty,
  isValidTopicIdForGradeDifficulty,
  normalizeGradeLevel,
  normalizeDifficultyValue,
  parseExpectedQuestionCount,
  parseLessonQuestionCount,
  resolveQuestionPoolScope,
  validateLearningMetadata,
  validateExpectedQuestionCount,
} = require('./learningContentRules.utils');

test('stores the approved lesson difficulties exactly', () => {
  assert.deepEqual(ALLOWED_DIFFICULTIES, ['Easy', 'Normal', 'Difficult']);
});

test('normalizes legacy and current difficulty terminology to one display value', () => {
  assert.equal(normalizeDifficultyValue('Easy'), 'Easy');
  assert.equal(normalizeDifficultyValue('Medium'), 'Normal');
  assert.equal(normalizeDifficultyValue('Normal'), 'Normal');
  assert.equal(normalizeDifficultyValue('Hard'), 'Difficult');
  assert.equal(normalizeDifficultyValue('Difficult'), 'Difficult');
});

test('resolves the active question pool from Grade and Difficulty without Topic metadata', () => {
  assert.deepEqual(
    resolveQuestionPoolScope({ grade: '1', difficulty: 'Hard' }),
    { grade_level: 'Grade 1', difficulty: 'Difficult' }
  );
  assert.deepEqual(
    resolveQuestionPoolScope({ grade_level: 'Grade 6', difficulty: 'Average', topic_id: 'unsupported-source-tag' }),
    { grade_level: 'Grade 6', difficulty: 'Normal' }
  );
  assert.equal(validateLearningMetadata({ grade_level: 'Grade 1', difficulty: 'Easy' }), '');
  assert.equal(validateLearningMetadata({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    topic_id: 'unsupported-source-tag',
  }), '');
});

test('maps math topics by grade and difficulty', () => {
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 1', 'Easy'), [
    'Basic Addition',
    'Subtraction',
    'Shapes',
    'Place Value',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 2', 'Hard'), [
    'Problem Solving',
    'Multiplication',
    'Division',
    'Fractions',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 3', 'Medium'), [
    'Multiplication',
    'Division',
    'Fractions',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 6', 'Hard'), [
    'Rational Numbers',
    'Geometric Measurements',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 6', 'Average'), [
    'Number Sense and Operations',
  ]);
  assert.deepEqual(getMathTopicsForGradeDifficulty('Grade 6', 'Difficult'), [
    'Rational Numbers',
    'Geometric Measurements',
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
  assert.equal(isValidDifficulty('Hard'), true);
  assert.equal(isValidDifficulty('Normal'), true);
  assert.equal(
    isValidMathTopicForGradeDifficulty(
      'Grade 1',
      'Medium',
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
      difficulty: 'Medium',
      math_topic: 'Multiplication',
    }),
    ''
  );
  assert.equal(
    validateLearningMetadata({
      grade_level: 'Grade 2',
      difficulty: 'Impossible',
      math_topic: 'Multiplication',
    }),
    'Difficulty must be Easy, Normal, or Difficult.'
  );
  assert.equal(
    validateLearningMetadata({
      grade_level: 'Grade 2',
      difficulty: 'Medium',
      math_topic: 'Measurement',
    }),
    ''
  );
});

test('derives canonical topic IDs from the backend registry without accepting arbitrary topic text', () => {
  assert.equal(normalizeGradeLevel('grade1'), 'Grade 1');
  assert.deepEqual(getTopicIdsForGradeDifficulty('Grade 1', 'Easy'), [
    'basic_addition',
    'subtraction',
    'shapes',
    'place_value',
  ]);
  assert.equal(isValidTopicIdForGradeDifficulty('Grade 1', 'Easy', 'basic_addition'), true);
  assert.equal(isValidTopicIdForGradeDifficulty('Grade 1', 'Easy', 'addition'), false);
  assert.equal(isValidTopicIdForGradeDifficulty('Grade 1', 'Easy', 'basic-addition'), false);
  assert.equal(
    validateLearningMetadata({
      grade_level: 'grade1',
      difficulty: 'Medium',
      topic_id: 'addition',
    }),
    ''
  );
  assert.equal(
    validateLearningMetadata({
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      topic_id: 'addition',
    }),
    ''
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

test('lesson Question Count accepts only the supported AI generation totals', () => {
  assert.deepEqual(LESSON_QUESTION_COUNT_OPTIONS, [5, 10, 20, 25]);
  for (const count of LESSON_QUESTION_COUNT_OPTIONS) {
    assert.deepEqual(parseLessonQuestionCount(String(count)), { value: count, error: null });
  }
  assert.equal(MAX_LESSON_QUESTION_COUNT, 25);
  assert.equal(parseLessonQuestionCount('').error, 'Question Count is required for Lesson PDF or PPTX files.');
  assert.equal(parseLessonQuestionCount('0').error, 'Question Count must be one of: 5, 10, 20, 25.');
  assert.equal(parseLessonQuestionCount('6').error, 'Question Count must be one of: 5, 10, 20, 25.');
  assert.equal(parseLessonQuestionCount('2.5').error, 'Question Count must be one of: 5, 10, 20, 25.');
  assert.equal(parseLessonQuestionCount('50').error, 'Question Count must be one of: 5, 10, 20, 25.');
});
