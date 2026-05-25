import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LoginScreen from './LoginScreen';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const setInputValue = (input, value) => {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  valueSetter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('LoginScreen OTP device controls', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loginDeviceId', 'browser-device-123');
    global.alert = jest.fn();
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        success: true,
        step: 2,
        userId: 18,
        otpExpiresAt: '2026-05-21T12:03:00.000Z',
        emailSent: true,
      }),
    }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
    delete global.alert;
  });

  test('offers the opt-in 30-day OTP device checkbox on verification step', async () => {
    await act(async () => {
      root.render(<LoginScreen />);
    });

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'admin@example.com');
      setInputValue(inputs[1], 'StrongPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain("Don't send OTP for 30 days on this device");
    expect(container.querySelector('input[type="checkbox"]').checked).toBe(false);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
      deviceId: 'browser-device-123',
    });
  });

  test('routes successful login to the role dashboard even when mustChangePassword is true', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        success: true,
        mustChangePassword: true,
        user: {
          id: 25,
          name: 'Parent User',
          email: 'parent@example.com',
          role: 'parent',
          mustChangePassword: true,
        },
      }),
    }));

    await act(async () => {
      root.render(<LoginScreen />);
    });

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'parent@example.com');
      setInputValue(inputs[1], 'GeneratedPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith('/parent-dashboard');
    expect(mockNavigate).not.toHaveBeenCalledWith('/change-password', { replace: true });
  });
});
