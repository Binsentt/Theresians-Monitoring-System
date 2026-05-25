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
});
