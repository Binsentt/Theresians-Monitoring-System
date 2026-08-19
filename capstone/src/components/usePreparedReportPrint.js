import { useEffect, useState } from 'react';

export function usePreparedReportPrint(initialRows = []) {
  const [preparedRows, setPreparedRows] = useState(Array.isArray(initialRows) ? initialRows : []);
  const [preparing, setPreparing] = useState(false);
  const [printRequested, setPrintRequested] = useState(false);

  useEffect(() => {
    if (!printRequested) return undefined;
    const timer = window.setTimeout(() => {
      window.print();
      setPrintRequested(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [printRequested]);

  const prepareAndPrint = async (loadRows) => {
    if (preparing || typeof loadRows !== 'function') return false;
    setPreparing(true);
    try {
      const rows = await loadRows();
      const safeRows = Array.isArray(rows) ? rows : [];
      if (!safeRows.length) return false;
      setPreparedRows(safeRows);
      setPrintRequested(true);
      return true;
    } finally {
      setPreparing(false);
    }
  };

  return {
    preparedRows,
    preparing,
    prepareAndPrint,
  };
}
