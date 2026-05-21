const ALLOWED_GRADE_LEVELS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];

const GRADE_TOPIC_MAP = {
  'Grade 1': ['Addition', 'Subtraction'],
  'Grade 2': ['Addition', 'Subtraction'],
  'Grade 3': ['Multiplication', 'Division'],
  'Grade 4': ['Multiplication', 'Division'],
  'Grade 5': ['Formulas', 'Decimals', 'Word Problems', 'Fractions', 'Geometry', 'Basic Algebra'],
  'Grade 6': ['Formulas', 'Decimals', 'Word Problems', 'Fractions', 'Geometry', 'Basic Algebra'],
};

const ALLOWED_MATH_TOPICS = Array.from(new Set(Object.values(GRADE_TOPIC_MAP).flat()));

const getMathTopicsForGrade = (gradeLevel) => {
  return GRADE_TOPIC_MAP[String(gradeLevel || '').trim()] || ALLOWED_MATH_TOPICS;
};

const isValidGradeLevel = (value) => ALLOWED_GRADE_LEVELS.includes(String(value || '').trim());

const isValidMathTopicForGrade = (gradeLevel, topic) => {
  return getMathTopicsForGrade(gradeLevel).includes(String(topic || '').trim());
};

const parseExpectedQuestionCount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : null;
};

const validateExpectedQuestionCount = (questions, expectedCount) => {
  const count = parseExpectedQuestionCount(expectedCount);
  if (!count) return null;
  const actualCount = Array.isArray(questions) ? questions.length : 0;
  if (actualCount === count) return null;
  return `Expected ${count} fixed questions, but the uploaded file contains ${actualCount}.`;
};

module.exports = {
  ALLOWED_GRADE_LEVELS,
  ALLOWED_MATH_TOPICS,
  getMathTopicsForGrade,
  isValidGradeLevel,
  isValidMathTopicForGrade,
  parseExpectedQuestionCount,
  validateExpectedQuestionCount,
};
