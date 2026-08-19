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
