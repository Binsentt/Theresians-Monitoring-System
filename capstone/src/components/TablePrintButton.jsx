import React from 'react';
import { Printer } from 'lucide-react';
import { openPreparedReport } from './PrintReportPortal';

export function TablePrintButton({
  reportTitle,
  label,
  disabled = false,
  preparing = false,
  onPrint,
  showPrintHeading: _showPrintHeading = true,
  className = '',
}) {
  const title = String(reportTitle || 'Report').trim() || 'Report';
  const buttonLabel = String(label || `Print ${title}`).trim() || `Print ${title}`;
  const unavailable = Boolean(disabled || preparing);
  const handlePrint = () => {
    if (unavailable) return;
    if (typeof onPrint === 'function') {
      onPrint();
      return;
    }
    openPreparedReport();
  };

  return (
      <button
        type="button"
        className={`table-print-button no-print ${className}`.trim()}
        onClick={handlePrint}
        aria-label={buttonLabel}
        disabled={unavailable}
      >
        <Printer size={16} aria-hidden="true" />
        {preparing ? 'Preparing report...' : buttonLabel}
      </button>
  );
}
