import { normalizeRole } from './manageUsers.utils';

const API_BASE_URL = 'http://localhost:5000';

export const buildScopedApiUrl = (path, role, userId) => {
  const url = new URL(`${API_BASE_URL}${path}`);
  const normalizedRole = normalizeRole(role);

  if (normalizedRole === 'teacher' && userId) {
    url.searchParams.set('teacher_id', String(userId));
  }

  if (normalizedRole === 'parent' && userId) {
    url.searchParams.set('parent_id', String(userId));
  }

  return url.toString();
};

export const buildStudentProgressDetailUrl = (studentId, role, userId) =>
  buildScopedApiUrl(`/api/student-progress/${studentId}`, role, userId);
