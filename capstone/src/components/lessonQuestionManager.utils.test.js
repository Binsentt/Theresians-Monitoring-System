import {
  filterLearningFiles,
  formatLearningFileSize,
  getFolderContents,
  getMathTopicsForGrade,
  inferLearningFileUploadType,
  normalizeMathTopicForGrade,
} from './lessonQuestionManager.utils';

describe('lesson question manager helpers', () => {
  test('returns grade-specific math topics', () => {
    expect(getMathTopicsForGrade('Grade 1')).toEqual(['Addition', 'Subtraction']);
    expect(getMathTopicsForGrade('Grade 2')).toEqual(['Addition', 'Subtraction']);
    expect(getMathTopicsForGrade('Grade 3')).toEqual(['Multiplication', 'Division']);
    expect(getMathTopicsForGrade('Grade 4')).toEqual(['Multiplication', 'Division']);
    expect(getMathTopicsForGrade('Grade 5')).toEqual([
      'Formulas',
      'Decimals',
      'Word Problems',
      'Fractions',
      'Geometry',
      'Basic Algebra',
    ]);
    expect(getMathTopicsForGrade('Grade 6')).toEqual([
      'Formulas',
      'Decimals',
      'Word Problems',
      'Fractions',
      'Geometry',
      'Basic Algebra',
    ]);
  });

  test('resets invalid topics when the grade level changes', () => {
    expect(normalizeMathTopicForGrade('Grade 1', 'Multiplication')).toBe('Addition');
    expect(normalizeMathTopicForGrade('Grade 4', 'Division')).toBe('Division');
    expect(normalizeMathTopicForGrade('Grade 6', 'Addition')).toBe('Formulas');
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
});
