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

test('page entrance does not retain a transformed containing block after the animation', () => {
  const stylesheet = fs.readFileSync(path.resolve(__dirname, '../../styles/layout.css'), 'utf8');
  const transition = stylesheet.match(/\.page-content-transition\s*\{([^}]*)\}/s)[1];
  expect(transition).not.toMatch(/\b(both|forwards)\b/);
});

test('table horizontal scrolling allows native vertical scroll chaining to the page', () => {
  const stylesheet = fs.readFileSync(path.resolve(__dirname, '../../styles/global.css'), 'utf8');
  const tableRule = stylesheet.match(/\.table-container,\s*\.data-table-wrapper,[\s\S]*?\{([^}]*)\}/)[1];
  expect(tableRule).toContain('overscroll-behavior-y: auto');
});

test('shared dashboard shell keeps native main-content scrolling reachable without wheel interception', () => {
  const layoutStyles = fs.readFileSync(path.resolve(__dirname, '../../styles/layout.css'), 'utf8');
  const globalStyles = fs.readFileSync(path.resolve(__dirname, '../../styles/global.css'), 'utf8');
  const sidebarStyles = fs.readFileSync(path.resolve(__dirname, '../../styles/analyticsSidebar.css'), 'utf8');
  const managerStyles = fs.readFileSync(path.resolve(__dirname, '../../styles/lessonQuestionManager.css'), 'utf8');
  const userStyles = fs.readFileSync(path.resolve(__dirname, '../../styles/manageusers.css'), 'utf8');
  const parentStyles = fs.readFileSync(path.resolve(__dirname, '../../styles/parentdashboard.css'), 'utf8');
  const settingsStyles = fs.readFileSync(path.resolve(__dirname, '../../styles/settings.css'), 'utf8');
  const rule = (styles, selector) => styles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';

  const dashboard = rule(layoutStyles, '\\.dashboard-container');
  const main = rule(layoutStyles, '\\.main-content');
  const page = rule(layoutStyles, '\\.page-content');
  const sidebar = rule(sidebarStyles, '\\.analytics-sidebar-panel');

  expect(dashboard).toContain('height: 100vh');
  expect(dashboard).toContain('min-height: 0');
  expect(main).toContain('min-height: 0');
  expect(page).toContain('min-height: 0');
  expect(page).toContain('overflow-y: auto');
  expect(page).toContain('overscroll-behavior-y: auto');
  expect(page).toContain('-webkit-overflow-scrolling: touch');
  expect(sidebar).toContain('overflow-y: auto');
  expect(sidebar).toContain('overscroll-behavior-y: auto');
  expect(sidebar).toContain('-webkit-overflow-scrolling: touch');

  expect(layoutStyles).not.toMatch(/wheel|touch-action\s*:\s*none/i);
  expect(managerStyles).toMatch(/\.generated-questions-preview-body\s*\{[\s\S]*overflow-y:\s*auto;/);
  expect(managerStyles).toMatch(/\.file-preview-body\s*\{[\s\S]*overflow:\s*auto;/);
  expect(userStyles).toMatch(/\.modal-content\s*\{[\s\S]*overflow-y:\s*auto;/);
  expect(parentStyles).toMatch(/\.parent-add-child-modal\s*\{[\s\S]*overflow-y:\s*auto;/);
  expect(settingsStyles).toMatch(/\.temporary-password-modal\s*\{[\s\S]*overflow-y:\s*auto;/);
  expect(globalStyles).toMatch(/\.table-container,[\s\S]*overflow-x:\s*auto;/);
});
