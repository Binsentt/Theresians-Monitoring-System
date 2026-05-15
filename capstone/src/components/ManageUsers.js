import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { filterUsers, formatRoleLabel, normalizeRole, paginateItems } from './manageUsers.utils';
import '../styles/manageusers.css';

export default function ManageUsers() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedRole, setSelectedRole] = useState('Parent');
  const [roleFilter, setRoleFilter] = useState('All');
  const [showArchived, setShowArchived] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  const [newUser, setNewUser] = useState({
    firstName: '',
    middleName: '',
    lastName: '',
    email: '',
    password: '',
    mobile_number: '',
    address: '',
    birthday: '',
    gender: '',
    employee_id: ''
  });
  const [adding, setAdding] = useState(false);
  const [addErrors, setAddErrors] = useState({});
  const [validationModal, setValidationModal] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState({
    firstName: '',
    middleName: '',
    lastName: '',
    email: '',
    mobile_number: '',
    address: '',
    birthday: '',
    gender: '',
    employee_id: '',
    role: 'Parent'
  });
  const [updating, setUpdating] = useState(false);
  const [editErrors, setEditErrors] = useState({});
  const [teacherRelations, setTeacherRelations] = useState([]);
  const [relationEmail, setRelationEmail] = useState('');
  const [relationMessage, setRelationMessage] = useState('');
  const [deletingUser, setDeletingUser] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const filteredUsers = filterUsers(users, searchTerm, roleFilter);
  const usersPerPage = 8;
  const paginatedUsers = paginateItems(filteredUsers, currentPage, usersPerPage);
  const getMaxBirthdate = () => {
    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() - 18);
    return maxDate.toISOString().split('T')[0];
  };

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

  const validateNameField = (name) => {
    if (!name) return 'This field is required';
    if (/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(name)) return 'No numbers or symbols allowed';
    return '';
  };

  const validateEmail = (email) => {
    if (!email) return 'Email is required';
    if (!email.endsWith('@gmail.com')) return 'Email must be a Gmail address (@gmail.com)';
    return '';
  };

  const validatePhone = (phone) => {
    if (!phone) return 'Mobile number is required';
    if (!phone.startsWith('09')) return 'Mobile number must start with 09';
    if (phone.length !== 11) return 'Mobile number must be exactly 11 digits';
    return '';
  };

  const validatePassword = (password) => {
    if (!password) return 'Password is required';
    if (password.length < 12) return 'Password must be at least 12 characters long';
    if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
    if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
    if (!/\d/.test(password)) return 'Password must contain at least one number';
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return 'Password must contain at least one symbol';
    return '';
  };
  const restrictInput = (field, value) => {
    let cleanedValue = value;
    if (field === 'firstName' || field === 'middleName' || field === 'lastName') {
      cleanedValue = value.replace(/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/g, '');
    }
    if (field === 'mobile_number') {
      cleanedValue = value.replace(/[^0-9]/g, '').slice(0, 11);
    }
    return cleanedValue;
  };

  const handleAddFormChange = (field, value) => {
    const finalValue = restrictInput(field, value);
    setNewUser({ ...newUser, [field]: finalValue });
    
    let error = '';
    if (field === 'firstName' || field === 'middleName' || field === 'lastName') error = validateNameField(finalValue);
    else if (field === 'email') error = validateEmail(finalValue);
    else if (field === 'mobile_number') error = validatePhone(finalValue);
    else if (field === 'password') {
      if (selectedRole === 'Teacher' && !finalValue) {
        error = 'Password is required for teachers';
      } else if (finalValue) {
        error = validatePassword(finalValue);
      }
    }
    else if (field === 'birthday') error = validateBirthday(finalValue);
    else if (field === 'gender') {
      if ((selectedRole || '').toLowerCase() !== 'admin' && finalValue === '') error = 'Gender is required';
    }

    setAddErrors({ ...addErrors, [field]: error });
  };

  const handleEditFormChange = (field, value) => {
    const finalValue = restrictInput(field, value);
    setEditForm({ ...editForm, [field]: finalValue });

    let error = '';
    if (field === 'firstName' || field === 'middleName' || field === 'lastName') error = validateNameField(finalValue);
    else if (field === 'email') error = validateEmail(finalValue);
    else if (field === 'mobile_number') error = validatePhone(finalValue);
    else if (field === 'birthday') error = validateBirthday(finalValue);
    else if (field === 'gender') {
      const roleToCheck = (editForm.role || editingUser?.role || '').toLowerCase();
      if (roleToCheck !== 'admin' && finalValue === '') error = 'Gender is required';
    }

    setEditErrors({ ...editErrors, [field]: error });
  };

  useEffect(() => {
    const loadData = async () => {
      try {
        // Load and apply theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (!loggedInUser || loggedInUser.role !== 'admin') {
          navigate('/login');
          return;
        }
        setUser(loggedInUser);
        loadUsers();
      } catch (error) {
        console.error('Error loading data:', error);
        navigate('/login');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [navigate]);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const loadUsers = async () => {
    try {
      const response = await fetch(`http://localhost:5000/api/accounts?archived=${showArchived}`);
      const data = await response.json();
      setUsers(data);
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    const roleIsTeacher = (selectedRole || '').toLowerCase() === 'teacher';
    const missingPassword = roleIsTeacher && !newUser.password;
    if (!newUser.firstName || !newUser.lastName || !newUser.email || !newUser.birthday || !newUser.gender || missingPassword) {
      setValidationModal({
        title: 'Missing Required Fields',
        message: `Please fill in all required fields (${roleIsTeacher ? 'First Name, Last Name, Email, Password, Birthday, Gender' : 'First Name, Last Name, Email, Birthday, Gender'})`
      });
      return;
    }
    if (roleIsTeacher && !newUser.employee_id) {
      setValidationModal({
        title: 'Missing Employee ID',
        message: 'Teachers must have an employee ID.'
      });
      return;
    }
    if (Object.values(addErrors).some(err => err !== '')) {
      setValidationModal({
        title: 'Form Errors',
        message: 'Please fix the errors in the form before submitting'
      });
      return;
    }

    setAdding(true);
    try {
      const fullName = `${newUser.firstName}${newUser.middleName ? ' ' + newUser.middleName : ''} ${newUser.lastName}`;
      const payload = {
        name: fullName,
        email: newUser.email,
        password: newUser.password || undefined,
        mobile_number: newUser.mobile_number,
        address: newUser.address,
        birthday: newUser.birthday,
        gender: newUser.gender || '',
        role: selectedRole.toLowerCase(),
      };
      if (roleIsTeacher) payload.employee_id = newUser.employee_id;

      const response = await fetch('http://localhost:5000/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (response.ok) {
        const passwordMessage = data.tempPassword
          ? ` Temporary login password: ${data.tempPassword}`
          : '';
        setValidationModal({
          title: 'Success',
          message: `${selectedRole} added successfully!${passwordMessage}`
        });
        setNewUser({ firstName: '', middleName: '', lastName: '', email: '', password: '', mobile_number: '', address: '', birthday: '', gender: '', employee_id: '' });
        setShowAddForm(false);
        setSelectedRole('Parent');
        loadUsers();
      } else {
        setValidationModal({
          title: 'Error',
          message: data.error || `Failed to add ${selectedRole.toLowerCase()}`
        });
      }
    } catch (error) {
      setValidationModal({
        title: 'Connection Error',
        message: 'Connection error. Please check if the server is running.'
      });
    } finally {
      setAdding(false);
    }
  };

  const handleEditClick = (u) => {
    setEditingUser(u);
    setEditErrors({});
    setRelationEmail('');
    setRelationMessage('');
    const nameParts = String(u.name || '').trim().split(/\s+/).filter(Boolean);
    setEditForm({
      firstName: nameParts[0] || '',
      middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
      lastName: nameParts[nameParts.length - 1] || '',
      email: u.email,
      mobile_number: u.mobile_number || '',
      address: u.address || '',
      birthday: u.birthday ? new Date(u.birthday).toISOString().split('T')[0] : '',
      gender: u.gender || '',
      employee_id: u.employee_id || '',
      role: formatRoleLabel(u.role || 'Parent')
    });
    if (normalizeRole(u.role) === 'teacher') {
      loadTeacherRelationships(u.id);
    } else {
      setTeacherRelations([]);
    }
  };

  const loadTeacherRelationships = async (teacherId) => {
    try {
      const response = await fetch(`http://localhost:5000/api/teacher-student-relationships?teacherId=${teacherId}`);
      const data = await response.json();
      if (response.ok) {
        setTeacherRelations(data.relationships || []);
      } else {
        setTeacherRelations([]);
      }
    } catch (error) {
      console.error('Failed to load teacher relationships:', error);
      setTeacherRelations([]);
    }
  };

  const handleAddTeacherRelation = async () => {
    if (!relationEmail) {
      setRelationMessage('Student email is required to create a relationship.');
      return;
    }

    try {
      const response = await fetch('http://localhost:5000/api/teacher-student-relationships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacherId: editingUser.id, studentEmail: relationEmail, relationship_type: 'Parent' }),
      });
      const data = await response.json();
      if (response.ok) {
        setRelationMessage('Relationship added successfully.');
        setRelationEmail('');
        loadTeacherRelationships(editingUser.id);
      } else {
        setRelationMessage(data.error || 'Could not add relationship.');
      }
    } catch (error) {
      console.error('Failed to add teacher relation:', error);
      setRelationMessage('Connection error while adding relationship.');
    }
  };

  const handleRemoveTeacherRelation = async (relationId) => {
    try {
      const response = await fetch(`http://localhost:5000/api/teacher-student-relationships/${relationId}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        setRelationMessage('Relationship removed.');
        loadTeacherRelationships(editingUser.id);
      } else {
        setRelationMessage('Failed to remove relationship.');
      }
    } catch (error) {
      console.error('Failed to remove relationship:', error);
      setRelationMessage('Connection error while removing relationship.');
    }
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    const selectedRole = editForm.role || editingUser.role;
    if (!editForm.firstName || !editForm.lastName || !editForm.email || !editForm.birthday) {
      setValidationModal({
        title: 'Missing Required Fields',
        message: 'Please fill in all required fields (First Name, Last Name, Email, Birthday)'
      });
      return;
    }
    if (selectedRole === 'Teacher' && !editForm.employee_id) {
      setValidationModal({
        title: 'Missing Employee ID',
        message: 'Teachers must have an employee ID.'
      });
      return;
    }
    if (Object.values(editErrors).some(err => err !== '')) {
      setValidationModal({
        title: 'Form Errors',
        message: 'Please fix the errors before updating'
      });
      return;
    }

    setUpdating(true);
    try {
      const fullName = `${editForm.firstName}${editForm.middleName ? ' ' + editForm.middleName : ''} ${editForm.lastName}`;
      const payload = {
        name: fullName,
        email: editForm.email,
        role: selectedRole,
        mobile_number: editForm.mobile_number,
        address: editForm.address,
        birthday: editForm.birthday,
        gender: editForm.gender || '',
        employee_id: editForm.employee_id || undefined
      };

      const response = await fetch(`http://localhost:5000/api/accounts/${editingUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        setValidationModal({
          title: 'Success',
          message: 'User updated successfully!'
        });
        setEditingUser(null);
        loadUsers();
      } else {
        setValidationModal({
          title: 'Error',
          message: 'Failed to update user'
        });
      }
    } catch (error) {
      setValidationModal({
        title: 'Connection Error',
        message: 'Connection error'
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deletingUser?.id) return;
    setDeleting(true);
    try {
      const response = await fetch(`http://localhost:5000/api/accounts/${deletingUser.id}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setValidationModal({
          title: 'Success',
          message: 'User archived successfully!'
        });
        setDeletingUser(null);
        loadUsers();
      } else {
        setValidationModal({
          title: 'Error',
          message: 'Failed to archive user'
        });
      }
    } catch (error) {
      setValidationModal({
        title: 'Connection Error',
        message: 'Connection error'
      });
    } finally {
      setDeleting(false);
    }
  };

  const handlePermanentDeleteUser = async (userToDelete) => {
    if (!window.confirm(`Permanently delete ${userToDelete.name}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const response = await fetch(`http://localhost:5000/api/accounts/${userToDelete.id}?permanent=true`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setValidationModal({
          title: 'Success',
          message: 'User permanently deleted.'
        });
        loadUsers();
      } else {
        setValidationModal({
          title: 'Error',
          message: 'Failed to delete user permanently'
        });
      }
    } catch (error) {
      setValidationModal({
        title: 'Connection Error',
        message: 'Connection error'
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleRestoreUser = async (userToRestore) => {
    try {
      const response = await fetch(`http://localhost:5000/api/accounts/${userToRestore.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        setValidationModal({
          title: 'Success',
          message: 'User restored successfully!'
        });
        loadUsers();
      } else {
        setValidationModal({
          title: 'Error',
          message: 'Failed to restore user'
        });
      }
    } catch (error) {
      setValidationModal({
        title: 'Connection Error',
        message: 'Connection error'
      });
    }
  };

  useEffect(() => {
    loadUsers();
  }, [showArchived]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, roleFilter, showArchived]);

  useEffect(() => {
    if (currentPage !== paginatedUsers.currentPage) {
      setCurrentPage(paginatedUsers.currentPage);
    }
  }, [currentPage, paginatedUsers.currentPage]);

  const handleLogout = () => {
    localStorage.removeItem('loggedInUser');
    localStorage.removeItem('token');
    navigate('/');
  };

  if (loading) {
    return (
      <div className="sts-loader-container">
        <div className="sts-spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role="admin"
          activeItem="manage-users"
          logoSrc={logoImage}
          portalLabel="Admin Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>Manage Users</h1>
              <p>Welcome, {user?.name || 'Administrator'}</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection
              title={`Users List (${filteredUsers.length})`}
              actions={
                <div className="controls-wrapper">
                  <input
                    type="text"
                    placeholder="Search users..."
                    className="sts-search-input"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                  <select
                    className="sts-select"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                  >
                    <option value="All">All Roles</option>
                    <option value="Parent">Parent</option>
                    <option value="Teacher">Teacher</option>
                    <option value="Admin">Admin</option>
                  </select>
                  <button
                    className="sts-add-btn"
                    onClick={() => {
                      setSearchTerm('');
                      setShowArchived(prev => !prev);
                    }}
                  >
                    {showArchived ? 'Show Active' : 'Show Archived'}
                  </button>
                  <button
                    className="sts-add-btn"
                    onClick={() => setShowAddForm(!showAddForm)}
                  >
                    {showAddForm ? 'Cancel' : 'Add'}
                  </button>
                </div>
              }
            >

            {showAddForm && (
              <div className="form-container-card">
                <h3>Add New User</h3>
                <div className="role-selector">
                  <label>Select Role:</label>
                  <select
                    value={selectedRole}
                    onChange={(e) => {
                      setSelectedRole(e.target.value);
                      if (e.target.value === 'Parent' || e.target.value === 'Admin') {
                        setNewUser({ ...newUser, password: '' });
                      }
                    }}
                    className="sts-input"
                  >
                    <option value="Parent">Parent</option>
                    <option value="Teacher">Teacher</option>
                    <option value="Admin">Admin</option>
                  </select>
                </div>
                <form onSubmit={handleAddUser} className="sts-form">
                  <div className="form-group">
                    <label>First Name: *</label>
                    <input
                      type="text"
                      placeholder="John"
                      value={newUser.firstName}
                      onChange={(e) => handleAddFormChange('firstName', e.target.value)}
                      className="sts-input"
                    />
                    {addErrors.firstName && <p className="error-text">{addErrors.firstName}</p>}
                  </div>

                  <div className="form-group">
                    <label>Middle Name/Initial:</label>
                    <input
                      type="text"
                      placeholder="M. or Michael"
                      value={newUser.middleName}
                      onChange={(e) => handleAddFormChange('middleName', e.target.value)}
                      className="sts-input"
                    />
                    {addErrors.middleName && <p className="error-text">{addErrors.middleName}</p>}
                  </div>

                  <div className="form-group">
                    <label>Last Name: *</label>
                    <input
                      type="text"
                      placeholder="Doe"
                      value={newUser.lastName}
                      onChange={(e) => handleAddFormChange('lastName', e.target.value)}
                      className="sts-input"
                    />
                    {addErrors.lastName && <p className="error-text">{addErrors.lastName}</p>}
                  </div>

                  <div className="form-group">
                    <label>Email: *</label>
                    <input
                      type="email"
                      placeholder="user@gmail.com"
                      value={newUser.email}
                      onChange={(e) => handleAddFormChange('email', e.target.value)}
                      className="sts-input"
                    />
                    {addErrors.email && <p className="error-text">{addErrors.email}</p>}
                  </div>

                  {selectedRole === 'Teacher' ? (
                  <div className="form-group">
                    <label>Password: *</label>
                    <div className="password-field-wrapper">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Enter password"
                        value={newUser.password}
                        onChange={(e) => handleAddFormChange('password', e.target.value)}
                        className="sts-input"
                      />
                      <button
                        type="button"
                        className="password-toggle-button"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        )}
                      </button>
                    </div>
                    {addErrors.password && <p className="error-text">{addErrors.password}</p>}
                  </div>
                ) : (
                  <div className="form-group">
                    <label>Password:</label>
                    <div className="profile-static-field" style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '4px', border: '1px solid #d1d5db' }}>
                      A strong password will be generated automatically for parent and admin accounts.
                    </div>
                  </div>
                )}

                  <div className="form-group">
                    <label>Mobile Number:</label>
                    <input
                      type="text"
                      placeholder="09123456789"
                      value={newUser.mobile_number}
                      onChange={(e) => handleAddFormChange('mobile_number', e.target.value)}
                      className="sts-input"
                    />
                    {addErrors.mobile_number && <p className="error-text">{addErrors.mobile_number}</p>}
                  </div>

                  <div className="form-group">
                    <label>Address:</label>
                    <input
                      type="text"
                      placeholder="Enter address"
                      value={newUser.address}
                      onChange={(e) => setNewUser({ ...newUser, address: e.target.value })}
                      className="sts-input"
                    />
                  </div>

                  <div className="form-group">
                    <label>Birthday: *</label>
                    <input
                      type="date"
                      max={getMaxBirthdate()}
                      value={newUser.birthday}
                      onChange={(e) => {
                        const selectedDate = new Date(e.target.value);
                        const maxDate = new Date(getMaxBirthdate());
                        if (selectedDate <= maxDate) {
                          handleAddFormChange('birthday', e.target.value);
                        } else {
                          handleAddFormChange('birthday', '');
                        }
                      }}
                      className="sts-input"
                    />
                    {addErrors.birthday && <p className="error-text">{addErrors.birthday}</p>}
                  </div>

                  <div className="form-group">
                    <label>Gender: *</label>
                    <select
                      value={newUser.gender}
                      onChange={(e) => handleAddFormChange('gender', e.target.value)}
                      className="sts-input"
                    >
                      <option value="">Select Gender</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                    </select>
                    {addErrors.gender && <p className="error-text">{addErrors.gender}</p>}
                  </div>

                  {selectedRole === 'Teacher' && (
                    <div className="form-group">
                      <label>Employee ID: *</label>
                      <input
                        type="text"
                        placeholder="EMP-1234"
                        value={newUser.employee_id}
                        onChange={(e) => setNewUser({ ...newUser, employee_id: e.target.value })}
                        className="sts-input"
                      />
                    </div>
                  )}

                  <button type="submit" disabled={adding} className="sts-submit-btn">
                    {adding ? `Adding ${selectedRole}...` : `Add ${selectedRole}`}
                  </button>
                </form>
              </div>
            )}

            <div className="table-container">
              <table className="sts-data-table">
                <thead>
                  <tr>
                    <th>USER NAME</th>
                    <th>EMAIL</th>
                    <th>ROLE</th>
                    <th>MOBILE NUMBER</th>
                    <th>BIRTHDAY</th>
                    <th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="empty-table-msg">
                        {searchTerm ? `No results found for "${searchTerm}"` : "No users found."}
                      </td>
                    </tr>
                  ) : (
                    paginatedUsers.pageItems.map((u) => (
                      <tr key={u.id}>
                        <td>{u.name || 'No name set'}</td>
                        <td className="email-cell">{u.email}</td>
                        <td>
                          <span className={`role-badge role-${normalizeRole(u.role)}`}>
                            {formatRoleLabel(u.role)}
                          </span>
                        </td>
                        <td>{u.mobile_number || '-'}</td>
                        <td>{u.birthday ? new Date(u.birthday).toLocaleDateString() : 'Not set'}</td>
                        <td className="actions-cell">
                          {showArchived ? (
                            <>
                              <button className="restore-action-btn" onClick={() => handleRestoreUser(u)}>Restore</button>
                              <button className="delete-action-btn" onClick={() => handlePermanentDeleteUser(u)}>Delete</button>
                            </>
                          ) : (
                            <>
                              <button className="edit-action-btn" onClick={() => handleEditClick(u)}>Edit</button>
                              <button className="delete-action-btn" onClick={() => setDeletingUser(u)}>Delete</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {filteredUsers.length > 0 && paginatedUsers.totalPages > 1 && (
              <div className="manage-users-pagination">
                <span className="manage-users-pagination-summary">
                  Showing {paginatedUsers.startIndex + 1} - {paginatedUsers.endIndex} of {paginatedUsers.totalItems} users
                </span>
                <div className="manage-users-pagination-controls">
                  <button
                    type="button"
                    className="pagination-btn"
                    onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                    disabled={paginatedUsers.currentPage === 1}
                  >
                    Previous
                  </button>
                  <span className="pagination-info">
                    Page {paginatedUsers.currentPage} of {paginatedUsers.totalPages}
                  </span>
                  <button
                    type="button"
                    className="pagination-btn"
                    onClick={() => setCurrentPage((prev) => Math.min(prev + 1, paginatedUsers.totalPages))}
                    disabled={paginatedUsers.currentPage === paginatedUsers.totalPages}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {validationModal && (
              <div className="modal-overlay" onClick={() => setValidationModal(null)}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <h2>{validationModal.title}</h2>
                  <p>{validationModal.message}</p>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="update-btn"
                      onClick={() => setValidationModal(null)}
                    >
                      OK
                    </button>
                  </div>
                </div>
              </div>
            )}

            {deletingUser && (
              <div className="modal-overlay" onClick={() => !deleting && setDeletingUser(null)}>
                <div className="modal-content delete-modal" onClick={(e) => e.stopPropagation()}>
                  <h2>Confirm User Deletion</h2>
                  <p>
                    Are you sure you want to archive <strong>{deletingUser.name || deletingUser.email}</strong>?
                    This will remove the account from the active users table but keep it available in archived users.
                  </p>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="cancel-btn"
                      onClick={() => setDeletingUser(null)}
                      disabled={deleting}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="confirm-delete-btn"
                      onClick={handleDeleteUser}
                      disabled={deleting}
                    >
                      {deleting ? 'Deleting...' : 'Delete User'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {editingUser && (
              <div className="modal-overlay" onClick={() => !updating && setEditingUser(null)}>
                <div className="modal-content edit-user-modal" onClick={(e) => e.stopPropagation()}>
                  <h2 className="edit-user-modal-title">Edit User</h2>
                  <form onSubmit={handleUpdateUser} className="sts-form edit-user-form">
                    <div className="form-group">
                      <label>First Name: *</label>
                      <input
                        type="text"
                        value={editForm.firstName}
                        onChange={(e) => handleEditFormChange('firstName', e.target.value)}
                        className="sts-input"
                      />
                      {editErrors.firstName && <p className="error-text">{editErrors.firstName}</p>}
                    </div>

                    <div className="form-group">
                      <label>Middle Name/Initial:</label>
                      <input
                        type="text"
                        value={editForm.middleName}
                        onChange={(e) => handleEditFormChange('middleName', e.target.value)}
                        className="sts-input"
                      />
                      {editErrors.middleName && <p className="error-text">{editErrors.middleName}</p>}
                    </div>

                    <div className="form-group">
                      <label>Last Name: *</label>
                      <input
                        type="text"
                        value={editForm.lastName}
                        onChange={(e) => handleEditFormChange('lastName', e.target.value)}
                        className="sts-input"
                      />
                      {editErrors.lastName && <p className="error-text">{editErrors.lastName}</p>}
                    </div>

                    <div className="form-group">
                      <label>Email: *</label>
                      <input
                        type="email"
                        value={editForm.email}
                        onChange={(e) => handleEditFormChange('email', e.target.value)}
                        className="sts-input"
                      />
                      {editErrors.email && <p className="error-text">{editErrors.email}</p>}
                    </div>

                    <div className="form-group">
                      <label>Role:</label>
                      <select
                        value={editForm.role}
                        onChange={(e) => {
                          const nextRole = e.target.value;
                          setEditForm((prev) => ({
                            ...prev,
                            role: nextRole,
                            employee_id: nextRole === 'Teacher' ? prev.employee_id : '',
                          }));
                          if (nextRole !== 'Teacher') {
                            setTeacherRelations([]);
                            setRelationEmail('');
                            setRelationMessage('');
                          } else if (editingUser?.id) {
                            loadTeacherRelationships(editingUser.id);
                          }
                        }}
                        className="sts-input"
                      >
                        <option value="Parent">Parent</option>
                        <option value="Teacher">Teacher</option>
                        <option value="Admin">Admin</option>
                      </select>
                    </div>

                    {editForm.role === 'Teacher' && (
                      <div className="form-group">
                        <label>Employee ID: *</label>
                        <input
                          type="text"
                          value={editForm.employee_id}
                          onChange={(e) => setEditForm({ ...editForm, employee_id: e.target.value })}
                          className="sts-input"
                        />
                      </div>
                    )}

                    <div className="form-group">
                      <label>Mobile Number:</label>
                      <input
                        type="text"
                        value={editForm.mobile_number}
                        onChange={(e) => handleEditFormChange('mobile_number', e.target.value)}
                        className="sts-input"
                      />
                      {editErrors.mobile_number && <p className="error-text">{editErrors.mobile_number}</p>}
                    </div>

                    <div className="form-group">
                      <label>Address:</label>
                      <input
                        type="text"
                        value={editForm.address}
                        onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                        className="sts-input"
                      />
                    </div>

                    <div className="form-group">
                      <label>Birthday: *</label>
                      <input
                        type="date"
                        max={getMaxBirthdate()}
                        value={editForm.birthday}
                        onChange={(e) => handleEditFormChange('birthday', e.target.value)}
                        className="sts-input"
                      />
                      {editErrors.birthday && <p className="error-text">{editErrors.birthday}</p>}
                    </div>

                    <div className="form-group">
                      <label>Gender:</label>
                      <select
                        value={editForm.gender}
                        onChange={(e) => handleEditFormChange('gender', e.target.value)}
                        className="sts-input"
                      >
                        <option value="">Select Gender</option>
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                      </select>
                      {editErrors.gender && <p className="error-text">{editErrors.gender}</p>}
                    </div>

                    {editForm.role === 'Teacher' && (
                      <div className="form-container-card edit-user-teacher-panel">
                        <h3>Assigned Students</h3>
                        <p className="edit-user-helper-text">
                          Link students to this teacher from a dedicated, roomier section so the role-specific settings stay readable.
                        </p>
                        <div className="form-group edit-user-teacher-input">
                          <label>Student Email</label>
                          <input
                            type="email"
                            value={relationEmail}
                            onChange={(e) => setRelationEmail(e.target.value)}
                            className="sts-input"
                            placeholder="student@gmail.com"
                          />
                        </div>
                        <div className="modal-actions edit-user-teacher-actions">
                          <button
                            type="button"
                            className="sts-add-btn"
                            onClick={handleAddTeacherRelation}
                          >
                            Add Student
                          </button>
                        </div>
                        {relationMessage && <p className="info-text">{relationMessage}</p>}
                        {teacherRelations.length === 0 ? (
                          <p className="empty-table-msg">No assigned students yet.</p>
                        ) : (
                          <div className="table-container">
                            <table className="sts-data-table">
                              <thead>
                                <tr>
                                  <th>STUDENT NAME</th>
                                  <th>EMAIL</th>
                                  <th>ACTION</th>
                                </tr>
                              </thead>
                              <tbody>
                                {teacherRelations.map((relation) => (
                                  <tr key={relation.id}>
                                    <td>{relation.student_name || 'Unknown'}</td>
                                    <td>{relation.student_email || 'N/A'}</td>
                                    <td>
                                      <button
                                        type="button"
                                        className="delete-action-btn"
                                        onClick={() => handleRemoveTeacherRelation(relation.id)}
                                      >
                                        Remove
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="modal-actions edit-user-footer">
                      <button
                        type="button"
                        className="cancel-btn"
                        onClick={() => setEditingUser(null)}
                        disabled={updating}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="update-btn"
                        disabled={updating}
                      >
                        {updating ? 'Updating...' : 'Update User'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
