import fs from 'fs';
import path from 'path';

describe('print reporting styles', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, 'components.css'), 'utf8');
  const studentAnalyticsStyles = fs.readFileSync(path.resolve(__dirname, 'studentprogress.css'), 'utf8');
  const screenTimeStyles = fs.readFileSync(path.resolve(__dirname, 'screenTime.css'), 'utf8');

  test('keeps dashboard chrome out of dedicated print reports', () => {
    expect(styles).toContain('body *');
    expect(styles).toContain('.print-only *');
    expect(styles).toContain('visibility: hidden');
    expect(styles).toContain('visibility: visible !important');
  });

  test('formats printable reports for A4 with repeated headers and safe row breaks', () => {
    expect(styles).toContain('@page');
    expect(styles).toContain('size: A4');
    expect(styles).toContain('display: table-header-group');
    expect(styles).toContain('break-inside: avoid');
    expect(styles).toContain('printable-report-landscape');
    expect(styles).toContain('.student-analytics-print-report dl');
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
