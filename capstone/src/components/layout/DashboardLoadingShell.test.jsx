import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DashboardLoadingShell from './DashboardLoadingShell';

jest.mock('./AnalyticsSidebar', () => ({ role, activeItem }) => (
  <aside data-testid="dashboard-sidebar">{`${role}:${activeItem}`}</aside>
));

jest.mock('./AppLayout', () => ({
  DashboardContainer: ({ sidebar, main }) => <div data-testid="dashboard">{sidebar}{main}</div>,
  MainContent: ({ children }) => <main>{children}</main>,
  TopBar: ({ children }) => <header>{children}</header>,
  PageContent: ({ children }) => <section>{children}</section>,
}));

test('renders the route title, sidebar, and inline skeleton without visible loading text', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <DashboardLoadingShell
        role="admin"
        activeItem="manage-users"
        portalLabel="Admin Portal"
        heading="Manage Users"
        subheading="Manage website accounts."
      />
    );
  });

  expect(container.querySelector('[data-testid="dashboard"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="dashboard-sidebar"]').textContent).toBe('admin:manage-users');
  expect(container.textContent).toContain('Manage Users');
  expect(container.textContent).not.toContain('Loading...');
  expect(container.querySelector('.dashboard-inline-loading')).toBeTruthy();

  await act(async () => {
    root.unmount();
  });
  delete global.IS_REACT_ACT_ENVIRONMENT;
});
