import {
  filterLearningFiles,
  countFixedQuestionRecords,
  getLargestLearningFiles,
  getDifficultyLevels,
  getGradeLevels,
  formatLearningFileSize,
  getFolderContents,
  getMathTopicsForGrade,
  getMathTopicsForGradeDifficulty,
  getLearningFilePreviewKind,
  getQuestionFolderPath,
  getQuestionFolderView,
  inferLearningFileUploadType,
  isSupportedLearningUpload,
  normalizeDifficultyValue,
  normalizeMathTopicForGradeDifficulty,
  getQuestionFolderStructure,
} from './lessonQuestionManager.utils';
import { normalizeCurriculumRegistry } from '../curriculumRegistry';

const registryFixture = {
  grades: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  difficulties: ['Easy', 'Normal', 'Difficult'],
  topics: [
    ['basic_addition', 'Basic Addition'], ['subtraction', 'Subtraction'], ['shapes', 'Shapes'], ['place_value', 'Place Value'],
    ['addition', 'Addition'], ['multiplication', 'Multiplication'], ['word_problems', 'Word Problems'], ['division', 'Division'],
    ['fractions', 'Fractions'], ['problem_solving', 'Problem Solving'], ['addition_of_money', 'Addition of Money'], ['whole_numbers', 'Whole Numbers'],
    ['number_theory', 'Number Theory'], ['place_value_whole_numbers', 'Place Value of Whole Numbers'],
    ['compare_whole_numbers', 'Reading, Writing, and Comparing Whole Numbers'], ['basic_arithmetic', 'Basic Arithmetic'],
    ['time_conversion', 'Time Conversion'], ['order_of_operations', 'Order of Operations'], ['number_sense_operations', 'Number Sense and Operations'],
    ['rational_numbers', 'Rational Numbers'], ['geometric_measurements', 'Geometric Measurements'],
  ].map(([topic_id, display_label]) => ({ topic_id, display_label })),
  scopes: [
    { grade_level: 'Grade 1', difficulty: 'Easy', topic_ids: ['basic_addition', 'subtraction', 'shapes', 'place_value'] },
    { grade_level: 'Grade 1', difficulty: 'Normal', topic_ids: ['addition', 'multiplication', 'word_problems'] },
    { grade_level: 'Grade 2', difficulty: 'Difficult', topic_ids: ['problem_solving', 'multiplication', 'division', 'fractions'] },
    { grade_level: 'Grade 3', difficulty: 'Normal', topic_ids: ['multiplication', 'division', 'fractions'] },
    { grade_level: 'Grade 4', difficulty: 'Easy', topic_ids: ['number_theory'] },
    { grade_level: 'Grade 4', difficulty: 'Normal', topic_ids: ['place_value_whole_numbers'] },
    { grade_level: 'Grade 4', difficulty: 'Difficult', topic_ids: ['compare_whole_numbers'] },
    { grade_level: 'Grade 5', difficulty: 'Normal', topic_ids: ['number_theory', 'basic_arithmetic'] },
    { grade_level: 'Grade 5', difficulty: 'Difficult', topic_ids: ['time_conversion', 'number_theory', 'word_problems', 'order_of_operations'] },
    { grade_level: 'Grade 6', difficulty: 'Normal', topic_ids: ['number_sense_operations'] },
    { grade_level: 'Grade 6', difficulty: 'Difficult', topic_ids: ['rational_numbers', 'geometric_measurements'] },
  ],
};

