import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import { apiUrl } from '../api';
import { getDefaultDashboardRoute, normalizeRole } from './manageUsers.utils';
import { buildAuthHeaders } from './session.utils';

export default function ChangePasswordScreen() {
  const [user, setUser] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const storedUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
    if (!storedUser?.id) {
      navigate('/login', { replace: true });
      return;
    }

    if (!storedUser.mustChangePassword) {
      navigate(getDefaultDashboardRoute(normalizeRole(storedUser.role)), { replace: true });
      return;
    }

    setUser(storedUser);
  }, [navigate]);

  const validateForm = () => {
    if (!newPassword) return 'New password is required.';
    if (newPassword.length < 12) return 'Password must be at least 12 characters.';
    if (newPassword !== confirmPassword) return 'Passwords do not match.';
    return '';
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const validationError = validateForm();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setErrorMessage('');
    setSaving(true);

    try {
      const response = await fetch(apiUrl('/api/verify-password-change-otp'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify({
          userId: user.id,
          newPassword,
          firstLogin: true,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(data.error || 'Password could not be changed.');
        return;
      }

      const updatedUser = { ...user, mustChangePassword: false };
      localStorage.setItem('loggedInUser', JSON.stringify(updatedUser));
      navigate(getDefaultDashboardRoute(normalizeRole(updatedUser.role)), { replace: true });
    } catch (error) {
      setErrorMessage('Network error while changing password.');
    } finally {
      setSaving(false);
    }
  };

  if (!user) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="login-page-wrapper">
      <div className="sts-header-bar">
        <img src={logoImage} alt="STS Logo" className="sts-logo-circle" />
        <h2 className="sts-header-text">Change Password</h2>
      </div>

      <div className="login-flex-container">
        <div className="login-card-main">
          <h3 className="login-title-sts">Create a New Password</h3>
          <p className="verification-instruction" style={{ textAlign: 'center', fontSize: '14px', marginBottom: '18px' }}>
            Please change your temporary password before continuing.
          </p>

          <form onSubmit={handleSubmit}>
            <div className="sts-input-group">
              <label className="sts-label">New Password</label>
              <div className="password-field-wrapper login-password-field">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="sts-input-field"
                  placeholder="At least 12 characters"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  disabled={saving}
                />
                <button
                  type="button"
                  className="password-toggle-button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div className="sts-input-group">
              <label className="sts-label">Confirm Password</label>
              <div className="password-field-wrapper login-password-field">
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  className="sts-input-field"
                  placeholder="Re-enter new password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  disabled={saving}
                />
                <button
                  type="button"
                  className="password-toggle-button"
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  {showConfirmPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <button className="sts-login-button" type="submit" disabled={saving}>
              {saving ? 'SAVING...' : 'CHANGE PASSWORD'}
            </button>
          </form>
        </div>
      </div>

      {errorMessage && (
        <div style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          backgroundColor: document.documentElement.getAttribute('data-theme') === 'dark' ? '#5a2a2a' : '#f8d7da',
          color: document.documentElement.getAttribute('data-theme') === 'dark' ? '#ffb3b3' : '#721c24',
          padding: '12px 20px',
          borderRadius: '4px',
          border: document.documentElement.getAttribute('data-theme') === 'dark' ? '1px solid #8b3d3d' : '1px solid #f5c6cb',
          zIndex: 1000,
          maxWidth: '400px'
        }}>
          {errorMessage}
          <button
            onClick={() => setErrorMessage('')}
            style={{
              marginLeft: '10px',
              background: 'none',
              border: 'none',
              color: document.documentElement.getAttribute('data-theme') === 'dark' ? '#ffb3b3' : '#721c24',
              cursor: 'pointer',
              fontSize: '18px'
            }}
          >
            x
          </button>
        </div>
      )}
    </div>
  );
}
