import React, { act } from 'react';
import {
  clearPreparedReport,
  openPreparedReport,
  registerPreparedReport,
} from './PrintReportPortal';

describe('PrintReportPortal', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.useFakeTimers();
    act(() => clearPreparedReport());
  });

  afterEach(() => {
    act(() => clearPreparedReport());
    jest.useRealTimers();
  });

  test('prints one prepared report at a time and removes it after browser printing', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    registerPreparedReport({
      title: 'Top Achievers Report',
      context: 'Grade 1 / Active Students',
      rows: [
        { id: 1, student_name: 'Ava Santos', accuracy: 0 },
        { id: 2, student_name: 'Ben Cruz', accuracy: 100 },
      ],
      columns: [
        { header: 'Student Name', value: (row) => row.student_name },
        { header: 'Accuracy', value: (row) => row.accuracy },
      ],
      orientation: 'landscape',
    });

    act(() => expect(openPreparedReport()).toBe(true));

    const root = document.querySelector('#print-report-root');
    expect(root).toBeTruthy();
    expect(root.querySelector('#print-report-settings')).toBeTruthy();
    expect(root.textContent).toContain('Top Achievers Report');
    expect(root.textContent).toContain('Records: 2');
    expect(printSpy).not.toHaveBeenCalled();
    act(() => root.querySelector('#print-report-settings button[type="submit"]').click());
    act(() => jest.runOnlyPendingTimers());
    expect(root.querySelectorAll('.print-sheet')).toHaveLength(1);
    expect(root.querySelectorAll('.print-sheet .printable-report-row')).toHaveLength(2);
    expect(root.querySelector('.printable-report-footer').textContent).toContain('Page 1 of 1');
    expect(root.querySelector('button')).toBeNull();
    expect(printSpy).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event('afterprint')));
    expect(document.querySelector('#print-report-root')).toBeNull();
    printSpy.mockRestore();
  });

  test('uses the latest fully prepared report rather than retaining a prior page report', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    registerPreparedReport({
      title: 'First report',
      rows: [{ id: 1, label: 'Old row' }],
      columns: [{ header: 'Label', value: (row) => row.label }],
    });
    registerPreparedReport({
      title: 'Second report',
      rows: [{ id: 2, label: 'Prepared complete row' }],
      columns: [{ header: 'Label', value: (row) => row.label }],
    });

    act(() => expect(openPreparedReport()).toBe(true));
    expect(document.querySelector('#print-report-root').textContent).toContain('Second report');
    expect(document.querySelector('#print-report-root').textContent).not.toContain('First report');
    expect(document.querySelector('#print-report-root #print-report-settings')).toBeTruthy();
    printSpy.mockRestore();
  });

  test('prints a truthful no-data report instead of returning a blank page', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    registerPreparedReport({
      title: 'Screen Time Report',
      context: 'All authorised records',
      rows: [],
      recordCount: 0,
      columns: [{ header: 'Student Name', value: (row) => row.student_name }],
    });

    act(() => expect(openPreparedReport()).toBe(true));

    const root = document.querySelector('#print-report-root');
    const report = root.querySelector('.print-measurement .printable-table-report');
    expect(report).toBeTruthy();
    expect(report.textContent).toContain('Records: 0');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(report.querySelector('.printable-report-empty')?.textContent).toContain('No data available for the selected authorized scope.');
    expect(printSpy).not.toHaveBeenCalled();
    act(() => root.querySelector('#print-report-settings button[type="submit"]').click());
    act(() => jest.runOnlyPendingTimers());
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  test('renders every filtered row once across measured print pages', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    const rows = Array.from({ length: 53 }, (_, index) => ({ id: index + 1, label: `Filtered row ${index + 1}` }));
    registerPreparedReport({
      title: 'Filtered Records',
      context: 'Search: selected records',
      rows,
      recordCount: rows.length,
      columns: [{ header: 'Record', value: (row) => row.label }],
    });

    act(() => expect(openPreparedReport()).toBe(true));
    const root = document.querySelector('#print-report-root');
    const report = root.querySelector('.print-measurement .printable-table-report');

    expect(report.querySelectorAll('tbody tr')).toHaveLength(53);
    expect(report.textContent).toContain('Filtered row 53');
    expect(report.querySelector('.printable-report-header').textContent).toContain('Records: 53');
    act(() => root.querySelector('#print-report-settings button[type="submit"]').click());
    act(() => jest.runOnlyPendingTimers());
    const pages = Array.from(root.querySelectorAll('.print-sheet .printable-report-row'));
    expect(root.querySelectorAll('.print-sheet').length).toBeGreaterThan(0);
    expect(pages).toHaveLength(53);
    expect(pages.map((row) => Number(row.dataset.reportIndex)).sort((left, right) => left - right)).toEqual(Array.from({ length: 53 }, (_, index) => index));
    expect(root.querySelectorAll('.print-sheet').length).toBeGreaterThan(1);
    expect(root.querySelectorAll('.print-sheet .printable-table-report thead')).toHaveLength(root.querySelectorAll('.printable-table-report').length - 1);
    const pageCount = root.querySelectorAll('.print-sheet').length;
    const pageFooters = Array.from(root.querySelectorAll('.print-sheet .printable-report-footer')).map((footer) => footer.textContent);
    expect(pageFooters).toHaveLength(pageCount);
    pageFooters.forEach((text, index) => expect(text).toContain(`Page ${index + 1} of ${pageCount}`));
    expect(Array.from(root.querySelectorAll('.print-sheet .printable-table-report thead')).every((header) => header.textContent.includes('Record'))).toBe(true);
    printSpy.mockRestore();
  });

  test('prints only measured pages requested by a valid custom range', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    const rows = Array.from({ length: 53 }, (_, index) => ({ id: index + 1, label: `Record ${index + 1}` }));
    registerPreparedReport({
      title: 'Custom page report',
      rows,
      columns: [{ header: 'Record', value: (row) => row.label }],
    });
    act(() => expect(openPreparedReport()).toBe(true));
    const root = document.querySelector('#print-report-root');
    const settings = root.querySelector('#print-report-settings');
    act(() => {
      const select = settings.querySelector('select[name="pages"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'custom');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(settings.querySelector('input[name="custom-pages"]').getAttribute('placeholder')).toContain('1, 3, 5');
    act(() => {
      const input = settings.querySelector('input[name="custom-pages"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2-3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => settings.querySelector('button[type="submit"]').click());
    act(() => jest.runOnlyPendingTimers());

    expect(root.querySelectorAll('.print-sheet')).toHaveLength(2);
    const footers = Array.from(root.querySelectorAll('.print-sheet .printable-report-footer')).map((footer) => footer.textContent);
    expect(footers.some((text) => text.includes('Page 2 of'))).toBe(true);
    expect(footers.some((text) => text.includes('Page 3 of'))).toBe(true);
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  test('rejects an out-of-range custom page selection with inline validation', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    registerPreparedReport({
      title: 'One page',
      rows: [{ id: 1, label: 'Short row' }],
      columns: [{ header: 'Label', value: (row) => row.label }],
    });
    act(() => expect(openPreparedReport()).toBe(true));
    const root = document.querySelector('#print-report-root');
    const settings = root.querySelector('#print-report-settings');
    act(() => {
      settings.querySelector('select[name="pages"]').value = 'custom';
      settings.querySelector('select[name="pages"]').dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => {
      const input = settings.querySelector('input[name="custom-pages"]');
      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => settings.querySelector('button[type="submit"]').click());

    expect(settings.querySelector('[role="alert"]').textContent).toMatch(/1 through 1/i);
    expect(settings.querySelector('input[name="custom-pages"]').getAttribute('aria-invalid')).toBe('true');
    expect(printSpy).not.toHaveBeenCalled();
    printSpy.mockRestore();
  });

  test('applies selected orientation and two-up layout to the generated print document', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    registerPreparedReport({
      title: 'Orientation report',
      rows: [{ id: 1, label: 'A' }, { id: 2, label: 'B' }],
      columns: [{ header: 'Label', value: (row) => row.label }],
    });
    act(() => expect(openPreparedReport()).toBe(true));
    const root = document.querySelector('#print-report-root');
    const settings = root.querySelector('#print-report-settings');
    act(() => {
      const orientation = settings.querySelector('select[name="orientation"]');
      orientation.value = 'portrait';
      orientation.dispatchEvent(new Event('change', { bubbles: true }));
      const pagesPerSheet = settings.querySelector('select[name="pages-per-sheet"]');
      pagesPerSheet.value = '2';
      pagesPerSheet.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => settings.querySelector('button[type="submit"]').click());
    act(() => jest.runOnlyPendingTimers());

    expect(root.querySelector('.print-sheet').classList.contains('print-sheet-portrait')).toBe(true);
    expect(root.querySelector('.print-sheet-grid').getAttribute('data-pages-per-sheet')).toBe('2');
    expect(root.querySelector('.print-sheet-grid').getAttribute('data-grid-columns')).toBe('2');
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
