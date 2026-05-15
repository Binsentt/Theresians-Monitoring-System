import { normalizeRole } from './manageUsers.utils';

export const SESSION_STORAGE_KEY = 'loggedInUser';
export const TOKEN_STORAGE_KEY = 'token';
export const REMEMBER_TOKEN_STORAGE_KEY = 'rememberToken';

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
  if (!sessionRole || sessionRole !== expectedRole) return null;

  return {
    ...session,
    role: sessionRole,
  };
};

export const buildAuthHeaders = (storage = window.localStorage) => {
  const token =
    storage?.getItem?.(TOKEN_STORAGE_KEY) ||
    storage?.getItem?.(REMEMBER_TOKEN_STORAGE_KEY);

  return token ? { Authorization: `Bearer ${token}` } : {};
};
