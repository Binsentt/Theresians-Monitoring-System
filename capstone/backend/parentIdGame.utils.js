const normalizeParentCode = (value) => {
  const code = String(value || '').trim();
  return /^\d{6}$/.test(code) ? code : null;
};

const normalizeNewStudentCode = (value) => {
  const code = String(value ?? '');
  return /^[0-9]{8}$/.test(code) ? code : null;
};

const normalizeExistingStudentCode = (value) => {
  const code = String(value ?? '');
  return /^[0-9]{6}$/.test(code) || /^[0-9]{8}$/.test(code) ? code : null;
};

const normalizeGameStudentName = (value) =>
  String(value || '').trim().replace(/\s+/g, ' ');

const buildGameStudentEmail = (parentAccountId, studentName) => {
  const slug = normalizeGameStudentName(studentName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'player';

  return `game-student+${parentAccountId}-${slug}@theresian.local`;
};

const toNullableNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const clampPercentage = (value) => {
  const number = toNullableNumber(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
};

const resolveProgressPercentage = (payload = {}) => {
  const progressPercentage = clampPercentage(payload.progress_percentage);
  if (progressPercentage !== null) return progressPercentage;

  const completionPercentage = clampPercentage(payload.completion_percentage);
  if (completionPercentage !== null) return completionPercentage;

  const lessonProgress = clampPercentage(payload.lesson_progress);
  if (lessonProgress !== null) return lessonProgress;

  const questProgress = clampPercentage(payload.quest_progress);
  if (questProgress !== null) return questProgress;

  return 0;
};

const resolveAccuracyRate = (payload = {}) => {
  const explicitAccuracy = clampPercentage(payload.accuracy_rate);
  if (explicitAccuracy !== null) return explicitAccuracy;

  const correctAnswers = toNullableNumber(payload.correct_answers);
  const totalQuestions = toNullableNumber(payload.total_questions);
  if (correctAnswers === null || !totalQuestions) return 0;

  return Math.min(100, Math.max(0, (correctAnswers / totalQuestions) * 100));
};

module.exports = {
  normalizeParentCode,
  normalizeNewStudentCode,
  normalizeExistingStudentCode,
  normalizeGameStudentName,
  buildGameStudentEmail,
  toNullableNumber,
  resolveProgressPercentage,
  resolveAccuracyRate,
};
