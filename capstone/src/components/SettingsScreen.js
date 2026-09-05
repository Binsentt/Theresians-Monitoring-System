import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import {
  combineAddressFields,
  formatRoleLabel,
  isParentRole,
  normalizeRole,
  splitAddressFields,
  validateOptionalAdultBirthday,
} from './manageUsers.utils';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import { DashboardContainer, MainContent, PageContent, TopBar } from './layout/AppLayout';
import { apiUrl } from '../api';
import { buildAuthHeaders, clearStoredSession, getStoredUserSession } from './session.utils';
import PasswordStrengthFeedback from './PasswordStrengthFeedback';
import { validateNewWebsitePassword, validatePhilippineMobile, validatePhilippineMobileUpdate } from '../utils/validation.utils';
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
    street: '',
    city: '',
    province: '',
    birthday: '',
    gender: ''
  });
  const [profileErrors, setProfileErrors] = useState({});
  const [profileUpdating, setProfileUpdating] = useState(false);
  const [originalMobileNumber, setOriginalMobileNumber] = useState('');

  // Change Password States
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [passwordErrors, setPasswordErrors] = useState({});
  const [showPasswords, setShowPasswords] = useState({
    current: false,
    new: false,
    confirm: false
  });
  const [passwordUpdating, setPasswordUpdating] = useState(false);
  const [showInitialPasswordConfirmation, setShowInitialPasswordConfirmation] = useState(false);

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
          const response = await fetch(apiUrl(`/api/user/${loggedInUser.id}`), {
            headers: buildAuthHeaders(),
          });
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
    clearStoredSession();
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
  const validatePhone = (phone, originalPhone) => {
    const result = originalPhone === undefined
      ? validatePhilippineMobile(phone)
      : validatePhilippineMobileUpdate(phone, originalPhone);
    return result.error || '';
  };
  const validateNewPassword = (pw) => validateNewWebsitePassword(pw).error || '';
  const validateBirthday = (date) => {
    return validateOptionalAdultBirthday(date);
  };

  // Profile handlers
  const handleEditProfileClick = async () => {
    // FIX: Re-fetch fresh user data when Edit is clicked to ensure we have latest DB values
    try {
      console.log('📥 Re-fetching user data before edit for ID:', user?.id);
      const response = await fetch(apiUrl(`/api/user/${user.id}`), {
        headers: buildAuthHeaders(),
      });
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
      const originalMobile = freshUserData.mobile_number || '';
      setEditForm({
        firstName: nameParts[0] || '',
        middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
        lastName: nameParts.length ? nameParts[nameParts.length - 1] : '',
        email: freshUserData.email || '',
        mobile_number: originalMobile,
        ...splitAddressFields(freshUserData.address),
        birthday: freshUserData.birthday || '',
        gender: freshUserData.gender || ''
      });
      setOriginalMobileNumber(originalMobile);
      console.log('📝 Edit form initialized:', { phone: freshUserData.mobile_number, address: freshUserData.address, birthday: freshUserData.birthday, gender: freshUserData.gender });
      setProfileErrors({});
      setErrorMessage('');
      setShowEditProfile(true);
    } catch (err) {
      console.error('Error preparing edit form:', err);
      // Fallback: initialize from current user state even if fetch fails
      const nameParts = (user?.name || '').split(' ').filter(Boolean);
      const originalMobile = user.mobile_number || '';
      setEditForm({
        firstName: nameParts[0] || '',
        middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
        lastName: nameParts.length ? nameParts[nameParts.length - 1] : '',
        email: user.email,
        mobile_number: originalMobile,
        ...splitAddressFields(user.address),
        birthday: user.birthday || '',
        gender: user.gender || ''
      });
      setOriginalMobileNumber(originalMobile);
      setProfileErrors({});
      setErrorMessage('');
      setShowEditProfile(true);
    }
  };

  const handleProfileFormChange = (field, value) => {
    let finalValue = value;
    if (field === 'firstName' || field === 'middleName' || field === 'lastName') finalValue = value.replace(/[0-9]/g, '');

    setEditForm({ ...editForm, [field]: finalValue });

    let error = '';
    if (field === 'firstName') error = validateNamePart(finalValue, true);
    else if (field === 'middleName') error = validateNamePart(finalValue, false);
    else if (field === 'lastName') error = validateNamePart(finalValue, true);
    else if (field === 'email') error = validateEmail(finalValue);
    else if (field === 'mobile_number') error = validatePhone(finalValue, originalMobileNumber);
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
    
    const mobileResult = validatePhilippineMobileUpdate(editForm.mobile_number, originalMobileNumber);
    const mobileError = mobileResult.error;
    if (mobileError) validationErrors.mobile_number = mobileError;
    
    const birthdayError = validateBirthday(editForm.birthday);
    if (birthdayError) validationErrors.birthday = birthdayError;

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
        address: combineAddressFields(editForm),
        birthday: editForm.birthday || '', // Send empty string, backend converts to NULL
        gender: editForm.gender || '',
        status: user.status || 'Active'
      };
      if (editForm.mobile_number !== originalMobileNumber) {
        payload.mobile_number = mobileResult.value;
      }

      console.log('📤 Sending profile update payload:', payload);

      const response = await fetch(apiUrl(`/api/user/${user.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
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
            const freshResponse = await fetch(apiUrl(`/api/user/${user.id}`), {
              headers: buildAuthHeaders(),
            });
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
    setShowChangePassword(true);
  };

  const handlePasswordFormChange = (field, value) => {
    setPasswordForm({ ...passwordForm, [field]: value });

    let error = '';
    if (field === 'currentPassword') {
      error = !value ? 'Current password is required' : '';
    } else if (field === 'newPassword') {
      error = !value ? 'New password is required' : validateNewPassword(value);
    } else if (field === 'confirmPassword') {
      error = value !== passwordForm.newPassword ? 'Passwords do not match' : '';
    }
    
    setPasswordErrors({ ...passwordErrors, [field]: error });
  };

  const validatePasswordChange = (requiresInitialPassword) => {
    const errors = {};
    if (!requiresInitialPassword && !passwordForm.currentPassword) errors.currentPassword = 'Current password is required';
    if (!passwordForm.newPassword) errors.newPassword = 'New password is required';
    const pwError = validateNewPassword(passwordForm.newPassword);
    if (pwError) errors.newPassword = pwError;
    if (passwordForm.newPassword !== passwordForm.confirmPassword) errors.confirmPassword = 'Passwords do not match';

    if (Object.keys(errors).length > 0) {
      setPasswordErrors(errors);
      return false;
    }
    return true;
  };

  const submitPasswordChange = async (requiresInitialPassword) => {
    setErrorMessage('');
    setPasswordUpdating(true);
    try {
      const response = await fetch(apiUrl(requiresInitialPassword ? '/api/account/initial-password' : '/api/account/password'), {
        method: requiresInitialPassword ? 'POST' : 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify(requiresInitialPassword
          ? { newPassword: passwordForm.newPassword }
          : { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword }),
      });

      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(data.error || 'Unable to change password.');
        if (response.status === 401 || response.status === 403) {
          clearStoredSession();
          navigate('/login', { replace: true, state: { sessionExpired: true } });
        }
        return;
      }

      if (data.user) {
        localStorage.setItem('loggedInUser', JSON.stringify(data.user));
        window.dispatchEvent(new Event('session-user-updated'));
        setUser(data.user);
      }
      if (data.rememberToken) localStorage.setItem('rememberToken', data.rememberToken);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPasswordErrors({});
      setErrorMessage('Password changed successfully!');
      setShowChangePassword(false);
      setShowInitialPasswordConfirmation(false);
    } catch (err) {
      setErrorMessage('Cannot connect to server.');
    } finally {
      setPasswordUpdating(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    const requiresInitialPassword = user?.requiresInitialPasswordSetup === true;
    if (!validatePasswordChange(requiresInitialPassword)) return;
    if (requiresInitialPassword) {
      setShowInitialPasswordConfirmation(true);
      return;
    }

    await submitPasswordChange(false);
  };

  // Theme handlers
  const handleThemeChange = (newTheme) => {
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  if (loading) {
    const loadingRole = normalizeRole(getStoredUserSession()?.role || 'parent');
    return (
      <DashboardLoadingShell
        role={loadingRole}
        activeItem="settings"
        logoSrc={logoImage}
        portalLabel={`${formatRoleLabel(loadingRole)} Portal`}
        heading="Settings"
        subheading="Manage your profile, security, and preferences."
      />
    );
  }

  const role = normalizeRole(user?.role || 'parent');
  const requiresInitialPassword = user?.requiresInitialPasswordSetup === true;

  return (
    <DashboardContainer
      className="settings-dashboard-shell"
      sidebar={(
        <AnalyticsSidebar
          role={role}
          activeItem="settings"
          logoSrc={logoImage}
          portalLabel={`${formatRoleLabel(role)} Portal`}
        />
      )}
      main={(
        <MainContent>
          <TopBar className="settings-topbar">
            <div>
              <h1>Settings</h1>
              <p>Manage your profile, password, and appearance.</p>
            </div>
          </TopBar>
          <PageContent>
            <div className="settings-container" data-theme={theme}>
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
                      <span className="role-badge">{formatRoleLabel(user?.role || 'User')}</span>
                    </div>
                    {isParentRole(user?.role) && (
                      <div className="info-row">
                        <label>Parent ID:</label>
                        <div className="profile-static-field">{user.parent_id || 'Not generated yet'}</div>
                      </div>
                    )}
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
                    <label>Phone Number</label>
                    <input
                      type="tel"
                      placeholder="09XXXXXXXXX"
                      value={editForm.mobile_number}
                      onChange={(e) => handleProfileFormChange('mobile_number', e.target.value)}
                      className={profileErrors.mobile_number ? 'error' : ''}
                      inputMode="numeric"
                      maxLength={11}
                    />
                    {profileErrors.mobile_number && <span className="error-text">{profileErrors.mobile_number}</span>}
                  </div>

                  <div className="form-group">
                    <label>Street</label>
                    <input
                      type="text"
                      value={editForm.street}
                      onChange={(e) => setEditForm({ ...editForm, street: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label>City</label>
                    <input
                      type="text"
                      value={editForm.city}
                      onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label>Province</label>
                    <input
                      type="text"
                      value={editForm.province}
                      onChange={(e) => setEditForm({ ...editForm, province: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label>Birthday</label>
                    <input
                      type="date"
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
          {activeTab === 'password' && (
            <div className="settings-section">
              <div className="section-header">
                <h2>Change Password</h2>
              </div>
              {requiresInitialPassword ? (
                <div className="password-view temporary-password-settings-view">
                  <div className="temporary-password-settings-warning" role="status">
                    <strong>Your account is still using a temporary password.</strong>
                    <span>Create your permanent password to secure your account.</span>
                  </div>
                  <form onSubmit={handleChangePassword} className="password-form">
                    <div className="form-group">
                      <label>New Password *</label>
                      <div className="password-input-wrapper">
                        <input
                          type={showPasswords.new ? 'text' : 'password'}
                          value={passwordForm.newPassword}
                          onChange={(e) => handlePasswordFormChange('newPassword', e.target.value)}
                          className={passwordErrors.newPassword ? 'error' : ''}
                          placeholder="At least 8 characters"
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
                      <PasswordStrengthFeedback password={passwordForm.newPassword} />
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
                      <button type="submit" className="btn btn-success" disabled={passwordUpdating}>
                        {passwordUpdating ? 'Saving...' : 'Save Permanent Password'}
                      </button>
                    </div>
                  </form>
                </div>
              ) : !showChangePassword ? (
                <div className="password-view">
                  <p className="info-text">Update your password to keep your account secure.</p>
                  <button className="btn btn-primary" onClick={handleChangePasswordClick}>
                    Change Password
                  </button>
                </div>
              ) : (
                <form onSubmit={handleChangePassword} className="password-form">
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
                        placeholder="At least 8 characters"
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
                    <PasswordStrengthFeedback password={passwordForm.newPassword} />
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
                      {passwordUpdating ? ' Saving...' : 'Change Password'}
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
              {showInitialPasswordConfirmation && requiresInitialPassword && (
                <div className="temporary-password-overlay" role="presentation">
                  <section className="temporary-password-modal temporary-password-confirmation" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-password-title">
                    <h2 id="settings-confirm-password-title">Confirm Password Change</h2>
                    <p>Are you sure you want to use this as your new permanent password?</p>
                    <div className="temporary-password-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => submitPasswordChange(true)}
                        disabled={passwordUpdating}
                      >
                        {passwordUpdating ? 'Saving...' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setShowInitialPasswordConfirmation(false)}
                        disabled={passwordUpdating}
                      >
                        Cancel
                      </button>
                    </div>
                  </section>
                </div>
              )}
            </div>
          </PageContent>
        </MainContent>
      )}
    />
  );
}
