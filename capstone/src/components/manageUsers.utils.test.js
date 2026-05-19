import {
  buildAccountCreationSuccessModal,
  canAccessRole,
  filterUsers,
  formatRoleLabel,
  getDefaultDashboardRoute,
  isParentRole,
  isTeacherRole,
  normalizeRole,
  paginateItems,
} from './manageUsers.utils';

describe('manageUsers role helpers', () => {
  const users = [
    { id: 1, name: 'Alice Admin', email: 'alice@gmail.com', role: 'admin' },
    { id: 2, name: 'Tom Teacher', email: 'tom@gmail.com', role: 'Teacher' },
    { id: 3, name: 'Paula Parent', email: 'paula@gmail.com', role: 'PARENT' },
    { id: 4, name: 'Sam Student', email: 'sam@gmail.com', role: 'student' },
    { id: 5, name: 'Pat Dual', email: 'pat@gmail.com', role: 'parent_teacher' },
  ];

  test('normalizeRole trims and lowercases role values', () => {
    expect(normalizeRole(' Teacher ')).toBe('teacher');
    expect(normalizeRole('PARENT')).toBe('parent');
    expect(normalizeRole('Parent/Teacher')).toBe('parent_teacher');
    expect(normalizeRole()).toBe('');
  });

  test('formatRoleLabel returns a readable fallback label', () => {
    expect(formatRoleLabel('teacher')).toBe('Teacher');
    expect(formatRoleLabel('parent_teacher')).toBe('Parent/Teacher');
    expect(formatRoleLabel('')).toBe('Parent');
  });

  test('Parent/Teacher role can access both parent and teacher areas', () => {
    expect(isParentRole('parent_teacher')).toBe(true);
    expect(isTeacherRole('parent_teacher')).toBe(true);
    expect(canAccessRole('parent_teacher', 'parent')).toBe(true);
    expect(canAccessRole('parent_teacher', 'teacher')).toBe(true);
    expect(canAccessRole('parent_teacher', 'admin')).toBe(false);
  });

  test('Parent/Teacher defaults to the Teacher dashboard after login', () => {
    expect(getDefaultDashboardRoute('parent_teacher')).toBe('/teacher-dashboard');
    expect(getDefaultDashboardRoute('Parent/Teacher')).toBe('/teacher-dashboard');
    expect(getDefaultDashboardRoute('parent')).toBe('/parent-dashboard');
  });

  test('filterUsers returns every user matching the selected role regardless of role casing', () => {
    expect(filterUsers(users, '', 'Teacher')).toEqual([users[1]]);
    expect(filterUsers(users, '', 'Parent')).toEqual([users[2]]);
    expect(filterUsers(users, '', 'Admin')).toEqual([users[0]]);
    expect(filterUsers(users, '', 'Student')).toEqual([users[3]]);
    expect(filterUsers(users, '', 'Parent/Teacher')).toEqual([users[4]]);
  });

  test('filterUsers keeps search behavior alongside role filtering', () => {
    expect(filterUsers(users, 'sam', 'Student')).toEqual([users[3]]);
    expect(filterUsers(users, 'teacher', 'All')).toEqual([users[1], users[4]]);
  });

  test('paginateItems slices a filtered list and reports pagination metadata', () => {
    const result = paginateItems(users, 2, 2);

    expect(result.currentPage).toBe(2);
    expect(result.totalPages).toBe(3);
    expect(result.startIndex).toBe(2);
    expect(result.endIndex).toBe(4);
    expect(result.pageItems).toEqual([users[2], users[3]]);
  });

  test('paginateItems clamps invalid page values safely', () => {
    const result = paginateItems(users, 99, 3);

    expect(result.currentPage).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.pageItems).toEqual([users[3], users[4]]);
  });

  test('buildAccountCreationSuccessModal reports credential email instead of exposing generated password', () => {
    expect(buildAccountCreationSuccessModal('Parent', { tempPassword: 'A1strong!temp', user: { parent_id: '482915' } })).toEqual({
      title: 'Success',
      message: "Parent added successfully! Account credentials were sent to the user's email.",
      tempPassword: '',
      parentId: '482915',
      emailSent: true,
    });
  });

  test('buildAccountCreationSuccessModal shows one-time temporary password only when email delivery fails', () => {
    expect(
      buildAccountCreationSuccessModal('Teacher', {
        warning: 'Teacher account was created, but the credential email could not be sent. Copy the temporary password now and share it securely with the user.',
        tempPassword: 'Generated!2345',
        user: {},
      })
    ).toEqual({
      title: 'Account Created - Email Issue',
      message: 'Teacher account was created, but the credential email could not be sent. Copy the temporary password now and share it securely with the user.',
      tempPassword: 'Generated!2345',
      parentId: '',
      emailSent: false,
    });
  });
});
