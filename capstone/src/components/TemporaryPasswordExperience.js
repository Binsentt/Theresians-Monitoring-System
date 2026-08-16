import React, { useEffect, useState } from 'react';
import { apiUrl } from '../api';
import {
  buildAuthHeaders,
  clearStoredSession,
  getStoredUserSession,
  REMEMBER_TOKEN_STORAGE_KEY,
  SESSION_STORAGE_KEY,
} from './session.utils';
import '../styles/settings.css';

const validatePassword = (value) => (
  String(value || '').trim().length >= 12 ? '' : 'Password must be at least 12 characters.'
);

const updateStoredSession = (payload) => {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload.user));
  if (payload.rememberToken) {
    localStorage.setItem(REMEMBER_TOKEN_STORAGE_KEY, payload.rememberToken);
  }
  window.dispatchEvent(new Event('session-user-updated'));
};

export default function TemporaryPasswordExperience({ children }) {
  const [user, setUser] = useState(() => getStoredUserSession());
  const [promptOpen, setPromptOpen] = useState(() => getStoredUserSession()?.requiresInitialPasswordSetup === true);
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [requestError, setRequestError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    const syncUser = () => {
      const nextUser = getStoredUserSession();
      setUser(nextUser);
      if (nextUser?.requiresInitialPasswordSetup !== true) {
        setPromptOpen(false);
        setSetupOpen(false);
        setConfirmationOpen(false);
        setDeferred(false);
      }
    };

    window.addEventListener('session-user-updated', syncUser);
    window.addEventListener('storage', syncUser);
    return () => {
      window.removeEventListener('session-user-updated', syncUser);
      window.removeEventListener('storage', syncUser);
    };
  }, []);

  const requiresPermanentPassword = user?.requiresInitialPasswordSetup === true;

  const openSetup = () => {
    setPromptOpen(false);
    setSetupOpen(true);
    setConfirmationOpen(false);
    setRequestError('');
    setErrors({});
  };

  const validateSetup = () => {
    const nextErrors = {};
    const newPasswordError = validatePassword(newPassword);
    if (newPasswordError) nextErrors.newPassword = newPasswordError;
    if (!confirmPassword) nextErrors.confirmPassword = 'Confirm your new password.';
    else if (newPassword !== confirmPassword) nextErrors.confirmPassword = 'Passwords do not match.';
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleContinue = (event) => {
    event.preventDefault();
    if (!validateSetup()) return;
    setConfirmationOpen(true);
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setRequestError('');
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
        setRequestError(payload?.error || 'Unable to set your password.');
        setConfirmationOpen(false);
        if (response.status === 401 || response.status === 403) clearStoredSession();
        return;
      }

      updateStoredSession(payload);
      setUser(payload.user);
      setNewPassword('');
      setConfirmPassword('');
      setSuccessMessage('Your permanent password has been saved.');
    } catch (error) {
      setRequestError('Unable to connect. Please try again.');
      setConfirmationOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasswordChange = (field, value) => {
    if (field === 'newPassword') {
      setNewPassword(value);
      setErrors((current) => ({
        ...current,
        newPassword: value ? validatePassword(value) : 'New password is required.',
        ...(confirmPassword ? { confirmPassword: value === confirmPassword ? '' : 'Passwords do not match.' } : {}),
      }));
      return;
    }

    setConfirmPassword(value);
    setErrors((current) => ({
      ...current,
      confirmPassword: !value ? 'Confirm your new password.' : (value === newPassword ? '' : 'Passwords do not match.'),
    }));
  };

  return (
    <>
      {children}
      {successMessage && <p className="temporary-password-success" role="status">{successMessage}</p>}
      {requiresPermanentPassword && deferred && (
        <section className="temporary-password-warning" role="status" aria-live="polite">
          <div>
            <strong>Your account is still using a temporary password.</strong>
            <span>Please create a permanent password in Settings.</span>
          </div>
          <button type="button" className="btn btn-primary" onClick={openSetup}>Change Password</button>
        </section>
      )}

      {requiresPermanentPassword && promptOpen && (
        <div className="temporary-password-overlay" role="presentation">
          <section className="temporary-password-modal" role="dialog" aria-modal="true" aria-labelledby="temporary-password-title">
            <h2 id="temporary-password-title">Change Your Temporary Password</h2>
            <p>For security, your current password is temporary. Would you like to create your permanent password now?</p>
            <div className="temporary-password-actions">
              <button type="button" className="btn btn-primary" onClick={openSetup}>Change Password Now</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setPromptOpen(false); setDeferred(true); }}>Not Now</button>
            </div>
          </section>
        </div>
      )}

      {requiresPermanentPassword && setupOpen && (
        <div className="temporary-password-overlay" role="presentation">
          <section className="temporary-password-modal" role="dialog" aria-modal="true" aria-labelledby="permanent-password-title">
            <h2 id="permanent-password-title">Create Your Permanent Password</h2>
            <p>Choose a password with at least 12 characters to secure your account.</p>
            <form onSubmit={handleContinue} noValidate>
              <div className="form-group">
                <label htmlFor="dashboard-new-password">New Password</label>
                <input
                  id="dashboard-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => handlePasswordChange('newPassword', event.target.value)}
                  aria-invalid={Boolean(errors.newPassword)}
                />
                {errors.newPassword && <span className="error-text" role="alert">{errors.newPassword}</span>}
              </div>
              <div className="form-group">
                <label htmlFor="dashboard-confirm-password">Confirm New Password</label>
                <input
                  id="dashboard-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => handlePasswordChange('confirmPassword', event.target.value)}
                  aria-invalid={Boolean(errors.confirmPassword)}
                />
                {errors.confirmPassword && <span className="error-text" role="alert">{errors.confirmPassword}</span>}
              </div>
              {requestError && <p className="error-text" role="alert">{requestError}</p>}
              <div className="temporary-password-actions">
                <button type="submit" className="btn btn-primary">Continue</button>
                <button type="button" className="btn btn-secondary" onClick={() => { setSetupOpen(false); setDeferred(true); }}>Not Now</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {requiresPermanentPassword && confirmationOpen && (
        <div className="temporary-password-overlay" role="presentation">
          <section className="temporary-password-modal temporary-password-confirmation" role="dialog" aria-modal="true" aria-labelledby="confirm-password-title">
            <h2 id="confirm-password-title">Confirm Password Change</h2>
            <p>Are you sure you want to use this as your new permanent password?</p>
            <div className="temporary-password-actions">
              <button type="button" className="btn btn-primary" onClick={handleConfirm} disabled={submitting}>{submitting ? 'Saving...' : 'Confirm'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmationOpen(false)} disabled={submitting}>Cancel</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
