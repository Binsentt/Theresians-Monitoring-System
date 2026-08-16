import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import { apiUrl } from '../api';
import { getDefaultDashboardRoute, normalizeRole } from './manageUsers.utils';
import { getOrCreateLoginDeviceId } from './session.utils';
import { validateEmail, validatePassword, validateOtp } from '../utils/validation.utils';

const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please login and verify OTP again.';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(1);
  const [otp, setOtp] = useState('');
  const [pendingUserId, setPendingUserId] = useState(null);
  const [otpExpiresAt, setOtpExpiresAt] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [rememberToken, setRememberToken] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [skipOtpFor30Days, setSkipOtpFor30Days] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Field validation states
  const [emailError, setEmailError] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [otpTouched, setOtpTouched] = useState(false);

  // Refs for focus management
  const emailInputRef = useRef(null);
  const passwordInputRef = useRef(null);
  const otpInputRef = useRef(null);

  const navigate = useNavigate();
  const location = useLocation();

  // Validation handlers
  const validateEmailField = (emailValue) => {
    const validation = validateEmail(emailValue);
    setEmailError(validation.error || '');
    return validation.isValid;
  };

  const validatePasswordField = (passwordValue) => {
    const validation = validatePassword(passwordValue);
    setPasswordError(validation.error || '');
    return validation.isValid;
  };

  const validateOtpField = (otpValue) => {
    const validation = validateOtp(otpValue);
    setOtpError(validation.error || '');
    return validation.isValid;
  };

  const handleEmailChange = (e) => {
    const value = e.target.value;
    setEmail(value);
    // Validate in real-time after field has been touched or if error exists
    if (emailTouched || emailError) {
      validateEmailField(value);
    }
  };

  const handleEmailBlur = () => {
    setEmailTouched(true);
    validateEmailField(email);
  };

  const handlePasswordChange = (e) => {
    const value = e.target.value;
    setPassword(value);
    // Validate in real-time after field has been touched or if error exists
    if (passwordTouched || passwordError) {
      validatePasswordField(value);
    }
  };

  const handlePasswordBlur = () => {
    setPasswordTouched(true);
    validatePasswordField(password);
  };

  const handleOtpChange = (e) => {
    const value = e.target.value.replace(/[^0-9]/g, ''); // Only allow digits
    setOtp(value);
    // Validate in real-time after field has been touched or if error exists
    if (otpTouched || otpError) {
      validateOtpField(value);
    }
  };

  const handleOtpBlur = () => {
    setOtpTouched(true);
    validateOtpField(otp);
  };

  // Load saved theme on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const savedToken = localStorage.getItem('rememberToken');
    if (savedToken) setRememberToken(savedToken);
    setDeviceId(getOrCreateLoginDeviceId());
  }, []);

  useEffect(() => {
    if (location?.state?.sessionExpired) {
      setErrorMessage(SESSION_EXPIRED_MESSAGE);
    }
  }, [location?.state]);

  useEffect(() => {
    if (!otpExpiresAt) {
      setCountdown(0);
      return;
    }

    const updateCountdown = () => {
      const now = new Date().getTime();
      const expires = new Date(otpExpiresAt).getTime();
      const remaining = Math.max(0, Math.round((expires - now) / 1000));
      setCountdown(remaining);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [otpExpiresAt]);

  const persistSuccessfulLogin = (payload) => {
    const requiresInitialPasswordSetup = payload?.requiresInitialPasswordSetup === true
      || payload?.user?.requiresInitialPasswordSetup === true;
    const sessionUser = {
      ...payload.user,
      mustChangePassword: requiresInitialPasswordSetup,
      requiresInitialPasswordSetup,
    };

    if (payload.rememberToken) {
      localStorage.setItem('rememberToken', payload.rememberToken);
      setRememberToken(payload.rememberToken);
    }

    localStorage.setItem('loggedInUser', JSON.stringify(sessionUser));
    const role = normalizeRole(sessionUser.role);
    alert(`Welcome back, ${sessionUser.name}!`);

    navigate(getDefaultDashboardRoute(role));
  };

  const handleLogin = async () => {
    // Mark all fields as touched
    setEmailTouched(true);
    setPasswordTouched(true);

    // Validate all fields
    const isEmailValid = validateEmailField(email);
    const isPasswordValid = validatePasswordField(password);

    if (!isEmailValid || !isPasswordValid) {
      // Focus first invalid field
      if (!isEmailValid && emailInputRef.current) {
        emailInputRef.current.focus();
      } else if (!isPasswordValid && passwordInputRef.current) {
        passwordInputRef.current.focus();
      }
      // Clear any backend error message when validation fails
      setErrorMessage('');
      return;
    }

    setErrorMessage('');
    setLoading(true);
    try {
      const response = await fetch(apiUrl('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: email.trim().toLowerCase(),
          password: password,
          rememberToken: rememberToken || undefined,
          deviceId,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(data.error || 'Invalid email or password.');
        return;
      }

      if (data.success && data.user) {
        persistSuccessfulLogin(data);
        return;
      }

      if (data.step === 2) {
        setPendingUserId(data.userId);
        setOtpExpiresAt(data.otpExpiresAt);
        setStep(2);
        // Clear field errors when transitioning to OTP step
        setOtpError('');
        setOtpTouched(false);
        if (data.warning) {
          setErrorMessage(data.warning);
        } else {
          alert('Verification code sent to your email.');
        }
      }
    } catch (error) {
      setErrorMessage('Network error. Please check if server is running.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    // Mark OTP field as touched
    setOtpTouched(true);

    // Validate OTP
    const isOtpValid = validateOtpField(otp);

    if (!isOtpValid) {
      // Focus OTP field
      if (otpInputRef.current) {
        otpInputRef.current.focus();
      }
      // Clear any backend error message when validation fails
      setErrorMessage('');
      return;
    }

    setErrorMessage('');
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/login/verify-otp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: pendingUserId,
          otp,
          deviceId,
          skipOtpFor30Days,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        setErrorMessage(result.error || 'Invalid OTP.');
        return;
      }
      if (result.success && result.user) {
        persistSuccessfulLogin(result);
      }
    } catch (err) {
      setErrorMessage('Network error while verifying OTP.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (!pendingUserId && !email) {
      setErrorMessage('Cannot resend OTP without a login attempt.');
      return;
    }
    setErrorMessage('');
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/login/resend-otp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: pendingUserId, email: email.trim().toLowerCase() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to resend OTP.');
        return;
      }
      setOtpExpiresAt(data.otpExpiresAt);
      setErrorMessage(data.warning || 'A new code was sent to your email.');
    } catch (err) {
      setErrorMessage('Network error while resending OTP.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page-wrapper">
      <div className="sts-header-bar">
        <img src={logoImage} alt="STS Logo" className="sts-logo-circle" />
        <h2 className="sts-header-text">Login</h2>
      </div>

      <div className="login-flex-container">
        <div className="login-card-main">
          <button className="back-home-link" onClick={() => navigate('/')}>← Back to Home</button>
          
          <h3 className="login-title-sts">
            {step === 1 ? 'Enter your Credentials' : 'Security Verification'}
          </h3>

          {step === 1 ? (
            <>

              <div className="sts-input-group">
                <label className="sts-label" htmlFor="email-input">Email Address</label>
                <input
                  id="email-input"
                  ref={emailInputRef}
                  type="email"
                  className={`sts-input-field ${emailTouched && emailError ? 'sts-input-error' : ''}`}
                  placeholder="email@example.com"
                  value={email}
                  onChange={handleEmailChange}
                  onBlur={handleEmailBlur}
                  disabled={loading}
                  aria-invalid={emailTouched && !!emailError}
                  aria-describedby={emailError ? 'email-error' : undefined}
                />
                {emailTouched && emailError && (
                  <div id="email-error" className="sts-field-error">
                    {emailError}
                  </div>
                )}
              </div>

              <div className="sts-input-group">
                <label className="sts-label" htmlFor="password-input">Password</label>
                
                <div className="password-field-wrapper login-password-field">
                  <input
                    id="password-input"
                    ref={passwordInputRef}
                    type={showPassword ? "text" : "password"}
                    className={`sts-input-field ${passwordTouched && passwordError ? 'sts-input-error' : ''}`}
                    placeholder="••••••••"
                    value={password}
                    onChange={handlePasswordChange}
                    onBlur={handlePasswordBlur}
                    disabled={loading}
                    aria-invalid={passwordTouched && !!passwordError}
                    aria-describedby={passwordError ? 'password-error' : undefined}
                  />

                  <button
                    type="button"
                    className="password-toggle-button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                    )}
                  </button>
                </div>

                {passwordTouched && passwordError && (
                  <div id="password-error" className="sts-field-error">
                    {passwordError}
                  </div>
                )}

                <div className="pw-footer-row">
                  <span className="forgot-pass-link-bottom" onClick={() => navigate('/reset-password')}>
                    Forgot Password?
                  </span>
                </div>
              </div>

              <button className="sts-login-button" onClick={handleLogin} disabled={loading}>
                {loading ? 'LOGGING IN...' : 'LOGIN'}
              </button>
            </>
          ) : (
            <div style={{ marginTop: 16 }}>
              <p className="verification-instruction" style={{ textAlign: 'center', fontSize: '14px', marginBottom: '15px' }}>
                Enter the 6-digit code sent to <b>{email}</b>
              </p>
              <div className="sts-input-group">
                <label className="sts-label" htmlFor="otp-input">Verification Code</label>
                <input
                  id="otp-input"
                  ref={otpInputRef}
                  className={`sts-input-field otp-input ${otpTouched && otpError ? 'sts-input-error' : ''}`}
                  type="text"
                  placeholder="000000"
                  value={otp}
                  onChange={handleOtpChange}
                  onBlur={handleOtpBlur}
                  maxLength={6}
                  aria-invalid={otpTouched && !!otpError}
                  aria-describedby={otpError ? 'otp-error' : undefined}
                />
                {otpTouched && otpError && (
                  <div id="otp-error" className="sts-field-error">
                    {otpError}
                  </div>
                )}
              </div>
              <label className="otp-device-skip-option">
                <input
                  type="checkbox"
                  checked={skipOtpFor30Days}
                  onChange={(event) => setSkipOtpFor30Days(event.target.checked)}
                  disabled={loading}
                />
                <span>Trust this device for 30 days</span>
              </label>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                <small style={{ color: '#555' }}>
                  {countdown > 0 ? `Code expires in ${countdown}s` : 'Code expired. Please resend.'}
                </small>
                <button
                  className="resend-otp-button"
                  type="button"
                  onClick={handleResendOtp}
                  disabled={loading || countdown > 0}
                  style={{ padding: '8px 16px', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer' }}
                >
                  RESEND CODE
                </button>
              </div>
              <button className="sts-login-button" onClick={handleVerifyOtp} disabled={loading}>
                {loading ? 'VERIFYING...' : 'VERIFY CODE'}
              </button>
              <button
                onClick={() => {
                  setStep(1);
                  setPendingUserId(null);
                  setOtp('');
                  setOtpExpiresAt(null);
                  setSkipOtpFor30Days(false);
                  setErrorMessage('');
                  // Clear field errors
                  setOtpError('');
                  setOtpTouched(false);
                  setEmailTouched(false);
                  setPasswordTouched(false);
                }}
                className="back-login-btn"
              >
                Back to Login
              </button>
            </div>
          )}
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
            ×
          </button>
        </div>
      )}
    </div>
  );
}
