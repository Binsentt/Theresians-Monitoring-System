import {
  buildAuthHeaders,
  getStoredUserSession,
  resolveAuthorizedSession,
  SESSION_STORAGE_KEY,
} from './session.utils';

const createStorage = (entries = {}) => ({
  getItem: jest.fn((key) => (Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null)),
});

describe('session utilities', () => {
  test('reads the logged-in user from the shared localStorage key', () => {
    const storage = createStorage({
      [SESSION_STORAGE_KEY]: JSON.stringify({ id: 17, role: 'Teacher', name: 'Ms. Cruz' }),
    });

    expect(getStoredUserSession(storage)).toEqual({ id: 17, role: 'Teacher', name: 'Ms. Cruz' });
  });

  test('returns null when the stored session is missing or malformed', () => {
    expect(getStoredUserSession(createStorage())).toBeNull();
    expect(getStoredUserSession(createStorage({ [SESSION_STORAGE_KEY]: '{bad json' }))).toBeNull();
  });

  test('authorizes teachers only after session hydration confirms role and id', () => {
    const storage = createStorage({
      [SESSION_STORAGE_KEY]: JSON.stringify({ id: 9, role: ' Teacher ', email: 'teacher@example.com' }),
    });

    expect(resolveAuthorizedSession('teacher', storage)).toEqual({
      id: 9,
      role: 'teacher',
      email: 'teacher@example.com',
    });
  });

  test('rejects unauthorized or incomplete teacher sessions', () => {
    expect(
      resolveAuthorizedSession(
        'teacher',
        createStorage({ [SESSION_STORAGE_KEY]: JSON.stringify({ id: null, role: 'teacher' }) })
      )
    ).toBeNull();

    expect(
      resolveAuthorizedSession(
        'teacher',
        createStorage({ [SESSION_STORAGE_KEY]: JSON.stringify({ id: 4, role: 'parent' }) })
      )
    ).toBeNull();
  });

  test('attaches an authorization header when a token-like value is available', () => {
    const storage = createStorage({
      token: 'primary-token',
      rememberToken: 'remember-token',
    });

    expect(buildAuthHeaders(storage)).toEqual({ Authorization: 'Bearer primary-token' });
    expect(buildAuthHeaders(createStorage({ rememberToken: 'remember-only' }))).toEqual({
      Authorization: 'Bearer remember-only',
    });
    expect(buildAuthHeaders(createStorage())).toEqual({});
  });
});
