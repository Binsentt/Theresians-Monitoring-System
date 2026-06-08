import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LoginScreen from './LoginScreen';

const mockNavigate = jest.fn();
let mockLocation = { state: null };

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => mockLocation,
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
    mockLocation = { state: null };
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

    expect(container.textContent).toContain('Trust this device for 30 days');
    expect(container.querySelector('input[type="checkbox"]').checked).toBe(false);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
      deviceId: 'browser-device-123',
    });
  });

  test('sends the trusted device choice when verifying OTP', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/login/verify-otp')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            rememberToken: 'thirty-day-token',
            user: { id: 18, name: 'Teacher User', role: 'teacher' },
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          step: 2,
          userId: 18,
          otpExpiresAt: '2026-05-21T12:03:00.000Z',
          emailSent: true,
        }),
      });
    });

    await act(async () => {
      root.render(<LoginScreen />);
    });

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'teacher@example.com');
      setInputValue(inputs[1], 'StrongPassword123!');
    });

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const otpInput = container.querySelector('.otp-input');
    const trustedDeviceCheckbox = container.querySelector('input[type="checkbox"]');
    await act(async () => {
      setInputValue(otpInput, '123456');
      trustedDeviceCheckbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'VERIFY CODE')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toMatchObject({
      userId: 18,
      otp: '123456',
      deviceId: 'browser-device-123',
      skipOtpFor30Days: true,
    });
    expect(localStorage.getItem('rememberToken')).toBe('thirty-day-token');
    expect(mockNavigate).toHaveBeenCalledWith('/teacher-dashboard');
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

  test('shows the required session expired message when routed from an expired session', async () => {
    mockLocation = { state: { sessionExpired: true } };

    await act(async () => {
      root.render(<LoginScreen />);
    });

    expect(container.textContent).toContain('Your session has expired. Please login and verify OTP again.');
  });
});
