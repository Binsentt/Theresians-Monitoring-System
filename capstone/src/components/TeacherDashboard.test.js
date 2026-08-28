import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TeacherDashboard from './TeacherDashboard';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div data-testid="dashboard">{main}</div>,
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

jest.mock('./layout/Card', () => ({
  Card: ({ children }) => <div>{children}</div>,
  MetricCard: ({ label, value }) => (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  ),
  InfoCard: ({ children, title }) => (
    <div>
      <h3>{title}</h3>
      {children}
    </div>
  ),
}));

jest.mock('./layout/Grid', () => ({
  ResponsiveGrid: ({ children }) => <div>{children}</div>,
}));

jest.mock('./layout/AnalyticsSidebar', () => ({ role }) => <div data-testid="sidebar">{role}</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

describe('TeacherDashboard route protection', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    global.fetch = jest.fn((url) => {
      if (url === '/api/students/progress?lifecycle=active') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/api/analytics/overview') {
        return Promise.resolve({ ok: true, json: async () => ({ studentCount: 0, averageAccuracy: null, averageProgress: null }) });
      }
      if (url === '/api/top-achievers') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
  });

  test('redirects to login when no authenticated teacher session exists', async () => {
    await act(async () => {
      root.render(<TeacherDashboard />);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login');
    expect(container.textContent).not.toContain('Teacher Dashboard');
  });

  test('renders for authenticated Parent/Teacher sessions', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 5, role: 'Parent/Teacher', name: 'Pat Dual' }));

    await act(async () => {
      root.render(<TeacherDashboard />);
    });

    expect(mockNavigate).not.toHaveBeenCalledWith('/login');
    expect(container.textContent).toContain('Teacher Dashboard');
    expect(container.textContent).toContain('Welcome, Pat Dual');
  });

  test('uses only the authenticated teacher scope to render live classroom metrics', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 5, role: 'teacher', name: 'Teacher Cruz' }));
    localStorage.setItem('token', 'teacher-dashboard-token');
    const requests = [];
    global.fetch = jest.fn((url, options) => {
      requests.push({ url, options });
      if (url === '/api/students/progress?lifecycle=active') {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            student_id: 44,
            student_name: 'Ava Santos',
            grade_level: 'Grade 3',
            section: 'Rizal',
            total_questions: null,
            accuracy_rate: null,
            performance_percentage: null,
            current_quest: null,
          }],
        });
      }
      if (url === '/api/analytics/overview') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ studentCount: 1, averageAccuracy: null, averageProgress: null }),
        });
      }
      if (url === '/api/top-achievers') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await act(async () => {
      root.render(<TeacherDashboard />);
    });

    expect(container.textContent).toContain('Assigned Students');
    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('No activity yet');
    expect(container.textContent).not.toContain('QUESTS COMPLETED');
    expect(container.textContent).not.toContain('Grade 10');
    expect(requests.map((request) => request.url)).toEqual(expect.arrayContaining([
      '/api/students/progress?lifecycle=active',
      '/api/analytics/overview',
      '/api/top-achievers',
    ]));
    expect(requests.every((request) => request.options?.headers?.Authorization === 'Bearer teacher-dashboard-token')).toBe(true);
  });
});
