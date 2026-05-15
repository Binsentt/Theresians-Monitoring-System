import {
  filterStudentProgress,
  getDefaultSection,
  normalizeStudentProgressPayload,
} from './studentProgress.utils';

describe('student progress helpers', () => {
  test('supports legacy array payloads and normalizes student progress rows', () => {
    const result = normalizeStudentProgressPayload([
      {
        student_id: 7,
        grade_level: 'Grade 4',
        correct_answers: 8,
        total_questions: 10,
        accuracy_rate: 80,
      }
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        student_id: 7,
        section: 'Section B',
        incorrect_answers: 2,
        performance_percentage: 80,
      })
    ]);
  });

  test('supports wrapped payloads and safely falls back to an empty list', () => {
    expect(normalizeStudentProgressPayload({ data: [{ student_id: 2, total_questions: 0, correct_answers: 0 }] })).toHaveLength(1);
    expect(normalizeStudentProgressPayload({ error: 'Forbidden' })).toEqual([]);
    expect(normalizeStudentProgressPayload(null)).toEqual([]);
  });

  test('filters student progress safely even when names are missing', () => {
    const students = [
      { student_id: 1, student_name: null, grade_level: 'Grade 3', section: 'Section A' },
      { student_id: 2, student_name: 'Maria Santos', grade_level: 'Grade 3', section: 'Section B' },
    ];

    expect(() =>
      filterStudentProgress(students, {
        searchQuery: 'maria',
        selectedGrade: 'Grade 3',
        selectedSection: 'Section B',
      })
    ).not.toThrow();

    expect(
      filterStudentProgress(students, {
        searchQuery: 'maria',
        selectedGrade: 'Grade 3',
        selectedSection: 'Section B',
      }).map((student) => student.student_id)
    ).toEqual([2]);
  });

  test('builds a deterministic default section when the backend does not provide one', () => {
    expect(getDefaultSection('Grade 2', 3)).toBe('Section A');
    expect(getDefaultSection('Grade 2', 4)).toBe('Section B');
  });
});
