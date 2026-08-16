import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import { PageContent } from './AppLayout';

test('PageContent uses the shared content-transition wrapper', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(<PageContent>Page body</PageContent>);
  });

  const content = container.querySelector('.page-content');
  expect(content.classList.contains('page-content-transition')).toBe(true);
  expect(content.textContent).toBe('Page body');
  await act(async () => {
    root.unmount();
  });
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

test('shared content transition honors reduced-motion preferences', () => {
  const stylesheet = fs.readFileSync(path.resolve(__dirname, '../../styles/layout.css'), 'utf8');

  expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.page-content-transition\s*\{\s*animation:\s*none;/);
  expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dashboard-inline-skeleton\s*\{\s*animation:\s*none;/);
});
