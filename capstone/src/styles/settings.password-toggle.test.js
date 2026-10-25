import fs from 'fs';
import path from 'path';

const stylesheet = fs.readFileSync(path.resolve(__dirname, 'settings.css'), 'utf8').replace(/\r\n/g, '\n');

test('Settings password visibility controls stay anchored in every pointer state', () => {
  const baseSelector = '.settings-container .password-input-wrapper > .password-toggle-button';
  const selectors = [baseSelector, ':hover', ':active', ':focus', ':focus-visible']
    .map((state) => (state.startsWith(':') ? `${baseSelector}${state}` : state));
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selectorGroup = selectors.map(escapeRegex).join('\\s*,\\s*');
  const rule = stylesheet.match(new RegExp(`${selectorGroup}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';

  expect(rule).toContain('top: 50%');
  expect(rule).toContain('right: 12px');
  expect(rule).toContain('bottom: auto');
  expect(rule).toContain('margin: 0');
  expect(rule).toContain('padding: 5px');
  expect(rule).toContain('translate: 0 -50%');
  expect(rule).toContain('transform: none !important');
});
