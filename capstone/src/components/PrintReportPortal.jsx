import React, { useEffect } from 'react';
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
  className: String(report.className || '').trim(),
  printedAt: String(report.printedAt || printedAt()),
});

function PrintableReportHeader({ report }) {
  return (
    <header className="printable-report-header">
      <p>Theresian's Quest</p>
      <h1>{report.title}</h1>
      {report.context && <span>{report.context}</span>}
      <span>Records: {report.recordCount}</span>
      <span>Printed: {report.printedAt}</span>
    </header>
  );
}

function PrintableReportTable({ report }) {
  return (
    <table className="printable-report-table">
      <thead>
        <tr>{report.columns.map((column) => <th key={column.header}>{column.header}</th>)}</tr>
      </thead>
      <tbody>
        {report.rows.length ? report.rows.map((row, sourceIndex) => (
          <tr
            key={`${row?.id ?? row?.student_id ?? sourceIndex}-${sourceIndex}`}
            className="printable-report-row"
            data-report-index={sourceIndex}
          >
            {report.columns.map((column) => (
              <td key={column.header}>{printableValue(column.value(row, sourceIndex))}</td>
            ))}
          </tr>
        )) : (
          <tr className="printable-report-empty">
            <td colSpan={Math.max(1, report.columns.length)}>No data available for the selected authorized scope.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function PrintableReportDocument({ report }) {
  useEffect(() => {
    printTimer = window.setTimeout(() => {
      printTimer = null;
      if (typeof window.print === 'function') window.print();
    }, 0);
    return () => {
      if (printTimer !== null) {
        window.clearTimeout(printTimer);
        printTimer = null;
      }
    };
  }, []);

  return (
    <article className={`printable-table-report ${report.className}`.trim()} aria-label={report.title}>
      <PrintableReportHeader report={report} />
      <PrintableReportTable report={report} />
      <footer className="printable-report-footer">
        <span>Theresian's Quest</span>
        <span>{report.recordCount} records · Printed {report.printedAt}</span>
      </footer>
    </article>
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
  flushSync(() => portalRoot.render(<PrintableReportDocument report={report} />));
  window.addEventListener('afterprint', removePortal, { once: true });
  return true;
}
