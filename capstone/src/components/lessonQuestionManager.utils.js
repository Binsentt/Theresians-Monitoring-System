import {
  DIFFICULTY_LEVELS,
  GRADE_LEVELS,
  GRADE_TOPIC_MAP,
} from '../config/gradeTopicMap';

export {
  DIFFICULTY_LEVELS,
  GRADE_LEVELS,
  GRADE_TOPIC_MAP,
};

export const QUESTION_FOLDER_STRUCTURE = GRADE_LEVELS.map((grade) => ({
  grade,
  folderName: grade,
  godotFolderName: grade.replace(/\s+/g, ''),
  difficulties: DIFFICULTY_LEVELS,
}));

export const getQuestionFolderPath = (gradeLevel, difficulty) => {
  const grade = normalizeLearningMetadataValue(gradeLevel);
  const level = normalizeDifficultyValue(difficulty);
  if (!grade) return 'Questions/';
  if (!level) return `Questions/${grade}/`;
  return `Questions/${grade}/${level}`;
};

export const MATH_TOPICS = Array.from(new Set(
  Object.values(GRADE_TOPIC_MAP).flatMap((difficultyMap) => Object.values(difficultyMap).flat())
));

const normalizeLearningMetadataValue = (value) => String(value || '').trim();

export const normalizeDifficultyValue = (value) => {
  const difficulty = normalizeLearningMetadataValue(value);
  if (/^(normal|average|medium|normal\s*\/\s*average)$/i.test(difficulty)) return 'Medium';
  if (/^(difficult|hard)$/i.test(difficulty)) return 'Hard';
  if (/^easy$/i.test(difficulty)) return 'Easy';
  return difficulty;
};

export const getMathTopicsForGradeDifficulty = (gradeLevel, difficulty) => {
  const grade = normalizeLearningMetadataValue(gradeLevel);
  const level = normalizeDifficultyValue(difficulty);
  return GRADE_TOPIC_MAP[grade]?.[level] || [];
};

export const getMathTopicsForGrade = (gradeLevel) => {
  const grade = normalizeLearningMetadataValue(gradeLevel);
  const difficultyMap = GRADE_TOPIC_MAP[grade];
  return difficultyMap ? Object.values(difficultyMap).flat() : [];
};

export const isValidGradeLevel = (value) => GRADE_LEVELS.includes(normalizeLearningMetadataValue(value));

export const isValidDifficulty = (value) => DIFFICULTY_LEVELS.includes(normalizeDifficultyValue(value));

export const isValidMathTopicForGradeDifficulty = (gradeLevel, difficulty, topic) => {
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return getMathTopicsForGradeDifficulty(gradeLevel, difficulty).includes(selectedTopic);
};

export const isValidMathTopicForGrade = (gradeLevel, topic) => {
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return getMathTopicsForGrade(gradeLevel).includes(selectedTopic);
};

export const normalizeMathTopicForGradeDifficulty = (gradeLevel, difficulty, topic) => {
  const options = getMathTopicsForGradeDifficulty(gradeLevel, difficulty);
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return options.includes(selectedTopic) ? selectedTopic : options[0] || '';
};

export const normalizeMathTopicForGrade = (gradeLevel, topic) => {
  const options = getMathTopicsForGrade(gradeLevel);
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return options.includes(selectedTopic) ? selectedTopic : options[0] || '';
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

export const normalizeLearningFileRecord = (file = {}) => ({
  ...file,
  difficulty: normalizeDifficultyValue(file.difficulty),
  folder_name: getQuestionFolderPath(file.grade_level, file.difficulty),
});

export const filterLearningFiles = (files, filters) => {
  const search = normalizeText(filters.search);
  const folder = normalizeText(filters.folder);
  const gradeLevel = normalizeLearningMetadataValue(filters.grade_level);
  const difficulty = normalizeDifficultyValue(filters.difficulty);
  const mathTopic = normalizeLearningMetadataValue(filters.math_topic);
  const fileType = normalizeLearningMetadataValue(filters.file_type);

  return files.map(normalizeLearningFileRecord).filter((file) => {
    const folderMatch = folder ? normalizeText(file.folder_name) === folder : true;
    const gradeMatch = gradeLevel ? file.grade_level === gradeLevel : true;
    const difficultyMatch = difficulty ? normalizeDifficultyValue(file.difficulty) === difficulty : true;
    const topicMatch = mathTopic ? file.math_topic === mathTopic : true;
    const typeMatch = fileType ? file.file_type === fileType : true;
    const searchMatch = search
      ? [
          file.title,
          file.file_name,
          file.math_topic,
          file.grade_level,
          file.difficulty,
          file.folder_name,
          file.file_type,
        ].join(' ').toLowerCase().includes(search)
      : true;

    return folderMatch && gradeMatch && difficultyMatch && topicMatch && typeMatch && searchMatch;
  });
};

export const getQuestionFolderView = (files, selection = {}) => {
  const gradeLevel = normalizeLearningMetadataValue(selection.grade_level);
  const difficulty = normalizeDifficultyValue(selection.difficulty);
  const path = ['Questions'];
  if (gradeLevel) path.push(gradeLevel);
  if (difficulty) path.push(difficulty);

  if (!gradeLevel) {
    return {
      path,
      childFolders: QUESTION_FOLDER_STRUCTURE.map((folder) => ({
        type: 'grade',
        label: folder.folderName,
        grade_level: folder.grade,
        godotFolderName: folder.godotFolderName,
      })),
      files: filterLearningFiles(files, {
        search: selection.search || '',
        folder: '',
        grade_level: '',
        difficulty: '',
        math_topic: selection.math_topic || '',
        file_type: selection.file_type || '',
      }),
    };
  }

  if (!difficulty) {
    const gradeFolder = QUESTION_FOLDER_STRUCTURE.find((folder) => folder.grade === gradeLevel);
    return {
      path,
      childFolders: (gradeFolder?.difficulties || DIFFICULTY_LEVELS).map((level) => ({
        type: 'difficulty',
        label: level,
        grade_level: gradeLevel,
        difficulty: level,
      })),
      files: filterLearningFiles(files, {
        search: selection.search || '',
        folder: '',
        grade_level: gradeLevel,
        difficulty: '',
        math_topic: selection.math_topic || '',
        file_type: selection.file_type || '',
      }),
    };
  }

  return {
    path,
    childFolders: [],
    files: filterLearningFiles(files, {
      search: selection.search || '',
      folder: '',
      grade_level: gradeLevel,
      difficulty,
      math_topic: selection.math_topic || '',
      file_type: selection.file_type || '',
    }),
  };
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
