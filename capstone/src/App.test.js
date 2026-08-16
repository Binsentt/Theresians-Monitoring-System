import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

jest.mock('./assets/images/STS_Logo.png', () => 'logo.png');

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

  test('blocks direct dashboard routes until a temporary-password user completes forced setup', async () => {
    window.history.pushState({}, '', '/parent-dashboard');
    localStorage.setItem('rememberToken', 'pending-password-token');
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 12,
      name: 'Pending Parent',
      role: 'parent',
      mustChangePassword: true,
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
        },
      }),
    }));

    await act(async () => {
      root.render(<App />);
    });

    expect(window.location.pathname).toBe('/initial-password-setup');
    expect(container.textContent).toContain('Create Your Password');
  });
});
