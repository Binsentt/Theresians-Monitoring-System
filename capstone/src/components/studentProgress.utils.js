const sceneDifficultyMap = {
  oak_leaf_village: 'Easy',
  city_of_knowledge: 'Medium',
  pinehill_village: 'Hard',
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
  const totalQuestions = Number(row.total_questions);
  const correctAnswers = Number(row.correct_answers);
  const hasAnswerTotals = Number.isFinite(totalQuestions) && Number.isFinite(correctAnswers);
  const fallbackIncorrectAnswers = hasAnswerTotals ? Math.max(totalQuestions - correctAnswers, 0) : null;
  const difficultyLevel = resolveDifficultyFromScene(row);

  return {
    ...row,
    section: row.section || null,
    incorrect_answers: toFiniteNumber(row.incorrect_answers ?? fallbackIncorrectAnswers, null),
    performance_percentage: toFiniteNumber(row.performance_percentage ?? row.accuracy_rate, null),
    difficultyBreakdown: {
      easy: toFiniteNumber(row.difficultyBreakdown?.easy?.accuracy ?? row.difficultyBreakdown?.easy, null),
      medium: toFiniteNumber(row.difficultyBreakdown?.medium?.accuracy ?? row.difficultyBreakdown?.medium, null),
      hard: toFiniteNumber(row.difficultyBreakdown?.hard?.accuracy ?? row.difficultyBreakdown?.hard, null),
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
  const normalizedQuery = String(searchQuery || '').trim().toLowerCase();

  return safeStudents.filter((student) => {
    const matchesGrade = selectedGrade ? student.grade_level === selectedGrade : true;
    const matchesSection = selectedSection ? student.section === selectedSection : true;
    const searchableName = String(student?.student_name || '').toLowerCase();
    const gameStudentId = String(student?.game_student_id || '').trim().toLowerCase();
    const matchesSearch = normalizedQuery
      ? searchableName.includes(normalizedQuery) || gameStudentId === normalizedQuery
      : true;

    return matchesGrade && matchesSection && matchesSearch;
  });
};
