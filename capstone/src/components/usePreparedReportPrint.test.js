import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usePreparedReportPrint } from './usePreparedReportPrint';

function Harness() {
  const { preparedRows, preparing, prepareAndPrint } = usePreparedReportPrint();
  return (
    <div>
      <button type="button" onClick={() => prepareAndPrint(async () => [{ id: 1 }, { id: 2 }])}>Prepare</button>
      <span>{preparing ? 'Preparing' : 'Ready'}</span>
      <span>{preparedRows.length}</span>
    </div>
  );
}

describe('usePreparedReportPrint', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  test('prepares rows before opening the read-only print dialog', async () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    act(() => root.render(<Harness />));

    await act(async () => {
      container.querySelector('button').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('2');
    expect(printSpy).not.toHaveBeenCalled();

    act(() => jest.runOnlyPendingTimers());
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
