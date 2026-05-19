export const GRADE_LEVELS = [
  'Grade 1',
  'Grade 2',
  'Grade 3',
  'Grade 4',
  'Grade 5',
  'Grade 6',
];

export const GRADE_TOPIC_MAP = {
  'Grade 1': ['Addition', 'Subtraction'],
  'Grade 2': ['Addition', 'Subtraction'],
  'Grade 3': ['Multiplication', 'Division'],
  'Grade 4': ['Multiplication', 'Division'],
  'Grade 5': ['Formulas', 'Decimals', 'Word Problems', 'Fractions', 'Geometry', 'Basic Algebra'],
  'Grade 6': ['Formulas', 'Decimals', 'Word Problems', 'Fractions', 'Geometry', 'Basic Algebra'],
};

export const MATH_TOPICS = Array.from(new Set(Object.values(GRADE_TOPIC_MAP).flat()));

export const getMathTopicsForGrade = (gradeLevel) => {
  return GRADE_TOPIC_MAP[String(gradeLevel || '').trim()] || MATH_TOPICS;
};

export const isValidGradeLevel = (value) => GRADE_LEVELS.includes(String(value || '').trim());

export const isValidMathTopicForGrade = (gradeLevel, topic) => {
  return getMathTopicsForGrade(gradeLevel).includes(String(topic || '').trim());
};

export const normalizeMathTopicForGrade = (gradeLevel, topic) => {
  const options = getMathTopicsForGrade(gradeLevel);
  const current = String(topic || '').trim();
  return options.includes(current) ? current : options[0];
};

const normalizeText = (value) => String(value || '').trim().toLowerCase();

export const filterLearningFiles = (files, filters) => {
  const search = normalizeText(filters.search);
  const folder = normalizeText(filters.folder);
  const gradeLevel = String(filters.grade_level || '').trim();
  const mathTopic = String(filters.math_topic || '').trim();
  const fileType = String(filters.file_type || '').trim();

  return files.filter((file) => {
    const folderMatch = folder ? normalizeText(file.folder_name) === folder : true;
    const gradeMatch = gradeLevel ? file.grade_level === gradeLevel : true;
    const topicMatch = mathTopic ? file.math_topic === mathTopic : true;
    const typeMatch = fileType ? file.file_type === fileType : true;
    const searchMatch = search
      ? [
          file.title,
          file.file_name,
          file.math_topic,
          file.grade_level,
          file.folder_name,
          file.file_type,
        ].join(' ').toLowerCase().includes(search)
      : true;

    return folderMatch && gradeMatch && topicMatch && typeMatch && searchMatch;
  });
};

export const getFolderContents = (files, folder) => {
  if (!folder) return [];
  const folderId = folder.id !== undefined && folder.id !== null ? String(folder.id) : '';
  const folderName = normalizeText(folder.name);

  return files.filter((file) => {
    if (folderId) {
      return String(file.folder_id || '') === folderId;
    }
    return folderName ? normalizeText(file.folder_name) === folderName : false;
  });
};
