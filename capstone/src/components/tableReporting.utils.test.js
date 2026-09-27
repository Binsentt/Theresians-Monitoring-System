import {
  collectAuthorizedReportRows,
  formatReportContext,
  matchesTableSearch,
  paginateTableRows,
  formatTableRange,
} from './tableReporting.utils';

describe('table reporting utilities', () => {
  const rows = [
    { student_name: 'Ana Reyes', game_student_id: '001234', grade_level: 'Grade 1' },
    { student_name: 'Ben Cruz', game_student_id: '100001', grade_level: 'Grade 2' },
    { student_name: 'Cara Santos', game_student_id: '100002', grade_level: 'Grade 2' },
  ];

  test('searches visible fields case-insensitively without coercing a leading-zero Student ID', () => {
    expect(matchesTableSearch(rows[0], '001234', ['student_name', 'game_student_id'])).toBe(true);
    expect(matchesTableSearch(rows[0], 'ana', ['student_name', 'game_student_id'])).toBe(true);
    expect(matchesTableSearch(rows[0], '1234', ['student_name', 'game_student_id'])).toBe(false);
  });

  test('filters school ID columns by safe leading prefixes without dropping leading-zero identity', () => {
    expect(matchesTableSearch(rows[0], '001', ['student_name', 'game_student_id'])).toBe(true);
    expect(matchesTableSearch(rows[0], '1234', ['student_name', 'game_student_id'])).toBe(false);

    const dashed = { student_name: 'Dana Cruz', game_student_id: '17-000087' };
    expect(matchesTableSearch(dashed, '17-0', ['student_name', 'game_student_id'])).toBe(true);
    expect(matchesTableSearch(dashed, '1700', ['student_name', 'game_student_id'])).toBe(true);
  });

  test('matches normalized multi-term searches across different displayed fields', () => {
    expect(matchesTableSearch(rows[0], '  ANA   Grade 1  ', ['student_name', 'game_student_id', 'grade_level'])).toBe(true);
    expect(matchesTableSearch(rows[0], 'Grade 1 001234', ['student_name', 'game_student_id', 'grade_level'])).toBe(true);
    expect(matchesTableSearch(rows[0], 'Ana Grade 2', ['student_name', 'game_student_id', 'grade_level'])).toBe(false);
  });

  test('treats explicit Grade and Difficulty phrases as field filters instead of loose row terms', () => {
    const gradeOneWithUnrelatedTwo = {
      student_name: 'Easy Santos 2',
      game_student_id: '20000001',
      grade_level: 'Grade 1',
      difficulty_level: 'Normal',
      game_score: 2,
    };
    const gradeTwoEasy = {
      student_name: 'Ana Reyes',
      game_student_id: '20000002',
      grade_level: 'Grade 2',
      difficulty_level: 'Easy',
      game_score: 0,
    };
    const fields = ['student_name', 'game_student_id', 'grade_level', 'difficulty_level', 'game_score'];

    expect(matchesTableSearch(gradeOneWithUnrelatedTwo, 'Grade 2', fields)).toBe(false);
    expect(matchesTableSearch(gradeTwoEasy, '  GRADE   2 ', fields)).toBe(true);
    expect(matchesTableSearch(gradeOneWithUnrelatedTwo, 'difficulty Easy', fields)).toBe(false);
    expect(matchesTableSearch(gradeTwoEasy, 'difficulty Easy', fields)).toBe(true);
  });

  test('matches dashed and plain canonical eight-digit Student IDs as one exact identity', () => {
    const row = { student_name: 'Ana Reyes', game_student_id: '17-000087' };

    expect(matchesTableSearch(row, '17000087', ['student_name', 'game_student_id'])).toBe(true);
    expect(matchesTableSearch(row, '17-000087', ['student_name', 'game_student_id'])).toBe(true);
    expect(matchesTableSearch(row, '000087', ['student_name', 'game_student_id'])).toBe(false);
  });

  test('paginates the already filtered rows and clamps an invalid page', () => {
    expect(paginateTableRows(rows, 3, 2)).toEqual({
      rows: [rows[2]],
      currentPage: 2,
      totalPages: 2,
      totalItems: 3,
      start: 3,
      end: 3,
    });
  });

  test('paginates only the complete filtered Grade result across multiple pages', () => {
    const gradeOne = Array.from({ length: 10 }, (_, index) => ({
      student_name: `Grade One ${index}`,
      game_student_id: String(10000000 + index),
      grade_level: 'Grade 1',
    }));
    const gradeTwo = Array.from({ length: 23 }, (_, index) => ({
      student_name: `Grade Two ${index}`,
      game_student_id: String(20000000 + index),
      grade_level: 'Grade 2',
    }));
    const filtered = [...gradeOne, ...gradeTwo].filter((row) => (
      matchesTableSearch(row, 'Grade 2', ['student_name', 'game_student_id', 'grade_level'])
    ));
    const firstPage = paginateTableRows(filtered, 1, 10);
    const lastPage = paginateTableRows(filtered, 3, 10);

    expect(firstPage.totalItems).toBe(23);
    expect(firstPage.totalPages).toBe(3);
    expect(firstPage.rows).toHaveLength(10);
    expect(lastPage.rows).toHaveLength(3);
    expect([...firstPage.rows, ...lastPage.rows].every((row) => row.grade_level === 'Grade 2')).toBe(true);
  });

  test('formats empty and populated result ranges truthfully', () => {
    expect(formatTableRange({ totalItems: 0, start: 0, end: 0 })).toBe('0 records');
    expect(formatTableRange({ totalItems: 12, start: 6, end: 10 })).toBe('Showing 6–10 of 12 records');
  });

  test('collects every bounded authorized page without mutating the visible page state', async () => {
    const loadPage = jest.fn(async ({ page, limit }) => ({
      rows: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
      pagination: { page, pages: 2, limit, total: 3 },
    }));

    await expect(collectAuthorizedReportRows({ loadPage, pageSize: 2 })).resolves.toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    expect(loadPage).toHaveBeenNthCalledWith(1, { page: 1, limit: 2 });
    expect(loadPage).toHaveBeenNthCalledWith(2, { page: 2, limit: 2 });
  });

  test('formats report context from the actual printed row count and active scope', () => {
    expect(formatReportContext({ scope: 'Grade 3 / Section A', recordCount: 12 })).toBe('Grade 3 / Section A · Records: 12');
    expect(formatReportContext({ scope: '', recordCount: 0 })).toBe('Records: 0');
  });
});
