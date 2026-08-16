import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

jest.mock('./assets/images/STS_Logo.png', () => 'logo.png');
jest.mock('./components/AdminDashboard', () => () => <div>Admin Dashboard</div>);
jest.mock('./components/ManageUsers', () => () => <div>Manage Users</div>);
jest.mock('./components/ParentDashboard', () => () => <div>Parent Dashboard</div>);

describe('App public auth routes', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
    window.history.pushState({}, '', '/');
  });

  test('redirects direct /change-password access back to the normal login page', async () => {
    window.history.pushState({}, '', '/change-password');

    await act(async () => {
      root.render(<App />);
    });

    expect(window.location.pathname).toBe('/login');
    expect(container.textContent).toContain('Enter your Credentials');
    expect(container.textContent).not.toContain('Create a New Password');
  });

  test('keeps a temporary-password user in the normal dashboard with the styled password prompt', async () => {
    window.history.pushState({}, '', '/parent-dashboard');
    localStorage.setItem('rememberToken', 'pending-password-token');
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 12,
      name: 'Pending Parent',
      role: 'parent',
      mustChangePassword: true,
      requiresInitialPasswordSetup: true,
    }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        user: {
          id: 12,
          name: 'Pending Parent',
          role: 'parent',
          mustChangePassword: true,
          requiresInitialPasswordSetup: true,
        },
      }),
    }));

    await act(async () => {
      root.render(<App />);
    });

    expect(window.location.pathname).toBe('/parent-dashboard');
    expect(container.textContent).toContain('Parent Dashboard');
    expect(container.textContent).toContain('Change Your Temporary Password');
  });

  test('uses the restored server eligibility marker instead of a stale local temporary flag', async () => {
    window.history.pushState({}, '', '/admin-dashboard');
    localStorage.setItem('rememberToken', 'established-admin-token');
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 1,
      name: 'Established Admin',
      role: 'admin',
      mustChangePassword: true,
    }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        user: {
          id: 1,
          name: 'Established Admin',
          role: 'admin',
          mustChangePassword: false,
          requiresInitialPasswordSetup: false,
        },
      }),
    }));

    await act(async () => {
      root.render(<App />);
    });

    expect(window.location.pathname).toBe('/admin-dashboard');
    expect(container.textContent).not.toContain('Change Your Temporary Password');
  });

  test('keeps the dashboard content mounted while revalidating a sidebar route change', async () => {
    window.history.pushState({}, '', '/admin-dashboard');
    localStorage.setItem('rememberToken', 'established-admin-token');
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 1,
      name: 'Established Admin',
      role: 'admin',
      requiresInitialPasswordSetup: false,
    }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        user: {
          id: 1,
          name: 'Established Admin',
          role: 'admin',
          requiresInitialPasswordSetup: false,
        },
      }),
    }));

    await act(async () => {
      root.render(<App />);
    });
    expect(container.textContent).toContain('Admin Dashboard');

    let resolveRevalidation;
    global.fetch.mockImplementation(() => new Promise((resolve) => {
      resolveRevalidation = resolve;
    }));

    await act(async () => {
      window.history.pushState({}, '', '/manage-users');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('Manage Users');

    await act(async () => {
      resolveRevalidation({
        ok: true,
        status: 200,
        json: async () => ({
          valid: true,
          user: {
            id: 1,
            name: 'Established Admin',
            role: 'admin',
            requiresInitialPasswordSetup: false,
          },
        }),
      });
    });
  });
});
