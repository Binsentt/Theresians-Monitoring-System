import {
  buildActivityLogQueryParams,
  formatActivityLogDuration,
  getActivityLogActivity,
  getActivityLogGrade,
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
      selectedStudentId: 22,
      debouncedSearch: 'alpha',
      selectedGrade: 'Grade 4',
      selectedSection: 'Section A',
      currentPage: 2,
    });

    expect(params.get('search')).toBeNull();
    expect(params.get('grade_level')).toBeNull();
    expect(params.get('section')).toBeNull();
    expect(params.get('teacher_id')).toBeNull();
    expect(params.get('student_id')).toBe('22');
    expect(params.get('offset')).toBe('10');
  });

  test('does not include a caller-supplied teacher identity in activity log filters', () => {
    const params = buildActivityLogQueryParams({
      role: 'teacher',
      userId: 16,
      debouncedSearch: 'beta',
      selectedGrade: 'Grade 5',
      selectedSection: 'Section B',
    });

    expect(params.get('teacher_id')).toBeNull();
    expect(params.get('search')).toBe('beta');
    expect(params.get('grade_level')).toBe('Grade 5');
    expect(params.get('section')).toBe('Section B');
  });

  test('formats activity log rows for the simplified Godot activity table', () => {
    expect(getActivityLogGrade({ grade: 'Grade 2' })).toBe('Grade 2');
    expect(getActivityLogGrade({ grade_level: 'Grade 3' })).toBe('Grade 3');
    expect(getActivityLogActivity({ current_quest: 'Fractions Gate', activity_description: 'Gameplay Session' })).toBe('Fractions Gate');
    expect(getActivityLogActivity({ activity_description: 'Gameplay Session' })).toBe('No active quest');
    expect(formatActivityLogDuration({ duration_seconds: 125 })).toBe('2m 5s');
    expect(formatActivityLogDuration({ total_play_time: 3600 })).toBe('1h 0m');
    expect(formatActivityLogDuration({ duration: '7m 30s' })).toBe('7m 30s');
  });

  test('renders stored canonical quests with only meaningful stored difficulty', () => {
    expect(getActivityLogActivity({ current_quest: 'Tutorial', activity_description: 'New Game' })).toBe('Tutorial');
    expect(getActivityLogActivity({ current_quest: 'Teacher House', activity_description: 'Load Game' })).toBe('Teacher House');
    expect(getActivityLogActivity({ current_quest: 'Oakleaf Bandit', difficulty_level: 'Easy' })).toBe('Oakleaf Bandit — Easy');
    expect(getActivityLogActivity({ current_quest: 'Oakleaf Bandit', difficulty_level: ' unknown ' })).toBe('Oakleaf Bandit');
  });

  test('never uses generic activity descriptions or website URLs as Student Quest Activity', () => {
    expect(getActivityLogActivity({ activity_description: 'Viewed https://portal.example/admin' })).toBe('No active quest');
    expect(getActivityLogActivity({ current_quest: '   ', activity_description: 'Account signed in' })).toBe('No active quest');
  });
});
