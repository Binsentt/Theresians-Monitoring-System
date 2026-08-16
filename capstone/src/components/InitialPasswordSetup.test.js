import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import InitialPasswordSetup from './InitialPasswordSetup';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

describe('InitialPasswordSetup', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('rememberToken', 'first-login-token');
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 7,
      name: 'First Login Teacher',
      role: 'teacher',
      mustChangePassword: true,
    }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        success: true,
        user: { id: 7, name: 'First Login Teacher', role: 'teacher', mustChangePassword: false },
        rememberToken: 'refreshed-token',
      }),
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('shows only new-password and confirmation inputs for the forced setup flow', async () => {
    await act(async () => {
      root.render(<InitialPasswordSetup />);
    });

    expect(container.textContent).toContain('Create Your Password');
    expect(container.textContent).toContain('New Password');
    expect(container.textContent).toContain('Confirm New Password');
    expect(container.textContent).not.toContain('Current Password');
  });
});
