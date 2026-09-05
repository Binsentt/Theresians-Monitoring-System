import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ResetPassword from './ResetPassword';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const setInputValue = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ResetPassword auth theme integration', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({}),
      })
    );
    global.alert = jest.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
    delete global.alert;
  });

  test('renders the forgot password page with the shared auth shell', async () => {
    await act(async () => {
      root.render(<ResetPassword />);
    });

    expect(container.querySelector('.login-page-wrapper')).toBeTruthy();
    expect(container.querySelector('.login-flex-container')).toBeTruthy();
    expect(container.querySelector('.login-card-main')).toBeTruthy();
    expect(container.textContent).toContain('Account Recovery');
    expect(container.textContent).toContain('Reset Password');
  });

  test('keeps the reset flow working after the send code action', async () => {
    await act(async () => {
      root.render(<ResetPassword />);
    });

    const emailInput = container.querySelector('input[type="email"]');

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      valueSetter.call(emailInput, 'teacher@example.com');
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendCodeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'SEND VERIFICATION CODE'
    );

    await act(async () => {
      sendCodeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/reset-password/send-code',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(container.textContent).toContain('Code sent to:');
  });

  test('shows strength feedback and blocks a too-short recovery password before the request', async () => {
    await act(async () => {
      root.render(<ResetPassword />);
    });

    await setInputValue(container.querySelector('input[type="email"]'), 'teacher@example.com');
    const sendCodeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'SEND VERIFICATION CODE'
    );
    await act(async () => {
      sendCodeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await setInputValue(container.querySelector('input[placeholder="6-Digit Verification Code"]'), '123456');
    await setInputValue(container.querySelector('input[placeholder="Enter your new password"]'), 'short');
    await setInputValue(container.querySelector('input[placeholder="Re-enter your new password"]'), 'short');
    expect(container.textContent).toContain('Password Strength: Very Weak');

    const updateButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'UPDATE PASSWORD'
    );
    await act(async () => {
      updateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.alert).toHaveBeenCalledWith('Password must be at least 8 characters.');
    expect(global.fetch.mock.calls.filter(([url]) => String(url).includes('/api/reset-password/verify'))).toHaveLength(0);
  });
});
