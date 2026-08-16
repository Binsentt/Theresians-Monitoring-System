import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUrl } from '../api';
import { getDefaultDashboardRoute, normalizeRole } from './manageUsers.utils';
import {
  buildAuthHeaders,
  clearStoredSession,
  getStoredUserSession,
  REMEMBER_TOKEN_STORAGE_KEY,
  SESSION_STORAGE_KEY,
} from './session.utils';
import '../styles/Login.css';

const validatePassword = (value) => (
  String(value || '').trim().length >= 12 ? '' : 'Password must be at least 12 characters.'
);

export default function InitialPasswordSetup() {
  const navigate = useNavigate();
  const [user, setUser] = useState(() => getStoredUserSession());
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user?.id) {
      navigate('/login', { replace: true });
      return;
    }
    if (!user.mustChangePassword) {
      navigate(getDefaultDashboardRoute(normalizeRole(user.role)), { replace: true });
    }
  }, [navigate, user]);

  const submit = async (event) => {
    event.preventDefault();
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(apiUrl('/api/account/initial-password'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify({ newPassword }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.user || !payload?.rememberToken) {
        setError(payload?.error || 'Unable to set your password.');
        if (response.status === 401 || response.status === 403) {
          clearStoredSession();
          navigate('/login', { replace: true });
        }
        return;
      }

      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload.user));
      localStorage.setItem(REMEMBER_TOKEN_STORAGE_KEY, payload.rememberToken);
      setUser(payload.user);
      navigate(getDefaultDashboardRoute(normalizeRole(payload.user.role)), { replace: true });
    } catch (requestError) {
      setError('Unable to connect. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!user?.id || !user.mustChangePassword) return null;

  return (
    <div className="login-page" data-testid="initial-password-setup">
      <main className="login-card">
        <h1>Create Your Password</h1>
        <p>Set a permanent password to continue to your dashboard.</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="initial-new-password">New Password</label>
          <input
            id="initial-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <label htmlFor="initial-confirm-password">Confirm New Password</label>
          <input
            id="initial-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="submit" className="sts-login-button" disabled={submitting}>
            {submitting ? 'SAVING...' : 'SAVE PASSWORD'}
          </button>
        </form>
      </main>
    </div>
  );
}
