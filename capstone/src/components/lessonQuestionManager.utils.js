import { getRegistryScopeTopics } from '../curriculumRegistry';

const normalizeRegistryDimension = (entry) => {
  if (typeof entry === 'string') {
    const value = entry.trim();
    return value ? { value, displayLabel: value } : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const value = typeof entry.value === 'string' ? entry.value.trim() : '';
  const displayLabel = typeof entry.display_label === 'string' ? entry.display_label.trim() : value;
  return value && displayLabel ? { value, displayLabel } : null;
};

const getRegistryDimensionOptions = (registry, key) => (
  Array.isArray(registry?.[key])
    ? registry[key].map(normalizeRegistryDimension).filter(Boolean)
    : []
);

export const getQuestionFolderPath = (gradeLevel, difficulty) => {
  const grade = normalizeLearningMetadataValue(gradeLevel);
  const level = normalizeDifficultyValue(difficulty);
  if (!grade) return 'Questions/';
  if (!level) return `Questions/${grade}/`;
  return `Questions/${grade}/${level}`;
};

const normalizeLearningMetadataValue = (value) => String(value || '').trim();

export const normalizeDifficultyValue = (value) => {
  const difficulty = normalizeLearningMetadataValue(value);
  if (/^(normal|average|medium|normal\s*\/\s*average)$/i.test(difficulty)) return 'Normal';
  if (/^(difficult|hard)$/i.test(difficulty)) return 'Difficult';
  if (/^easy$/i.test(difficulty)) return 'Easy';
  return difficulty;
};

export const getGradeLevels = (registry) => getRegistryDimensionOptions(registry, 'grades').map((entry) => entry.value);

export const getDifficultyLevels = (registry) => getRegistryDimensionOptions(registry, 'difficulties').map((entry) => entry.value);

export const getQuestionFolderStructure = (registry) => getRegistryDimensionOptions(registry, 'grades').map((grade) => ({
  grade: grade.value,
  folderName: grade.displayLabel,
  godotFolderName: grade.value.replace(/\s+/g, ''),
  difficulties: getDifficultyLevels(registry),
}));

export const getMathTopicsForGradeDifficulty = (gradeLevel, difficulty, registry) => {
  const grade = normalizeLearningMetadataValue(gradeLevel);
  const level = normalizeDifficultyValue(difficulty);
  return getRegistryScopeTopics(registry, grade, level).map((topic) => topic.display_label);
};

export const getMathTopicsForGrade = (gradeLevel, registry) => {
  const grade = normalizeLearningMetadataValue(gradeLevel);
  return Array.from(new Set(getDifficultyLevels(registry)
    .flatMap((difficulty) => getMathTopicsForGradeDifficulty(grade, difficulty, registry))));
};

export const isValidGradeLevel = (value, registry) => getGradeLevels(registry).includes(normalizeLearningMetadataValue(value));

export const isValidDifficulty = (value, registry) => getDifficultyLevels(registry).includes(normalizeDifficultyValue(value));

export const isValidMathTopicForGradeDifficulty = (gradeLevel, difficulty, topic, registry) => {
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return getMathTopicsForGradeDifficulty(gradeLevel, difficulty, registry).includes(selectedTopic);
};

export const isValidMathTopicForGrade = (gradeLevel, topic, registry) => {
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return getMathTopicsForGrade(gradeLevel, registry).includes(selectedTopic);
};

export const normalizeMathTopicForGradeDifficulty = (gradeLevel, difficulty, topic, registry) => {
  const options = getMathTopicsForGradeDifficulty(gradeLevel, difficulty, registry);
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return options.includes(selectedTopic) ? selectedTopic : options[0] || '';
};

export const normalizeMathTopicForGrade = (gradeLevel, topic, registry) => {
  const options = getMathTopicsForGrade(gradeLevel, registry);
  const selectedTopic = normalizeLearningMetadataValue(topic);
  return options.includes(selectedTopic) ? selectedTopic : options[0] || '';
};

export const inferLearningFileUploadType = (fileName) => {
  const normalizedName = String(fileName || '').trim().toLowerCase();
  if (normalizedName.endsWith('.pdf')) return 'lesson';
  if (normalizedName.endsWith('.json') || normalizedName.endsWith('.csv')) return 'fixed_questions';
  return '';
};

export const isSupportedLearningUpload = (fileName, fileType) => {
  const normalizedName = String(fileName || '').trim().toLowerCase();
  const normalizedType = String(fileType || '').trim().toLowerCase();
  if (normalizedType === 'lesson') return normalizedName.endsWith('.pdf');
  if (normalizedType === 'fixed_questions') {
    return /\.(docx|pdf|json|csv)$/.test(normalizedName);
  }
  return false;
};

export const formatLearningFileSize = (value) => {
  if (value === undefined || value === null || value === '') return '-';
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

export const getQuestionFolderView = (files, selection = {}, registry) => {
  const gradeLevel = normalizeLearningMetadataValue(selection.grade_level);
  const difficulty = normalizeDifficultyValue(selection.difficulty);
  const questionFolderStructure = getQuestionFolderStructure(registry);
  const path = ['Questions'];
  if (gradeLevel) path.push(gradeLevel);
  if (difficulty) path.push(difficulty);

  if (!gradeLevel) {
    return {
      path,
      childFolders: questionFolderStructure.map((folder) => ({
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
    return {
      path,
      childFolders: getRegistryDimensionOptions(registry, 'difficulties').map((level) => ({
        type: 'difficulty',
        label: level.displayLabel,
        grade_level: gradeLevel,
        difficulty: level.value,
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
