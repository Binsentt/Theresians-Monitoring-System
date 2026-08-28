import { useEffect, useState } from 'react';
import { openPreparedReport } from './PrintReportPortal';

export function usePreparedReportPrint(initialRows = []) {
  const [preparedRows, setPreparedRows] = useState(Array.isArray(initialRows) ? initialRows : []);
  const [hasPreparedReport, setHasPreparedReport] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [printRequested, setPrintRequested] = useState(false);

  useEffect(() => {
    if (!printRequested) return undefined;
    const timer = window.setTimeout(() => {
      openPreparedReport();
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
      setPreparedRows(safeRows);
      setHasPreparedReport(true);
      setPrintRequested(true);
      return true;
    } catch {
      return false;
    } finally {
      setPreparing(false);
    }
  };

  return {
    preparedRows,
    hasPreparedReport,
    preparing,
    prepareAndPrint,
  };
}
