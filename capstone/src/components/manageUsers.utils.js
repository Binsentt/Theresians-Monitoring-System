export const normalizeRole = (role) => String(role || '').trim().toLowerCase();

export const formatRoleLabel = (role) => {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return 'Parent';
  return normalizedRole.charAt(0).toUpperCase() + normalizedRole.slice(1);
};

export const filterUsers = (users, searchTerm, roleFilter) => {
  const normalizedSearch = String(searchTerm || '').trim().toLowerCase();
  const normalizedRoleFilter = normalizeRole(roleFilter);

  return users.filter((user) => {
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
