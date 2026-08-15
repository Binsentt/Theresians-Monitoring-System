import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import SettingsScreen from './SettingsScreen';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ sidebar, main }) => <div data-testid="dashboard-shell">{sidebar}{main}</div>,
  MainContent: ({ children }) => <main>{children}</main>,
  TopBar: ({ children }) => <header>{children}</header>,
  PageContent: ({ children }) => <section>{children}</section>,
}));

jest.mock('./layout/AnalyticsSidebar', () => (props) => (
  <div data-testid="dashboard-sidebar" data-role={props.role} data-active-item={props.activeItem}>Dashboard sidebar</div>
));
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

describe('SettingsScreen dashboard layout', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 8,
      name: 'Parent Teacher',
      email: 'parent-teacher@example.com',
      role: 'parent_teacher',
    }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        id: 8,
        name: 'Parent Teacher',
        email: 'parent-teacher@example.com',
        role: 'parent_teacher',
      }),
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('uses the role-aware dashboard sidebar and removes the redundant Back button', async () => {
    await act(async () => {
      root.render(<SettingsScreen />);
    });

    const sidebar = container.querySelector('[data-testid="dashboard-sidebar"]');
    expect(container.querySelector('[data-testid="dashboard-shell"]')).toBeTruthy();
    expect(sidebar).toBeTruthy();
    expect(sidebar.dataset.role).toBe('parent_teacher');
    expect(sidebar.dataset.activeItem).toBe('settings');
    expect(container.textContent).toContain('Settings');
    expect(container.querySelector('.back-btn')).toBeNull();
  });
});
