import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PrintableTableReport } from './PrintableTableReport';
import { clearPreparedReport, openPreparedReport } from './PrintReportPortal';

describe('PrintableTableReport', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => root.unmount());
    act(() => clearPreparedReport());
    container.remove();
    jest.useRealTimers();
  });

  test('registers the complete prepared row set for the isolated portal with no screen controls', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    act(() => {
      root.render(
        <PrintableTableReport
          title="Top Achievers Report"
          context="Grade 3"
          orientation="landscape"
          rows={[{ student_name: 'Ava Santos', student_id: '001234', accuracy: 0 }, { student_name: 'Ben Cruz', student_id: '001235', accuracy: null }]}
          columns={[
            { header: 'Student ID', value: (row) => row.student_id },
            { header: 'Student Name', value: (row) => row.student_name },
            { header: 'Accuracy', value: (row) => row.accuracy },
          ]}
        />
      );
    });

    expect(container.querySelector('.printable-table-report')).toBeNull();
    act(() => expect(openPreparedReport()).toBe(true));
    act(() => jest.runOnlyPendingTimers());
    const report = document.querySelector('#print-report-root .printable-table-report');
    expect(report).toBeTruthy();
    expect(report.className).toContain('printable-report-landscape');
    expect(report.textContent).toContain('Records: 2');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(report.textContent).toContain('0');
    expect(report.textContent).toContain('Not available');
    expect(report.querySelector('button')).toBeFalsy();
    printSpy.mockRestore();
  });
});
