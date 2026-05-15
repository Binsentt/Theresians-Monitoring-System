const defaultSectionMap = {
  'Grade 1': ['Section A', 'Section B', 'Section C'],
  'Grade 2': ['Section A', 'Section B', 'Section C'],
  'Grade 3': ['Section A', 'Section B', 'Section C'],
  'Grade 4': ['Section A', 'Section B', 'Section C'],
  'Grade 5': ['Section A', 'Section B', 'Section C'],
  'Grade 6': ['Section A', 'Section B', 'Section C'],
};

const defaultSections = ['Section A', 'Section B', 'Section C'];

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const getDefaultSection = (grade, studentId) => {
  const letters = ['A', 'B', 'C'];
  const index = studentId ? studentId % letters.length : 0;
  return `Section ${letters[index]}`;
};

export const normalizeStudentProgressRow = (row = {}) => {
  const totalQuestions = toNumber(row.total_questions);
  const correctAnswers = toNumber(row.correct_answers);
  const fallbackIncorrectAnswers = Math.max(totalQuestions - correctAnswers, 0);

  return {
    ...row,
    section: row.section || getDefaultSection(row.grade_level, row.student_id),
    incorrect_answers: toNumber(row.incorrect_answers ?? fallbackIncorrectAnswers),
    performance_percentage: toNumber(
      row.performance_percentage ?? row.accuracy_rate ?? row.progress_percentage
    ),
    difficultyBreakdown: {
      easy: toNumber(row.difficultyBreakdown?.easy),
      medium: toNumber(row.difficultyBreakdown?.medium),
      hard: toNumber(row.difficultyBreakdown?.hard),
    },
  };
};

export const normalizeStudentProgressPayload = (payload) => {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  return rows.map((row) => normalizeStudentProgressRow(row));
};

export const getStudentProgressSectionOptions = (students, selectedGrade = '') => {
  const safeStudents = Array.isArray(students) ? students : [];
  const availableSections = Array.from(
    new Set(
      safeStudents
        .filter((student) => !selectedGrade || student.grade_level === selectedGrade)
        .map((student) => student.section || getDefaultSection(student.grade_level, student.student_id))
        .filter(Boolean)
    )
  ).sort();

  if (selectedGrade && availableSections.length === 0) {
    return defaultSectionMap[selectedGrade] || defaultSections;
  }

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
    const matchesSearch = normalizedQuery ? searchableName.includes(normalizedQuery) : true;

    return matchesGrade && matchesSection && matchesSearch;
  });
};