describe('lesson question manager helpers', () => {
  test('returns configured difficulty values and grade difficulty topics', () => {
    expect(getDifficultyLevels(registryFixture)).toEqual(['Easy', 'Normal', 'Difficult']);
    expect(getMathTopicsForGradeDifficulty('Grade 1', 'Easy', registryFixture)).toEqual([
      'Basic Addition',
      'Subtraction',
      'Shapes',
      'Place Value',
    ]);
    expect(getMathTopicsForGradeDifficulty('Grade 2', 'Hard', registryFixture)).toEqual([
      'Problem Solving',
      'Multiplication',
      'Division',
      'Fractions',
    ]);
    expect(getMathTopicsForGradeDifficulty('Grade 3', 'Medium', registryFixture)).toEqual([
      'Multiplication',
      'Division',
      'Fractions',
    ]);
    expect(getMathTopicsForGradeDifficulty('Grade 5', 'Hard', registryFixture)).toEqual([
      'Time Conversion',
      'Number Theory',
      'Word Problems',
      'Order of Operations',
    ]);
    expect(getMathTopicsForGradeDifficulty('Grade 6', 'Hard', registryFixture)).toEqual([
      'Rational Numbers',
      'Geometric Measurements',
    ]);
    expect(getMathTopicsForGradeDifficulty('Grade 6', 'Average', registryFixture)).toEqual([
      'Number Sense and Operations',
    ]);
    expect(getMathTopicsForGradeDifficulty('Grade 6', 'Normal', registryFixture)).toEqual([
      'Number Sense and Operations',
    ]);
    expect(getMathTopicsForGradeDifficulty('Grade 5', 'Normal', registryFixture)).toEqual([
      'Number Theory',
      'Basic Arithmetic',
    ]);
  });

  test('normalizes legacy difficulty values to game folder labels', () => {
    expect(normalizeDifficultyValue('Easy')).toBe('Easy');
    expect(normalizeDifficultyValue('Medium')).toBe('Normal');
    expect(normalizeDifficultyValue('Normal')).toBe('Normal');
    expect(normalizeDifficultyValue('Normal / Average')).toBe('Normal');
    expect(normalizeDifficultyValue('Average')).toBe('Normal');
    expect(normalizeDifficultyValue('Difficult')).toBe('Difficult');
    expect(normalizeDifficultyValue('Hard')).toBe('Difficult');
  });

  test('keeps grade topic helpers constrained to approved map topics', () => {
    expect(getMathTopicsForGrade('Grade 4', registryFixture)).toEqual([
      'Number Theory',
      'Place Value of Whole Numbers',
      'Reading, Writing, and Comparing Whole Numbers',
    ]);
    expect(getMathTopicsForGrade('Grade 4', registryFixture)).not.toContain('Division');
  });

  test('resets topics when grade or difficulty changes', () => {
    expect(normalizeMathTopicForGradeDifficulty('Grade 1', '', 'Addition', registryFixture)).toBe('');
    expect(normalizeMathTopicForGradeDifficulty('Grade 1', 'Easy', 'Addition', registryFixture)).toBe(
      'Basic Addition'
    );
    expect(normalizeMathTopicForGradeDifficulty(
      'Grade 1',
      'Medium',
      'Addition',
      registryFixture
    )).toBe('Addition');
  });

  test('builds the fixed Questions grade difficulty folder structure', () => {
    expect(getGradeLevels(registryFixture)).toHaveLength(6);
    expect(getQuestionFolderStructure(registryFixture)[0]).toEqual({
      grade: 'Grade 1',
      folderName: 'Grade 1',
      godotFolderName: 'Grade1',
      difficulties: ['Easy', 'Normal', 'Difficult'],
    });
    expect(getQuestionFolderPath()).toBe('Questions/');
    expect(getQuestionFolderPath('Grade 1')).toBe('Questions/Grade 1/');
    expect(getQuestionFolderPath('Grade 1', 'Easy')).toBe('Questions/Grade 1/Easy');
    expect(getQuestionFolderPath('Grade 6', 'Hard')).toBe('Questions/Grade 6/Difficult');
  });

  test('uses registry display labels while retaining primitive folder scopes', () => {
    const registry = normalizeCurriculumRegistry({
      ...registryFixture,
      grades: [{ value: 'Grade 1', display_label: 'Grade 1', aliases: ['1'] }],
      difficulties: [{ value: 'Easy', display_label: 'Easy', aliases: [] }],
      scopes: [{ grade_level: 'Grade 1', difficulty: 'Easy', topic_ids: ['basic_addition'] }],
    });

    expect(getQuestionFolderStructure(registry)).toEqual([{
      grade: 'Grade 1',
      folderName: 'Grade 1',
      godotFolderName: 'Grade1',
      difficulties: ['Easy'],
    }]);
    expect(getQuestionFolderView([], {}, registry).childFolders).toEqual([expect.objectContaining({
      label: 'Grade 1',
      grade_level: 'Grade 1',
    })]);
    expect(getQuestionFolderView([], { grade_level: 'Grade 1' }, registry).childFolders).toEqual([
      expect.objectContaining({ label: 'Easy', grade_level: 'Grade 1', difficulty: 'Easy' }),
    ]);
  });

  test('returns fixed system folder filters and files for the selected path', () => {
    const files = [
      { id: 1, title: 'Easy Quiz', grade_level: 'Grade 1', difficulty: 'Easy' },
      { id: 2, title: 'Legacy Medium Quiz', grade_level: 'Grade 1', difficulty: 'Normal' },
      { id: 3, title: 'Hard Quiz', grade_level: 'Grade 2', difficulty: 'Difficult' },
    ];

    expect(getQuestionFolderView(files, {}, registryFixture)).toMatchObject({
      path: ['Questions'],
      childFolders: expect.arrayContaining([
        expect.objectContaining({ label: 'Grade 1', type: 'grade' }),
        expect.objectContaining({ label: 'Grade 6', type: 'grade' }),
      ]),
      files: [
        expect.objectContaining({ id: 1, difficulty: 'Easy' }),
        expect.objectContaining({ id: 2, difficulty: 'Normal' }),
        expect.objectContaining({ id: 3, difficulty: 'Difficult' }),
      ],
    });
    expect(getQuestionFolderView(files, { grade_level: 'Grade 1' }, registryFixture)).toMatchObject({
      path: ['Questions', 'Grade 1'],
      childFolders: expect.arrayContaining([
        expect.objectContaining({ label: 'Easy', difficulty: 'Easy' }),
        expect.objectContaining({ label: 'Normal', difficulty: 'Normal' }),
        expect.objectContaining({ label: 'Difficult', difficulty: 'Difficult' }),
      ]),
      files: [
        expect.objectContaining({ id: 1, difficulty: 'Easy' }),
        expect.objectContaining({ id: 2, difficulty: 'Normal' }),
      ],
    });
    expect(getQuestionFolderView(files, { grade_level: 'Grade 1', difficulty: 'Normal' }, registryFixture).files).toEqual([
      expect.objectContaining({ id: 2, difficulty: 'Normal' }),
    ]);
  });

  test('filters learning files by search, folder, grade, difficulty, topic, and file type', () => {
    const files = [
      {
        title: 'Addition Basics',
        file_name: 'add.pdf',
        folder_name: 'Grade 1 Folder',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        file_type: 'lesson',
      },
      {
        title: 'Number Theory Quiz',
        file_name: 'number-theory.csv',
        folder_name: 'Grade 4 Folder',
        grade_level: 'Grade 4',
        difficulty: 'Easy',
        math_topic: 'Number Theory',
        file_type: 'fixed_questions',
      },
      {
        title: 'Legacy Decimals Review',
        file_name: 'decimals.pdf',
        folder_name: 'Grade 6 Folder',
        grade_level: 'Grade 6',
        difficulty: 'Difficult',
        math_topic: 'Rational Numbers',
        file_type: 'lesson',
      },
    ];

    expect(filterLearningFiles(files, {
      search: 'number',
      folder: 'Questions/Grade 4/Easy',
      grade_level: 'Grade 4',
      difficulty: 'Easy',
      math_topic: 'Number Theory',
      file_type: 'fixed_questions',
    })).toEqual([expect.objectContaining({ ...files[1], folder_name: 'Questions/Grade 4/Easy' })]);

    expect(filterLearningFiles(files, {
      search: '',
      folder: 'Questions/Grade 6/Difficult',
      grade_level: 'Grade 6',
      difficulty: 'Difficult',
      math_topic: 'Rational Numbers',
      file_type: 'lesson',
    })).toEqual([expect.objectContaining({ ...files[2], difficulty: 'Difficult', folder_name: 'Questions/Grade 6/Difficult' })]);

    expect(filterLearningFiles(files, {
      search: '',
      folder: 'Questions/Grade 6/Difficult',
      grade_level: 'Grade 6',
      difficulty: 'Difficult',
      math_topic: '',
      file_type: 'lesson',
    })).toEqual([expect.objectContaining({ ...files[2], difficulty: 'Difficult', folder_name: 'Questions/Grade 6/Difficult' })]);
  });

  test('returns the uploaded files inside an opened folder', () => {
    const folder = { id: 12, name: 'Grade 2 Addition' };
    const files = [
      { id: 1, title: 'Inside by id', folder_id: 12, folder_name: 'Grade 2 Addition' },
      { id: 2, title: 'Inside by id as string', folder_id: '12', folder_name: 'Renamed Folder' },
      { id: 3, title: 'Outside', folder_id: 14, folder_name: 'Grade 4 Division' },
    ];

    expect(getFolderContents(files, folder)).toEqual([files[0], files[1]]);
  });

  test('falls back to folder name when file records do not expose folder ids', () => {
    const folder = { name: 'Grade 6 Decimals' };
    const files = [
      { id: 1, title: 'Inside', folder_name: 'Grade 6 Decimals' },
      { id: 2, title: 'Outside', folder_name: 'Unassigned' },
    ];

    expect(getFolderContents(files, folder)).toEqual([files[0]]);
  });

  test('infers upload type and formats learning file sizes for the drive table', () => {
    expect(inferLearningFileUploadType('lesson.pdf')).toBe('lesson');
    expect(inferLearningFileUploadType('lesson.pptx')).toBe('lesson');
    expect(inferLearningFileUploadType('quiz.csv')).toBe('fixed_questions');
    expect(inferLearningFileUploadType('quiz.json')).toBe('fixed_questions');
    expect(inferLearningFileUploadType('notes.txt')).toBe('');
    expect(isSupportedLearningUpload('set-a.docx', 'fixed_questions')).toBe(true);
    expect(isSupportedLearningUpload('set-a.pdf', 'fixed_questions')).toBe(true);
    expect(isSupportedLearningUpload('set-a.pdf', 'lesson')).toBe(true);
    expect(isSupportedLearningUpload('lesson.pptx', 'lesson')).toBe(true);
    expect(isSupportedLearningUpload('lesson.ppt', 'lesson')).toBe(false);
    expect(isSupportedLearningUpload('set-a.docx', 'lesson')).toBe(false);
    expect(formatLearningFileSize(1536)).toBe('1.5 KB');
    expect(formatLearningFileSize(1.3 * 1024 * 1024 * 1024)).toBe('1.3 GB');
    expect(formatLearningFileSize(null)).toBe('-');
  });

  test('chooses preview renderers for supported uploaded files', () => {
    expect(getLearningFilePreviewKind({ file_name: 'lesson.pdf' })).toBe('pdf');
    expect(getLearningFilePreviewKind({ file_url: '/uploads/poster.png' })).toBe('image');
    expect(getLearningFilePreviewKind({ title: 'questions', file_name: 'fixed.csv' })).toBe('text');
    expect(getLearningFilePreviewKind({ file_name: 'archive.zip' })).toBe('unsupported');
  });

  test('counts fixed question files for optional upload validation', () => {
    expect(countFixedQuestionRecords(JSON.stringify([
      { question: 'What is 1 + 1?', correct_answer: '2' },
      { question: 'What is 2 + 2?', answer: '4' },
      { question: '', correct_answer: 'skip' },
    ]), 'addition.json')).toBe(2);

    expect(countFixedQuestionRecords([
      'What is 3 + 3?,6,7,8',
      '',
      'What is 4 + 4?,8,9,10',
    ].join('\n'), 'addition.csv')).toBe(2);
  });

  test('returns the largest uploaded source files without assuming a storage quota', () => {
    const files = [
      { id: 1, title: 'Small', file_size: 512 },
      { id: 2, title: 'Largest', file_size: 4096 },
      { id: 3, title: 'Unknown', file_size: null },
    ];

    expect(getLargestLearningFiles(files, 2)).toEqual([files[1], files[0]]);
  });
});
