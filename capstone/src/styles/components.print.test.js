import fs from 'fs';
import path from 'path';

describe('print reporting styles', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, 'components.css'), 'utf8');
  const studentAnalyticsStyles = fs.readFileSync(path.resolve(__dirname, 'studentprogress.css'), 'utf8');
  const screenTimeStyles = fs.readFileSync(path.resolve(__dirname, 'screenTime.css'), 'utf8');

  test('keeps dashboard chrome out of dedicated print reports', () => {
    expect(styles).toContain('body *');
    expect(styles).toContain('#print-report-root *');
    expect(styles).toContain('#root,');
    expect(styles).toContain('visibility: hidden');
    expect(styles).toContain('visibility: visible !important');
  });

  test('formats explicit A4 portrait and landscape sheets with repeated table headers', () => {
    expect(styles).toContain('@page report-portrait');
    expect(styles).toContain('@page report-landscape');
    expect(styles).toContain('size: A4 portrait');
    expect(styles).toContain('size: A4 landscape');
    expect(styles).toContain('display: table-header-group');
    expect(styles).toContain('break-inside: avoid');
    expect(styles).toContain('.print-sheet-landscape');
    expect(styles).toContain('.print-sheet-portrait');
    expect(styles).toContain('.printable-report-empty td');
  });

  test('provides a measured page grid and fixed 1/2/4-up sheet composition without report scrollbars', () => {
    expect(styles).toContain('.print-measurement');
    expect(styles).toContain('grid-template-columns: repeat(var(--sheet-columns, 1), minmax(0, 1fr))');
    expect(styles).toContain('grid-template-rows: repeat(var(--sheet-rows, 1), minmax(0, 1fr))');
    expect(styles).toContain('transform: scale(var(--page-scale, 1))');
    expect(styles).toContain('overflow: visible !important');
    expect(styles).toContain('.print-sheet-last');
  });

  test('styles print page selection errors as semantic validation feedback', () => {
    expect(styles).toMatch(/\.print-settings-validation\s*\{[^}]*color:\s*var\(--error-color,\s*#b91c1c\)/s);
    expect(styles).toMatch(/\.print-settings-field input\[aria-invalid="true"\]\s*\{[^}]*border-color:\s*var\(--error-color,\s*#b91c1c\)/s);
  });

  test('releases the viewport scroll container so long reports paginate instead of clipping', () => {
    const printRules = styles.slice(styles.indexOf('@media print'));

    expect(printRules).toMatch(/html,\s*body\s*\{[^}]*height:\s*auto\s*!important/s);
    expect(printRules).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*visible\s*!important/s);
    expect(printRules).toMatch(/#print-report-root\s*\{[^}]*max-height:\s*none\s*!important/s);
    expect(printRules).toMatch(/#print-report-root\s*\{[^}]*overflow:\s*visible\s*!important/s);
  });

  test('gives the four Student Analytics summary cards the full profile width on desktop', () => {
    expect(studentAnalyticsStyles).toMatch(/\.student-profile-meta\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s);
    expect(studentAnalyticsStyles).toMatch(/\.student-profile-meta\s*\{[^}]*grid-template-columns:\s*minmax\(/s);
    expect(studentAnalyticsStyles).toMatch(/\.student-performance-meta\s*\{[^}]*grid-template-columns:\s*minmax\([^}]*repeat\(3,/s);
  });

  test('keeps analytics values word-wrapped and returns summary cards to a two-column tablet grid', () => {
    const valueRule = studentAnalyticsStyles.match(/\.student-profile-meta strong,\s*\.student-performance-meta strong\s*\{([^}]*)\}/s)?.[1] || '';

    expect(valueRule).toContain('overflow-wrap: break-word');
    expect(valueRule).not.toContain('overflow-wrap: anywhere');
    expect(studentAnalyticsStyles).toMatch(/@media \(max-width: 980px\)\s*\{[\s\S]*?\.student-profile-meta,[\s\S]*?\.student-performance-meta,[\s\S]*?grid-template-columns:\s*repeat\(2,/s);
  });

  test('separates the Screen Time report toolbar from the table while retaining a responsive layout', () => {
    const toolbarRule = screenTimeStyles.match(/\.screen-time-results\s*\{([^}]*)\}/s)?.[1] || '';
    const mobileToolbarRule = screenTimeStyles.match(/@media \(max-width: 640px\)\s*\{[\s\S]*?\.screen-time-results\s*\{([^}]*)\}/s)?.[1] || '';

    expect(toolbarRule).toContain('align-items: center');
    expect(toolbarRule).toContain('gap: 10px');
    expect(toolbarRule).toContain('margin-bottom: 20px');
    expect(screenTimeStyles).toMatch(/\.screen-time-results \.table-report-controls\s*\{[^}]*margin:\s*0;/s);
    expect(mobileToolbarRule).toContain('flex-direction: column');
    expect(mobileToolbarRule).toContain('align-items: stretch');
    expect(screenTimeStyles).toMatch(/\.screen-time-table-wrap\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);
  });
});
