import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import '../styles/resetpassword.css';

function PasswordVisibilityIcon({ visible }) {
  if (visible) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    );
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
      <line x1="1" y1="1" x2="23" y2="23"></line>
    </svg>
  );
}

export default function ResetPassword() {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
  }, []);

  const handleSendCode = async () => {
    if (!email) {
      alert('Please enter your email address');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('http://localhost:5000/api/reset-password/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (response.ok) {
        alert('Verification code sent! Please check your email inbox or spam.');
        setStep(2);
      } else {
        alert(data.error || 'Failed to send code. Make sure the email is registered.');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Connection error. Please check if your backend is running.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (!otp || !newPassword || !confirmPassword) {
      alert('Please fill in all fields');
      return;
    }

    if (newPassword !== confirmPassword) {
      alert('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('http://localhost:5000/api/reset-password/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          otp,
          newPassword,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        alert('Password updated successfully! You can now login with your new password.');
        navigate('/login');
      } else {
        alert(data.error || 'Invalid or expired verification code.');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Connection error. Failed to update password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page-wrapper forgot-password-page">
      <div className="sts-header-bar">
        <img src={logoImage} alt="STS Logo" className="sts-logo-circle" />
        <h2 className="sts-header-text">Account Recovery</h2>
      </div>

      <div className="login-flex-container">
        <div className="login-card-main forgot-password-card">
          <button className="back-home-link" onClick={() => navigate('/login')}>
            {'<-'} Back to Login
          </button>

          <h3 className="login-title-sts forgot-password-title">Reset Password</h3>

          {step === 1 ? (
            <div className="forgot-password-step">
              <p className="forgot-password-instruction">
                Enter your registered email to receive a verification code.
              </p>

              <div className="sts-input-group">
                <label className="sts-label">Email Address</label>
                <input
                  className="sts-input-field"
                  type="email"
                  placeholder="johndoe@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                />
              </div>

              <button
                className="sts-login-button forgot-password-action"
                onClick={handleSendCode}
                disabled={loading}
              >
                {loading ? 'SENDING...' : 'SEND VERIFICATION CODE'}
              </button>
            </div>
          ) : (
            <div className="forgot-password-step">
              <p className="forgot-password-sent">
                Code sent to: <strong>{email}</strong>
              </p>

              <div className="sts-input-group">
                <label className="sts-label">Verification Code</label>
                <input
                  className="sts-input-field"
                  type="text"
                  placeholder="6-Digit Verification Code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  disabled={loading}
                />
              </div>

              <div className="sts-input-group">
                <label className="sts-label">New Password</label>
                <div className="password-field-wrapper login-password-field forgot-password-password-field">
                  <input
                    className="sts-input-field"
                    type={showNewPassword ? 'text' : 'password'}
                    placeholder="Enter your new password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={loading}
                  />
                  <button
                    type="button"
                    className="password-toggle-button"
                    aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowNewPassword(!showNewPassword)}
                  >
                    <PasswordVisibilityIcon visible={showNewPassword} />
                  </button>
                </div>
              </div>

              <div className="sts-input-group">
                <label className="sts-label">Confirm Password</label>
                <div className="password-field-wrapper login-password-field forgot-password-password-field">
                  <input
                    className="sts-input-field"
                    type={showConfirmPassword ? 'text' : 'password'}
                    placeholder="Re-enter your new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={loading}
                  />
                  <button
                    type="button"
                    className="password-toggle-button"
                    aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    <PasswordVisibilityIcon visible={showConfirmPassword} />
                  </button>
                </div>
              </div>

              <button
                className="sts-login-button forgot-password-action"
                onClick={handleUpdatePassword}
                disabled={loading}
              >
                {loading ? 'UPDATING...' : 'UPDATE PASSWORD'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
