import { matchesTableSearch } from './tableReporting.utils';

const sceneDifficultyMap = {
  oak_leaf_village: 'Easy',
  city_of_knowledge: 'Normal',
  pinehill_village: 'Difficult',
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const clampPercent = (value, fallback = 0) => {
  const numericValue = toFiniteNumber(value, fallback);
  return Math.min(100, Math.max(0, numericValue));
};

export const formatPercent = (value, fallback = '--') => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(0)}%` : fallback;
};

export const safeDisplayText = (value, fallback = 'N/A') => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const candidate = value.message ?? value.text ?? value.label ?? value.name ?? value.title;
    return safeDisplayText(candidate, fallback);
  }
  return fallback;
};

export const normalizeDifficultyDisplay = (value, fallback = 'Unknown') => {
  const difficulty = safeDisplayText(value, '');
  if (/^(normal|average|medium|normal\s*\/\s*average)$/i.test(difficulty)) return 'Normal';
  if (/^(difficult|hard)$/i.test(difficulty)) return 'Difficult';
  if (/^easy$/i.test(difficulty)) return 'Easy';
  return difficulty || fallback;
};

export const normalizeDisplayList = (items) => {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => safeDisplayText(item, ''))
    .filter(Boolean);
};

const normalizeSceneKey = (value) => {
  const pathPart = String(value || '').trim().toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  return pathPart
    .replace(/\?.*$/, '')
    .replace(/\.tscn$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
};

export const resolveDifficultyFromScene = (row = {}) => {
  const candidates = [
    row.current_scene,
    row.currentScene,
    row.scene,
    row.scene_name,
    row.current_map,
    row.currentMap,
    row.map,
    row.map_name,
  ];

  for (const candidate of candidates) {
    const key = normalizeSceneKey(candidate);
    if (sceneDifficultyMap[key]) {
      return sceneDifficultyMap[key];
    }
  }

  return 'Unknown';
};

export const getTotalProgressNote = (metrics) => (
  metrics?.totalProgress === null && metrics?.totalProgressUnavailableReason === 'full_game_milestones_unverified'
    ? 'Progress unavailable: full-game milestones are not yet verified.'
    : ''
);

export const resolveCurrentDifficulty = (row = {}) => {
  if (row.metrics?.currentDifficulty !== undefined) {
    return normalizeDifficultyDisplay(row.metrics.currentDifficulty);
  }
  const recordedDifficulty = normalizeDifficultyDisplay(row.difficulty_level || row.difficulty);
  return ['Easy', 'Normal', 'Difficult'].includes(recordedDifficulty)
    ? recordedDifficulty
    : resolveDifficultyFromScene(row);
};

const toNullableNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return toFiniteNumber(value, null);
};

const getStudentDisplayName = (student = {}) => safeDisplayText(
  student.student_name || student.child_name || student.name,
  ''
).trim();

export const sortStudentsByName = (students) => {
  if (!Array.isArray(students)) return [];
  return students.slice().sort((left, right) => (
    getStudentDisplayName(left).localeCompare(getStudentDisplayName(right), undefined, {
      sensitivity: 'base',
      numeric: true,
    })
  ));
};

export const normalizeStudentProgressRow = (row = {}) => {
  const metricValue = (key, fallback) => row.metrics?.[key] !== undefined ? row.metrics[key] : fallback;
  const totalQuestions = toNullableNumber(metricValue('totalQuestions', row.total_questions));
  const correctAnswers = toNullableNumber(metricValue('correctAnswers', row.correct_answers));
  const hasAnswerTotals = totalQuestions !== null && correctAnswers !== null;
  const fallbackIncorrectAnswers = hasAnswerTotals ? Math.max(totalQuestions - correctAnswers, 0) : null;
  const incorrectAnswers = metricValue('incorrectAnswers', row.incorrect_answers);
  const accuracy = metricValue('accuracy', row.performance_percentage !== undefined ? row.performance_percentage : row.accuracy_rate);
  const difficultyBreakdown = metricValue('difficultyBreakdown', row.difficultyBreakdown);
  const difficultyLevel = resolveCurrentDifficulty(row);

  return {
    ...row,
    section: row.section || null,
    current_quest: metricValue('currentQuest', row.current_quest),
    total_questions: totalQuestions,
    correct_answers: correctAnswers,
    incorrect_answers: toNullableNumber(incorrectAnswers === undefined ? fallbackIncorrectAnswers : incorrectAnswers),
    performance_percentage: toNullableNumber(accuracy),
    difficultyBreakdown: {
      easy: toNullableNumber(difficultyBreakdown?.easy?.accuracy ?? difficultyBreakdown?.easy),
      medium: toNullableNumber(difficultyBreakdown?.medium?.accuracy ?? difficultyBreakdown?.medium),
      hard: toNullableNumber(difficultyBreakdown?.hard?.accuracy ?? difficultyBreakdown?.hard),
    },
    difficulty: difficultyLevel,
    difficulty_level: difficultyLevel,
  };
};

export const normalizeStudentProgressPayload = (payload) => {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  return sortStudentsByName(rows.map((row) => normalizeStudentProgressRow(row)));
};

export const getStudentProgressSectionOptions = (students, selectedGrade = '') => {
  const safeStudents = Array.isArray(students) ? students : [];
  const availableSections = Array.from(
    new Set(
      safeStudents
        .filter((student) => !selectedGrade || student.grade_level === selectedGrade)
        .map((student) => student.section)
        .filter(Boolean)
    )
  ).sort();

  return availableSections;
};

export const filterStudentProgress = (
  students,
  {
    searchQuery = '',
    selectedGrade = '',
    selectedSection = '',
  } = {}
) => {
  const safeStudents = Array.isArray(students) ? students : [];
  return safeStudents.filter((student) => {
    const matchesGrade = selectedGrade ? student.grade_level === selectedGrade : true;
    const matchesSection = selectedSection ? student.section === selectedSection : true;
    const matchesSearch = matchesTableSearch(student, searchQuery, [
      'student_name', 'game_student_id', 'grade_level', 'section', 'current_quest',
      'difficulty_level', 'difficulty', 'current_location', 'correct_answers',
      'incorrect_answers', 'performance_percentage',
    ]);

    return matchesGrade && matchesSection && matchesSearch;
  });
};

const studentProgressListStateKey = (role) => (
  `theresians.student-progress-list.${String(role || 'admin').trim().toLowerCase()}`
);

const defaultStudentProgressListState = () => ({
  searchQuery: '',
  page: 1,
  lifecycle: 'active',
  scrollTop: 0,
});

export const loadStudentProgressListState = (role) => {
  const fallback = defaultStudentProgressListState();
  try {
    const stored = globalThis.sessionStorage?.getItem(studentProgressListStateKey(role));
    if (!stored) return fallback;
    const parsed = JSON.parse(stored);
    return {
      searchQuery: String(parsed?.searchQuery || ''),
      page: Math.max(1, Number.parseInt(parsed?.page, 10) || 1),
      lifecycle: parsed?.lifecycle === 'archived' ? 'archived' : 'active',
      scrollTop: Math.max(0, Number(parsed?.scrollTop) || 0),
    };
  } catch {
    return fallback;
  }
};

export const saveStudentProgressListState = (role, state = {}) => {
  const safeState = {
    searchQuery: String(state.searchQuery || ''),
    page: Math.max(1, Number.parseInt(state.page, 10) || 1),
    lifecycle: state.lifecycle === 'archived' ? 'archived' : 'active',
    scrollTop: Math.max(0, Number(state.scrollTop) || 0),
  };
  try {
    globalThis.sessionStorage?.setItem(studentProgressListStateKey(role), JSON.stringify(safeState));
  } catch {
    // List navigation must remain usable when storage is unavailable.
  }
  return safeState;
};
