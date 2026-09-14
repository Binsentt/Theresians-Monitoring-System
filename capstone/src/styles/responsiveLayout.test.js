import fs from 'fs';
import path from 'path';

describe('responsive text and table layout guardrails', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, 'global.css'), 'utf8');
  const layoutStyles = fs.readFileSync(path.resolve(__dirname, 'layout.css'), 'utf8');
  const componentStyles = fs.readFileSync(path.resolve(__dirname, 'components.css'), 'utf8');
  const sidebarStyles = fs.readFileSync(path.resolve(__dirname, 'analyticsSidebar.css'), 'utf8');
  const progressStyles = fs.readFileSync(path.resolve(__dirname, 'studentprogress.css'), 'utf8');
  const manageUsersStyles = fs.readFileSync(path.resolve(__dirname, 'manageusers.css'), 'utf8');

  const rule = (source, selector) => source.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';
  const mediaBlock = (source, query, startingAt = 0) => {
    const markerIndex = source.indexOf(`@media (${query})`, startingAt);
    if (markerIndex < 0) return '';

    const openingBrace = source.indexOf('{', markerIndex);
    let depth = 1;
    for (let index = openingBrace + 1; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }

    return '';
  };
  const columnWidth = (source, column) => Number(
    source.match(new RegExp(
      `\\.student-progress-table th:nth-child\\(${column}\\),\\s*` +
      `\\.student-progress-table td:nth-child\\(${column}\\)\\s*\\{[^}]*width:\\s*(\\d+)%`,
      's'
    ))?.[1]
  );

  test('shared text and sidebar labels wrap at word boundaries instead of arbitrary characters', () => {
    expect(rule(styles, 'p,\\s*label,\\s*h1,\\s*h2,\\s*h3,\\s*h4,\\s*h5,\\s*h6')).toContain('overflow-wrap: normal');
    expect(rule(layoutStyles, '\\.header-info h1,\\s*\\.header-info p,\\s*\\.top-bar h1,\\s*\\.top-bar p')).toContain('overflow-wrap: normal');
    expect(rule(sidebarStyles, '\\.analytics-sidebar-item-label')).toContain('overflow-wrap: normal');
    expect(styles).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(layoutStyles).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(sidebarStyles).not.toMatch(/overflow-wrap:\s*anywhere/);
  });

  test('table values preserve atomic IDs/names and rely on the wrapper for narrow viewports', () => {
    const globalCells = rule(styles, 'td,\\s*th');
    const dataCells = rule(componentStyles, '\\.data-table-td');

    expect(globalCells).toContain('overflow-wrap: normal');
    expect(globalCells).toContain('word-break: normal');
    expect(dataCells).toContain('overflow-wrap: normal');
    expect(componentStyles).not.toMatch(/word-break:\s*break-all/);
    expect(manageUsersStyles).not.toMatch(/word-break:\s*break-all/);
    expect(progressStyles).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(styles).toMatch(/\.table-container,[\s\S]*overflow-x:\s*auto;/);
    expect(progressStyles).toMatch(/\.table-wrapper\s*\{[\s\S]*overflow-x:\s*auto;/);
  });

  test('Student Progress uses a compact no-scroll desktop table while retaining mobile overflow fallback', () => {
    expect(progressStyles).toMatch(/@media\s*\(min-width:\s*1200px\)[\s\S]*\.student-progress-table\s*\{[\s\S]*min-width:\s*0/);
    expect(progressStyles).toMatch(/@media\s*\(min-width:\s*1200px\)[\s\S]*table-layout:\s*fixed/);
    expect(progressStyles).toMatch(/@media\s*\(max-width:\s*980px\)[\s\S]*\.table-wrapper\s*\{[\s\S]*overflow-x:\s*auto/);
    expect(progressStyles).toMatch(/\.student-progress-table th:nth-child\(6\)/);
  });

  test.each([1366, 1440, 1536, 1920])(
    'Student Progress stays within its table wrapper at %ipx desktop width',
    (viewportWidth) => {
      const desktopStyles = mediaBlock(
        progressStyles,
        'min-width: 1200px',
        progressStyles.indexOf('.student-progress-row-actions')
      );
      const tableRule = rule(desktopStyles, '\\.student-progress-table');
      const baseTableRule = rule(progressStyles, '\\.student-progress-table');
      const wrapperRule = rule(progressStyles, '\\.table-wrapper');
      const widths = Array.from({ length: 9 }, (_, index) => columnWidth(desktopStyles, index + 1));

      expect(viewportWidth).toBeGreaterThanOrEqual(1200);
      expect(wrapperRule).toContain('max-width: 100%');
      expect(wrapperRule).toContain('min-width: 0');
      expect(baseTableRule).toContain('width: 100%');
      expect(tableRule).toContain('min-width: 0');
      expect(tableRule).toContain('table-layout: fixed');
      expect(desktopStyles).toMatch(/\.student-progress-table th,\s*\.student-progress-table td\s*\{[^}]*min-width:\s*0/s);
      expect(rule(desktopStyles, '\\.student-progress-table th')).toContain('white-space: normal');
      expect(rule(desktopStyles, '\\.student-progress-table th:nth-child\\(n\\+1\\)')).toContain('white-space: normal');
      expect(rule(desktopStyles, '\\.student-progress-table th:nth-child\\(n\\+1\\)')).toContain('min-width: 0');
      expect(widths).toEqual([4, 14, 9, 9, 8, 22, 9, 9, 16]);
      expect(widths.reduce((total, width) => total + width, 0)).toBeLessThanOrEqual(100);
    }
  );

  test.each([1024, 768, 390])(
    'Student Progress uses intentional horizontal scrolling without broken text at %ipx',
    (viewportWidth) => {
      const wrapperRule = rule(progressStyles, '\\.table-wrapper');
      const tableRule = rule(progressStyles, '\\.student-progress-table');

      expect(viewportWidth).toBeLessThan(1200);
      expect(wrapperRule).toContain('overflow-x: auto');
      expect(tableRule).toContain('min-width: 1040px');
      expect(progressStyles).not.toMatch(/word-break:\s*break-all/);
      expect(progressStyles).not.toMatch(/overflow-wrap:\s*anywhere/);
    }
  );
});
