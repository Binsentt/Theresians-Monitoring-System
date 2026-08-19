import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TablePrintButton } from './TablePrintButton';

describe('TablePrintButton', () => {
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

  test('prints the visible report with a print-only title and context', () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});

    act(() => {
      root.render(<TablePrintButton reportTitle="Student Progress" reportContext="Grade 1 · 2 records" />);
    });

    expect(container.textContent).toContain('Student Progress');
    expect(container.textContent).toContain('Grade 1 · 2 records');
    expect(container.querySelector('.print-only')).not.toBeNull();
    act(() => {
      container.querySelector('button').click();
    });
    expect(printSpy).toHaveBeenCalledTimes(1);

    printSpy.mockRestore();
  });
});
