import React from 'react';
import { Printer } from 'lucide-react';

export function TablePrintButton({
  reportTitle,
  reportContext = '',
  label,
  disabled = false,
  preparing = false,
  onPrint,
  showPrintHeading = true,
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
    window.print();
  };

  return (
    <>
      {showPrintHeading && (
        <div className="print-only table-print-heading">
          <h1>{title}</h1>
          {reportContext ? <p>{reportContext}</p> : null}
        </div>
      )}
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
    </>
  );
}
