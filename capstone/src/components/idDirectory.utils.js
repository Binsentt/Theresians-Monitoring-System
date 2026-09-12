import { normalizeRole } from './manageUsers.utils';
import { matchesTableSearch } from './tableReporting.utils';

const normalizeText = (value) => String(value ?? '').trim().toLowerCase();
export const normalizeDirectoryStudentId = (value) => {
  const raw = String(value ?? '').trim();
  if (/^\d{2}-\d{6}$/.test(raw)) return raw.replace('-', '');
  return /^\d{6}$/.test(raw) || /^\d{8}$/.test(raw) ? raw : null;
};

const valueForType = (row, type, field) => {
  if (type === 'student') {
    return row?.[field] ?? row?.[`student_${field}`] ?? '';
  }
  return row?.[field] ?? row?.[`teacher_${field}`] ?? '';
};

export const filterDirectoryRows = (rows, filters = {}, type) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (typeof filters === 'string') {
    const fields = type === 'student'
      ? ['student_id', 'student_name', 'grade_level', 'section', 'parent_name', 'parent_relationship', 'directory_status', 'created_at']
      : ['teacher_id', 'teacher_name', 'email', 'role', 'directory_status', 'created_at'];
    return safeRows.filter((row) => matchesTableSearch({
      ...row,
      directory_status: formatDirectoryStatus(row),
    }, filters, fields));
  }
  const idFilter = type === 'student'
    ? normalizeText(normalizeDirectoryStudentId(filters.id) || filters.id)
    : normalizeText(filters.id);
  const nameFilter = normalizeText(filters.name);
  const gradeFilter = normalizeText(filters.grade);
  const sectionFilter = normalizeText(filters.section);
  const statusFilter = normalizeText(filters.status);
  const emailFilter = normalizeText(filters.email);
  const roleFilter = normalizeText(filters.role);

  return safeRows.filter((row) => {
    const rawId = valueForType(row, type, type === 'student' ? 'student_id' : 'teacher_id');
    const id = type === 'student'
      ? normalizeText(normalizeDirectoryStudentId(rawId) || rawId)
      : normalizeText(rawId);
    const name = normalizeText(valueForType(row, type, type === 'student' ? 'student_name' : 'teacher_name'));
    const grade = normalizeText(row?.grade_level ?? row?.gradeLevel);
    const section = normalizeText(row?.section);
    const status = normalizeText((row?.is_archived || row?.isArchived)
      ? 'Archived'
      : (row?.status || 'Active'));
    const email = normalizeText(row?.email);
    const role = normalizeText(row?.role);

    return (!idFilter || id.includes(idFilter))
      && (!nameFilter || name.includes(nameFilter))
      && (!gradeFilter || grade.includes(gradeFilter))
      && (!sectionFilter || section.includes(sectionFilter))
      && (!statusFilter || status.includes(statusFilter))
      && (!emailFilter || email.includes(emailFilter))
      && (!roleFilter || role.includes(roleFilter));
  });
};

export const formatDirectoryStatus = (row) => (
  row?.is_archived || row?.isArchived
    ? 'Archived'
    : String(row?.status || '').trim() || 'Active'
);

export const formatDirectoryRole = (role) => {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return '—';
  if (normalizedRole === 'parent_teacher') return 'Parent/Teacher';
  return normalizedRole.charAt(0).toUpperCase() + normalizedRole.slice(1);
};

export const formatDirectoryDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
};
