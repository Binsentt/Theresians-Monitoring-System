import { buildScopedApiUrl, buildStudentProgressDetailUrl } from './analyticsEndpoints';

describe('analytics endpoint helpers', () => {
  test('uses a non-identity parent context selector for parent-scoped analytics requests', () => {
    expect(buildScopedApiUrl('/api/analytics/overview', 'parent', 19)).toBe(
      '/api/analytics/overview?scope=parent'
    );
  });

  test('preserves existing query parameters when parent context is added', () => {
    expect(buildScopedApiUrl('/api/students/progress?limit=10', 'parent', 19)).toBe(
      '/api/students/progress?limit=10&scope=parent'
    );
  });

  test('does not place a teacher identity in analytics requests', () => {
    expect(buildScopedApiUrl('/api/analytics/recommendations', 'teacher', 16)).toBe(
      '/api/analytics/recommendations'
    );
  });

  test('uses teacher context by default for Parent/Teacher analytics requests', () => {
    expect(buildScopedApiUrl('/api/students/progress', 'parent_teacher', 16)).toBe(
      '/api/students/progress'
    );
  });

  test('builds parent-scoped student detail URLs', () => {
    expect(buildStudentProgressDetailUrl(20, 'parent', 19)).toBe(
      '/api/student-progress/20?scope=parent'
    );
  });

  test('does not add scope parameters for admin requests', () => {
    expect(buildScopedApiUrl('/api/students/progress', 'admin', 3)).toBe(
      '/api/students/progress'
    );
  });
});
