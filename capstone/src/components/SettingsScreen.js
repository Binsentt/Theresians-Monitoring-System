import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import '../styles/settings.css';

export default function SettingsScreen() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('profile');
  const [theme, setTheme] = useState('light');
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [showMenu, setShowMenu] = useState(true);
  
  const [errorMessage, setErrorMessage] = useState('');
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [editForm, setEditForm] = useState({
    firstName: '',
    middleName: '',
    lastName: '',
    email: '',
    mobile_number: '',
    address: '',
    birthday: '',
    gender: ''
  });
  const [profileErrors, setProfileErrors] = useState({});
  const [profileUpdating, setProfileUpdating] = useState(false);

  // Change Password States
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [passwordErrors, setPasswordErrors] = useState({});
  const [passwordStep, setPasswordStep] = useState(1); // 1: form, 2: otp
  const [otpCode, setOtpCode] = useState('');
  const [pendingUserId, setPendingUserId] = useState(null);
  const [showPasswords, setShowPasswords] = useState({
    current: false,
    new: false,
    confirm: false
  });
  const [passwordUpdating, setPasswordUpdating] = useState(false);

  const getMaxBirthdate = () => {
    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() - 18);
    return maxDate.toISOString().split('T')[0];
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'Not set';
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return 'Not set';
    return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`;
  };

  // --- Icons ---
  const EyeIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );

  const EyeOffIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );

  const GearIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m3.08 3.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m3.08-3.08l4.24-4.24M19.78 19.78l-4.24-4.24m-3.08-3.08l-4.24-4.24" />
    </svg>
  );

  // Load user and theme
  useEffect(() => {
    const loadUser = async () => {
      try {
        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (!loggedInUser || !loggedInUser.id) {
          navigate('/login');
          return;
        }

        // FIX: Always fetch fresh user data from database on load
        // This ensures profile fields (phone, address, birthday, gender) are loaded from DB
        let freshUserData = null;
        let fetchSuccess = false;

        try {
          console.log('📥 Fetching fresh user data for ID:', loggedInUser.id);
          const response = await fetch(`http://localhost:5000/api/user/${loggedInUser.id}`);
          if (response.ok) {
            freshUserData = await response.json();
            console.log('✅ Fresh user data received:', { id: freshUserData.id, name: freshUserData.name, email: freshUserData.email, phone: freshUserData.mobile_number, address: freshUserData.address, birthday: freshUserData.birthday, gender: freshUserData.gender });
            fetchSuccess = true;
          } else {
            console.warn('⚠️ Failed to fetch fresh data (status ' + response.status + '), using cached');
          }
        } catch (err) {
          console.error('⚠️ Failed to fetch fresh user data, using cached:', err.message);
        }

        // Use fresh data if fetch succeeded, otherwise use cached data
        const userData = fetchSuccess ? freshUserData : loggedInUser;
        console.log('💾 Using user data:', { id: userData.id, name: userData.name, email: userData.email, phone: userData.mobile_number, address: userData.address, birthday: userData.birthday, gender: userData.gender });
        
        setUser(userData);
        
        // Update localStorage with fresh data if fetch succeeded
        if (fetchSuccess) {
          localStorage.setItem('loggedInUser', JSON.stringify(freshUserData));
        }

        const savedTheme = localStorage.getItem('theme') || 'light';
        setTheme(savedTheme);
        document.documentElement.setAttribute('data-theme', savedTheme);
      } catch (e) {
        navigate('/login');
      } finally {
        setLoading(false);
      }
    };
    loadUser();
  }, [navigate]);

  // Handle window resize for mobile detection
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('loggedInUser');
    localStorage.removeItem('token');
    navigate('/');
  };

  // Validation Functions
  const validateName = (name) => !name ? 'Full name is required' : (/\d/.test(name) ? 'No numbers allowed' : '');
  const validateNamePart = (part, required = true) => {
    if (required && !part) return 'This field is required';
    if (/\d/.test(part)) return 'No numbers allowed';
    return '';
  };
  const validateEmail = (email) => !email ? 'Email is required' : (!email.endsWith('@gmail.com') ? 'Use @gmail.com' : '');
  const validatePhone = (phone) => {
    if (!phone) return 'Phone is required';
    if (!phone.startsWith('09') || phone.length !== 11) return 'Must be 11 digits (09...)';
    return '';
  };
  const validatePassword = (pw) => (pw && pw.length < 12) ? 'At least 12 characters' : '';
  const validateBirthday = (date) => {
    if (!date) return 'Birthday is required';
    const birthDate = new Date(date);
    const today = new Date();
    if (birthDate > today) {
      return 'Birthday cannot be in the future';
    }
    const age = Math.floor((today - birthDate) / (1000 * 60 * 60 * 24 * 365.25));
    if (age < 18) return 'User must be at least 18 years old';
    return '';
  };

  // Profile handlers
  const handleEditProfileClick = async () => {
    // FIX: Re-fetch fresh user data when Edit is clicked to ensure we have latest DB values
    try {
      console.log('📥 Re-fetching user data before edit for ID:', user?.id);
      const response = await fetch(`http://localhost:5000/api/user/${user.id}`);
      let freshUserData = user;  // fallback to current user state
      
      if (response.ok) {
        freshUserData = await response.json();
        console.log('✅ Fresh data on edit click:', { phone: freshUserData.mobile_number, address: freshUserData.address, birthday: freshUserData.birthday, gender: freshUserData.gender });
        setUser(freshUserData);
      } else {
        console.warn('⚠️ Failed to fetch fresh data on edit, using current state');
      }

      // Initialize form from the fresh data
      const nameParts = (freshUserData?.name || '').split(' ').filter(Boolean);
      setEditForm({
        firstName: nameParts[0] || '',
        middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
        lastName: nameParts.length ? nameParts[nameParts.length - 1] : '',
        email: freshUserData.email || '',
        mobile_number: freshUserData.mobile_number || '',
        address: freshUserData.address || '',
        birthday: freshUserData.birthday || '',
        gender: freshUserData.gender || ''
      });
      console.log('📝 Edit form initialized:', { phone: freshUserData.mobile_number, address: freshUserData.address, birthday: freshUserData.birthday, gender: freshUserData.gender });
      setProfileErrors({});
      setErrorMessage('');
      setShowEditProfile(true);
    } catch (err) {
      console.error('Error preparing edit form:', err);
      // Fallback: initialize from current user state even if fetch fails
      const nameParts = (user?.name || '').split(' ').filter(Boolean);
      setEditForm({
        firstName: nameParts[0] || '',
        middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
        lastName: nameParts.length ? nameParts[nameParts.length - 1] : '',
        email: user.email,
        mobile_number: user.mobile_number || '',
        address: user.address || '',
        birthday: user.birthday || '',
        gender: user.gender || ''
      });
      setProfileErrors({});
      setErrorMessage('');
      setShowEditProfile(true);
    }
  };

  const handleProfileFormChange = (field, value) => {
    let finalValue = value;
    if (field === 'firstName' || field === 'middleName' || field === 'lastName') finalValue = value.replace(/[0-9]/g, '');
    if (field === 'mobile_number') finalValue = value.replace(/[^0-9]/g, '').slice(0, 11);

    setEditForm({ ...editForm, [field]: finalValue });

    let error = '';
    if (field === 'firstName') error = validateNamePart(finalValue, true);
    else if (field === 'middleName') error = validateNamePart(finalValue, false);
    else if (field === 'lastName') error = validateNamePart(finalValue, true);
    else if (field === 'email') error = validateEmail(finalValue);
    else if (field === 'mobile_number') error = validatePhone(finalValue);
    else if (field === 'birthday') error = validateBirthday(finalValue);

    setProfileErrors({ ...profileErrors, [field]: error });
  };

  const handleUpdateProfile = async (e) => {
    e.preventDefault();

    // CRITICAL FIX: Validate only the fields being submitted
    // Do NOT block save due to validation errors on unchanged fields
    const validationErrors = {};
    
    if (!editForm.firstName) validationErrors.firstName = 'First name is required';
    else if (/\d/.test(editForm.firstName)) validationErrors.firstName = 'No numbers allowed';
    
    if (editForm.middleName && /\d/.test(editForm.middleName)) validationErrors.middleName = 'No numbers allowed';
    
    if (!editForm.lastName) validationErrors.lastName = 'Last name is required';
    else if (/\d/.test(editForm.lastName)) validationErrors.lastName = 'No numbers allowed';
    
    if (!editForm.email) validationErrors.email = 'Email is required';
    else if (!editForm.email.endsWith('@gmail.com')) validationErrors.email = 'Use @gmail.com';
    
    if (!editForm.mobile_number) validationErrors.mobile_number = 'Phone is required';
    else if (!editForm.mobile_number.startsWith('09') || editForm.mobile_number.length !== 11) 
      validationErrors.mobile_number = 'Must be 11 digits (09...)';
    
    if (editForm.birthday) {
      const birthDate = new Date(editForm.birthday);
      const todayDate = new Date();
      if (birthDate > todayDate) {
        validationErrors.birthday = 'Birthday cannot be in the future';
      }
    }

    // If there are validation errors, show them and don't save
    if (Object.keys(validationErrors).length > 0) {
      console.warn('❌ Validation errors found:', validationErrors);
      setProfileErrors(validationErrors);
      setErrorMessage('Please fix the errors below before saving.');
      return;
    }
    
    setProfileErrors({});
    setErrorMessage('');

    setProfileUpdating(true);
    try {
      const fullName = `${editForm.firstName}${editForm.middleName ? ' ' + editForm.middleName : ''} ${editForm.lastName}`;
      
      // CRITICAL FIX: Build payload with all profile fields that may have been changed
      // The backend PUT endpoint is designed to handle partial updates correctly
      const payload = {
        name: fullName.trim(),
        email: editForm.email.toLowerCase().trim(),
        role: user.role || 'User',
        mobile_number: editForm.mobile_number || '',
        address: editForm.address || '',
        birthday: editForm.birthday || '', // Send empty string, backend converts to NULL
        gender: editForm.gender || '',
        status: user.status || 'Active'
      };

      console.log('📤 Sending profile update payload:', payload);

      const response = await fetch(`http://localhost:5000/api/accounts/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      console.log('📥 Backend response status:', response.status);

      const responseData = await response.json();
      console.log('📥 Backend response data:', responseData);

      if (response.ok) {
        // CRITICAL FIX: Always get fresh data from backend after save
        // This ensures what's displayed matches what's in the database
        let updatedUserData = responseData.user || {};
        
        // If no user data in response, fetch fresh from database
        if (!updatedUserData.id) {
          console.log('⏳ Fetching fresh user data from database...');
          try {
            const freshResponse = await fetch(`http://localhost:5000/api/user/${user.id}`);
            if (freshResponse.ok) {
              updatedUserData = await freshResponse.json();
              console.log('✅ Fresh user data fetched successfully:', { phone: updatedUserData.mobile_number, address: updatedUserData.address, birthday: updatedUserData.birthday, gender: updatedUserData.gender });
            } else {
              console.warn('⚠️ Failed to fetch fresh data');
              updatedUserData = { ...user, ...payload };
            }
          } catch (fetchErr) {
            console.warn('⚠️ Failed to fetch fresh data:', fetchErr);
            updatedUserData = { ...user, ...payload };
          }
        }
        
        // CRITICAL: Remove sensitive fields before storing in localStorage
        delete updatedUserData.password;
        delete updatedUserData.otp_code;
        
        console.log('💾 Saving updated profile to localStorage:', { id: updatedUserData.id, name: updatedUserData.name, email: updatedUserData.email, phone: updatedUserData.mobile_number, address: updatedUserData.address, birthday: updatedUserData.birthday, gender: updatedUserData.gender });
        localStorage.setItem('loggedInUser', JSON.stringify(updatedUserData));
        setUser(updatedUserData);
        setShowEditProfile(false);
        setErrorMessage('✅ Profile updated successfully! All changes have been saved.');
        
        // Clear success message after 3 seconds
        setTimeout(() => setErrorMessage(''), 3000);
      } else {
        setErrorMessage(responseData.error || 'Failed to update profile. Please try again.');
        console.error('❌ Backend error:', responseData);
      }
    } catch (err) {
      setErrorMessage('Cannot connect to server. Please check if the backend is running.');
      console.error('❌ Profile update error:', err);
    } finally {
      setProfileUpdating(false);
    }
  };

  // Change Password handlers
  const handleChangePasswordClick = () => {
    setPasswordForm({
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    });
    setPasswordErrors({});
    setPasswordStep(1);
    setOtpCode('');
    setShowChangePassword(true);
  };

  const handlePasswordFormChange = (field, value) => {
    setPasswordForm({ ...passwordForm, [field]: value });

    let error = '';
    if (field === 'currentPassword') {
      error = !value ? 'Current password is required' : '';
    } else if (field === 'newPassword') {
      error = !value ? 'New password is required' : validatePassword(value);
    } else if (field === 'confirmPassword') {
      error = value !== passwordForm.newPassword ? 'Passwords do not match' : '';
    }
    
    setPasswordErrors({ ...passwordErrors, [field]: error });
  };

  const handleRequestChangePassword = async (e) => {
    e.preventDefault();

    // Validate all fields
    const errors = {};
    if (!passwordForm.currentPassword) errors.currentPassword = 'Current password is required';
    if (!passwordForm.newPassword) errors.newPassword = 'New password is required';
    const pwError = validatePassword(passwordForm.newPassword);
    if (pwError) errors.newPassword = pwError;
    if (passwordForm.newPassword !== passwordForm.confirmPassword) errors.confirmPassword = 'Passwords do not match';

    if (Object.keys(errors).length > 0) {
      setPasswordErrors(errors);
      return;
    }

    // Verify current password
    if (passwordForm.currentPassword !== user.password) {
      setErrorMessage('Current password is incorrect.');
      return;
    }
    setErrorMessage('');

    setPasswordUpdating(true);
    try {
      // Request OTP for password change
      const response = await fetch('http://localhost:5000/api/request-password-change-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, email: user.email }),
      });

      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(data.error || 'Failed to send OTP.');
        return;
      }

      setPendingUserId(user.id);
      setPasswordStep(2);
      alert('OTP sent to your email. Please check your inbox.');
    } catch (err) {
      setErrorMessage('Cannot connect to server.');
    } finally {
      setPasswordUpdating(false);
    }
  };

  const handleVerifyAndChangePassword = async (e) => {
    e.preventDefault();

    if (!otpCode) {
      setErrorMessage('Please enter the OTP code.');
      return;
    }
    setErrorMessage('');

    setPasswordUpdating(true);
    try {
      // Verify OTP and update password
      const response = await fetch('http://localhost:5000/api/verify-password-change-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: pendingUserId,
          otp: otpCode,
          newPassword: passwordForm.newPassword
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(data.error || 'OTP verification failed.');
        return;
      }

      setErrorMessage('Password changed successfully!');
      setShowChangePassword(false);
      
      // Update local user with new password
      const updatedUser = { ...user, password: passwordForm.newPassword };
      localStorage.setItem('loggedInUser', JSON.stringify(updatedUser));
      setUser(updatedUser);
    } catch (err) {
      setErrorMessage('Cannot connect to server.');
    } finally {
      setPasswordUpdating(false);
    }
  };

  // Theme handlers
  const handleThemeChange = (newTheme) => {
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="settings-container" data-theme={theme}>
      {/* Header */}
      <div className="settings-header">
        <button
          className="back-btn"
          onClick={() => {
            if (user?.role === 'admin') navigate('/admin-dashboard');
            else if (user?.role === 'teacher') navigate('/teacher-dashboard');
            else navigate('/parent-dashboard');
          }}
        >
          Back
        </button>
        <img src={logoImage} alt="Logo" className="settings-logo" />
        <h1>Settings</h1>
      </div>

      {/* Main Content */}
      <div className="settings-content">
        {/* Sidebar */}
        <aside className="settings-sidebar">
          <button
            className={`sidebar-btn ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
          >
            👤 My Profile
          </button>
          <button
            className={`sidebar-btn ${activeTab === 'password' ? 'active' : ''}`}
            onClick={() => setActiveTab('password')}
          >
            🔒 Change Password
          </button>
          <button
            className={`sidebar-btn ${activeTab === 'appearance' ? 'active' : ''}`}
            onClick={() => setActiveTab('appearance')}
          >
            <GearIcon /> Appearance
          </button>
          <button
            className={`sidebar-btn ${activeTab === 'logout' ? 'active' : ''}`}
            onClick={handleLogout}
            style={{ marginTop: '5px' }}
          >
            Logout
          </button>
        </aside>
        <main className="settings-main">
          {activeTab === 'profile' && (
            <div className="settings-section">
              <div className="section-header">
                <h2>My Profile</h2>
              </div>
              {!showEditProfile ? (
                <div className="profile-view">
                  <div className="profile-header">
                    <div className="profile-left">
                      <div className="profile-avatar">{(user?.name||'').charAt(0).toUpperCase()}</div>
                      <div>
                        <h3 style={{margin:0}}>{user?.name}</h3>
                        <div className="info-text">{user?.email}</div>
                      </div>
                    </div>
                    <div className="profile-actions">
                      <button className="btn btn-primary" onClick={handleEditProfileClick}>Edit Profile</button>
                    </div>
                  </div>

                  <div className="profile-details-grid">
                    <div className="info-row"><label>First Name:</label><div className="profile-static-field">{(user?.name || '').split(' ')[0] || ''}</div></div>
                    <div className="info-row"><label>Middle Name:</label><div className="profile-static-field">{(() => { const p=(user?.name||'').split(' '); return p.length>2 ? p.slice(1,-1).join(' ') : ''; })()}</div></div>
                    <div className="info-row"><label>Last Name:</label><div className="profile-static-field">{(() => { const p=(user?.name||'').split(' '); return p.length ? p[p.length-1] : ''; })()}</div></div>
                    <div className="info-row"><label>Email:</label><div className="profile-static-field">{user.email}</div></div>
                    <div className="info-row">
                      <label>Role:</label>
                      <span className="role-badge">{user?.role ? `${user.role.charAt(0).toUpperCase()}${user.role.slice(1)}` : 'User'}</span>
                    </div>
                    <div className="info-row">
                      <label>Phone Number:</label>
                      <span>{user.mobile_number || 'Not set'}</span>
                    </div>
                    <div className="info-row">
                      <label>Address:</label>
                      <span>{user.address || 'Not set'}</span>
                    </div>
                    <div className="info-row">
                      <label>Birthday:</label>
                      <span>{formatDate(user.birthday)}</span>
                    </div>
                    <div className="info-row">
                      <label>Gender:</label>
                      <span>{user.gender || 'Not set'}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleUpdateProfile} className="profile-form">
                  <div className="form-group">
                    <label>First Name *</label>
                    <input
                      type="text"
                      value={editForm.firstName}
                      onChange={(e) => handleProfileFormChange('firstName', e.target.value)}
                      className={profileErrors.firstName ? 'error' : ''}
                    />
                    {profileErrors.firstName && <span className="error-text">{profileErrors.firstName}</span>}
                  </div>

                  <div className="form-group">
                    <label>Middle Name</label>
                    <input
                      type="text"
                      value={editForm.middleName}
                      onChange={(e) => handleProfileFormChange('middleName', e.target.value)}
                      className={profileErrors.middleName ? 'error' : ''}
                    />
                    {profileErrors.middleName && <span className="error-text">{profileErrors.middleName}</span>}
                  </div>

                  <div className="form-group">
                    <label>Last Name *</label>
                    <input
                      type="text"
                      value={editForm.lastName}
                      onChange={(e) => handleProfileFormChange('lastName', e.target.value)}
                      className={profileErrors.lastName ? 'error' : ''}
                    />
                    {profileErrors.lastName && <span className="error-text">{profileErrors.lastName}</span>}
                  </div>

                  <div className="form-group">
                    <label>Email *</label>
                    <input
                      type="email"
                      value={editForm.email}
                      onChange={(e) => handleProfileFormChange('email', e.target.value)}
                      className={profileErrors.email ? 'error' : ''}
                    />
                    {profileErrors.email && <span className="error-text">{profileErrors.email}</span>}
                  </div>

                  <div className="form-group">
                    <label>Phone Number *</label>
                    <input
                      type="text"
                      placeholder="09XXXXXXXXX"
                      value={editForm.mobile_number}
                      onChange={(e) => handleProfileFormChange('mobile_number', e.target.value)}
                      className={profileErrors.mobile_number ? 'error' : ''}
                    />
                    {profileErrors.mobile_number && <span className="error-text">{profileErrors.mobile_number}</span>}
                  </div>

                  <div className="form-group">
                    <label>Address</label>
                    <input
                      type="text"
                      value={editForm.address}
                      onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label>Birthday</label>
                    <input
                      type="date"
                      max={getMaxBirthdate()}
                      value={editForm.birthday}
                      onChange={(e) => {
                        const selectedDate = e.target.value;
                        setEditForm({ ...editForm, birthday: selectedDate });
                        const error = validateBirthday(selectedDate);
                        setProfileErrors({ ...profileErrors, birthday: error });
                      }}
                      className={profileErrors.birthday ? 'error' : ''}
                    />
                    {profileErrors.birthday && <span className="error-text">{profileErrors.birthday}</span>}
                  </div>

                  <div className="form-group">
                    <label>Gender</label>
                    <select
                      value={editForm.gender || ''}
                      onChange={(e) => setEditForm({ ...editForm, gender: e.target.value })}
                      className="gender-select"
                    >
                      <option value="">Select gender</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                    </select>
                  </div>

                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn-success"
                      disabled={profileUpdating}
                    >
                      {profileUpdating ? 'Saving...' : 'Save Changes'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setShowEditProfile(false)}
                      disabled={profileUpdating}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Change Password Tab */}
          {activeTab === 'password' && (
            <div className="settings-section">
              <div className="section-header">
                <h2>Change Password</h2>
              </div>
              {!showChangePassword ? (
                <div className="password-view">
                  <p className="info-text">Update your password to keep your account secure. You'll need to verify with OTP.</p>
                  <button className="btn btn-primary" onClick={handleChangePasswordClick}>
                    Change Password
                  </button>
                </div>
              ) : passwordStep === 1 ? (
                <form onSubmit={handleRequestChangePassword} className="password-form">
                  <div className="form-group">
                    <label>Current Password *</label>
                    <div className="password-input-wrapper">
                      <input
                        type={showPasswords.current ? 'text' : 'password'}
                        value={passwordForm.currentPassword}
                        onChange={(e) => handlePasswordFormChange('currentPassword', e.target.value)}
                        className={passwordErrors.currentPassword ? 'error' : ''}
                      />
                      {passwordForm.currentPassword?.length > 0 && (
                        <button
                          type="button"
                          className="password-toggle-button"
                          aria-label={showPasswords.current ? 'Hide password' : 'Show password'}
                          onClick={() => setShowPasswords({ ...showPasswords, current: !showPasswords.current })}
                        >
                          {showPasswords.current ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      )}
                    </div>
                    {passwordErrors.currentPassword && <span className="error-text">{passwordErrors.currentPassword}</span>}
                  </div>

                  <div className="form-group">
                    <label>New Password *</label>
                    <div className="password-input-wrapper">
                      <input
                        type={showPasswords.new ? 'text' : 'password'}
                        value={passwordForm.newPassword}
                        onChange={(e) => handlePasswordFormChange('newPassword', e.target.value)}
                        className={passwordErrors.newPassword ? 'error' : ''}
                        placeholder="At least 12 characters"
                      />
                      {passwordForm.newPassword?.length > 0 && (
                        <button
                          type="button"
                          className="password-toggle-button"
                          aria-label={showPasswords.new ? 'Hide password' : 'Show password'}
                          onClick={() => setShowPasswords({ ...showPasswords, new: !showPasswords.new })}
                        >
                          {showPasswords.new ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      )}
                    </div>
                    {passwordErrors.newPassword && <span className="error-text">{passwordErrors.newPassword}</span>}
                  </div>

                  <div className="form-group">
                    <label>Confirm New Password *</label>
                    <div className="password-input-wrapper">
                      <input
                        type={showPasswords.confirm ? 'text' : 'password'}
                        value={passwordForm.confirmPassword}
                        onChange={(e) => handlePasswordFormChange('confirmPassword', e.target.value)}
                        className={passwordErrors.confirmPassword ? 'error' : ''}
                      />
                      {passwordForm.confirmPassword?.length > 0 && (
                        <button
                          type="button"
                          className="password-toggle-button"
                          aria-label={showPasswords.confirm ? 'Hide password' : 'Show password'}
                          onClick={() => setShowPasswords({ ...showPasswords, confirm: !showPasswords.confirm })}
                        >
                          {showPasswords.confirm ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      )}
                    </div>
                    {passwordErrors.confirmPassword && <span className="error-text">{passwordErrors.confirmPassword}</span>}
                  </div>

                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn-success"
                      disabled={passwordUpdating}
                    >
                      {passwordUpdating ? ' Sending OTP...' : 'Send OTP'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setShowChangePassword(false)}
                      disabled={passwordUpdating}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleVerifyAndChangePassword} className="otp-form">
                  <p className="info-text">An OTP has been sent to your email. Please enter it below.</p>
                  
                  <div className="form-group">
                    <label>OTP Code *</label>
                    <input
                      type="text"
                      placeholder="Enter 6-digit code"
                      maxLength="6"
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                      className="otp-input"
                    />
                  </div>

                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn-success"
                      disabled={passwordUpdating || !otpCode}
                    >
                      {passwordUpdating ? ' Verifying...' : ' Verify & Change Password'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setPasswordStep(1)}
                      disabled={passwordUpdating}
                    >
                      Back
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Appearance Tab */}
          {activeTab === 'appearance' && (
            <div className="settings-section">
              <div className="section-header">
                <h2>Appearance</h2>
              </div>
              <div className="appearance-view">
                <p className="info-text">Choose your preferred theme for the application.</p>

                <div className="theme-selector">
                  <div
                    className={`theme-option ${theme === 'light' ? 'active' : ''}`}
                    onClick={() => handleThemeChange('light')}
                  >
                    <div className="theme-preview light"></div>
                    <span>Light Theme</span>
                  </div>

                  <div
                    className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
                    onClick={() => handleThemeChange('dark')}
                  >
                    <div className="theme-preview dark"></div>
                    <span>Dark Theme</span>
                  </div>
                </div>

                <div className="theme-info">
                  <p><strong>Current Theme:</strong> {theme.charAt(0).toUpperCase() + theme.slice(1)}</p>
                  <p>Your theme preference will be saved and applied across the application.</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Footer removed (back button moved to header) */}

      {/* Inline error message */}
      {errorMessage && (
        <div style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          backgroundColor: theme === 'dark' ? '#5a2a2a' : '#f8d7da',
          color: theme === 'dark' ? '#ffb3b3' : '#721c24',
          padding: '12px 20px',
          borderRadius: '4px',
          border: theme === 'dark' ? '1px solid #8b3d3d' : '1px solid #f5c6cb',
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
              color: theme === 'dark' ? '#ffb3b3' : '#721c24',
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
