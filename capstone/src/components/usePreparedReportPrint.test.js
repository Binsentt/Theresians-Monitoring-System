import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usePreparedReportPrint } from './usePreparedReportPrint';
import { PrintableTableReport } from './PrintableTableReport';

function Harness() {
  const { preparedRows, hasPreparedReport, preparing, prepareAndPrint } = usePreparedReportPrint();
  return (
    <div>
      <button type="button" onClick={() => prepareAndPrint(async () => [{ id: 1 }, { id: 2 }])}>Prepare</button>
      <button type="button" onClick={() => prepareAndPrint(async () => [])}>Prepare empty</button>
      <span>{preparing ? 'Preparing' : 'Ready'}</span>
      <span>{preparedRows.length}</span>
      <span>{hasPreparedReport ? 'Prepared report' : 'No prepared report'}</span>
      <PrintableTableReport
        title="Prepared report"
        rows={preparedRows}
        columns={[{ header: 'ID', value: (row) => row.id }]}
      />
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

    act(() => jest.runAllTimers());
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  test('opens a no-data report after an authorised empty response', async () => {
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    act(() => root.render(<Harness />));

    await act(async () => {
      container.querySelectorAll('button')[1].click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Prepared report');
    act(() => jest.runAllTimers());
    expect(document.querySelector('#print-report-root .printable-report-empty')?.textContent).toContain('No data available for the selected authorized scope.');
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
