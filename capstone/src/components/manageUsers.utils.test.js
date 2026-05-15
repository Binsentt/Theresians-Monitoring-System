import { filterUsers, formatRoleLabel, normalizeRole, paginateItems } from './manageUsers.utils';

describe('manageUsers role helpers', () => {
  const users = [
    { id: 1, name: 'Alice Admin', email: 'alice@gmail.com', role: 'admin' },
    { id: 2, name: 'Tom Teacher', email: 'tom@gmail.com', role: 'Teacher' },
    { id: 3, name: 'Paula Parent', email: 'paula@gmail.com', role: 'PARENT' },
    { id: 4, name: 'Sam Student', email: 'sam@gmail.com', role: 'student' },
  ];

  test('normalizeRole trims and lowercases role values', () => {
    expect(normalizeRole(' Teacher ')).toBe('teacher');
    expect(normalizeRole('PARENT')).toBe('parent');
    expect(normalizeRole()).toBe('');
  });

  test('formatRoleLabel returns a readable fallback label', () => {
    expect(formatRoleLabel('teacher')).toBe('Teacher');
    expect(formatRoleLabel('')).toBe('Parent');
  });

  test('filterUsers returns every user matching the selected role regardless of role casing', () => {
    expect(filterUsers(users, '', 'Teacher')).toEqual([users[1]]);
    expect(filterUsers(users, '', 'Parent')).toEqual([users[2]]);
    expect(filterUsers(users, '', 'Admin')).toEqual([users[0]]);
    expect(filterUsers(users, '', 'Student')).toEqual([users[3]]);
  });

  test('filterUsers keeps search behavior alongside role filtering', () => {
    expect(filterUsers(users, 'sam', 'Student')).toEqual([users[3]]);
    expect(filterUsers(users, 'teacher', 'All')).toEqual([users[1]]);
  });

  test('paginateItems slices a filtered list and reports pagination metadata', () => {
    const result = paginateItems(users, 2, 2);

    expect(result.currentPage).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.startIndex).toBe(2);
    expect(result.endIndex).toBe(4);
    expect(result.pageItems).toEqual([users[2], users[3]]);
  });

  test('paginateItems clamps invalid page values safely', () => {
    const result = paginateItems(users, 99, 3);

    expect(result.currentPage).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.pageItems).toEqual([users[3]]);
  });
});
