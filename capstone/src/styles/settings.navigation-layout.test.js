import fs from 'fs';
import path from 'path';

const stylesheet = fs.readFileSync(path.resolve(__dirname, 'settings.css'), 'utf8');

test('Settings profile navigation uses a full-width horizontal toolbar', () => {
  const contentRule = stylesheet.match(/\.settings-content\s*\{([^}]*)\}/s)?.[1] || '';
  const sidebarRule = stylesheet.match(/\.settings-sidebar\s*\{([^}]*)\}/s)?.[1] || '';

  expect(contentRule).toContain('grid-template-columns: minmax(0, 1fr)');
  expect(sidebarRule).toContain('flex-direction: row');
  expect(sidebarRule).toContain('flex-wrap: wrap');
  expect(sidebarRule).toContain('width: 100%');
});
