const {
  CANONICAL_DIFFICULTIES,
  CANONICAL_GRADES,
  TOPICS,
  getTopicById,
  getTopicsForScope,
  isValidScope,
  normalizeDifficulty,
  normalizeGradeLevel,
  normalizeTopicId,
  resolveLegacyDisplayTopic,
} = require('./curriculumScopeRegistry');

const ALLOWED_GRADE_LEVELS = CANONICAL_GRADES;
const ALLOWED_DIFFICULTIES = CANONICAL_DIFFICULTIES;
const MIN_LESSON_QUESTION_COUNT = 1;
const MAX_LESSON_QUESTION_COUNT = 50;

const ALLOWED_MATH_TOPICS = TOPICS.map((topic) => topic.display_label);

const normalizeLearningMetadataValue = (value) => String(value || '').trim();

const normalizeDifficultyValue = (value) => {
  const difficulty = normalizeLearningMetadataValue(value);
  return normalizeDifficulty(difficulty) || difficulty;
};

const getMathTopicsForGradeDifficulty = (gradeLevel, difficulty) => {
  return getTopicsForScope(gradeLevel, difficulty).map((topic) => topic.display_label);
};

const getTopicIdsForGradeDifficulty = (gradeLevel, difficulty) => {
  return getTopicsForScope(gradeLevel, difficulty).map((topic) => topic.topic_id);
};

const getMathTopicsForGrade = (gradeLevel) => {
  return ALLOWED_DIFFICULTIES.flatMap((difficulty) => getMathTopicsForGradeDifficulty(gradeLevel, difficulty));
};

const isValidGradeLevel = (value) => Boolean(normalizeGradeLevel(value));

const isValidDifficulty = (value) => Boolean(normalizeDifficulty(value));

// Topic is historical/source metadata.  The active question-pool identity is
// deliberately limited to these two canonical values.
const resolveQuestionPoolScope = ({ grade_level: gradeLevel, grade, difficulty } = {}) => {
  const canonicalGrade = normalizeGradeLevel(gradeLevel || grade);
  const canonicalDifficulty = normalizeDifficulty(difficulty);
  return canonicalGrade && canonicalDifficulty
    ? { grade_level: canonicalGrade, difficulty: canonicalDifficulty }
    : null;
};

const isValidTopicIdForGradeDifficulty = (gradeLevel, difficulty, topicId) => {
  return isValidScope(gradeLevel, difficulty, topicId);
};

const isValidMathTopicForGradeDifficulty = (gradeLevel, difficulty, topic) => {
  return Boolean(resolveLegacyDisplayTopic(gradeLevel, difficulty, topic));
};

const isValidMathTopicForGrade = (gradeLevel, topic) => {
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return getMathTopicsForGrade(gradeLevel).includes(selectedTopic);
};

const validateLearningMetadata = ({ grade_level: gradeLevel, difficulty } = {}) => {
  if (!isValidGradeLevel(gradeLevel)) {
    return 'Grade level must be one of Grade 1 through Grade 6.';
  }

  if (!isValidDifficulty(difficulty)) {
    return 'Difficulty must be Easy, Normal, or Difficult.';
  }

  return '';
};

const parseExpectedQuestionCount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : null;
};

const parseLessonQuestionCount = (value) => {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return { value: null, error: 'Question Count is required for Lesson PDF files.' };
  }
  if (!/^\d+$/.test(rawValue)) {
    return { value: null, error: `Question Count must be a whole number between ${MIN_LESSON_QUESTION_COUNT} and ${MAX_LESSON_QUESTION_COUNT}.` };
  }
  const count = Number(rawValue);
  if (count < MIN_LESSON_QUESTION_COUNT || count > MAX_LESSON_QUESTION_COUNT) {
    return { value: null, error: `Question Count must be a whole number between ${MIN_LESSON_QUESTION_COUNT} and ${MAX_LESSON_QUESTION_COUNT}.` };
  }
  return { value: count, error: null };
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
  MIN_LESSON_QUESTION_COUNT,
  MAX_LESSON_QUESTION_COUNT,
  ALLOWED_MATH_TOPICS,
  getMathTopicsForGrade,
  getMathTopicsForGradeDifficulty,
  getTopicIdsForGradeDifficulty,
  getTopicById,
  isValidGradeLevel,
  isValidDifficulty,
  resolveQuestionPoolScope,
  normalizeGradeLevel,
  normalizeDifficultyValue,
  isValidMathTopicForGrade,
  isValidMathTopicForGradeDifficulty,
  isValidTopicIdForGradeDifficulty,
  validateLearningMetadata,
  parseExpectedQuestionCount,
  parseLessonQuestionCount,
  validateExpectedQuestionCount,
};
