import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import {
  buildAccountCreationSuccessModal,
  combineAddressFields,
  filterUsers,
  formatRoleLabel,
  isParentRole,
  isTeacherRole,
  isWebsiteManagedRole,
  normalizeEmployeeIdInput,
  normalizeRole,
  paginateItems,
  splitAddressFields,
  validateEmployeeId,
  validateOptionalAdultBirthday,
} from './manageUsers.utils';
import { apiUrl } from '../api';
import { buildAuthHeaders, clearStoredSession } from './session.utils';
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
    mobile_number: '',
    street: '',
    city: '',
    province: '',
    birthday: '',
    gender: '',
    employee_id: ''
  });
  const [adding, setAdding] = useState(false);
  const [addErrors, setAddErrors] = useState({});
  const [validationModal, setValidationModal] = useState(null);
  const [editingUser, setEditingUser] = useState(null);
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
  const [deleteOperation, setDeleteOperation] = useState('archive');
  const [deletionReason, setDeletionReason] = useState('');
  const [deletionReasonError, setDeletionReasonError] = useState('');
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [regeneratingUserId, setRegeneratingUserId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);

  const filteredUsers = filterUsers(users, searchTerm, roleFilter);
  const usersPerPage = 8;
  const paginatedUsers = paginateItems(filteredUsers, currentPage, usersPerPage);
  const currentUserId = user?.id !== undefined && user?.id !== null ? String(user.id) : '';
  const currentUserEmail = String(user?.email || '').trim().toLowerCase();

  const isCurrentAccount = (account) => {
    const accountId = account?.id !== undefined && account?.id !== null ? String(account.id) : '';
    const accountEmail = String(account?.email || '').trim().toLowerCase();
    return Boolean(
      (currentUserId && accountId && currentUserId === accountId) ||
      (currentUserEmail && accountEmail && currentUserEmail === accountEmail)
    );
  };

  const showSelfEditWarning = () => {
    setValidationModal({
      title: 'Current Account',
      message: 'You cannot edit your own account here. Please use My Profile.'
    });
  };

  const showSelfDeleteWarning = () => {
    setValidationModal({
      title: 'Current Account',
      message: 'You cannot delete your own account.'
    });
  };

  const validateBirthday = (date) => {
    return validateOptionalAdultBirthday(date);
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
    if (!phone) return '';
    if (!phone.startsWith('09')) return 'Mobile number must start with 09';
    if (phone.length !== 11) return 'Mobile number must be exactly 11 digits';
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
    if (field === 'employee_id') {
      cleanedValue = normalizeEmployeeIdInput(value);
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
    else if (field === 'birthday') error = validateBirthday(finalValue);
    else if (field === 'employee_id') error = validateEmployeeId(finalValue, { required: isTeacherRole(selectedRole) });
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
    else if (field === 'employee_id') error = validateEmployeeId(finalValue, { required: isTeacherRole(editingUser?.role || editForm.role) });
    else if (field === 'gender') {
      const roleToCheck = normalizeRole(editingUser?.role || editForm.role);
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
        if (!loggedInUser || normalizeRole(loggedInUser.role) !== 'admin') {
          navigate('/login');
          return;
        }
        setUser(loggedInUser);
        await loadUsers();
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
      const response = await fetch(apiUrl(`/api/accounts?archived=${showArchived}`), {
        headers: buildAuthHeaders(),
      });
      if (response.status === 401 || response.status === 403) {
        clearStoredSession();
        navigate('/login', { replace: true, state: { sessionExpired: true } });
        return;
      }
      const data = await response.json();
      setUsers(Array.isArray(data) ? data.filter((account) => isWebsiteManagedRole(account.role)) : []);
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    const selectedRoleValue = normalizeRole(selectedRole);
    const roleIsTeacher = isTeacherRole(selectedRoleValue);
    if (!newUser.firstName || !newUser.lastName || !newUser.email) {
      setValidationModal({
        title: 'Missing Required Fields',
        message: 'Please fill in all required fields (First Name, Last Name, Email)'
      });
      return;
    }
    const employeeIdError = validateEmployeeId(newUser.employee_id, { required: roleIsTeacher });
    if (employeeIdError) {
      setAddErrors((prev) => ({ ...prev, employee_id: employeeIdError }));
      setValidationModal({
        title: roleIsTeacher && !newUser.employee_id ? 'Missing Employee ID' : 'Invalid Employee ID',
        message: employeeIdError
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
        mobile_number: newUser.mobile_number,
        address: combineAddressFields(newUser),
        birthday: newUser.birthday,
        gender: newUser.gender || '',
        role: selectedRoleValue,
      };
      if (roleIsTeacher) payload.employee_id = newUser.employee_id;

      const response = await fetch(apiUrl('/api/accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (response.ok) {
        setValidationModal(buildAccountCreationSuccessModal(selectedRole, data));
        setNewUser({ firstName: '', middleName: '', lastName: '', email: '', mobile_number: '', street: '', city: '', province: '', birthday: '', gender: '', employee_id: '' });
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
    if (isCurrentAccount(u)) {
      showSelfEditWarning();
      return;
    }

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
      ...splitAddressFields(u.address),
      birthday: u.birthday ? new Date(u.birthday).toISOString().split('T')[0] : '',
      gender: u.gender || '',
      employee_id: u.employee_id || '',
      role: formatRoleLabel(u.role || 'Parent')
    });
    if (isTeacherRole(u.role) || isParentRole(u.role)) {
      loadTeacherRelationships(u.id);
    } else {
      setTeacherRelations([]);
    }
  };

  const loadTeacherRelationships = async (teacherId) => {
    try {
      const response = await fetch(apiUrl(`/api/teacher-student-relationships?teacherId=${teacherId}`));
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
      const response = await fetch(apiUrl('/api/teacher-student-relationships'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacherId: editingUser.id,
          studentEmail: relationEmail,
          relationship_type: isParentRole(editingUser.role) ? 'Parent' : 'Teacher',
        }),
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
      const response = await fetch(apiUrl(`/api/teacher-student-relationships/${relationId}`), {
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
    const selectedRole = normalizeRole(editingUser.role);
    if (!editForm.firstName || !editForm.lastName || !editForm.email) {
      setValidationModal({
        title: 'Missing Required Fields',
        message: 'Please fill in all required fields (First Name, Last Name, Email)'
      });
      return;
    }
    if (isTeacherRole(selectedRole) && !editForm.employee_id) {
      const employeeIdError = validateEmployeeId(editForm.employee_id, { required: true });
      setEditErrors((prev) => ({ ...prev, employee_id: employeeIdError }));
      setValidationModal({
        title: 'Missing Employee ID',
        message: employeeIdError
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
        mobile_number: editForm.mobile_number,
        address: combineAddressFields(editForm),
        birthday: editForm.birthday,
        gender: editForm.gender || '',
        employee_id: editForm.employee_id || undefined
      };

      const response = await fetch(apiUrl(`/api/accounts/${editingUser.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

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
          message: data.error || 'Failed to update user'
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

  const openDeleteDialog = (account, operation = 'archive') => {
    if (isCurrentAccount(account)) {
      showSelfDeleteWarning();
      return;
    }
    setDeletingUser(account);
    setDeleteOperation(operation);
    setDeletionReason('');
    setDeletionReasonError('');
    setShowDeleteConfirmation(false);
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    setDeletingUser(null);
    setDeletionReason('');
    setDeletionReasonError('');
    setShowDeleteConfirmation(false);
  };

  const continueDeleteDialog = () => {
    const reason = deletionReason.trim();
    if (!reason) {
      setDeletionReasonError('Reason for deletion is required.');
      return;
    }
    setDeletionReasonError('');
    setShowDeleteConfirmation(true);
  };

  const handleDeleteUser = async () => {
    if (!deletingUser?.id) return;
    if (isCurrentAccount(deletingUser)) {
      showSelfDeleteWarning();
      closeDeleteDialog();
      return;
    }

    setDeleting(true);
    try {
      const permanent = deleteOperation === 'permanent';
      const response = await fetch(apiUrl(`/api/accounts/${deletingUser.id}${permanent ? '?permanent=true' : ''}`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
        body: JSON.stringify({ reason: deletionReason.trim() }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        setValidationModal({
          title: 'Success',
          message: permanent ? 'User permanently deleted.' : 'User archived successfully!'
        });
        closeDeleteDialog();
        loadUsers();
      } else {
        setValidationModal({
          title: 'Error',
          message: data.error || (permanent ? 'Failed to delete user permanently' : 'Failed to archive user')
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
      const response = await fetch(apiUrl(`/api/accounts/${userToRestore.id}/restore`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setValidationModal({
          title: 'Success',
          message: 'User restored successfully!'
        });
        loadUsers();
      } else {
        setValidationModal({
          title: 'Error',
          message: data.error || 'Failed to restore user'
        });
      }
    } catch (error) {
      setValidationModal({
        title: 'Connection Error',
        message: 'Connection error'
      });
    }
  };

  const handleRegenerateTemporaryPassword = async (account) => {
    if (!account?.id || isCurrentAccount(account)) return;
    const confirmed = window.confirm(
      `Send a new temporary password to ${account.email}? Their previous password will stop working and the new temporary password will expire in 30 minutes.`
    );
    if (!confirmed) return;

    setRegeneratingUserId(account.id);
    try {
      const response = await fetch(apiUrl(`/api/accounts/${account.id}/temporary-password`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
      });
      const data = await response.json();
      if (response.status === 401 || response.status === 403) {
        clearStoredSession();
        navigate('/login', { replace: true, state: { sessionExpired: true } });
        return;
      }
      setValidationModal({
        title: response.ok ? 'Temporary Password Issued' : 'Unable to Issue Temporary Password',
        message: response.ok
          ? (data.emailSent
            ? 'A new temporary password was emailed to the account. It expires in 30 minutes and must be changed after login.'
            : (data.warning || 'Credential delivery requires another administrator-issued temporary password after email is available.'))
          : (data.error || 'Unable to issue a temporary password.'),
      });
      if (response.ok) await loadUsers();
    } catch (error) {
      setValidationModal({
        title: 'Connection Error',
        message: 'Unable to issue a temporary password. Please try again.',
      });
    } finally {
      setRegeneratingUserId(null);
    }
  };

  useEffect(() => {
    if (!user) return;
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
    clearStoredSession();
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
                    <option value="Admin">Admin</option>
                    <option value="Parent">Parent</option>
                    <option value="Teacher">Teacher</option>
                    <option value="Parent/Teacher">Parent/Teacher</option>
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
                    }}
                    className="sts-input"
                  >
                    <option value="Parent">Parent</option>
                    <option value="Teacher">Teacher</option>
                    <option value="Parent/Teacher">Parent/Teacher</option>
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

                  <div className="form-group">
                    <label>Temporary Password:</label>
                    <div className="profile-static-field" style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '4px', border: '1px solid #d1d5db' }}>
                      A strong temporary password will be generated and emailed automatically.
                    </div>
                  </div>

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
                    <label>Street:</label>
                    <input
                      type="text"
                      placeholder="Street"
                      value={newUser.street}
                      onChange={(e) => setNewUser({ ...newUser, street: e.target.value })}
                      className="sts-input"
                    />
                  </div>

                  <div className="form-group">
                    <label>City:</label>
                    <input
                      type="text"
                      placeholder="City"
                      value={newUser.city}
                      onChange={(e) => setNewUser({ ...newUser, city: e.target.value })}
                      className="sts-input"
                    />
                  </div>

                  <div className="form-group">
                    <label>Province:</label>
                    <input
                      type="text"
                      placeholder="Province"
                      value={newUser.province}
                      onChange={(e) => setNewUser({ ...newUser, province: e.target.value })}
                      className="sts-input"
                    />
                  </div>

                  <div className="form-group">
                    <label>Birthday:</label>
                    <input
                      type="date"
                      value={newUser.birthday}
                      onChange={(e) => handleAddFormChange('birthday', e.target.value)}
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

                  {isTeacherRole(selectedRole) && (
                    <div className="form-group">
                      <label>Employee ID: *</label>
                      <input
                        type="text"
                        placeholder="1234567890"
                        value={newUser.employee_id}
                        onChange={(e) => handleAddFormChange('employee_id', e.target.value)}
                        className="sts-input"
                        inputMode="numeric"
                        maxLength={10}
                      />
                      {addErrors.employee_id && <p className="error-text">{addErrors.employee_id}</p>}
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
                    <th>PARENT ID</th>
                    <th>MOBILE NUMBER</th>
                    <th>BIRTHDAY</th>
                    <th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="empty-table-msg">
                        {searchTerm ? `No results found for "${searchTerm}"` : "No users found."}
                      </td>
                    </tr>
                  ) : (
                    paginatedUsers.pageItems.map((u) => {
                      const currentAccount = isCurrentAccount(u);
                      return (
                        <tr key={u.id}>
                          <td className="user-name-cell" title={u.name || 'No name set'}>{u.name || 'No name set'}</td>
                          <td className="email-cell" title={u.email || ''}>{u.email}</td>
                          <td>
                            <span className="role-badge-group">
                              <span className={`role-badge role-${normalizeRole(u.role)}`}>
                                {formatRoleLabel(u.role)}
                              </span>
                              {currentAccount && <span className="protected-account-badge">Protected</span>}
                            </span>
                          </td>
                          <td>{isParentRole(u.role) ? (u.parent_id || 'Not generated') : '-'}</td>
                          <td>{u.mobile_number || '-'}</td>
                          <td>{u.birthday ? new Date(u.birthday).toLocaleDateString() : 'Not set'}</td>
                          <td className="actions-cell manage-user-actions">
                            {currentAccount ? (
                              <span className="current-account-badge">Current Account</span>
                            ) : showArchived ? (
                              <>
                                <button type="button" className="restore-action-btn manage-user-action-btn" onClick={() => handleRestoreUser(u)}>Restore</button>
                                <button type="button" className="delete-action-btn manage-user-action-btn" onClick={() => openDeleteDialog(u, 'permanent')}>Delete</button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="edit-action-btn manage-user-action-btn" onClick={() => handleEditClick(u)}>Edit</button>
                                <button
                                  type="button"
                                  className="restore-action-btn manage-user-action-btn"
                                  onClick={() => handleRegenerateTemporaryPassword(u)}
                                  disabled={regeneratingUserId === u.id}
                                >
                                  {regeneratingUserId === u.id ? 'Sending...' : 'Send Temporary Password'}
                                </button>
                                <button type="button" className="delete-action-btn manage-user-action-btn" onClick={() => openDeleteDialog(u)}>Delete</button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })
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
              <div className="modal-overlay" onClick={() => { setValidationModal(null); }}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <h2>{validationModal.title}</h2>
                  <p>{validationModal.message}</p>
                  {validationModal.parentId && (
                    <div className="generated-credential-panel">
                      <span className="generated-credential-label">Parent ID</span>
                      <strong className="generated-credential-value">{validationModal.parentId}</strong>
                    </div>
                  )}
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="update-btn"
                      onClick={() => { setValidationModal(null); }}
                    >
                      OK
                    </button>
                  </div>
                </div>
              </div>
            )}

            {deletingUser && (
              <div className="modal-overlay" onClick={closeDeleteDialog}>
                <div className="modal-content delete-modal" onClick={(e) => e.stopPropagation()}>
                  {!showDeleteConfirmation ? (
                    <>
                      <h2>Delete Account</h2>
                      <p>You are about to {deleteOperation === 'permanent' ? 'permanently delete' : 'archive'} <strong>{deletingUser.name || deletingUser.email}</strong>.</p>
                      <p className="delete-account-role">Role: {formatRoleLabel(deletingUser.role)}</p>
                      <label className="deletion-reason-label" htmlFor="deletion-reason">Reason for deleting this account:</label>
                      <textarea
                        id="deletion-reason"
                        name="deletion-reason"
                        className={deletionReasonError ? 'deletion-reason-textarea error' : 'deletion-reason-textarea'}
                        value={deletionReason}
                        onChange={(event) => {
                          setDeletionReason(event.target.value.slice(0, 1000));
                          if (deletionReasonError) setDeletionReasonError('');
                        }}
                        maxLength={1000}
                        rows={4}
                        aria-invalid={Boolean(deletionReasonError)}
                      />
                      {deletionReasonError && <p className="error-text" role="alert">{deletionReasonError}</p>}
                      <div className="modal-actions">
                        <button type="button" className="cancel-btn" onClick={closeDeleteDialog} disabled={deleting}>Cancel</button>
                        <button type="button" className="confirm-delete-btn" onClick={continueDeleteDialog} disabled={deleting}>Continue</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h2>Confirm Account Removal</h2>
                      <p>Are you sure you want to remove this account?</p>
                      <div className="modal-actions">
                        <button type="button" className="cancel-btn" onClick={() => setShowDeleteConfirmation(false)} disabled={deleting}>No, Cancel</button>
                        <button type="button" className="confirm-delete-btn" onClick={handleDeleteUser} disabled={deleting}>{deleting ? 'Deleting...' : 'Yes, Delete Account'}</button>
                      </div>
                    </>
                  )}
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
                      <div className="profile-static-field" style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '4px', border: '1px solid #d1d5db' }}>
                        {formatRoleLabel(editingUser.role)}
                      </div>
                    </div>

                    {isTeacherRole(editingUser.role) && (
                      <div className="form-group">
                        <label>Employee ID: *</label>
                        <input
                          type="text"
                          value={editForm.employee_id}
                          onChange={(e) => handleEditFormChange('employee_id', e.target.value)}
                          className="sts-input"
                          inputMode="numeric"
                          maxLength={10}
                        />
                        {editErrors.employee_id && <p className="error-text">{editErrors.employee_id}</p>}
                      </div>
                    )}

                    {isParentRole(editingUser.role) && (
                      <div className="form-group">
                        <label>Parent ID:</label>
                        <div className="profile-static-field" style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '4px', border: '1px solid #d1d5db' }}>
                          {editingUser.parent_id || 'Not generated yet'}
                        </div>
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
                      <label>Street:</label>
                      <input
                        type="text"
                        value={editForm.street}
                        onChange={(e) => setEditForm({ ...editForm, street: e.target.value })}
                        className="sts-input"
                      />
                    </div>

                    <div className="form-group">
                      <label>City:</label>
                      <input
                        type="text"
                        value={editForm.city}
                        onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                        className="sts-input"
                      />
                    </div>

                    <div className="form-group">
                      <label>Province:</label>
                      <input
                        type="text"
                        value={editForm.province}
                        onChange={(e) => setEditForm({ ...editForm, province: e.target.value })}
                        className="sts-input"
                      />
                    </div>

                    <div className="form-group">
                      <label>Birthday:</label>
                      <input
                        type="date"
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

                    {(isTeacherRole(editingUser.role) || isParentRole(editingUser.role)) && (
                      <div className="form-container-card edit-user-teacher-panel">
                        <h3>{isParentRole(editingUser.role) ? 'Linked Children' : 'Assigned Students'}</h3>
                        <p className="edit-user-helper-text">
                          Link students to this {isParentRole(editingUser.role) ? 'parent' : 'teacher'} from a dedicated, roomier section so role-specific settings stay readable.
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
                            {isParentRole(editingUser.role) ? 'Add Child' : 'Add Student'}
                          </button>
                        </div>
                        {relationMessage && <p className="info-text">{relationMessage}</p>}
                        {teacherRelations.length === 0 ? (
                          <p className="empty-table-msg">{isParentRole(editingUser.role) ? 'No linked children yet.' : 'No assigned students yet.'}</p>
                        ) : (
                          <div className="table-container">
                            <table className="sts-data-table">
                              <thead>
                                <tr>
                                  <th>STUDENT NAME</th>
                                  <th>STUDENT ID</th>
                                  <th>EMAIL</th>
                                  <th>ACTION</th>
                                </tr>
                              </thead>
                              <tbody>
                                {teacherRelations.map((relation) => (
                                  <tr key={relation.id}>
                                    <td>{relation.student_name || 'Unknown'}</td>
                                    <td>{relation.game_student_id || 'Not linked'}</td>
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
