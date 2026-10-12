import { useLayoutEffect } from 'react';
import { registerPreparedReport } from './PrintReportPortal';

export function PrintableTableReport({
  title,
  context = '',
  rows = [],
  columns = [],
  className = '',
  recordCount,
}) {
  useLayoutEffect(() => {
    registerPreparedReport({ title, context, rows, columns, className, recordCount });
  }, [className, columns, context, recordCount, rows, title]);

  // Only the fully prepared model is registered here. The printable DOM mounts
  // under document.body immediately before printing, not in the live dashboard.
  return null;
}
