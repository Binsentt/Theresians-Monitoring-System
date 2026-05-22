import {
  filterLearningFiles,
  calculateLearningStorage,
  countFixedQuestionRecords,
  getLargestLearningFiles,
  formatLearningFileSize,
  getFolderContents,
  getMathTopicsForGrade,
  getLearningFilePreviewKind,
  inferLearningFileUploadType,
  normalizeMathTopicForGrade,
} from './lessonQuestionManager.utils';

describe('lesson question manager helpers', () => {
  test('returns grade-specific math topics', () => {
    expect(getMathTopicsForGrade('Grade 1')).toEqual(['Addition', 'Subtraction']);
    expect(getMathTopicsForGrade('Grade 2')).toEqual(['Addition', 'Subtraction']);
    expect(getMathTopicsForGrade('Grade 4')).toEqual(['Multiplication', 'Division']);
    expect(getMathTopicsForGrade('Grade 6')).toEqual([
      'Multiplication',
      'Division',
      'Formulas',
      'Decimals',
      'Word Problem',
    ]);
  });

  test('resets invalid topics when the grade level changes', () => {
    expect(normalizeMathTopicForGrade('Grade 1', 'Multiplication')).toBe('Addition');
    expect(normalizeMathTopicForGrade('Grade 4', 'Division')).toBe('Division');
    expect(normalizeMathTopicForGrade('Grade 6', 'Addition')).toBe('Multiplication');
  });

  test('filters learning files by search, folder, grade, topic, and file type', () => {
    const files = [
      {
        title: 'Addition Basics',
        file_name: 'add.pdf',
        folder_name: 'Grade 1 Folder',
        grade_level: 'Grade 1',
        math_topic: 'Addition',
        file_type: 'lesson',
      },
      {
        title: 'Division Quiz',
        file_name: 'division.csv',
        folder_name: 'Grade 4 Folder',
        grade_level: 'Grade 4',
        math_topic: 'Division',
        file_type: 'fixed_questions',
      },
      {
        title: 'Decimals Review',
        file_name: 'decimals.pdf',
        folder_name: 'Grade 6 Folder',
        grade_level: 'Grade 6',
        math_topic: 'Decimals',
        file_type: 'lesson',
      },
    ];

    expect(filterLearningFiles(files, {
      search: 'division',
      folder: 'Grade 4 Folder',
      grade_level: 'Grade 4',
      math_topic: 'Division',
      file_type: 'fixed_questions',
    })).toEqual([files[1]]);

    expect(filterLearningFiles(files, {
      search: '',
      folder: 'Grade 6 Folder',
      grade_level: 'Grade 6',
      math_topic: 'Decimals',
      file_type: 'lesson',
    })).toEqual([files[2]]);
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
    expect(inferLearningFileUploadType('quiz.csv')).toBe('fixed_questions');
    expect(inferLearningFileUploadType('quiz.json')).toBe('fixed_questions');
    expect(inferLearningFileUploadType('notes.txt')).toBe('');
    expect(formatLearningFileSize(1536)).toBe('1.5 KB');
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

  test('summarizes drive storage and returns the largest files', () => {
    const files = [
      { id: 1, title: 'Small', file_size: 512 },
      { id: 2, title: 'Largest', file_size: 4096 },
      { id: 3, title: 'Unknown', file_size: null },
    ];

    expect(calculateLearningStorage(files)).toEqual({
      usedBytes: 4608,
      limitBytes: 10 * 1024 * 1024 * 1024,
      percentage: expect.any(Number),
    });
    expect(getLargestLearningFiles(files, 2)).toEqual([files[1], files[0]]);
  });
});
