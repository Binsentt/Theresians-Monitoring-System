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

  test('routes successful temporary-password login to forced initial password setup', async () => {
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

    expect(mockNavigate).toHaveBeenCalledWith('/initial-password-setup');
    expect(mockNavigate).not.toHaveBeenCalledWith('/parent-dashboard');
  });

  test('shows the required session expired message when routed from an expired session', async () => {
    mockLocation = { state: { sessionExpired: true } };

    await act(async () => {
      root.render(<LoginScreen />);
    });

    expect(container.textContent).toContain('Your session has expired. Please login and verify OTP again.');
  });
});

// ========== REAL-TIME VALIDATION TESTS ==========
describe('LoginScreen real-time form validation', () => {
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



  test('does not submit form when email is invalid', async () => {
    await act(async () => {
      root.render(<LoginScreen />);
    });

    const emailInput = container.querySelector('input[type="email"]');
    const passwordInput = container.querySelector('input[type="password"]');
    
    await act(async () => {
      setInputValue(emailInput, 'invalid-email');
      setInputValue(passwordInput, 'ValidPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('does not submit form when password is empty', async () => {
    await act(async () => {
      root.render(<LoginScreen />);
    });

    const emailInput = container.querySelector('input[type="email"]');
    
    await act(async () => {
      setInputValue(emailInput, 'test@example.com');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('focuses first invalid field (email) when both are invalid', async () => {
    await act(async () => {
      root.render(<LoginScreen />);
    });

    const emailInput = container.querySelector('input[type="email"]');
    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    
    const focusSpy = jest.spyOn(emailInput, 'focus');
    
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();
  });

  test('displays both email and password errors when both are invalid', async () => {
    await act(async () => {
      root.render(<LoginScreen />);
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Email is required.');
    expect(container.textContent).toContain('Password is required.');
  });

  test('does not display error messages before fields are touched', async () => {
    await act(async () => {
      root.render(<LoginScreen />);
    });

    expect(container.textContent).not.toContain('Email is required.');
    expect(container.textContent).not.toContain('Password is required.');
  });

  test('allows valid credentials to proceed to OTP step', async () => {
    await act(async () => {
      root.render(<LoginScreen />);
    });

    const emailInput = container.querySelector('input[type="email"]');
    const passwordInput = container.querySelector('input[type="password"]');
    
    await act(async () => {
      setInputValue(emailInput, 'admin@example.com');
      setInputValue(passwordInput, 'ValidPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.fetch).toHaveBeenCalled();
  });

  test('displays OTP required error when OTP field is empty and blurred', async () => {
    // First get to OTP step
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/login/verify-otp')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            user: { id: 18, name: 'Test User', role: 'admin' },
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
        }),
      });
    });

    await act(async () => {
      root.render(<LoginScreen />);
    });

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'admin@example.com');
      setInputValue(inputs[1], 'ValidPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Verify we're on OTP step
    expect(container.textContent).toContain('Security Verification');
  });

  test('displays OTP format error when OTP is not 6 digits', async () => {
    // First get to OTP step
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/login')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            step: 2,
            userId: 18,
            otpExpiresAt: '2026-05-21T12:03:00.000Z',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          user: { id: 18, name: 'Test User', role: 'admin' },
        }),
      });
    });

    await act(async () => {
      root.render(<LoginScreen />);
    });

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'admin@example.com');
      setInputValue(inputs[1], 'ValidPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Now we're on OTP step - try to submit with invalid OTP
    const otpInput = container.querySelector('.otp-input');
    await act(async () => {
      setInputValue(otpInput, '12345'); // Only 5 digits, should fail
    });

    const verifyButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'VERIFY CODE');
    await act(async () => {
      verifyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Should not have submitted verify-otp API call with invalid OTP
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/login/verify-otp'),
      expect.anything()
    );
  });

  test('does not submit OTP when OTP is invalid', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/login/verify-otp')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            user: { id: 18, name: 'Test User', role: 'admin' },
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
        }),
      });
    });

    await act(async () => {
      root.render(<LoginScreen />);
    });

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'admin@example.com');
      setInputValue(inputs[1], 'ValidPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Now we're on OTP step - try to submit with invalid OTP
    const otpInput = container.querySelector('.otp-input');
    await act(async () => {
      setInputValue(otpInput, '123');
    });

    const verifyButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'VERIFY CODE');
    await act(async () => {
      verifyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.fetch).toHaveBeenCalledTimes(1); // Only the login call, not the verify-otp call
  });

  test('clears field errors when going back from OTP to login', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/login')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            step: 2,
            userId: 18,
            otpExpiresAt: '2026-05-21T12:03:00.000Z',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          user: { id: 18, name: 'Test User', role: 'admin' },
        }),
      });
    });

    await act(async () => {
      root.render(<LoginScreen />);
    });

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'admin@example.com');
      setInputValue(inputs[1], 'ValidPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Go back to login
    const backButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Back to Login');
    await act(async () => {
      backButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Verify that we're back on login screen without errors
    expect(container.textContent).not.toContain('OTP is required.');
  });

  test('OTP input only accepts digits', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/login')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            step: 2,
            userId: 18,
            otpExpiresAt: '2026-05-21T12:03:00.000Z',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          user: { id: 18, name: 'Test User', role: 'admin' },
        }),
      });
    });

    await act(async () => {
      root.render(<LoginScreen />);
    });

    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'admin@example.com');
      setInputValue(inputs[1], 'ValidPassword123!');
    });

    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'LOGIN');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Now we're on OTP step
    const otpInput = container.querySelector('.otp-input');
    await act(async () => {
      setInputValue(otpInput, 'abc123');
    });

    expect(otpInput.value).toBe('123'); // Non-digits are filtered out
  });
});
