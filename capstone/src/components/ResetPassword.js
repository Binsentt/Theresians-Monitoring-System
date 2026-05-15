import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import '../styles/resetpassword.css';

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
          email: email,
          otp: otp,
          newPassword: newPassword 
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
    <div className="reset-page-wrapper">
      <div className="sts-header-bar">
        <img
          src={logoImage}
          alt="STS Logo"
          className="sts-logo-circle"
        />
        <h2 className="sts-header-text">Account Recovery</h2>
      </div>

      <div className="reset-flex-container">
        <div className="reset-card-main">
          <button className="back-link-sts" onClick={() => navigate('/login')}>← Back to Login</button>
          
          <h1 className="reset-title-sts">RESET PASSWORD</h1>

          {step === 1 ? (
            <div className="reset-step-content">
              <p className="reset-instruction">Enter your registered email to receive a verification code.</p>
              
              <div className="sts-input-group">
                <label className="sts-label">Email Address:*</label>
                <input 
                  className="sts-input-field"
                  type="email" 
                  placeholder="johndoe@email.com"
                  value={email} 
                  onChange={e => setEmail(e.target.value)} 
                />
              </div>

              <button 
                className="sts-action-button" 
                onClick={handleSendCode}
                disabled={loading}
              >
                {loading ? 'SENDING...' : 'SEND VERIFICATION CODE'}
              </button>
            </div>
          ) : (
            <div className="reset-step-content">
              <p className="reset-instruction-sent">Code sent to: <strong>{email}</strong></p>
              
              <div className="sts-input-group">
                <input 
                  className="sts-input-field" 
                  type="text" 
                  placeholder="6-Digit Verification Code" 
                  value={otp}
                  onChange={e => setOtp(e.target.value)}
                />
              </div>
              
              <div className="sts-input-group password-field-wrapper">
                <input 
                  className="sts-input-field" 
                  type={showNewPassword ? 'text' : 'password'} 
                  placeholder="New Password" 
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="password-toggle-button"
                  aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowNewPassword(!showNewPassword)}
                >
                  {showNewPassword ? '🙈' : '👁️'}
                </button>
              </div>

              <div className="sts-input-group password-field-wrapper">
                <input 
                  className="sts-input-field" 
                  type={showConfirmPassword ? 'text' : 'password'} 
                  placeholder="Re-enter New Password" 
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="password-toggle-button"
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  {showConfirmPassword ? '🙈' : '👁️'}
                </button>
              </div>

              <button 
                className="sts-action-button" 
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