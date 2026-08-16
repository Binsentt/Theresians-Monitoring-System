import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ParentChildProgress from './ParentChildProgress';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('recharts', () => ({
  Bar: () => <div>Bar</div>,
  BarChart: ({ children }) => <div>{children}</div>,
  CartesianGrid: () => <div>Grid</div>,
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  Tooltip: () => <div>Tooltip</div>,
  XAxis: () => <div>XAxis</div>,
  YAxis: () => <div>YAxis</div>,
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

const jsonResponse = (body) => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => body,
});

const successPayloadForUrl = (url, childrenPayload) => {
  if (url.startsWith('/api/parent/children?')) return jsonResponse(childrenPayload);
  if (url.startsWith('/api/students/progress?')) return jsonResponse([]);
  if (url.startsWith('/api/analytics/overview?')) return jsonResponse({});
  if (url.startsWith('/api/analytics/recommendations?')) return jsonResponse({ recommendations: [] });
  if (url.startsWith('/api/activity-logs?')) return jsonResponse({ data: [] });
  if (url.startsWith('/api/student-progress/44?')) return jsonResponse({
    progress: {
      student_id: 44,
      student_name: 'Ava Santos',
    },
    analysis: {
      recommendations: ['Practice fractions for Ava.'],
    },
    analyticsReadiness: {
      aiIntegration: { ready: true },
    },
  });
  if (url.startsWith('/api/student-progress/45?')) return jsonResponse({
    progress: {
      student_id: 45,
      student_name: 'Noah Santos',
    },
    analysis: {
      recommendations: ['Practice shapes for Noah.'],
    },
    analyticsReadiness: {
      aiIntegration: { ready: true },
    },
  });
  if (url.includes('/quizzes?')) return jsonResponse({ data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  if (url.includes('/topics?')) return jsonResponse([]);
  throw new Error(`Unexpected URL: ${url}`);
};

describe('ParentChildProgress child selection and game warnings', () => {
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
    localStorage.setItem('token', 'parent-analytics-token');
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

  test('skips the child selector when the parent has one linked child', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [{
        id: 44,
        game_student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
        total_quizzes: 0,
      }],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('Student ID');
    expect(container.textContent).toContain('001234');
    expect(container.textContent).toContain('Quiz Sessions');
    expect(container.textContent).toContain('No game progress data available yet.');
    expect(container.textContent).not.toContain('My Children');
    expect(mockNavigate).not.toHaveBeenCalledWith('/login');
    expect(global.fetch.mock.calls.every(([, options]) => (
      options?.headers?.Authorization === 'Bearer parent-analytics-token'
    ))).toBe(true);
  });

  test('shows the selector first when the parent has multiple linked children', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [
        { id: 44, student_name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' },
        { id: 45, student_name: 'Noah Santos', grade_level: 'Grade 1', section: 'Section B' },
      ],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('My Children');
    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('Noah Santos');
    expect(container.textContent).not.toContain('Quiz Sessions');
  });

  test('orders multiple child selectors alphabetically by child name', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [
        { id: 45, student_name: 'Noah Santos', grade_level: 'Grade 1', section: 'Section B' },
        { id: 44, student_name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' },
      ],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    const childButtons = Array.from(container.querySelectorAll('.child-selector-card'));
    expect(childButtons.map((button) => button.querySelector('strong')?.textContent)).toEqual(['Ava Santos', 'Noah Santos']);
  });

  test('shows the unlinked game session warning from the parent children response', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [{
        id: 44,
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
      }],
      unlinked_count: 2,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('Some game sessions could not be matched to a child profile.');
    expect(container.textContent).toContain('Please contact the school admin.');
  });

  test('shows recommendations for only the selected child', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [ {
        id: 44,
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
      } ],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('Practice fractions for Ava.');
    expect(container.textContent).not.toContain('Practice shapes for Noah.');
  });

  test('loads only the chosen child after the parent selects from multiple children', async () => {
    const fetchedUrls = [];
    global.fetch = jest.fn((url) => {
      fetchedUrls.push(url);
      return successPayloadForUrl(url, {
        children: [
          { id: 44, game_student_id: '001234', student_name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' },
          { id: 45, game_student_id: '001245', student_name: 'Noah Santos', grade_level: 'Grade 1', section: 'Section B' },
        ],
        unlinked_count: 0,
      });
    });

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    const noahButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Noah Santos'));

    await act(async () => {
      noahButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Noah Santos');
    expect(container.textContent).toContain('Student ID');
    expect(container.textContent).toContain('001245');
    expect(fetchedUrls.some((url) => url.startsWith('/api/parent/children/45/quizzes?'))).toBe(true);
    expect(fetchedUrls.some((url) => url.startsWith('/api/parent/children/44/quizzes?'))).toBe(false);
  });
});
