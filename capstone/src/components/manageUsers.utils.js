export const normalizeRole = (role) => {
  const value = String(role || '').trim().toLowerCase();
  if (['parent/teacher', 'parent_teacher', 'parent-teacher', 'parent teacher'].includes(value)) {
    return 'parent_teacher';
  }
  return value;
};

export const isAdminRole = (role) => normalizeRole(role) === 'admin';
export const isTeacherRole = (role) => ['teacher', 'parent_teacher'].includes(normalizeRole(role));
export const isParentRole = (role) => ['parent', 'parent_teacher'].includes(normalizeRole(role));
export const WEBSITE_MANAGED_ROLES = ['admin', 'teacher', 'parent', 'parent_teacher'];
export const isWebsiteManagedRole = (role) => WEBSITE_MANAGED_ROLES.includes(normalizeRole(role));
export const canAccessRole = (role, requiredRole) => {
  const required = normalizeRole(requiredRole);
  if (required === 'admin') return isAdminRole(role);
  if (required === 'teacher') return isTeacherRole(role);
  if (required === 'parent') return isParentRole(role);
  return normalizeRole(role) === required;
};

export const getDefaultDashboardRoute = (role) => {
  const normalizedRole = normalizeRole(role);
  if (normalizedRole === 'admin') return '/admin-dashboard';
  if (normalizedRole === 'teacher' || normalizedRole === 'parent_teacher') return '/teacher-dashboard';
  if (normalizedRole === 'parent') return '/parent-dashboard';
  return '/';
};

export const formatRoleLabel = (role) => {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return 'Parent';
  if (normalizedRole === 'parent_teacher') return 'Parent/Teacher';
  return normalizedRole.charAt(0).toUpperCase() + normalizedRole.slice(1);
};

export const filterUsers = (users, searchTerm, roleFilter) => {
  const normalizedSearch = String(searchTerm || '').trim().toLowerCase();
  const normalizedRoleFilter = normalizeRole(roleFilter);

  return users.filter((user) => {
    if (!isWebsiteManagedRole(user.role)) return false;

    const roleLabel = formatRoleLabel(user.role);
    const matchesSearch =
      !normalizedSearch ||
      user.name?.toLowerCase().includes(normalizedSearch) ||
      user.email?.toLowerCase().includes(normalizedSearch) ||
      roleLabel.toLowerCase().includes(normalizedSearch);

    const matchesRole =
      normalizedRoleFilter === '' ||
      normalizedRoleFilter === 'all' ||
      normalizeRole(user.role) === normalizedRoleFilter;

    return matchesSearch && matchesRole;
  });
};

export const paginateItems = (items, currentPage, pageSize) => {
  const safePageSize = Math.max(1, Number(pageSize) || 1);
  const totalItems = Array.isArray(items) ? items.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const safeCurrentPage = Math.min(Math.max(1, Number(currentPage) || 1), totalPages);
  const startIndex = totalItems === 0 ? 0 : (safeCurrentPage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalItems);

  return {
    currentPage: safeCurrentPage,
    totalPages,
    totalItems,
    startIndex,
    endIndex,
    pageItems: Array.isArray(items) ? items.slice(startIndex, endIndex) : [],
  };
};

export const splitAddressFields = (address = '') => {
  const [street = '', city = '', ...provinceParts] = String(address || '')
    .split(',')
    .map((value) => value.trim());

  return {
    street,
    city,
    province: provinceParts.join(', ').trim(),
  };
};

export const combineAddressFields = ({ street = '', city = '', province = '' } = {}) => (
  [street, city, province]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ')
);

export const validateOptionalAdultBirthday = (date, referenceDate = new Date()) => {
  if (!date) return '';

  const birthday = new Date(date);
  const today = new Date(referenceDate);
  if (Number.isNaN(birthday.getTime()) || Number.isNaN(today.getTime())) return '';
  if (birthday > today) return 'Birthday cannot be in the future';

  const adultBirthday = new Date(today);
  adultBirthday.setFullYear(adultBirthday.getFullYear() - 18);
  return birthday > adultBirthday ? 'Must be at least 18 years old' : '';
};

export const normalizeEmployeeIdInput = (value) => (
  String(value || '').replace(/\D/g, '').slice(0, 10)
);

export const validateEmployeeId = (value, { required = false } = {}) => {
  const normalized = String(value || '').trim();
  if (!normalized) return required ? 'Employee ID is required for teachers.' : '';
  if (!/^\d+$/.test(normalized)) return 'Employee ID must contain digits only.';
  if (normalized.length > 10) return 'Employee ID must be 10 digits or fewer.';
  return '';
};

export const buildAccountCreationSuccessModal = (selectedRole, data = {}) => ({
  title: data.warning ? 'Account Created - Email Issue' : 'Success',
  message: data.warning || `${selectedRole} added successfully! Account credentials were sent to the user's email.`,
  parentId: data.user?.parent_id || '',
  emailSent: !data.warning,
});
