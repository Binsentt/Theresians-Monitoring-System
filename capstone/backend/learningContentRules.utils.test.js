const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_MATH_TOPICS,
  getMathTopicsForGrade,
  isValidMathTopicForGrade,
} = require('./learningContentRules.utils');

test('maps math topics to the selected grade band', () => {
  assert.deepEqual(getMathTopicsForGrade('Grade 1'), ['Addition', 'Subtraction']);
  assert.deepEqual(getMathTopicsForGrade('Grade 3'), ['Multiplication', 'Division']);
  assert.deepEqual(getMathTopicsForGrade('Grade 6'), [
    'Formulas',
    'Decimals',
    'Word Problems',
    'Fractions',
    'Geometry',
    'Basic Algebra',
  ]);
});

test('validates math topics against the selected grade level', () => {
  assert.equal(isValidMathTopicForGrade('Grade 1', 'Addition'), true);
  assert.equal(isValidMathTopicForGrade('Grade 1', 'Multiplication'), false);
  assert.equal(isValidMathTopicForGrade('Grade 4', 'Division'), true);
  assert.equal(isValidMathTopicForGrade('Grade 5', 'Formulas'), true);
  assert.equal(ALLOWED_MATH_TOPICS.includes('Formulas'), true);
});
