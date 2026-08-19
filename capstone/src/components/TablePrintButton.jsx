import React from 'react';

export function TablePrintButton({ reportTitle, reportContext = '', className = '' }) {
  const title = String(reportTitle || 'Report').trim() || 'Report';

  return (
    <>
      <div className="print-only table-print-heading">
        <h1>{title}</h1>
        {reportContext ? <p>{reportContext}</p> : null}
      </div>
      <button
        type="button"
        className={`table-print-button no-print ${className}`.trim()}
        onClick={() => window.print()}
        aria-label={`Print ${title}`}
      >
        Print
      </button>
    </>
  );
}
