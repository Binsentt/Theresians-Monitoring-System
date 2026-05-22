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
  'Grade 5': ['Multiplication', 'Division', 'Formulas', 'Decimals', 'Word Problem'],
  'Grade 6': ['Multiplication', 'Division', 'Formulas', 'Decimals', 'Word Problem'],
};

export const MATH_TOPICS = Array.from(new Set(Object.values(GRADE_TOPIC_MAP).flat()));

export const getMathTopicsForGrade = (gradeLevel) => {
  return GRADE_TOPIC_MAP[String(gradeLevel || '').trim()] || MATH_TOPICS;
};

export const isValidGradeLevel = (value) => GRADE_LEVELS.includes(String(value || '').trim());

export const isValidMathTopicForGrade = (gradeLevel, topic) => {
  return isValidGradeLevel(gradeLevel) && Boolean(String(topic || '').trim());
};

export const normalizeMathTopicForGrade = (gradeLevel, topic) => {
  const options = getMathTopicsForGrade(gradeLevel);
  const current = String(topic || '').trim();
  if (current && !MATH_TOPICS.includes(current)) return current;
  return options.includes(current) ? current : options[0];
};

export const inferLearningFileUploadType = (fileName) => {
  const normalizedName = String(fileName || '').trim().toLowerCase();
  if (normalizedName.endsWith('.pdf')) return 'lesson';
  if (normalizedName.endsWith('.json') || normalizedName.endsWith('.csv')) return 'fixed_questions';
  return '';
};

export const formatLearningFileSize = (value) => {
  if (value === undefined || value === null || value === '') return '-';
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const normalizeStorageSize = (value) => {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : 0;
};

const countFixedQuestionJson = (content) => {
  const payload = JSON.parse(content);
  if (!Array.isArray(payload)) return 0;
  return payload.filter((item) => {
    const question = String(item?.question || '').trim();
    const answer = String(item?.correct_answer || item?.answer || '').trim();
    return question && answer;
  }).length;
};

const countFixedQuestionCsv = (content) => {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const [question, answer] = line.split(',').map((cell) => String(cell || '').trim());
      return Boolean(question && answer);
    }).length;
};

export const countFixedQuestionRecords = (content, fileName) => {
  const normalizedName = String(fileName || '').trim().toLowerCase();
  if (normalizedName.endsWith('.json')) return countFixedQuestionJson(content);
  if (normalizedName.endsWith('.csv')) return countFixedQuestionCsv(content);
  return 0;
};

export const calculateLearningStorage = (files, limitBytes = 10 * 1024 * 1024 * 1024) => {
  const list = Array.isArray(files) ? files : [];
  const usedBytes = list.reduce((total, file) => total + normalizeStorageSize(file?.file_size), 0);
  return {
    usedBytes,
    limitBytes,
    percentage: limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0,
  };
};

export const getLargestLearningFiles = (files, limit = 5) => {
  return [...(Array.isArray(files) ? files : [])]
    .sort((left, right) => normalizeStorageSize(right?.file_size) - normalizeStorageSize(left?.file_size))
    .slice(0, limit);
};

const getLearningFilePath = (file) => {
  return [file?.file_name, file?.file_url, file?.title]
    .map((value) => String(value || '').trim().toLowerCase())
    .find(Boolean) || '';
};

export const getLearningFilePreviewKind = (file) => {
  const path = getLearningFilePath(file);
  if (path.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(path)) return 'image';
  if (/\.(json|csv)$/.test(path)) return 'text';
  return 'unsupported';
};

export const formatLearningPreviewText = (content, file) => {
  const value = String(content || '');
  const path = getLearningFilePath(file);
  if (!path.endsWith('.json')) return value;

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch (error) {
    return value;
  }
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
