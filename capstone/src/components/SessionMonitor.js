import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiUrl } from '../api';
import {
  buildAuthHeaders,
  clearStoredSession,
  getStoredUserSession,
  SESSION_STORAGE_KEY,
} from './session.utils';

const PUBLIC_ROUTES = new Set(['/', '/login', '/reset-password']);

const isPublicRoute = (pathname) => PUBLIC_ROUTES.has(pathname);

export default function SessionMonitor() {
  const navigate = useNavigate();
  const location = useLocation();

  const redirectToLoginIfNeeded = useCallback(() => {
    if (!isPublicRoute(location.pathname)) {
      navigate('/login', { replace: true });
    }
  }, [location.pathname, navigate]);

  const validateSession = useCallback(async () => {
    const session = getStoredUserSession();
    if (!session?.id) return;

    const headers = buildAuthHeaders();
    if (!headers.Authorization) {
      clearStoredSession();
      redirectToLoginIfNeeded();
      return;
    }

    try {
      const response = await fetch(apiUrl('/api/session/validate'), { headers });
      if (response.status === 401 || response.status === 403) {
        clearStoredSession();
        redirectToLoginIfNeeded();
        return;
      }

      if (response.ok) {
        const payload = await response.json();
        if (payload?.user) {
          localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload.user));
        }
      }
    } catch (error) {
      // Do not force logout on a temporary network drop; the next check will retry.
    }
  }, [redirectToLoginIfNeeded]);

  useEffect(() => {
    validateSession();
    const intervalId = window.setInterval(validateSession, 15000);
    window.addEventListener('focus', validateSession);
    document.addEventListener('visibilitychange', validateSession);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', validateSession);
      document.removeEventListener('visibilitychange', validateSession);
    };
  }, [validateSession]);

  return null;
}
