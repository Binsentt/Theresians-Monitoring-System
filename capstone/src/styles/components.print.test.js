import fs from 'fs';
import path from 'path';

describe('print reporting styles', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, 'components.css'), 'utf8');

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
});
