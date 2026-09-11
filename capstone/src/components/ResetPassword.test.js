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

    expect(container.textContent).toContain('Password must be at least 8 characters.');
    expect(global.alert).not.toHaveBeenCalled();
    expect(global.fetch.mock.calls.filter(([url]) => String(url).includes('/api/reset-password/verify'))).toHaveLength(0);
  });

  test('shows accessible inline email validation without revealing account existence', async () => {
    await act(async () => {
      root.render(<ResetPassword />);
    });

    const emailInput = container.querySelector('input[type="email"]');
    const focusSpy = jest.spyOn(emailInput, 'focus');
    const sendButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'SEND VERIFICATION CODE');
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Email is required.');
    expect(emailInput.getAttribute('aria-invalid')).toBe('true');
    expect(emailInput.getAttribute('aria-describedby')).toBe('recovery-email-error');
    expect(global.alert).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();

    await setInputValue(emailInput, 'not-an-email');
    expect(container.textContent).toContain('Please enter a valid email address.');
    await setInputValue(emailInput, 'qa@example.test');
    expect(container.textContent).not.toContain('Please enter a valid email address.');
  });

  test('uses a six-digit one-time-code field and inline confirmation validation', async () => {
    await act(async () => {
      root.render(<ResetPassword />);
    });
    await setInputValue(container.querySelector('input[type="email"]'), 'qa@example.test');
    await act(async () => {
      container.querySelector('input[type="email"]').dispatchEvent(new Event('blur', { bubbles: true }));
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'SEND VERIFICATION CODE')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const otpInput = container.querySelector('input[autocomplete="one-time-code"]');
    expect(otpInput).toBeTruthy();
    expect(otpInput.getAttribute('inputmode')).toBe('numeric');
    expect(otpInput.maxLength).toBe(6);

    await setInputValue(container.querySelector('input[placeholder="Enter your new password"]'), 'ValidPass1!');
    await setInputValue(container.querySelector('input[placeholder="Re-enter your new password"]'), 'Different1!');
    expect(container.textContent).toContain('Passwords do not match.');
    expect(global.alert).not.toHaveBeenCalled();
  });

  test('prevents duplicate recovery submissions while the request is in flight', async () => {
    let resolveRequest;
    global.fetch = jest.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    await act(async () => {
      root.render(<ResetPassword />);
    });
    const emailInput = container.querySelector('input[type="email"]');
    await setInputValue(emailInput, 'qa@example.test');
    const sendButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'SEND VERIFICATION CODE');
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRequest({ ok: true, json: async () => ({ success: true, message: 'If an eligible account matches this email, recovery instructions will be sent.' }) });
    });
  });
});
