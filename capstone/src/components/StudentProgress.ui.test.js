import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminStudentProgress from './AdminStudentProgress';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div>{main}</div>,
  MainContent: ({ children }) => <div>{children}</div>,
  TopBar: ({ children }) => <div>{children}</div>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children, title }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  ),
}));

jest.mock('./layout/AnalyticsSidebar', () => () => <div>Sidebar</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const jsonResponse = (payload) => Promise.resolve({
  ok: true,
  json: async () => payload,
});

describe('Student Progress summary cards', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin' }));
    localStorage.setItem('token', 'analytics-test-token');
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
  });

  test('does not show the Grade Groups summary card', async () => {
    global.fetch = jest.fn((url) => {
      const value = String(url);
      if (value.startsWith('/api/students/progress')) {
        return jsonResponse([
          { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 3', correct_answers: 8, total_questions: 10, accuracy_rate: 80, progress_percentage: 70 },
        ]);
      }
      if (value.startsWith('/api/analytics/overview')) {
        return jsonResponse({ studentCount: 1, averageAccuracy: 80, averageProgress: 70 });
      }
      if (value.startsWith('/api/analytics/recommendations')) {
        return jsonResponse({ recommendations: ['Keep practicing fractions.'] });
      }
      return jsonResponse({});
    });

    await act(async () => {
      root.render(<AdminStudentProgress />);
    });

    expect(container.textContent).toContain('Total students');
    expect(container.textContent).toContain('Average accuracy');
    expect(container.textContent).toContain('Average completion');
    expect(container.textContent).not.toMatch(/Grade groups/i);
    expect(container.querySelector('button[aria-label="Print Student List"]')).not.toBeNull();
    expect(container.querySelectorAll('.printable-table-report tbody tr')).toHaveLength(1);
    expect(container.querySelector('.student-progress-table thead th')?.textContent).toBe('No.');
    expect(global.fetch.mock.calls.every(([, options]) => (
      options?.headers?.Authorization === 'Bearer analytics-test-token'
    ))).toBe(true);
  });

  test('does not render unavailable student metrics as fabricated zeroes', async () => {
    global.fetch = jest.fn((url) => {
      const value = String(url);
      if (value.startsWith('/api/students/progress')) {
        return jsonResponse([
          { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 3' },
        ]);
      }
      if (value.startsWith('/api/analytics/overview')) {
        return jsonResponse({ studentCount: 1, averageAccuracy: null, averageProgress: null });
      }
      if (value.startsWith('/api/analytics/recommendations')) {
        return jsonResponse({ recommendations: [] });
      }
      return jsonResponse({});
    });

    await act(async () => {
      root.render(<AdminStudentProgress />);
    });

    expect(container.textContent).toContain('Not available');
    expect(container.textContent).not.toContain('0%');
  });

  test('uses a dataset-ready empty state when no authorised student records exist', async () => {
    global.fetch = jest.fn((url) => {
      const value = String(url);
      if (value.startsWith('/api/students/progress')) return jsonResponse([]);
      if (value.startsWith('/api/analytics/overview')) return jsonResponse({ studentCount: 0, averageAccuracy: null, averageProgress: null });
      if (value.startsWith('/api/analytics/recommendations')) return jsonResponse({ recommendations: [] });
      return jsonResponse({});
    });

    await act(async () => {
      root.render(<AdminStudentProgress />);
    });

    expect(container.textContent).toContain('No student records are available yet.');
  });
});
