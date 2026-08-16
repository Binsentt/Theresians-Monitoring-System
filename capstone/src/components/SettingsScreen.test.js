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

const setInputValue = (input, value) => {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  valueSetter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

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
    localStorage.setItem('rememberToken', 'settings-session-token');
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

  test('submits normal password changes with the current password to the authenticated server route', async () => {
    global.fetch = jest.fn((url) => Promise.resolve({
      ok: true,
      json: async () => (String(url).includes('/api/account/password')
        ? {
          success: true,
          user: { id: 8, name: 'Parent Teacher', email: 'parent-teacher@example.com', role: 'parent_teacher' },
          rememberToken: 'refreshed-settings-token',
        }
        : {
          id: 8,
          name: 'Parent Teacher',
          email: 'parent-teacher@example.com',
          role: 'parent_teacher',
        }),
    }));

    await act(async () => {
      root.render(<SettingsScreen />);
    });

    const passwordTab = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Change Password'));
    await act(async () => {
      passwordTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const changeButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Change Password');
    await act(async () => {
      changeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const passwordInputs = container.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(passwordInputs[0], 'current-password');
      setInputValue(passwordInputs[1], 'new-permanent-password-123');
      setInputValue(passwordInputs[2], 'new-permanent-password-123');
      container.querySelector('.password-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const passwordRequest = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/account/password'));
    expect(passwordRequest).toBeTruthy();
    expect(passwordRequest[1].headers.Authorization).toBe('Bearer settings-session-token');
    expect(JSON.parse(passwordRequest[1].body)).toEqual({
      currentPassword: 'current-password',
      newPassword: 'new-permanent-password-123',
    });
  });
});
