import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ParentDashboard from './ParentDashboard';

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
jest.mock('./layout/Card', () => ({
  MetricCard: ({ label, value }) => <div>{label}: {value}</div>,
  InfoCard: ({ children, title }) => <div>{title}{children}</div>,
}));
jest.mock('./layout/Grid', () => ({
  ResponsiveGrid: ({ children }) => <div>{children}</div>,
}));
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const jsonResponse = (body) => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('ParentDashboard defensive game data rendering', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 19, role: 'parent', name: 'Parent User' }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
    console.error.mockRestore();
  });

  test('does not crash when analytics and game payloads contain malformed values', async () => {
    global.fetch = jest.fn((url) => {
      if (url.startsWith('/api/user/19')) return jsonResponse({ id: 19, role: 'parent', name: 'Parent User' });
      if (url.startsWith('/api/top-achievers')) {
        return jsonResponse([
          { id: 1, student_name: { bad: 'name' }, grade_level: null, current_quest: { bad: true }, score: { bad: true }, accuracy_rate: '82.4' },
        ]);
      }
      if (url.startsWith('/api/analytics/overview')) return jsonResponse({ studentCount: '1', averageAccuracy: '82.4', averageProgress: null });
      if (url.startsWith('/api/analytics/recommendations')) return jsonResponse({ recommendations: [{ message: 'Practice fractions.' }, null] });
      if (url.startsWith('/api/students/progress')) return jsonResponse({ data: null });
      throw new Error(`Unexpected URL: ${url}`);
    });

    await act(async () => {
      root.render(<ParentDashboard />);
    });

    expect(container.textContent).toContain('Parent Dashboard');
    expect(container.textContent).toContain('No game progress data available yet.');
    expect(container.textContent).toContain('Practice fractions.');
    expect(mockNavigate).not.toHaveBeenCalledWith('/login');
  });
});
