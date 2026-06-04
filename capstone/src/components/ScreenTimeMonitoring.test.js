import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ScreenTimeMonitoring from './ScreenTimeMonitoring';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div>{main}</div>,
  MainContent: ({ children }) => <div>{children}</div>,
  TopBar: ({ children }) => <div>{children}</div>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children }) => <section>{children}</section>,
}));

jest.mock('./layout/AnalyticsSidebar', () => ({ activeItem, role }) => (
  <div data-testid="sidebar">{role}:{activeItem}</div>
));
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const jsonResponse = (payload) => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => payload,
});

const playtimePayload = {
  data: [{
    id: 5,
    student_id: 44,
    parent_id: '123456',
    student_name: 'Ava Santos',
    child_name: 'Ava Santos',
    grade_level: 'Grade 3',
    section: 'Section A',
    date_played: '2026-06-01',
    start_time: '2026-06-01T09:00:00.000Z',
    end_time: '2026-06-01T09:30:00.000Z',
    total_playtime_minutes: 30,
    status: 'Completed',
  }],
  pagination: { page: 1, limit: 20, total: 1, pages: 1 },
};

const waitForContent = async (container, text) => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (container.textContent.includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for ${text}`);
};

describe('ScreenTimeMonitoring', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
  });

  test('admin all-student view fetches Screen Time Monitoring with parent IDs visible', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    localStorage.setItem('rememberToken', 'remember-token');
    global.fetch = jest.fn(() => jsonResponse(playtimePayload));

    act(() => {
      root.render(<ScreenTimeMonitoring mode="all" />);
    });
    await waitForContent(container, 'Ava Santos');

    expect(global.fetch.mock.calls[0][0]).toContain('/api/playtime?');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer remember-token');
    expect(container.textContent).toContain('Screen Time Monitoring');
    expect(container.textContent).toContain('Parent ID');
    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('30 min');
    expect(container.textContent).toContain('Completed');
  });

  test('parent child-only view fetches My Child Screen Time without exposing parent ID column', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 19, role: 'parent', name: 'Parent User' }));
    localStorage.setItem('rememberToken', 'remember-token');
    global.fetch = jest.fn(() => jsonResponse(playtimePayload));

    act(() => {
      root.render(<ScreenTimeMonitoring mode="children" />);
    });
    await waitForContent(container, 'Ava Santos');

    expect(global.fetch.mock.calls[0][0]).toContain('/api/playtime/my-children?');
    expect(container.textContent).toContain('My Child Screen Time');
    expect(container.textContent).toContain('Child Name');
    expect(container.textContent).not.toContain('Parent ID');
    expect(container.textContent).toContain('Ava Santos');
  });

  test('parent sessions cannot open the all-student screen time view', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 19, role: 'parent', name: 'Parent User' }));
    global.fetch = jest.fn(() => jsonResponse(playtimePayload));

    act(() => {
      root.render(<ScreenTimeMonitoring mode="all" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
