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

  test('sends a short complete report directly to the browser print dialog', () => {
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
    });

    act(() => expect(openPreparedReport()).toBe(true));
    const root = document.querySelector('#print-report-root');
    const report = root.querySelector('.printable-table-report');
    expect(report.textContent).toContain('Top Achievers Report');
    expect(report.textContent).toContain('Records: 2');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('select[name="orientation"]')).toBeNull();
    expect(root.querySelector('select[name="pages"]')).toBeNull();
    expect(root.querySelector('select[name="pages-per-sheet"]')).toBeNull();

    act(() => jest.runOnlyPendingTimers());
    expect(printSpy).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event('afterprint')));
    expect(document.querySelector('#print-report-root')).toBeNull();
    printSpy.mockRestore();
  });

  test('keeps every filtered row in one natural-flow document for browser pagination', () => {
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
    const report = root.querySelector('.printable-table-report');
    const printedRows = Array.from(report.querySelectorAll('tbody tr'));
    expect(printedRows).toHaveLength(53);
    expect(printedRows.map((row) => row.textContent)).toContain('Filtered row 53');
    expect(report.querySelector('thead')?.textContent).toContain('Record');
    expect(report.querySelector('.printable-report-header')?.textContent).toContain('Records: 53');
    expect(report.querySelector('.printable-report-footer')).toBeTruthy();
    expect(root.querySelector('.print-sheet-stack')).toBeNull();
    expect(root.querySelector('.print-logical-page')).toBeNull();

    act(() => jest.runOnlyPendingTimers());
    expect(printSpy).toHaveBeenCalledTimes(1);
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
    const report = root.querySelector('.printable-table-report');
    expect(report.textContent).toContain('Records: 0');
    expect(report.querySelector('.printable-report-empty')?.textContent)
      .toContain('No data available for the selected authorized scope.');
    act(() => jest.runOnlyPendingTimers());
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  test('uses the latest fully prepared report rather than retaining a prior report', () => {
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
    const report = document.querySelector('#print-report-root .printable-table-report');
    expect(report.textContent).toContain('Second report');
    expect(report.textContent).not.toContain('First report');
    expect(report.querySelector('tbody').textContent).toContain('Prepared complete row');
  });
});
