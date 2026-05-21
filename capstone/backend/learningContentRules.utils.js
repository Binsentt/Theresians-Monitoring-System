const ALLOWED_GRADE_LEVELS = ['Grade 1-2', 'Grade 3-4', 'Grade 5-6'];

const GRADE_TOPIC_MAP = {
  'Grade 1-2': ['Addition', 'Subtraction'],
  'Grade 3-4': ['Multiplication', 'Division'],
  'Grade 5-6': ['Multiplication', 'Division', 'Formulas', 'Decimals', 'Word Problem'],
};

const ALLOWED_MATH_TOPICS = Array.from(new Set(Object.values(GRADE_TOPIC_MAP).flat()));

const getMathTopicsForGrade = (gradeLevel) => {
  return GRADE_TOPIC_MAP[String(gradeLevel || '').trim()] || ALLOWED_MATH_TOPICS;
};

const isValidGradeLevel = (value) => ALLOWED_GRADE_LEVELS.includes(String(value || '').trim());

const isValidMathTopicForGrade = (gradeLevel, topic) => {
  return isValidGradeLevel(gradeLevel) && Boolean(String(topic || '').trim());
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
  return `File contains ${actualCount} questions but you specified ${count}. Please check your file.`;
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
