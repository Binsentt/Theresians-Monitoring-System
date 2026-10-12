import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  composeReportSheets,
  paginateReportRows,
  parseReportPageSelection,
} from './reportPrint.utils';

const PAGE_MM = {
  portrait: { width: 210, height: 297 },
  landscape: { width: 297, height: 210 },
};
const PAGE_MARGIN_MM = 12;
const CSS_PIXELS_PER_MM = 96 / 25.4;

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

const pageDimensions = (orientation) => {
  const page = PAGE_MM[orientation] || PAGE_MM.landscape;
  return {
    width: page.width,
    height: page.height,
    contentWidth: page.width - PAGE_MARGIN_MM * 2,
    contentHeight: page.height - PAGE_MARGIN_MM * 2,
  };
};

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

function PrintableReportTable({ report, entries }) {
  return (
    <table className="printable-report-table">
      <thead>
        <tr>{report.columns.map((column) => <th key={column.header}>{column.header}</th>)}</tr>
      </thead>
      <tbody>
        {entries.length ? entries.map(({ row, sourceIndex }, rowIndex) => (
          <tr
            key={`${row?.id ?? row?.student_id ?? sourceIndex}-${sourceIndex}`}
            className="printable-report-row"
            data-report-index={sourceIndex}
          >
            {report.columns.map((column) => (
              <td key={column.header}>{printableValue(column.value(row, sourceIndex ?? rowIndex))}</td>
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

function PrintableReportPage({ report, entries, pageNumber, totalPages, orientation }) {
  const safe = safeReport({ ...report, orientation });
  return (
    <section className={`printable-table-report printable-report-${orientation} ${safe.className}`.trim()} aria-label={safe.title}>
      <PrintableReportHeader report={safe} />
      <PrintableReportTable report={safe} entries={entries} />
      <footer className="printable-report-footer">
        <span>Page {pageNumber} of {totalPages}</span>
        <span>Theresian's Quest · {safe.recordCount} records</span>
      </footer>
    </section>
  );
}

function measuredHeight(element, fallback) {
  const height = element?.getBoundingClientRect?.().height || element?.offsetHeight || 0;
  return Number.isFinite(height) && height > 0 ? height : fallback;
}

function measureLogicalPages(report, orientation, measurementRef) {
  const dimensions = pageDimensions(orientation);
  const measurement = measurementRef.current;
  const pageContentHeight = dimensions.contentHeight * CSS_PIXELS_PER_MM;
  const fallbackRowHeight = 30;
  const fallbackHeaderHeight = 112;
  const fallbackTableHeaderHeight = 32;
  const fallbackFooterHeight = 26;
  const headerHeight = measuredHeight(measurement?.querySelector('.printable-report-header'), fallbackHeaderHeight);
  const tableHeaderHeight = measuredHeight(measurement?.querySelector('thead'), fallbackTableHeaderHeight);
  const footerHeight = measuredHeight(measurement?.querySelector('.printable-report-footer'), fallbackFooterHeight);
  const rowNodes = Array.from(measurement?.querySelectorAll('[data-report-index]') || []);
  const rowHeights = report.rows.map((_, index) => measuredHeight(rowNodes[index], fallbackRowHeight));
  const reservedHeight = headerHeight + tableHeaderHeight + footerHeight + 28;
  const availableHeight = Math.max(60, pageContentHeight - reservedHeight);
  const entries = report.rows.map((row, sourceIndex) => ({ row, sourceIndex }));
  return paginateReportRows(entries, rowHeights, availableHeight);
}

function PrintSettingsReport({ report, onCancel }) {
  const measurementRef = useRef(null);
  const [orientation, setOrientation] = useState(report.orientation);
  const [pageMode, setPageMode] = useState('all');
  const [customPages, setCustomPages] = useState('');
  const [pagesPerSheet, setPagesPerSheet] = useState(1);
  const [validationError, setValidationError] = useState('');
  const [logicalPages, setLogicalPages] = useState([[]]);
  const [printJob, setPrintJob] = useState(null);
  const dimensions = pageDimensions(orientation);

  useLayoutEffect(() => {
    setLogicalPages(measureLogicalPages(report, orientation, measurementRef));
  }, [orientation, report]);

  useEffect(() => {
    if (!printJob) return undefined;
    printTimer = window.setTimeout(() => {
      printTimer = null;
      window.print();
    }, 0);
    return () => {
      if (printTimer !== null) {
        window.clearTimeout(printTimer);
        printTimer = null;
      }
    };
  }, [printJob]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !printJob) onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, printJob]);

  const selection = useMemo(
    () => parseReportPageSelection(pageMode, customPages, logicalPages.length),
    [customPages, logicalPages.length, pageMode]
  );

  const submit = (event) => {
    event.preventDefault();
    if (selection.error || selection.pages.length === 0) {
      setValidationError(selection.error || 'Choose at least one report page to print.');
      return;
    }

    setValidationError('');
    const selectedPages = selection.pages.map((pageNumber) => ({
      pageNumber,
      entries: logicalPages[pageNumber - 1] || [],
    }));
    const sheets = composeReportSheets(selectedPages, pagesPerSheet);
    setPrintJob({ sheets, totalPages: logicalPages.length, orientation, pagesPerSheet });
  };

  const columns = pagesPerSheet === 1 ? 1 : 2;
  const gridRows = pagesPerSheet === 4 ? 2 : 1;
  const scale = pagesPerSheet === 1 ? 1 : 0.5;

  return (
    <>
      <div
        className={`print-measurement printable-report-${orientation}`}
        ref={measurementRef}
        aria-hidden="true"
        style={{ width: `${dimensions.contentWidth}mm`, height: `${dimensions.contentHeight}mm` }}
      >
        <PrintableReportPage
          report={report}
          entries={report.rows.map((row, sourceIndex) => ({ row, sourceIndex }))}
          pageNumber={1}
          totalPages={logicalPages.length}
          orientation={orientation}
        />
      </div>

      {!printJob && (
        <div className="print-settings-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onCancel();
        }}>
          <form
            id="print-report-settings"
            className="print-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="print-report-settings-title"
            onSubmit={submit}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="print-settings-heading">
              <div>
                <span className="print-settings-eyebrow">Report output</span>
                <h2 id="print-report-settings-title">Print Settings</h2>
                <p>{report.title} · {report.recordCount} records</p>
              </div>
              <button type="button" className="print-settings-close" aria-label="Close print settings" onClick={onCancel}>×</button>
            </div>

            <div className="print-settings-fields">
              <div className="print-settings-field">
                <label htmlFor="print-orientation">Orientation</label>
                <select id="print-orientation" name="orientation" value={orientation} onChange={(event) => {
                  setOrientation(event.target.value);
                  setValidationError('');
                }}>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </div>

              <div className="print-settings-field">
                <label htmlFor="print-pages">Pages</label>
                <select id="print-pages" name="pages" value={pageMode} onChange={(event) => {
                  setPageMode(event.target.value);
                  setValidationError('');
                }}>
                  <option value="all">All</option>
                  <option value="odd">Odd pages only</option>
                  <option value="even">Even pages only</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              {pageMode === 'custom' && (
                <div className="print-settings-field print-settings-custom-pages">
                  <label htmlFor="print-custom-pages">Custom page numbers</label>
                  <input
                    id="print-custom-pages"
                    name="custom-pages"
                    type="text"
                    value={customPages}
                    onChange={(event) => {
                      setCustomPages(event.target.value);
                      setValidationError('');
                    }}
                    placeholder="1, 3, 5 or 1-3, 6, 8-10"
                    aria-invalid={Boolean(validationError)}
                    aria-describedby={validationError ? 'print-pages-error' : 'print-pages-hint'}
                  />
                  <span id="print-pages-hint" className="print-settings-hint">Valid pages: 1–{logicalPages.length}</span>
                </div>
              )}

              <div className="print-settings-field">
                <label htmlFor="print-pages-per-sheet">Pages per sheet</label>
                <select id="print-pages-per-sheet" name="pages-per-sheet" value={pagesPerSheet} onChange={(event) => setPagesPerSheet(Number(event.target.value))}>
                  <option value="1">1 page per sheet</option>
                  <option value="2">2 pages per sheet</option>
                  <option value="4">4 pages per sheet</option>
                </select>
              </div>
            </div>

            <p className="print-settings-page-count" aria-live="polite">
              Report layout: {logicalPages.length} {logicalPages.length === 1 ? 'page' : 'pages'} · {selection.pages.length} selected
            </p>
            {validationError && (
              <p id="print-pages-error" className="print-settings-validation validation-error-text" role="alert">{validationError}</p>
            )}
            <div className="print-settings-actions">
              <button type="button" className="print-settings-cancel" onClick={onCancel}>Cancel</button>
              <button type="submit" className="print-settings-submit">Print report</button>
            </div>
          </form>
        </div>
      )}

      {printJob && (
        <div className="print-sheet-stack" data-orientation={printJob.orientation} data-pages-per-sheet={printJob.pagesPerSheet}>
          {printJob.sheets.map((sheet, sheetIndex) => (
            <section
              key={`sheet-${sheetIndex}`}
              className={`print-sheet print-sheet-${printJob.orientation}${sheetIndex === printJob.sheets.length - 1 ? ' print-sheet-last' : ''}`}
              style={{
                '--sheet-columns': columns,
                '--sheet-rows': gridRows,
                '--page-scale': scale,
                '--content-width': `${dimensions.contentWidth}mm`,
                '--content-height': `${dimensions.contentHeight}mm`,
              }}
            >
              <div className="print-sheet-grid" data-pages-per-sheet={printJob.pagesPerSheet} data-grid-columns={columns}>
                {sheet.map((page) => (
                  <div className="print-page-slot" key={`page-${page.pageNumber}`}>
                    <div className="print-logical-page">
                      <PrintableReportPage
                        report={report}
                        entries={page.entries}
                        pageNumber={page.pageNumber}
                        totalPages={printJob.totalPages}
                        orientation={printJob.orientation}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
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
}

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
  const cancel = () => {
    registeredReport = null;
    removePortal();
  };
  flushSync(() => portalRoot.render(<PrintSettingsReport report={report} onCancel={cancel} />));
  window.addEventListener('afterprint', removePortal, { once: true });
  return true;
}
