import {
  composeReportSheets,
  paginateReportRows,
  parseReportPageSelection,
} from './reportPrint.utils';

describe('report print pagination helpers', () => {
  test('keeps two short source records on one logical page', () => {
    const rows = [{ id: 1 }, { id: 2 }];

    const pages = paginateReportRows(rows, [24, 24], 100);

    expect(pages).toEqual([rows]);
  });

  test('creates real logical pages without losing or duplicating source rows', () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({ id: index + 1 }));
    const pages = paginateReportRows(rows, rows.map(() => 31), 100);

    expect(pages).toHaveLength(4);
    expect(pages.flat().map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
  });

  test.each([
    ['all', '', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ['odd', '', [1, 3, 5, 7, 9]],
    ['even', '', [2, 4, 6, 8, 10]],
    ['custom', '1', [1]],
    ['custom', '1-3', [1, 2, 3]],
    ['custom', '1,3,5', [1, 3, 5]],
    ['custom', '1-3,6,8-10', [1, 2, 3, 6, 8, 9, 10]],
  ])('selects %s pages from %s', (mode, customRange, expected) => {
    expect(parseReportPageSelection(mode, customRange, 10)).toEqual({ pages: expected, error: '' });
  });

  test.each(['0', '11', '3-2', '1,,3', 'x', ''])('rejects invalid custom range %s', (customRange) => {
    const result = parseReportPageSelection('custom', customRange, 10);

    expect(result.pages).toEqual([]);
    expect(result.error).toMatch(/1 through 10/i);
  });

  test.each([1, 2, 4])('composes selected pages exactly once with %s pages per sheet', (count) => {
    const pages = Array.from({ length: 9 }, (_, index) => ({ pageNumber: index + 1 }));
    const sheets = composeReportSheets(pages, count);

    expect(sheets.flat()).toEqual(pages);
    expect(sheets.every((sheet) => sheet.length <= count)).toBe(true);
  });
});
