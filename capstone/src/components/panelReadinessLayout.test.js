import fs from 'fs';
import path from 'path';

describe('panel-readiness desktop layout contracts', () => {
  const readStyle = (name) => fs.readFileSync(path.join(__dirname, '..', 'styles', name), 'utf8');

  test('Lesson Manager tables fit desktop content widths while retaining a small-screen scroll fallback', () => {
    const css = readStyle('lessonQuestionManager.css');
    expect(css).toMatch(/@media \(min-width: 1100px\)[\s\S]*\.drive-table \.data-table[\s\S]*min-width: 0/);
    expect(css).toMatch(/@media \(max-width: 1099px\)[\s\S]*\.drive-table \.data-table[\s\S]*min-width: 980px/);
  });

  test('Student Insights spans the full filter panel width below filters', () => {
    const css = readStyle('studentprogress.css');
    expect(css).toMatch(/\.analytics-insights-panel\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1/);
    expect(css).not.toMatch(/@media \(min-width: 1200px\)[\s\S]*grid-template-columns:\s*1\.5fr 1fr/);
  });
});
