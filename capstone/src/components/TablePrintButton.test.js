import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TablePrintButton } from './TablePrintButton';
import { clearPreparedReport, registerPreparedReport } from './PrintReportPortal';

describe('TablePrintButton', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    jest.useFakeTimers();
    registerPreparedReport({
      title: 'Student Progress',
      rows: [{ id: 1, name: 'Ava Santos' }],
      columns: [{ header: 'Student', value: (row) => row.name }],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    act(() => clearPreparedReport());
    container.remove();
    jest.useRealTimers();
  });

  test('keeps the live control accessible without rendering a duplicate printable heading', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});

    act(() => {
      root.render(<TablePrintButton reportTitle="Student Progress" />);
    });

    expect(container.textContent).toContain('Print Student Progress');
    expect(container.querySelector('.print-only')).toBeNull();
    act(() => {
      container.querySelector('button').click();
      jest.runAllTimers();
    });
    expect(printSpy).toHaveBeenCalledTimes(1);

    printSpy.mockRestore();
  });

  test('uses an explicit accessible label and blocks empty or preparing reports', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});

    act(() => {
      root.render(<TablePrintButton reportTitle="Student Progress" label="Print Student List" disabled />);
    });

    const button = container.querySelector('button');
    expect(button.getAttribute('aria-label')).toBe('Print Student List');
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(printSpy).not.toHaveBeenCalled();

    act(() => {
      root.render(<TablePrintButton reportTitle="Student Progress" label="Print Student List" preparing />);
    });
    expect(container.textContent).toContain('Preparing report...');
    expect(container.querySelector('button').disabled).toBe(true);

    printSpy.mockRestore();
  });
});
