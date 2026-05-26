import { canAccessRole, normalizeRole } from './manageUsers.utils';

export const SESSION_STORAGE_KEY = 'loggedInUser';
export const TOKEN_STORAGE_KEY = 'token';
export const REMEMBER_TOKEN_STORAGE_KEY = 'rememberToken';
export const LOGIN_DEVICE_STORAGE_KEY = 'loginDeviceId';

const createFallbackLoginDeviceId = (cryptoApi) => {
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `device-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

export const getOrCreateLoginDeviceId = (
  storage = window.localStorage,
  cryptoApi = window.crypto
) => {
  const savedDeviceId = String(storage?.getItem?.(LOGIN_DEVICE_STORAGE_KEY) || '').trim();
  if (savedDeviceId) return savedDeviceId;

  const newDeviceId = String(cryptoApi?.randomUUID?.() || createFallbackLoginDeviceId(cryptoApi)).trim();
  storage?.setItem?.(LOGIN_DEVICE_STORAGE_KEY, newDeviceId);
  return newDeviceId;
};

export const getStoredUserSession = (storage = window.localStorage) => {
  try {
    const rawValue = storage?.getItem?.(SESSION_STORAGE_KEY);
    if (!rawValue) return null;
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
};

export const resolveAuthorizedSession = (requiredRole, storage = window.localStorage) => {
  const session = getStoredUserSession(storage);
  if (!session?.id) return null;

  const sessionRole = normalizeRole(session.role);
  const expectedRole = normalizeRole(requiredRole);
  if (!sessionRole || !canAccessRole(sessionRole, expectedRole)) return null;

  return {
    ...session,
    role: sessionRole,
    activeRole: expectedRole,
  };
};

export const buildAuthHeaders = (storage = window.localStorage) => {
  const token =
    storage?.getItem?.(TOKEN_STORAGE_KEY) ||
    storage?.getItem?.(REMEMBER_TOKEN_STORAGE_KEY);

  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const clearStoredSession = (storage = window.localStorage) => {
  storage?.removeItem?.(SESSION_STORAGE_KEY);
  storage?.removeItem?.(TOKEN_STORAGE_KEY);
  storage?.removeItem?.(REMEMBER_TOKEN_STORAGE_KEY);
};
