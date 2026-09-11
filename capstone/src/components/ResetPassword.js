import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import { apiUrl } from '../api';
import PasswordStrengthFeedback from './PasswordStrengthFeedback';
import { validateEmail, validateNewWebsitePassword, validateOtp } from '../utils/validation.utils';
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
  const [emailError, setEmailError] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [otpTouched, setOtpTouched] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const requestInFlightRef = useRef(false);
  const emailInputRef = useRef(null);
  const otpInputRef = useRef(null);
  const newPasswordInputRef = useRef(null);
  const confirmPasswordInputRef = useRef(null);

  const navigate = useNavigate();

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
  }, []);

  const validateEmailField = (value) => {
    const validation = validateEmail(value);
    setEmailError(validation.error || '');
    return validation.isValid;
  };

  const validateOtpField = (value) => {
    const validation = validateOtp(value);
    setOtpError(validation.error || '');
    return validation.isValid;
  };

  const validatePasswordField = (value) => {
    const validation = validateNewWebsitePassword(value);
    setPasswordError(validation.error || '');
    return validation.isValid;
  };

  const validateConfirmField = (value, password = newPassword) => {
    const error = value && value !== password ? 'Passwords do not match.' : '';
    setConfirmError(error);
    return !error;
  };

  const handleSendCode = async () => {
    if (requestInFlightRef.current) return;
    setEmailTouched(true);
    if (!validateEmailField(email)) {
      emailInputRef.current?.focus();
      setStatusMessage('');
      return;
    }

    requestInFlightRef.current = true;
    setLoading(true);
    setStatusMessage('');
    try {
      const response = await fetch(apiUrl('/api/reset-password/send-code'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        setStatusMessage(data.message || 'If an eligible account matches this email, recovery instructions will be sent.');
        setStep(2);
      } else {
        setStatusMessage(data.error || 'Recovery service is temporarily unavailable. Please try again later.');
      }
    } catch (error) {
      console.error('Error:', error);
      setStatusMessage('Recovery service is unavailable. Please try again later.');
    } finally {
      requestInFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (requestInFlightRef.current) return;
    setOtpTouched(true);
    setPasswordTouched(true);
    setConfirmTouched(true);
    const otpValid = validateOtpField(otp);
    const passwordValid = validatePasswordField(newPassword);
    const confirmValid = validateConfirmField(confirmPassword, newPassword);
    if (!otpValid || !passwordValid || !confirmValid) {
      if (!otpValid) otpInputRef.current?.focus();
      else if (!passwordValid) newPasswordInputRef.current?.focus();
      else confirmPasswordInputRef.current?.focus();
      setStatusMessage('');
      return;
    }

    requestInFlightRef.current = true;
    setLoading(true);
    setStatusMessage('Checking verification code…');
    try {
      const response = await fetch(apiUrl('/api/reset-password/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          otp,
          newPassword,
          confirmPassword,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        setStatusMessage('Password updated successfully. You can now log in with your new password.');
        navigate('/login');
      } else {
        setStatusMessage(data.error || 'Invalid or expired verification code.');
      }
    } catch (error) {
      console.error('Error:', error);
      setStatusMessage('Recovery service is unavailable. Please try again later.');
    } finally {
      requestInFlightRef.current = false;
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

          {statusMessage && <div className="sts-field-status" role="status" aria-live="polite">{statusMessage}</div>}

          {step === 1 ? (
            <div className="forgot-password-step">
              <p className="forgot-password-instruction">
                Enter your registered email to receive a verification code.
              </p>

              <div className="sts-input-group">
                <label className="sts-label" htmlFor="recovery-email">Email Address</label>
                <input
                  id="recovery-email"
                  ref={emailInputRef}
                  className={`sts-input-field ${emailTouched && emailError ? 'sts-input-error' : ''}`}
                  type="email"
                  placeholder="johndoe@email.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setStatusMessage('');
                    if (emailTouched || emailError) validateEmailField(e.target.value);
                  }}
                  onBlur={() => { setEmailTouched(true); validateEmailField(email); }}
                  disabled={loading}
                  aria-invalid={emailTouched && !!emailError}
                  aria-describedby={emailError ? 'recovery-email-error' : undefined}
                />
                {emailTouched && emailError && <div id="recovery-email-error" className="sts-field-error" role="alert">{emailError}</div>}
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
                <label className="sts-label" htmlFor="recovery-otp">Verification Code</label>
                <input
                  id="recovery-otp"
                  ref={otpInputRef}
                  className={`sts-input-field ${otpTouched && otpError ? 'sts-input-error' : ''}`}
                  type="text"
                  placeholder="6-Digit Verification Code"
                  value={otp}
                  onChange={(e) => {
                    const value = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                    setOtp(value);
                    setStatusMessage('');
                    if (otpTouched || otpError) validateOtpField(value);
                  }}
                  onBlur={() => { setOtpTouched(true); validateOtpField(otp); }}
                  disabled={loading}
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-invalid={otpTouched && !!otpError}
                  aria-describedby={otpError ? 'recovery-otp-error' : undefined}
                />
                {otpTouched && otpError && <div id="recovery-otp-error" className="sts-field-error" role="alert">{otpError}</div>}
              </div>

              <div className="sts-input-group">
                <label className="sts-label" htmlFor="recovery-new-password">New Password</label>
                <div className="password-field-wrapper login-password-field forgot-password-password-field">
                  <input
                    id="recovery-new-password"
                    ref={newPasswordInputRef}
                    className="sts-input-field"
                    type={showNewPassword ? 'text' : 'password'}
                    placeholder="Enter your new password"
                    value={newPassword}
                    onChange={(e) => {
                      setNewPassword(e.target.value);
                      if (passwordTouched) validatePasswordField(e.target.value);
                      if (confirmTouched) validateConfirmField(confirmPassword, e.target.value);
                    }}
                    disabled={loading}
                    aria-invalid={passwordTouched && !!passwordError}
                    aria-describedby={passwordError ? 'recovery-password-error' : undefined}
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
                <PasswordStrengthFeedback password={newPassword} />
                {passwordTouched && passwordError && <div id="recovery-password-error" className="sts-field-error" role="alert">{passwordError}</div>}
              </div>

              <div className="sts-input-group">
                <label className="sts-label" htmlFor="recovery-confirm-password">Confirm Password</label>
                <div className="password-field-wrapper login-password-field forgot-password-password-field">
                  <input
                    id="recovery-confirm-password"
                    ref={confirmPasswordInputRef}
                    className="sts-input-field"
                    type={showConfirmPassword ? 'text' : 'password'}
                    placeholder="Re-enter your new password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      setConfirmTouched(true);
                      validateConfirmField(e.target.value, newPassword);
                    }}
                    disabled={loading}
                    aria-invalid={confirmTouched && !!confirmError}
                    aria-describedby={confirmError ? 'recovery-confirm-error' : undefined}
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
                {confirmTouched && confirmError && <div id="recovery-confirm-error" className="sts-field-error" role="alert">{confirmError}</div>}
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
