import {
  filterDirectoryRows,
  formatDirectoryStatus,
  formatDirectoryDate,
} from './idDirectory.utils';

describe('ID Directory helpers', () => {
  const students = [
    {
      student_id: '00123456',
      student_name: 'Ana Santos',
      grade_level: 'Grade 4',
      section: 'St. Anne',
      status: 'Active',
      is_archived: false,
    },
    {
      student_id: '001234',
      student_name: 'Ben Cruz',
      grade_level: 'Grade 6',
      section: 'St. Luke',
      status: 'Offline',
      is_archived: false,
    },
  ];

  test('filters students immediately across ID, name, grade, section, and status', () => {
    expect(filterDirectoryRows(students, {
      id: '00123456', name: '', grade: '', section: '', status: '',
    }, 'student')).toEqual([students[0]]);
    expect(filterDirectoryRows(students, {
      id: '', name: 'ben', grade: 'grade 6', section: 'st. luke', status: 'offline',
    }, 'student')).toEqual([students[1]]);
  });

  test('treats dashed and plain eight-digit Student IDs as the same directory identity', () => {
    const dashed = { ...students[0], student_id: '17-000087' };
    expect(filterDirectoryRows([dashed], {
      id: '17000087', name: '', grade: '', section: '', status: '',
    }, 'student')).toEqual([dashed]);
    expect(filterDirectoryRows([dashed], {
      id: '17-000087', name: '', grade: '', section: '', status: '',
    }, 'student')).toEqual([dashed]);
  });

  test('formats archived status truthfully and preserves date display', () => {
    expect(formatDirectoryStatus({ status: 'Active', is_archived: true })).toBe('Archived');
    expect(formatDirectoryStatus({ status: 'Offline', is_archived: false })).toBe('Offline');
    expect(formatDirectoryDate('2025-01-02T00:00:00.000Z')).not.toBe('—');
    expect(formatDirectoryDate(null)).toBe('—');
  });

  test('filters teachers by ID, name, email, role, and status', () => {
    const teachers = [{
      teacher_id: 'T-1001',
      teacher_name: 'Maria Cruz',
      email: 'maria@example.com',
      role: 'parent_teacher',
      status: 'Offline',
    }];
    expect(filterDirectoryRows(teachers, {
      id: 't-1001', name: 'maria', email: 'example.com', role: 'parent_teacher', status: 'offline',
    }, 'teacher')).toEqual(teachers);
  });
});
