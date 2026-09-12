const normalizeParentCode = (value) => {
  const code = String(value || '').trim();
  return /^\d{6}$/.test(code) ? code : null;
};

const normalizeStudentId = (value) => {
  const code = String(value ?? '').trim();
  if (/^\d{2}-\d{6}$/.test(code)) return code.replace('-', '');
  if (/^\d{8}$/.test(code) || /^\d{6}$/.test(code)) return code;
  return null;
};

const normalizeNewStudentCode = (value) => {
  const code = normalizeStudentId(value);
  return code && /^\d{8}$/.test(code) ? code : null;
};

const normalizeExistingStudentCode = (value) => normalizeStudentId(value);

const formatStudentId = (value) => {
  const code = normalizeStudentId(value);
  return code && code.length === 8 ? `${code.slice(0, 2)}-${code.slice(2)}` : code;
};

const getNextCanonicalStudentId = (rows = []) => {
  const validCodes = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeNewStudentCode(row?.game_student_id ?? row))
    .filter(Boolean);
  if (validCodes.length === 0) return null;
  const highest = Math.max(...validCodes.map((code) => Number(code)));
  if (!Number.isSafeInteger(highest) || highest >= 99999999) {
    throw new Error('The Student ID sequence has reached its maximum value.');
  }
  return String(highest + 1).padStart(8, '0');
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
  normalizeStudentId,
  formatStudentId,
  getNextCanonicalStudentId,
  normalizeNewStudentCode,
  normalizeExistingStudentCode,
  normalizeGameStudentName,
  buildGameStudentEmail,
  toNullableNumber,
  resolveProgressPercentage,
  resolveAccuracyRate,
};
