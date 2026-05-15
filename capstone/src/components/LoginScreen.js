import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';

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
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const navigate = useNavigate();

  // Load saved theme on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const savedToken = localStorage.getItem('rememberToken');
    if (savedToken) setRememberToken(savedToken);
  }, []);

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

  const handleLogin = async () => {
  
    if (!email && !password) {
      setErrorMessage('Email and password fields are empty.');
      return;
    }
    if (!email) {
      setErrorMessage('Please enter your email address.');
      return;
    }
    if (!password) {
      setErrorMessage('Password field is empty.');
      return;
    }
    setErrorMessage('');

    setLoading(true);
    try {
      const response = await fetch('http://localhost:5000/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: email.trim().toLowerCase(),
          password: password,
          rememberToken: rememberToken || undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(data.error || 'Invalid email or password.');
        return;
      }

      if (data.success && data.user) {
        if (data.rememberToken) {
          localStorage.setItem('rememberToken', data.rememberToken);
          setRememberToken(data.rememberToken);
        }
        localStorage.setItem('loggedInUser', JSON.stringify(data.user));
        const role = data.user.role?.toLowerCase();
        alert(`Welcome back, ${data.user.name}!`);
        if (role === 'admin') navigate('/admin-dashboard');
        else if (role === 'teacher') navigate('/teacher-dashboard');
        else if (role === 'parent') navigate('/parent-dashboard');
        else navigate('/');
        return;
      }

      if (data.step === 2) {
        setPendingUserId(data.userId);
        setOtpExpiresAt(data.otpExpiresAt);
        setStep(2);
        alert('Verification code sent to your email.');
      }
    } catch (error) {
      setErrorMessage('Network error. Please check if server is running.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!otp) {
      setErrorMessage('Please enter the verification code.');
      return;
    }
    setErrorMessage('');
    setLoading(true);
    try {
      const res = await fetch('http://localhost:5000/api/login/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: pendingUserId, otp }),
      });
      const result = await res.json();
      if (!res.ok) {
        setErrorMessage(result.error || 'Invalid OTP.');
        return;
      }
      if (result.success && result.user) {
        localStorage.setItem('loggedInUser', JSON.stringify(result.user));
        if (result.rememberToken) {
          localStorage.setItem('rememberToken', result.rememberToken);
          setRememberToken(result.rememberToken);
        }
        const role = result.user.role.toLowerCase();
        alert(`Welcome back, ${result.user.name}!`);
        
        if (role === 'admin') {
          navigate('/admin-dashboard');
        } else if (role === 'teacher') {
          navigate('/teacher-dashboard');
        } else if (role === 'parent') {
          navigate('/parent-dashboard');
        } else {
          navigate('/');
        }
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
      const res = await fetch('http://localhost:5000/api/login/resend-otp', {
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
      setErrorMessage('A new code was sent to your email.');
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
                <label className="sts-label">Email Address</label>
                <input
                  type="email"
                  className="sts-input-field"
                  placeholder="email@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  disabled={loading}
                />
              </div>

              <div className="sts-input-group">
                <label className="sts-label">Password</label>
                
                <div className="password-field-wrapper login-password-field">
                  <input
                    type={showPassword ? "text" : "password"}
                    className="sts-input-field"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    disabled={loading}
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
                <input
                  className="sts-input-field otp-input"
                  type="text"
                  placeholder="000000"
                  value={otp}
                  onChange={e => setOtp(e.target.value)}
                  maxLength={6}
                />
              </div>
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
                  setErrorMessage('');
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
