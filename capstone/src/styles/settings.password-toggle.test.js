import fs from 'fs';
import path from 'path';

const stylesheet = fs.readFileSync(path.resolve(__dirname, 'settings.css'), 'utf8');

test('Settings password visibility controls stay anchored in every pointer state', () => {
  const selector = `.settings-container .password-input-wrapper > .password-toggle-button,\n.settings-container .password-input-wrapper > .password-toggle-button:hover,\n.settings-container .password-input-wrapper > .password-toggle-button:active,\n.settings-container .password-input-wrapper > .password-toggle-button:focus,\n.settings-container .password-input-wrapper > .password-toggle-button:focus-visible`;
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';

  expect(rule).toContain('top: 50%');
  expect(rule).toContain('right: 12px');
  expect(rule).toContain('bottom: auto');
  expect(rule).toContain('margin: 0');
  expect(rule).toContain('padding: 5px');
  expect(rule).toContain('transform: none !important');
  expect(rule).toContain('translate: 0 -50%');
});
