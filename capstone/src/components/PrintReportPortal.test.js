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
      rows: [{ id: 1, student_name: 'Ava Santos', accuracy: 0 }],
      columns: [
        { header: 'Student Name', value: (row) => row.student_name },
        { header: 'Accuracy', value: (row) => row.accuracy },
      ],
      orientation: 'landscape',
    });

    act(() => expect(openPreparedReport()).toBe(true));
    act(() => jest.runOnlyPendingTimers());

    const root = document.querySelector('#print-report-root');
    expect(root).toBeTruthy();
    expect(root.querySelectorAll('.printable-table-report')).toHaveLength(1);
    expect(root.textContent).toContain('Top Achievers Report');
    expect(root.textContent).toContain('Records: 1');
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
    act(() => jest.runOnlyPendingTimers());
    expect(document.querySelector('#print-report-root').textContent).toContain('Second report');
    expect(document.querySelector('#print-report-root').textContent).not.toContain('First report');
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
    act(() => jest.runOnlyPendingTimers());

    const report = document.querySelector('#print-report-root .printable-table-report');
    expect(report).toBeTruthy();
    expect(report.textContent).toContain('Records: 0');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(report.querySelector('.printable-report-empty')?.textContent).toContain('No data available for the selected authorized scope.');
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
