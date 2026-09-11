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
});
