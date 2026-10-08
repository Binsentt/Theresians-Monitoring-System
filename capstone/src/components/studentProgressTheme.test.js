const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.resolve(__dirname, '../styles/studentprogress.css'), 'utf8');

describe('Student Progress insight dark mode styles', () => {
  test('overrides white insight cards and keeps insight text, metadata, empty states, and controls readable', () => {
    const darkRules = styles.split(/\[data-theme=['"]dark['"]\]/).slice(1).join('\n');

    expect(darkRules).toMatch(/\.grounded-ai-analysis[^{}]*\.student-dashboard-card/);
    expect(darkRules).toMatch(/\.student-insight-card/);
    expect(darkRules).toMatch(/\.student-insight-list/);
    expect(darkRules).toMatch(/\.student-insight-empty/);
    expect(darkRules).toMatch(/\.grounded-ai-evidence-meta/);
    expect(darkRules).toMatch(/\.student-insight-copy/);
    expect(darkRules).toMatch(/\.student-insight-highlight/);
    expect(darkRules).toMatch(/\.student-insight-action/);
    expect(darkRules).toMatch(/\.grounded-ai-status/);
  });
});
