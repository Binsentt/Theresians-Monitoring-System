import {
  buildActivityLogQueryParams,
  normalizeActivityLogPayload,
  shouldShowActivityLogFilters,
} from './activityLog.utils';

describe('normalizeActivityLogPayload', () => {
  test('reads paginated API payloads and sorts newest first', () => {
    const payload = {
      data: [
        { id: 1, student_name: 'Alpha', activity_timestamp: '2026-05-01T08:00:00.000Z' },
        { id: 2, student_name: 'Beta', activity_timestamp: '2026-05-02T08:00:00.000Z' },
      ],
      pagination: { total: 2, pages: 1, current_page: 1 }
    };

    const result = normalizeActivityLogPayload(payload);

    expect(result.records.map((item) => item.id)).toEqual([2, 1]);
    expect(result.pagination.total).toBe(2);
  });

  test('deduplicates repeated activity rows by id', () => {
    const payload = {
      data: [
        { id: 9, student_name: 'Gamma', activity_timestamp: '2026-05-03T09:00:00.000Z' },
        { id: 9, student_name: 'Gamma', activity_timestamp: '2026-05-03T09:00:00.000Z' },
      ]
    };

    const result = normalizeActivityLogPayload(payload);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].id).toBe(9);
  });

  test('supports legacy array payloads as a fallback', () => {
    const payload = [
      { id: 3, student_name: 'Legacy', activity_timestamp: '2026-05-01T06:00:00.000Z' }
    ];

    const result = normalizeActivityLogPayload(payload);

    expect(result.records).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
  });

  test('hides filters for the parent role only', () => {
    expect(shouldShowActivityLogFilters('parent')).toBe(false);
    expect(shouldShowActivityLogFilters('teacher')).toBe(true);
    expect(shouldShowActivityLogFilters('admin')).toBe(true);
  });

  test('does not include search or grade filters for parent activity log requests', () => {
    const params = buildActivityLogQueryParams({
      role: 'parent',
      userId: 15,
      debouncedSearch: 'alpha',
      selectedGrade: 'Grade 4',
      selectedSection: 'Section A',
      currentPage: 2,
    });

    expect(params.get('search')).toBeNull();
    expect(params.get('grade_level')).toBeNull();
    expect(params.get('section')).toBeNull();
    expect(params.get('teacher_id')).toBeNull();
    expect(params.get('offset')).toBe('10');
  });

  test('keeps teacher-specific filtering parameters intact', () => {
    const params = buildActivityLogQueryParams({
      role: 'teacher',
      userId: 16,
      debouncedSearch: 'beta',
      selectedGrade: 'Grade 5',
      selectedSection: 'Section B',
    });

    expect(params.get('teacher_id')).toBe('16');
    expect(params.get('search')).toBe('beta');
    expect(params.get('grade_level')).toBe('Grade 5');
    expect(params.get('section')).toBe('Section B');
  });
});
