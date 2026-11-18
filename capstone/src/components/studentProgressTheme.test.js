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
    expect(darkRules).toMatch(/\.grounded-ai-general-summary/);
    expect(darkRules).toMatch(/\.grounded-ai-map-observations/);
    expect(darkRules).toMatch(/\.student-insight-copy/);
    expect(darkRules).toMatch(/\.student-insight-highlight/);
    expect(darkRules).toMatch(/\.student-insight-action/);
    expect(darkRules).toMatch(/\.grounded-ai-status/);
  });

  test('uses a shared responsive Per-Quest Evidence grid in Student, Teacher, and Parent panels', () => {
    expect(styles).toMatch(/\.grounded-ai-quest-insights\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
    expect(styles).toMatch(/\.grounded-ai-quest-insights\s*>\s*ul\s*\{[^}]*repeat\(auto-fit,\s*minmax\(min\(100%,\s*230px\),\s*1fr\)\)/s);
    expect(styles).toMatch(/@container\s+quest-evidence\s*\(min-width:\s*760px\)[\s\S]*?repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(styles).toMatch(/@container\s+quest-evidence\s*\(min-width:\s*1060px\)[\s\S]*?repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(styles).toMatch(/\.grounded-ai-quest-evidence-item\s*\{[^}]*min-width:\s*0/s);
  });
});
