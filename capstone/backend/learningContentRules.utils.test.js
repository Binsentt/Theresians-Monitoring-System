const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_MATH_TOPICS,
  getMathTopicsForGrade,
  isValidMathTopicForGrade,
  parseExpectedQuestionCount,
  validateExpectedQuestionCount,
} = require('./learningContentRules.utils');

test('maps math topics to the selected grade band', () => {
  assert.deepEqual(getMathTopicsForGrade('Grade 1-2'), ['Addition', 'Subtraction']);
  assert.deepEqual(getMathTopicsForGrade('Grade 3-4'), ['Multiplication', 'Division']);
  assert.deepEqual(getMathTopicsForGrade('Grade 5-6'), [
    'Multiplication',
    'Division',
    'Formulas',
    'Decimals',
    'Word Problem',
  ]);
});

test('validates math topics against the selected grade level', () => {
  assert.equal(isValidMathTopicForGrade('Grade 1-2', 'Addition'), true);
  assert.equal(isValidMathTopicForGrade('Grade 1-2', 'Measurement'), true);
  assert.equal(isValidMathTopicForGrade('Grade 3-4', 'Division'), true);
  assert.equal(isValidMathTopicForGrade('Grade 5-6', 'Formulas'), true);
  assert.equal(isValidMathTopicForGrade('Grade 5-6', ''), false);
  assert.equal(ALLOWED_MATH_TOPICS.includes('Formulas'), true);
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
