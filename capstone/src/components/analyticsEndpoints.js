import { normalizeRole } from './manageUsers.utils';
import { apiUrl } from '../api';

export const buildScopedApiUrl = (path, role, userId) => {
  const url = new URL(apiUrl(path), 'http://app.local');
  const normalizedRole = normalizeRole(role);

  if ((normalizedRole === 'teacher' || normalizedRole === 'parent_teacher') && userId) {
    url.searchParams.set('teacher_id', String(userId));
  }

  if (normalizedRole === 'parent' && userId) {
    url.searchParams.set('parent_id', String(userId));
  }

  return `${url.pathname}${url.search}`;
};

export const buildStudentProgressDetailUrl = (studentId, role, userId) =>
  buildScopedApiUrl(`/api/student-progress/${studentId}`, role, userId);
