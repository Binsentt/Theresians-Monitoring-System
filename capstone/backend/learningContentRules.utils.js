const ALLOWED_GRADE_LEVELS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];
const ALLOWED_DIFFICULTIES = ['Easy', 'Normal', 'Difficult'];

const GRADE_TOPIC_MAP = {
  'Grade 1': {
    Easy: ['Basic Addition', 'Subtraction', 'Shapes', 'Place Value'],
    Normal: ['Addition', 'Multiplication', 'Word Problems'],
    Difficult: ['Problem Solving (Addition and Subtraction)'],
  },
  'Grade 2': {
    Easy: ['Shapes', 'Ordinal Numbers', 'Basic Addition/Subtraction'],
    Normal: ['Multiplication', 'Division', 'Word Problems'],
    Difficult: ['Problem Solving', 'Multiplication', 'Division', 'Fractions'],
  },
  'Grade 3': {
    Easy: ['Addition of Money', 'Whole Numbers'],
    Normal: ['Multiplication', 'Division', 'Fractions'],
    Difficult: ['Multi-step Problem Solving'],
  },
  'Grade 4': {
    Easy: ['Number Theory'],
    Normal: ['Place Value of Whole Numbers'],
    Difficult: ['Reading, Writing, and Comparing Whole Numbers'],
  },
  'Grade 5': {
    Easy: ['Number Theory', 'Basic Arithmetic'],
    Normal: ['Number Theory', 'Basic Arithmetic'],
    Difficult: ['Time Conversion', 'Number Theory', 'Word Problems', 'Order of Operations'],
  },
  'Grade 6': {
    Easy: ['Number Sense and Operations'],
    Normal: ['Number Sense and Operations'],
    Difficult: ['Rational Numbers', 'Geometric Measurements'],
  },
};

const ALLOWED_MATH_TOPICS = Array.from(new Set(
  Object.values(GRADE_TOPIC_MAP).flatMap((difficultyMap) => Object.values(difficultyMap).flat())
));

const normalizeLearningMetadataValue = (value) => String(value || '').trim();

const normalizeDifficultyValue = (value) => {
  const difficulty = normalizeLearningMetadataValue(value);
  if (/^(average|normal\s*\/\s*average)$/i.test(difficulty)) return 'Normal';
  return difficulty;
};

const getMathTopicsForGradeDifficulty = (gradeLevel, difficulty) => {
  const grade = normalizeLearningMetadataValue(gradeLevel);
  const level = normalizeDifficultyValue(difficulty);
  return GRADE_TOPIC_MAP[grade]?.[level] || [];
};

const getMathTopicsForGrade = (gradeLevel) => {
  const grade = normalizeLearningMetadataValue(gradeLevel);
  const difficultyMap = GRADE_TOPIC_MAP[grade];
  return difficultyMap ? Object.values(difficultyMap).flat() : [];
};

const isValidGradeLevel = (value) => ALLOWED_GRADE_LEVELS.includes(normalizeLearningMetadataValue(value));

const isValidDifficulty = (value) => ALLOWED_DIFFICULTIES.includes(normalizeDifficultyValue(value));

const isValidMathTopicForGradeDifficulty = (gradeLevel, difficulty, topic) => {
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return getMathTopicsForGradeDifficulty(gradeLevel, difficulty).includes(selectedTopic);
};

const isValidMathTopicForGrade = (gradeLevel, topic) => {
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return getMathTopicsForGrade(gradeLevel).includes(selectedTopic);
};

const validateLearningMetadata = ({ grade_level: gradeLevel, difficulty, math_topic: mathTopic } = {}) => {
  if (!isValidGradeLevel(gradeLevel)) {
    return 'Grade level must be one of Grade 1 through Grade 6.';
  }

  if (!isValidDifficulty(difficulty)) {
    return 'Difficulty must be Easy, Normal, or Difficult.';
  }

  if (!isValidMathTopicForGradeDifficulty(gradeLevel, difficulty, mathTopic)) {
    return 'Topic must match the selected grade level and difficulty.';
  }

  return '';
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
  ALLOWED_DIFFICULTIES,
  GRADE_TOPIC_MAP,
  ALLOWED_MATH_TOPICS,
  getMathTopicsForGrade,
  getMathTopicsForGradeDifficulty,
  isValidGradeLevel,
  isValidDifficulty,
  normalizeDifficultyValue,
  isValidMathTopicForGrade,
  isValidMathTopicForGradeDifficulty,
  validateLearningMetadata,
  parseExpectedQuestionCount,
  validateExpectedQuestionCount,
};
