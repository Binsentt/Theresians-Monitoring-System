const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_DIFFICULTIES,
  ALLOWED_MATH_TOPICS,
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
    'Topic must match the selected grade level and difficulty.'
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

test('lesson Question Count accepts only required bounded whole numbers', () => {
  assert.deepEqual(parseLessonQuestionCount('20'), { value: 20, error: null });
  assert.equal(parseLessonQuestionCount('').error, 'Question Count is required for Lesson PDF files.');
  assert.equal(parseLessonQuestionCount('0').error, 'Question Count must be a whole number between 1 and 50.');
  assert.equal(parseLessonQuestionCount('-1').error, 'Question Count must be a whole number between 1 and 50.');
  assert.equal(parseLessonQuestionCount('2.5').error, 'Question Count must be a whole number between 1 and 50.');
  assert.equal(parseLessonQuestionCount(String(MAX_LESSON_QUESTION_COUNT + 1)).error, 'Question Count must be a whole number between 1 and 50.');
});
