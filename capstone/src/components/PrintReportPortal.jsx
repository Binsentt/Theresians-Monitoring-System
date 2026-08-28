import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const printableValue = (value) => {
  if (value === null || value === undefined || value === '') return 'Not available';
  if (Array.isArray(value)) return value.length ? value.map(printableValue).join(', ') : 'Not available';
  if (typeof value === 'object') return 'Not available';
  return String(value);
};

const printedAt = () => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date());

let registeredReport = null;
let portalContainer = null;
let portalRoot = null;
let printTimer = null;

const safeReport = (report = {}) => ({
  title: String(report.title || 'Report').trim() || 'Report',
  context: String(report.context || '').trim(),
  rows: Array.isArray(report.rows) ? report.rows : [],
  recordCount: Math.max(0, Number(report.recordCount ?? (Array.isArray(report.rows) ? report.rows.length : 0)) || 0),
  columns: Array.isArray(report.columns)
    ? report.columns.filter((column) => column?.header && typeof column?.value === 'function')
    : [],
  orientation: report.orientation === 'portrait' ? 'portrait' : 'landscape',
  className: String(report.className || '').trim(),
});

export function PreparedTableReportContent({ report }) {
  const safe = safeReport(report);
  return (
    <section className={`printable-table-report printable-report-${safe.orientation} ${safe.className}`.trim()} aria-label={safe.title}>
      <header className="printable-report-header">
        <p>Theresian's Quest</p>
        <h1>{safe.title}</h1>
        {safe.context && <span>{safe.context}</span>}
        <span>Records: {safe.recordCount}</span>
        <span>Printed: {printedAt()}</span>
      </header>
      <table>
        <thead>
          <tr>{safe.columns.map((column) => <th key={column.header}>{column.header}</th>)}</tr>
        </thead>
        <tbody>
          {safe.rows.length ? safe.rows.map((row, rowIndex) => (
            <tr key={row?.id ?? row?.student_id ?? `${rowIndex}-${safe.columns.length}`}>
              {safe.columns.map((column) => <td key={column.header}>{printableValue(column.value(row, rowIndex))}</td>)}
            </tr>
          )) : (
            <tr className="printable-report-empty">
              <td colSpan={Math.max(1, safe.columns.length)}>No data available for the selected authorized scope.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

const removePortal = () => {
  if (printTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(printTimer);
    printTimer = null;
  }
  if (portalRoot) {
    flushSync(() => portalRoot.unmount());
    portalRoot = null;
  }
  if (portalContainer?.parentNode) portalContainer.parentNode.removeChild(portalContainer);
  portalContainer = null;
  if (typeof window !== 'undefined') window.removeEventListener('afterprint', removePortal);
};

export function clearPreparedReport() {
  registeredReport = null;
  removePortal();
}

export function registerPreparedReport(report) {
  registeredReport = safeReport(report);
}

export function openPreparedReport() {
  const report = safeReport(registeredReport || {});
  if (typeof document === 'undefined' || !report.columns.length) return false;

  removePortal();
  portalContainer = document.createElement('div');
  portalContainer.id = 'print-report-root';
  portalContainer.setAttribute('aria-live', 'off');
  document.body.appendChild(portalContainer);
  portalRoot = createRoot(portalContainer);
  flushSync(() => portalRoot.render(<PreparedTableReportContent report={report} />));
  window.addEventListener('afterprint', removePortal, { once: true });
  printTimer = window.setTimeout(() => {
    printTimer = null;
    window.print();
  }, 0);
  return true;
}
