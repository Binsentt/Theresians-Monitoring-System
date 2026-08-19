import {
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
});
