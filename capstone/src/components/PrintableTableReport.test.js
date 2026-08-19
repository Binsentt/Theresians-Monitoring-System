import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PrintableTableReport } from './PrintableTableReport';

describe('PrintableTableReport', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('renders the complete prepared row set with a truthful record count and no screen controls', () => {
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

    const report = container.querySelector('.printable-table-report');
    expect(report).toBeTruthy();
    expect(report.className).toContain('printable-report-landscape');
    expect(report.textContent).toContain('Records: 2');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(report.textContent).toContain('0');
    expect(report.textContent).toContain('Not available');
    expect(report.querySelector('button')).toBeFalsy();
  });
});
