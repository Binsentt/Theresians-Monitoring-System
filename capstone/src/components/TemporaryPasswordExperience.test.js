import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TemporaryPasswordExperience from './TemporaryPasswordExperience';

jest.mock('../api', () => ({ apiUrl: (path) => path }));

const setInputValue = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('TemporaryPasswordExperience', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    localStorage.setItem('rememberToken', 'temporary-password-token');
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 8,
      name: 'Parent Teacher',
      role: 'parent_teacher',
      mustChangePassword: true,
      requiresInitialPasswordSetup: true,
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('keeps the role dashboard visible, persists a reminder after Not Now, and clears it after confirmed setup', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        user: {
          id: 8,
          name: 'Parent Teacher',
          role: 'parent_teacher',
          mustChangePassword: false,
          requiresInitialPasswordSetup: false,
        },
        rememberToken: 'permanent-password-token',
      }),
    }));

    await act(async () => {
      root.render(
        <TemporaryPasswordExperience>
          <div data-testid="role-dashboard">Parent/Teacher Dashboard</div>
        </TemporaryPasswordExperience>
      );
    });

    expect(container.querySelector('[data-testid="role-dashboard"]')).toBeTruthy();
    expect(container.textContent).toContain('Change Your Temporary Password');

    const notNowButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Not Now');
    await act(async () => {
      notNowButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Your account is still using a temporary password.');
    const changePasswordButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Change Password');
    await act(async () => {
      changePasswordButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const passwordInputs = container.querySelectorAll('input[type="password"]');
    await setInputValue(passwordInputs[0], 'permanent-password-123');
    await setInputValue(passwordInputs[1], 'permanent-password-123');

    const continueButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Continue');
    await act(async () => {
      continueButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Are you sure you want to use this as your new permanent password?');
    expect(container.textContent).not.toContain('permanent-password-123');

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Confirm');
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/account/initial-password', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer temporary-password-token' }),
      body: JSON.stringify({ newPassword: 'permanent-password-123' }),
    }));
    expect(container.textContent).not.toContain('Your account is still using a temporary password.');
    expect(JSON.parse(localStorage.getItem('loggedInUser')).mustChangePassword).toBe(false);
    expect(localStorage.getItem('rememberToken')).toBe('permanent-password-token');
  });

  test.each(['admin', 'teacher', 'parent', 'parent_teacher'])('does not show a temporary-password prompt for an established %s account', async (role) => {
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 20,
      name: `Established ${role}`,
      role,
      mustChangePassword: false,
      requiresInitialPasswordSetup: false,
    }));

    await act(async () => {
      root.render(
        <TemporaryPasswordExperience>
          <div>Established dashboard</div>
        </TemporaryPasswordExperience>
      );
    });

    expect(container.textContent).not.toContain('Change Your Temporary Password');
    expect(container.textContent).not.toContain('Your account is still using a temporary password.');
  });

  test.each(['admin', 'teacher', 'parent', 'parent_teacher'])('shows the temporary-password prompt for a newly issued %s account', async (role) => {
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 30,
      name: `New ${role}`,
      role,
      mustChangePassword: true,
      requiresInitialPasswordSetup: true,
    }));

    await act(async () => {
      root.render(
        <TemporaryPasswordExperience>
          <div>New account dashboard</div>
        </TemporaryPasswordExperience>
      );
    });

    expect(container.textContent).toContain('Change Your Temporary Password');
  });

  test('does not infer temporary-password eligibility from a legacy or missing frontend marker', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 40,
      name: 'Legacy Admin',
      role: 'admin',
      mustChangePassword: true,
    }));

    await act(async () => {
      root.render(
        <TemporaryPasswordExperience>
          <div>Legacy dashboard</div>
        </TemporaryPasswordExperience>
      );
    });

    expect(container.textContent).not.toContain('Change Your Temporary Password');
    expect(container.textContent).not.toContain('Your account is still using a temporary password.');
  });

  test('shows first-login password strength guidance without changing the required confirmation flow', async () => {
    await act(async () => {
      root.render(<TemporaryPasswordExperience><div>Dashboard</div></TemporaryPasswordExperience>);
    });
    const changeNow = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Change Password Now');
    await act(async () => {
      changeNow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const passwordInput = container.querySelector('#dashboard-new-password');
    await setInputValue(passwordInput, 'short');
    expect(container.textContent).toContain('Password Strength: Very Weak');
    expect(container.textContent).toContain('Password must be at least 8 characters.');

    await setInputValue(passwordInput, 'Eight8!x');
    expect(container.textContent).toContain('Password Strength: Strong');
  });
});
