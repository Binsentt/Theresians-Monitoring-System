import { normalizeRole } from './manageUsers.utils';
import { apiUrl } from '../api';

export const buildScopedApiUrl = (path, role) => {
  const url = new URL(apiUrl(path), 'http://app.local');
  const normalizedRole = normalizeRole(role);

  if (normalizedRole === 'parent') {
    url.searchParams.set('scope', 'parent');
  }

  return `${url.pathname}${url.search}`;
};

export const buildStudentProgressDetailUrl = (studentId, role) =>
  buildScopedApiUrl(`/api/student-progress/${studentId}`, role);
