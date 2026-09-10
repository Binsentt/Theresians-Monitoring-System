import React, { useEffect, useState } from 'react';
import ModalPortal from './ModalPortal';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
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
import { fetchSectionRegistry } from '../sectionRegistry';
import { buildAuthHeaders, clearStoredSession, revokeCurrentSession } from './session.utils';
import {
  PARENT_CHILD_GRADE_OPTIONS,
  validateEmail as validateEmailFormat,
  validatePhilippineMobile,
  validatePhilippineMobileUpdate,
} from '../utils/validation.utils';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { formatReportContext } from './tableReporting.utils';
import AdminParentChildren from './AdminParentChildren';
import AdminManagedChildrenPanel from './AdminManagedChildrenPanel';
import {
  createAdminChildDraft,
  toAdminParentChildrenPayload,
  validateAdminParentChildren,
} from './adminParentChildren.utils';
import '../styles/manageusers.css';

export default function ManageUsers() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedRole, setSelectedRole] = useState('Parent');
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
  const [parentChildren, setParentChildren] = useState(() => [createAdminChildDraft()]);
  const [parentChildErrors, setParentChildErrors] = useState([]);
  const [parentChildFormError, setParentChildFormError] = useState('');
  const [parentChildAvailability, setParentChildAvailability] = useState({ pending: false, isValid: false });
  const [sectionRegistry, setSectionRegistry] = useState(null);
  const [sectionRegistryLoading, setSectionRegistryLoading] = useState(false);
  const [sectionRegistryError, setSectionRegistryError] = useState('');
  const [addErrors, setAddErrors] = useState({});
  const [addTouched, setAddTouched] = useState({});
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
  const [editTouched, setEditTouched] = useState({});
  const [teacherRelations, setTeacherRelations] = useState([]);
  const [relationEmail, setRelationEmail] = useState('');
  const [relationMessage, setRelationMessage] = useState('');
  const [teacherClassAssignments, setTeacherClassAssignments] = useState([]);
  const [classAssignmentForm, setClassAssignmentForm] = useState({ grade_level: '', section: '' });
  const [editingClassAssignmentId, setEditingClassAssignmentId] = useState(null);
  const [classAssignmentMessage, setClassAssignmentMessage] = useState('');
  const [deletingUser, setDeletingUser] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteOperation, setDeleteOperation] = useState('archive');
  const [deletionReason, setDeletionReason] = useState('');
  const [deletionReasonError, setDeletionReasonError] = useState('');
  const [permanentDeleteConfirmation, setPermanentDeleteConfirmation] = useState('');
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [regeneratingUserId, setRegeneratingUserId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);

  const filteredUsers = filterUsers(users, searchTerm);
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

  const validateNameField = (name, { required = true } = {}) => {
    if (!String(name || '').trim()) return required ? 'This field is required.' : '';
    if (/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(name)) return 'No numbers or symbols allowed';
    return '';
  };

  const validateEmail = (email) => {
    return validateEmailFormat(email).error || '';
  };

  const validatePhone = (phone, originalPhone) => {
    const result = originalPhone === undefined
      ? validatePhilippineMobile(phone)
      : validatePhilippineMobileUpdate(phone, originalPhone);
    return result.error || '';
  };

  const restrictInput = (field, value) => {
    let cleanedValue = value;
    if (field === 'firstName' || field === 'middleName' || field === 'lastName') {
      cleanedValue = value.replace(/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/g, '');
    }
    if (field === 'employee_id') {
      cleanedValue = normalizeEmployeeIdInput(value);
    }
    return cleanedValue;
  };

  const validateUserField = (field, value, role, originalMobileNumber) => {
    if (field === 'firstName' || field === 'lastName') return validateNameField(value);
    if (field === 'middleName') return validateNameField(value, { required: false });
    if (field === 'email') return validateEmail(value);
    if (field === 'mobile_number') return validatePhone(value, originalMobileNumber);
    if (field === 'birthday') return validateBirthday(value);
    if (field === 'employee_id') return validateEmployeeId(value, { required: isTeacherRole(role) });
    return '';
  };

  const validateUserForm = (form, role) => {
    const fields = ['firstName', 'middleName', 'lastName', 'email', 'mobile_number', 'birthday', 'employee_id'];
    return fields.reduce((errors, field) => {
      const error = validateUserField(field, form[field], role);
      if (error) errors[field] = error;
      return errors;
    }, {});
  };

  const handleAddFormChange = (field, value) => {
    const finalValue = restrictInput(field, value);
    const nextForm = { ...newUser, [field]: finalValue };
    setNewUser(nextForm);
    setAddErrors((current) => ({ ...current, [field]: validateUserField(field, finalValue, selectedRole) }));
  };

  const handleAddFormBlur = (field) => {
    setAddTouched((current) => ({ ...current, [field]: true }));
    setAddErrors((current) => ({ ...current, [field]: validateUserField(field, newUser[field], selectedRole) }));
  };

  const handleEditFormChange = (field, value) => {
    const finalValue = restrictInput(field, value);
    const nextForm = { ...editForm, [field]: finalValue };
    setEditForm(nextForm);
    setEditErrors((current) => ({
      ...current,
      [field]: validateUserField(field, finalValue, editingUser?.role || editForm.role, editingUser?.mobile_number || ''),
    }));
  };

  const handleEditFormBlur = (field) => {
    setEditTouched((current) => ({ ...current, [field]: true }));
    setEditErrors((current) => ({
      ...current,
      [field]: validateUserField(field, editForm[field], editingUser?.role || editForm.role, editingUser?.mobile_number || ''),
    }));
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

  useEffect(() => {
    const needsRegistry = (showAddForm && isParentRole(selectedRole)) || (editingUser && isParentRole(editingUser.role));
    if (!needsRegistry) return undefined;
    let mounted = true;
    setSectionRegistryLoading(true);
    setSectionRegistryError('');
    fetchSectionRegistry((url, options = {}) => fetch(url, {
      ...options,
      headers: { ...buildAuthHeaders(), ...(options.headers || {}) },
    }))
      .then((registry) => {
        if (mounted) setSectionRegistry(registry);
      })
      .catch(() => {
        if (mounted) setSectionRegistryError('Unable to load available Sections. Please try again.');
      })
      .finally(() => {
        if (mounted) setSectionRegistryLoading(false);
      });
    return () => { mounted = false; };
  }, [editingUser, showAddForm, selectedRole]);

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
    const errors = validateUserForm(newUser, selectedRoleValue);
    const childValidation = isParentRole(selectedRoleValue)
      ? validateAdminParentChildren(parentChildren, sectionRegistry)
      : { isValid: true, formError: '', errors: [] };
    setAddTouched({ firstName: true, middleName: true, lastName: true, email: true, mobile_number: true, birthday: true, employee_id: true });
    setAddErrors(errors);
    setParentChildErrors(childValidation.errors);
    setParentChildFormError(childValidation.formError);
    if (isParentRole(selectedRoleValue) && (!parentChildAvailability.isValid || parentChildAvailability.pending)) {
      setParentChildFormError(parentChildAvailability.pending
        ? 'Please wait while Student IDs are validated.'
        : 'Every Student ID must pass the availability check.');
    }
    if (Object.keys(errors).length > 0 || !childValidation.isValid
      || (isParentRole(selectedRoleValue) && (!parentChildAvailability.isValid || parentChildAvailability.pending))) {
      return;
    }

    setAdding(true);
    try {
      const fullName = `${newUser.firstName}${newUser.middleName ? ' ' + newUser.middleName : ''} ${newUser.lastName}`;
      const payload = {
        name: fullName,
        email: newUser.email,
        mobile_number: validatePhilippineMobile(newUser.mobile_number).value,
        address: combineAddressFields(newUser),
        birthday: newUser.birthday,
        gender: newUser.gender || '',
        role: selectedRoleValue,
      };
      if (roleIsTeacher) payload.employee_id = newUser.employee_id;
      if (isParentRole(selectedRoleValue)) payload.children = toAdminParentChildrenPayload(parentChildren);

      const response = await fetch(apiUrl('/api/accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (response.ok) {
        setValidationModal(buildAccountCreationSuccessModal(selectedRole, data));
        setNewUser({ firstName: '', middleName: '', lastName: '', email: '', mobile_number: '', street: '', city: '', province: '', birthday: '', gender: '', employee_id: '' });
        setAddErrors({});
        setAddTouched({});
        setParentChildren([createAdminChildDraft()]);
        setParentChildErrors([]);
        setParentChildFormError('');
        setParentChildAvailability({ pending: false, isValid: false });
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
    setEditTouched({});
    setRelationEmail('');
    setRelationMessage('');
    setTeacherClassAssignments([]);
    setClassAssignmentForm({ grade_level: '', section: '' });
    setEditingClassAssignmentId(null);
    setClassAssignmentMessage('');
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
    if (isTeacherRole(u.role)) loadTeacherRelationships(u.id, 'teacher');
    else setTeacherRelations([]);
    if (isTeacherRole(u.role)) {
      loadTeacherClassAssignments(u.id);
    }
  };

  const loadTeacherClassAssignments = async (teacherId) => {
    try {
      const response = await fetch(apiUrl(`/api/teacher-class-assignments?teacherId=${teacherId}`), {
        headers: buildAuthHeaders(),
      });
      const data = await response.json();
      setTeacherClassAssignments(response.ok ? (data.assignments || []) : []);
    } catch (error) {
      console.error('Failed to load teacher class assignments:', error);
      setTeacherClassAssignments([]);
    }
  };

  const loadTeacherRelationships = async (teacherId, relationshipType) => {
    const expectedType = String(relationshipType || '').toLowerCase();
    const setRelations = setTeacherRelations;
    try {
      const response = await fetch(apiUrl(`/api/teacher-student-relationships?teacherId=${teacherId}`), {
        headers: buildAuthHeaders(),
      });
      const data = await response.json();
      if (response.ok) {
        setRelations((data.relationships || []).filter((relationship) => (
          !expectedType || String(relationship.relationship_type || '').toLowerCase() === expectedType
        )));
      } else {
        setRelations([]);
      }
    } catch (error) {
      console.error('Failed to load teacher relationships:', error);
      setRelations([]);
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
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
        body: JSON.stringify({
          teacherId: editingUser.id,
          studentEmail: relationEmail,
          relationship_type: 'Teacher',
        }),
      });
      const data = await response.json();
      if (response.ok) {
        setRelationMessage('Relationship added successfully.');
        setRelationEmail('');
        loadTeacherRelationships(editingUser.id, 'teacher');
      } else {
        setRelationMessage(data.error || 'Could not add relationship.');
      }
    } catch (error) {
      console.error('Failed to add teacher relation:', error);
      setRelationMessage('Connection error while adding relationship.');
    }
  };

  const handleRemoveTeacherRelation = async (relationId, relationshipType = 'teacher') => {
    const isParentRelationship = String(relationshipType).toLowerCase() === 'parent';
    const setMessage = setRelationMessage;
    try {
      const response = await fetch(apiUrl(`/api/teacher-student-relationships/${relationId}`), {
        method: 'DELETE',
        headers: buildAuthHeaders(),
      });
      if (response.ok) {
        setMessage(isParentRelationship ? 'Child link removed.' : 'Relationship removed.');
        loadTeacherRelationships(editingUser.id, 'teacher');
      } else {
        setMessage(isParentRelationship ? 'Failed to remove child link.' : 'Failed to remove relationship.');
      }
    } catch (error) {
      console.error('Failed to remove relationship:', error);
      setMessage(isParentRelationship ? 'Connection error while removing child link.' : 'Connection error while removing relationship.');
    }
  };

  const resetClassAssignmentForm = () => {
    setClassAssignmentForm({ grade_level: '', section: '' });
    setEditingClassAssignmentId(null);
  };

  const handleSaveTeacherClassAssignment = async () => {
    const gradeLevel = String(classAssignmentForm.grade_level || '').trim();
    const section = String(classAssignmentForm.section || '').trim().replace(/\s+/g, ' ');
    if (!gradeLevel || !section) {
      setClassAssignmentMessage('Grade and Section are required.');
      return;
    }

    try {
      const path = editingClassAssignmentId
        ? `/api/teacher-class-assignments/${editingClassAssignmentId}`
        : '/api/teacher-class-assignments';
      const response = await fetch(apiUrl(path), {
        method: editingClassAssignmentId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
        body: JSON.stringify({
          ...(editingClassAssignmentId ? {} : { teacherId: editingUser.id }),
          grade_level: gradeLevel,
          section,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setClassAssignmentMessage(data.error || 'Could not save the class assignment.');
        return;
      }
      setClassAssignmentMessage(editingClassAssignmentId ? 'Class assignment updated.' : 'Class assignment added.');
      resetClassAssignmentForm();
      loadTeacherClassAssignments(editingUser.id);
    } catch (error) {
      console.error('Failed to save teacher class assignment:', error);
      setClassAssignmentMessage('Connection error while saving the class assignment.');
    }
  };

  const handleEditTeacherClassAssignment = (assignment) => {
    setClassAssignmentForm({
      grade_level: assignment.grade_level || '',
      section: assignment.section || '',
    });
    setEditingClassAssignmentId(assignment.id);
    setClassAssignmentMessage('');
  };

  const handleRemoveTeacherClassAssignment = async (assignmentId) => {
    try {
      const response = await fetch(apiUrl(`/api/teacher-class-assignments/${assignmentId}`), {
        method: 'DELETE',
        headers: buildAuthHeaders(),
      });
      const data = await response.json();
      if (!response.ok) {
        setClassAssignmentMessage(data.error || 'Could not remove the class assignment.');
        return;
      }
      if (editingClassAssignmentId === assignmentId) resetClassAssignmentForm();
      setClassAssignmentMessage('Class assignment removed.');
      loadTeacherClassAssignments(editingUser.id);
    } catch (error) {
      console.error('Failed to remove teacher class assignment:', error);
      setClassAssignmentMessage('Connection error while removing the class assignment.');
    }
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    const selectedRole = normalizeRole(editingUser.role);
    const errors = ['firstName', 'lastName', 'email'].reduce((nextErrors, field) => {
      const error = validateUserField(field, editForm[field], selectedRole);
      if (error) nextErrors[field] = error;
      return nextErrors;
    }, {});
    const mobileError = validatePhone(editForm.mobile_number, editingUser.mobile_number || '');
    if (mobileError) errors.mobile_number = mobileError;
    Object.keys(editTouched).forEach((field) => {
      const error = validateUserField(field, editForm[field], selectedRole, editingUser.mobile_number || '');
      if (error) errors[field] = error;
    });
    if (isTeacherRole(selectedRole) && !String(editForm.employee_id || '').trim()) {
      errors.employee_id = validateEmployeeId(editForm.employee_id, { required: true });
    }
    setEditTouched({ firstName: true, middleName: true, lastName: true, email: true, mobile_number: true, birthday: true, employee_id: true });
    setEditErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setUpdating(true);
    try {
      const fullName = `${editForm.firstName}${editForm.middleName ? ' ' + editForm.middleName : ''} ${editForm.lastName}`;
      const payload = {
        name: fullName,
        email: editForm.email,
        mobile_number: validatePhilippineMobileUpdate(editForm.mobile_number, editingUser.mobile_number || '').value,
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
    setPermanentDeleteConfirmation('');
    setShowDeleteConfirmation(false);
  };

  const resetDeleteDialog = () => {
    setDeletingUser(null);
    setDeleteOperation('archive');
    setDeletionReason('');
    setDeletionReasonError('');
    setPermanentDeleteConfirmation('');
    setShowDeleteConfirmation(false);
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    resetDeleteDialog();
  };

  const continueDeleteDialog = () => {
    const reason = deletionReason.trim();
    if (!reason) {
      setDeletionReasonError(
        deleteOperation === 'permanent'
          ? 'Reason for permanent deletion is required.'
          : 'Reason for archiving is required.'
      );
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

    const permanent = deleteOperation === 'permanent';
    if (permanent && permanentDeleteConfirmation !== 'DELETE') {
      return;
    }

    setDeleting(true);
    try {
      const response = await fetch(apiUrl(`/api/accounts/${deletingUser.id}${permanent ? '?permanent=true' : ''}`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
        body: JSON.stringify({
          reason: deletionReason.trim(),
          ...(permanent ? { permanent_confirmation: permanentDeleteConfirmation } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        resetDeleteDialog();
        setValidationModal({
          title: 'Success',
          message: permanent ? 'User permanently deleted.' : 'User archived successfully!'
        });
        await loadUsers();
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
  }, [searchTerm, showArchived]);

  useEffect(() => {
    if (currentPage !== paginatedUsers.currentPage) {
      setCurrentPage(paginatedUsers.currentPage);
    }
  }, [currentPage, paginatedUsers.currentPage]);

  const handleLogout = async () => {
    await revokeCurrentSession();
    clearStoredSession();
    navigate('/');
  };

  if (loading) {
    return (
      <DashboardLoadingShell
        role="admin"
        activeItem="manage-users"
        portalLabel="Admin Portal"
        heading="Manage Users"
        subheading="Manage website accounts, roles, and access."
      />
    );
  }

  const reportScope = [showArchived ? 'Archived accounts' : 'Active accounts', searchTerm ? `Search: ${searchTerm}` : '']
    .filter(Boolean)
    .join(' / ');
  const reportColumns = [
    { header: 'User Name', value: (row) => row.name },
    { header: 'Email', value: (row) => row.email },
    { header: 'Role', value: (row) => formatRoleLabel(row.role) },
    { header: 'Account Status', value: (row) => row.is_archived ? 'Archived' : 'Active' },
  ];

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
                <>
                  <div className="controls-wrapper no-print">
                  <input
                    type="search"
                    aria-label="Search Manage Users"
                    placeholder="Search name, email, role, ID, status, phone, or address"
                    className="sts-search-input"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
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
                  <TablePrintButton
                    reportTitle="User List"
                    reportContext={formatReportContext({ scope: reportScope, recordCount: filteredUsers.length })}
                    label="Print User List"
                    showPrintHeading={false}
                  />
                </>
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
                      if (addTouched.employee_id) {
                        setAddErrors((current) => ({
                          ...current,
                          employee_id: validateEmployeeId(newUser.employee_id, { required: isTeacherRole(e.target.value) }),
                        }));
                      }
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
                      onBlur={() => handleAddFormBlur('firstName')}
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
                      onBlur={() => handleAddFormBlur('middleName')}
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
                      onBlur={() => handleAddFormBlur('lastName')}
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
                      onBlur={() => handleAddFormBlur('email')}
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
                      type="tel"
                      placeholder="09123456789"
                      value={newUser.mobile_number}
                      onChange={(e) => handleAddFormChange('mobile_number', e.target.value)}
                      onBlur={() => handleAddFormBlur('mobile_number')}
                      inputMode="numeric"
                      maxLength={11}
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
                      onBlur={() => handleAddFormBlur('birthday')}
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
                        onBlur={() => handleAddFormBlur('employee_id')}
                        className="sts-input"
                        inputMode="numeric"
                        maxLength={10}
                      />
                      {addErrors.employee_id && <p className="error-text">{addErrors.employee_id}</p>}
                    </div>
                  )}

                  {isParentRole(selectedRole) && (
                    <div className="admin-parent-children-wrapper">
                      {sectionRegistryLoading && <p className="field-help">Loading available Sections...</p>}
                      {sectionRegistryError && <p className="error-text" role="alert">{sectionRegistryError}</p>}
                      <AdminParentChildren
                        value={parentChildren}
                        onChange={(children) => {
                          setParentChildren(children);
                          setParentChildErrors([]);
                          setParentChildFormError('');
                        }}
                        sectionRegistry={sectionRegistry}
                        errors={parentChildErrors}
                        formError={parentChildFormError}
                        authHeaders={buildAuthHeaders()}
                        onValidationStateChange={setParentChildAvailability}
                      />
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={adding || (isParentRole(selectedRole) && (parentChildAvailability.pending || !parentChildAvailability.isValid))}
                    className="sts-submit-btn"
                  >
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
                    <th className="no-print">ACTIONS</th>
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
                          <td className="actions-cell manage-user-actions no-print">
                            {currentAccount ? (
                              <span className="current-account-badge">Current Account</span>
                            ) : showArchived ? (
                              <>
                                <button type="button" className="restore-action-btn manage-user-action-btn" onClick={() => handleRestoreUser(u)}>Restore</button>
                                <button type="button" className="delete-action-btn manage-user-action-btn" onClick={() => openDeleteDialog(u, 'permanent')}>Delete Permanently</button>
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
            <div className="manage-users-pagination no-print">
              <span className="manage-users-pagination-summary">
                {paginatedUsers.totalItems === 0
                  ? '0 records'
                  : `Showing ${paginatedUsers.startIndex + 1} - ${paginatedUsers.endIndex} of ${paginatedUsers.totalItems} users`}
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
            <PrintableTableReport
              title="User List"
              context={reportScope}
              rows={filteredUsers}
              columns={reportColumns}
            />

            {validationModal && (
              <ModalPortal onClose={() => setValidationModal(null)}>
              <div className="modal-overlay" onClick={() => { setValidationModal(null); }}>
                <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="account-result-title" onClick={(e) => e.stopPropagation()}>
                  <h2 id="account-result-title">{validationModal.title}</h2>
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
              </ModalPortal>
            )}

            {deletingUser && (
              <ModalPortal onClose={closeDeleteDialog}>
              <div className="modal-overlay" onClick={closeDeleteDialog}>
                <div className="modal-content delete-modal" role="dialog" aria-modal="true" aria-labelledby="account-delete-title" onClick={(e) => e.stopPropagation()}>
                  {!showDeleteConfirmation ? (
                    <>
                      <h2 id="account-delete-title">{deleteOperation === 'permanent' ? 'Delete Permanently' : 'Delete Account'}</h2>
                      <p>{deleteOperation === 'permanent'
                        ? <>You are about to permanently delete <strong>{deletingUser.name || deletingUser.email}</strong>.</>
                        : <>You are about to delete <strong>{deletingUser.name || deletingUser.email}</strong> from active users. This account can be restored.</>}</p>
                      {deleteOperation === 'permanent' && <p className="error-text">This action is irreversible.</p>}
                      {deleteOperation === 'permanent' && isParentRole(deletingUser.role) && (
                        <p className="error-text">This also permanently deletes all exclusively owned child Student accounts and their dependent records.</p>
                      )}
                      <p className="delete-account-role">Role: {formatRoleLabel(deletingUser.role)}</p>
                      <label className="deletion-reason-label" htmlFor="deletion-reason">Reason for {deleteOperation === 'permanent' ? 'permanently deleting' : 'archiving'} this account:</label>
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
                      <h2 id="account-delete-title">{deleteOperation === 'permanent' ? 'Confirm Permanent Delete' : 'Confirm Delete Account'}</h2>
                      <p>{deleteOperation === 'permanent' ? 'This action is irreversible. Type DELETE to permanently delete this archived account.' : 'This removes the account from active users. It can be restored later.'}</p>
                      {deleteOperation === 'permanent' && (
                        <label className="deletion-reason-label" htmlFor="permanent-delete-confirmation">
                          Type DELETE to confirm permanent deletion.
                          <input
                            id="permanent-delete-confirmation"
                            name="permanent-delete-confirmation"
                            type="text"
                            value={permanentDeleteConfirmation}
                            onChange={(event) => setPermanentDeleteConfirmation(event.target.value)}
                            autoComplete="off"
                          />
                        </label>
                      )}
                      <div className="modal-actions">
                        <button type="button" className="cancel-btn" onClick={() => setShowDeleteConfirmation(false)} disabled={deleting}>No, Cancel</button>
                        <button
                          type="button"
                          className="confirm-delete-btn"
                          onClick={handleDeleteUser}
                          disabled={deleting || (deleteOperation === 'permanent' && permanentDeleteConfirmation !== 'DELETE')}
                        >
                          {deleting ? 'Deleting...' : (deleteOperation === 'permanent' ? 'Permanently Delete Account' : 'Yes, Delete Account')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              </ModalPortal>
            )}

            {editingUser && (
              <ModalPortal onClose={() => !updating && setEditingUser(null)}>
              <div className="modal-overlay" onClick={() => !updating && setEditingUser(null)}>
                <div className="modal-content edit-user-modal" role="dialog" aria-modal="true" aria-labelledby="edit-user-title" onClick={(e) => e.stopPropagation()}>
                  <h2 id="edit-user-title" className="edit-user-modal-title">Edit User</h2>
                  <form onSubmit={handleUpdateUser} className="sts-form edit-user-form">
                    <div className="form-group">
                      <label>First Name: *</label>
                      <input
                        type="text"
                        value={editForm.firstName}
                        onChange={(e) => handleEditFormChange('firstName', e.target.value)}
                        onBlur={() => handleEditFormBlur('firstName')}
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
                        onBlur={() => handleEditFormBlur('middleName')}
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
                        onBlur={() => handleEditFormBlur('lastName')}
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
                        onBlur={() => handleEditFormBlur('email')}
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
                          onBlur={() => handleEditFormBlur('employee_id')}
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
                        type="tel"
                        value={editForm.mobile_number}
                        onChange={(e) => handleEditFormChange('mobile_number', e.target.value)}
                        onBlur={() => handleEditFormBlur('mobile_number')}
                        inputMode="numeric"
                        maxLength={11}
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
                        onBlur={() => handleEditFormBlur('birthday')}
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

                    {isTeacherRole(editingUser.role) && (
                      <div className="form-container-card edit-user-teacher-panel">
                        <h3>Class Assignments</h3>
                        <p className="edit-user-helper-text">
                          Assign the Grade and Section this teacher can monitor. Matching canonical students appear automatically, including before gameplay.
                        </p>
                        <div className="form-group edit-user-teacher-input">
                          <label htmlFor="teacher-assignment-grade">Grade</label>
                          <select
                            id="teacher-assignment-grade"
                            value={classAssignmentForm.grade_level}
                            onChange={(event) => setClassAssignmentForm((current) => ({ ...current, grade_level: event.target.value }))}
                            className="sts-input"
                          >
                            <option value="">Select Grade</option>
                            {PARENT_CHILD_GRADE_OPTIONS.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                          </select>
                        </div>
                        <div className="form-group edit-user-teacher-input">
                          <label htmlFor="teacher-assignment-section">Section</label>
                          <input
                            id="teacher-assignment-section"
                            type="text"
                            value={classAssignmentForm.section}
                            onChange={(event) => setClassAssignmentForm((current) => ({ ...current, section: event.target.value }))}
                            className="sts-input"
                            maxLength={50}
                            placeholder="e.g. Rizal"
                          />
                        </div>
                        <div className="modal-actions edit-user-teacher-actions">
                          <button type="button" className="sts-add-btn" onClick={handleSaveTeacherClassAssignment}>
                            {editingClassAssignmentId ? 'Update Assignment' : 'Add Assignment'}
                          </button>
                          {editingClassAssignmentId && (
                            <button type="button" className="cancel-btn" onClick={resetClassAssignmentForm}>Cancel Edit</button>
                          )}
                        </div>
                        {classAssignmentMessage && <p className="info-text">{classAssignmentMessage}</p>}
                        {teacherClassAssignments.length === 0 ? (
                          <p className="empty-table-msg">No class assignments yet.</p>
                        ) : (
                          <div className="table-container">
                            <table className="sts-data-table">
                              <thead>
                                <tr>
                                  <th>GRADE</th>
                                  <th>SECTION</th>
                                  <th>ACTION</th>
                                </tr>
                              </thead>
                              <tbody>
                                {teacherClassAssignments.map((assignment) => (
                                  <tr key={assignment.id}>
                                    <td>{assignment.grade_level}</td>
                                    <td>{assignment.section}</td>
                                    <td>
                                      <button type="button" className="edit-action-btn" onClick={() => handleEditTeacherClassAssignment(assignment)}>Edit</button>
                                      <button type="button" className="delete-action-btn" onClick={() => handleRemoveTeacherClassAssignment(assignment.id)}>Remove</button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}

                    {isTeacherRole(editingUser.role) && (
                      <div className="form-container-card edit-user-teacher-panel">
                        <h3>Individual Student Exceptions</h3>
                        <p className="edit-user-helper-text">
                          Use an individual student link only when a documented exception is needed beyond the teacher's assigned classes.
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
                            Add Student Exception
                          </button>
                        </div>
                        {relationMessage && <p className="info-text">{relationMessage}</p>}
                        {teacherRelations.length === 0 ? (
                          <p className="empty-table-msg">No individual student exceptions yet.</p>
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

                    {isParentRole(editingUser.role) && (
                      <AdminManagedChildrenPanel
                        parentId={editingUser.id}
                        sectionRegistry={sectionRegistry}
                        authHeaders={buildAuthHeaders()}
                      />
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
              </ModalPortal>
            )}
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
