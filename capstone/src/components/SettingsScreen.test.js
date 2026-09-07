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

    const sidebar = document.body.querySelector('[data-testid="dashboard-sidebar"]');
    expect(document.body.querySelector('[data-testid="dashboard-shell"]')).toBeTruthy();
    expect(sidebar).toBeTruthy();
    expect(sidebar.dataset.role).toBe('parent_teacher');
    expect(sidebar.dataset.activeItem).toBe('settings');
    expect(document.body.textContent).toContain('Settings');
    expect(document.body.querySelector('.back-btn')).toBeNull();
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

    const passwordTab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Change Password'));
    await act(async () => {
      passwordTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const changeButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Change Password');
    await act(async () => {
      changeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const passwordInputs = document.body.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(passwordInputs[0], 'current-password');
      setInputValue(passwordInputs[1], 'new-permanent-password-123');
      setInputValue(passwordInputs[2], 'new-permanent-password-123');
      document.body.querySelector('.password-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const passwordRequest = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/account/password'));
    expect(passwordRequest).toBeTruthy();
    expect(passwordRequest[1].headers.Authorization).toBe('Bearer settings-session-token');
    expect(JSON.parse(passwordRequest[1].body)).toEqual({
      currentPassword: 'current-password',
      newPassword: 'new-permanent-password-123',
    });
  });

  test('shows temporary-password security warning and uses the first-login endpoint without a current password', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 8,
      name: 'Parent Teacher',
      email: 'parent-teacher@example.com',
      role: 'parent_teacher',
      mustChangePassword: true,
      requiresInitialPasswordSetup: true,
    }));
    global.fetch = jest.fn((url) => Promise.resolve({
      ok: true,
      json: async () => (String(url).includes('/api/account/initial-password')
        ? {
          success: true,
          user: {
            id: 8,
            name: 'Parent Teacher',
            email: 'parent-teacher@example.com',
            role: 'parent_teacher',
            mustChangePassword: false,
            requiresInitialPasswordSetup: false,
          },
          rememberToken: 'permanent-settings-token',
        }
        : {
          id: 8,
          name: 'Parent Teacher',
          email: 'parent-teacher@example.com',
          role: 'parent_teacher',
          mustChangePassword: true,
          requiresInitialPasswordSetup: true,
        }),
    }));

    await act(async () => {
      root.render(<SettingsScreen />);
    });

    const passwordTab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Change Password'));
    await act(async () => {
      passwordTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Your account is still using a temporary password.');
    expect(document.body.textContent).not.toContain('Current Password *');
    const passwordInputs = document.body.querySelectorAll('input[type="password"]');
    expect(passwordInputs).toHaveLength(2);

    await act(async () => {
      setInputValue(passwordInputs[0], 'new-permanent-password-123');
      setInputValue(passwordInputs[1], 'new-permanent-password-123');
      document.body.querySelector('.password-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(document.body.textContent).toContain('Are you sure you want to use this as your new permanent password?');
    const confirmButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Confirm');
    const confirmationDialog = document.querySelector('[aria-labelledby="settings-confirm-password-title"]');
    expect(confirmationDialog.parentElement.parentElement).toBe(document.body);
    expect(confirmationDialog.contains(document.activeElement)).toBe(true);
    await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[aria-labelledby="settings-confirm-password-title"]')).toBe(confirmationDialog);
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const passwordRequest = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/account/initial-password'));
    expect(passwordRequest).toBeTruthy();
    expect(passwordRequest[1].headers.Authorization).toBe('Bearer settings-session-token');
    expect(JSON.parse(passwordRequest[1].body)).toEqual({ newPassword: 'new-permanent-password-123' });
    expect(document.body.textContent).not.toContain('Your account is still using a temporary password.');
  });

  test('keeps the normal current-password form when authoritative account state is permanent', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 1,
      name: 'Established Admin',
      email: 'admin@example.com',
      role: 'admin',
      mustChangePassword: true,
      requiresInitialPasswordSetup: false,
    }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        id: 1,
        name: 'Established Admin',
        email: 'admin@example.com',
        role: 'admin',
        mustChangePassword: true,
        requiresInitialPasswordSetup: false,
      }),
    }));

    await act(async () => {
      root.render(<SettingsScreen />);
    });
    const passwordTab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Change Password'));
    await act(async () => {
      passwordTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).not.toContain('Your account is still using a temporary password.');

    const openFormButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Change Password');
    await act(async () => {
      openFormButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Current Password *');
    expect(document.body.querySelectorAll('input[type="password"]')).toHaveLength(3);
  });

  test('shows inline password strength guidance for the normal settings password flow', async () => {
    await act(async () => {
      root.render(<SettingsScreen />);
    });
    const passwordTab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Change Password'));
    await act(async () => {
      passwordTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const openFormButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Change Password');
    await act(async () => {
      openFormButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const passwordInputs = document.body.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(passwordInputs[1], 'short');
    });
    expect(document.body.textContent).toContain('Password Strength: Very Weak');
    expect(document.body.textContent).toContain('At least 8 characters required');

    await act(async () => {
      setInputValue(passwordInputs[1], 'Eight8!x');
    });
    expect(document.body.textContent).toContain('Password Strength: Strong');

    await act(async () => {
      setInputValue(passwordInputs[1], 'eight888');
    });
    expect(document.body.textContent).toContain('Password Strength: Fair');
  });

  test('keeps optional profile mobile blank and rejects a supplied non-local Philippine format inline', async () => {
    await act(async () => {
      root.render(<SettingsScreen />);
    });
    const editProfileButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Edit Profile');
    await act(async () => {
      editProfileButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const mobile = document.body.querySelector('input[placeholder="09XXXXXXXXX"]');
    await act(async () => {
      setInputValue(mobile, '0917-123-4567');
    });
    expect(document.body.textContent).toContain('Mobile number must be in the format 09XXXXXXXXX.');
    await act(async () => {
      setInputValue(mobile, '');
    });
    expect(document.body.textContent).not.toContain('Mobile number must be in the format 09XXXXXXXXX.');
  });

  test('omits an unchanged legacy mobile number from an unrelated profile update', async () => {
    const legacyUser = {
      id: 8,
      name: 'Parent Teacher',
      email: 'parent-teacher@gmail.com',
      role: 'parent_teacher',
      mobile_number: '0917-123-4567',
    };
    global.fetch = jest.fn((url, options = {}) => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (options.method === 'PUT' ? { user: legacyUser } : legacyUser),
    }));

    await act(async () => {
      root.render(<SettingsScreen />);
    });
    const editProfileButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Edit Profile');
    await act(async () => {
      editProfileButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const mobile = document.body.querySelector('input[placeholder="09XXXXXXXXX"]');
    expect(mobile.value).toBe('0917-123-4567');
    expect(mobile.type).toBe('tel');
    expect(mobile.inputMode).toBe('numeric');
    expect(mobile.maxLength).toBe(11);

    await act(async () => {
      setInputValue(document.body.querySelector('input[value="Parent"]'), 'Updated');
      document.body.querySelector('.profile-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const updateRequest = global.fetch.mock.calls.find(([url, options]) => (
      String(url).includes('/api/user/8') && options?.method === 'PUT'
    ));
    expect(updateRequest).toBeTruthy();
    const payload = JSON.parse(updateRequest[1].body);
    expect(payload.name).toBe('Updated Teacher');
    expect(payload).not.toHaveProperty('mobile_number');
  });
});
