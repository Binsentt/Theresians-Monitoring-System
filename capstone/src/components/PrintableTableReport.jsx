import React from 'react';

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

export function PrintableTableReport({
  title,
  context = '',
  rows = [],
  columns = [],
  orientation = 'landscape',
  className = '',
}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeColumns = Array.isArray(columns) ? columns.filter((column) => column?.header && typeof column?.value === 'function') : [];
  const reportTitle = String(title || 'Report').trim() || 'Report';
  const reportContext = String(context || '').trim();

  return (
    <section className={`print-only printable-table-report printable-report-${orientation} ${className}`.trim()} aria-label={reportTitle}>
      <header className="printable-report-header">
        <p>Theresian's Quest</p>
        <h1>{reportTitle}</h1>
        {reportContext && <span>{reportContext}</span>}
        <span>Records: {safeRows.length}</span>
        <span>Printed: {printedAt()}</span>
      </header>
      <table>
        <thead>
          <tr>{safeColumns.map((column) => <th key={column.header}>{column.header}</th>)}</tr>
        </thead>
        <tbody>
          {safeRows.map((row, rowIndex) => (
            <tr key={row?.id ?? row?.student_id ?? `${rowIndex}-${safeColumns.length}`}>
              {safeColumns.map((column) => <td key={column.header}>{printableValue(column.value(row, rowIndex))}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
