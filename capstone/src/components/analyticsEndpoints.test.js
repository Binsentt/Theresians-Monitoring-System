import { buildScopedApiUrl, buildStudentProgressDetailUrl } from './analyticsEndpoints';

describe('analytics endpoint helpers', () => {
  test('adds parent_id for parent-scoped analytics requests', () => {
    expect(buildScopedApiUrl('/api/analytics/overview', 'parent', 19)).toBe(
      'http://localhost:5000/api/analytics/overview?parent_id=19'
    );
  });

  test('preserves existing query parameters when parent scoping is added', () => {
    expect(buildScopedApiUrl('/api/students/progress?limit=10', 'parent', 19)).toBe(
      'http://localhost:5000/api/students/progress?limit=10&parent_id=19'
    );
  });

  test('adds teacher_id for teacher-scoped analytics requests', () => {
    expect(buildScopedApiUrl('/api/analytics/recommendations', 'teacher', 16)).toBe(
      'http://localhost:5000/api/analytics/recommendations?teacher_id=16'
    );
  });

  test('builds parent-scoped student detail URLs', () => {
    expect(buildStudentProgressDetailUrl(20, 'parent', 19)).toBe(
      'http://localhost:5000/api/student-progress/20?parent_id=19'
    );
  });

  test('does not add scope parameters for admin requests', () => {
    expect(buildScopedApiUrl('/api/students/progress', 'admin', 3)).toBe(
      'http://localhost:5000/api/students/progress'
    );
  });
});
