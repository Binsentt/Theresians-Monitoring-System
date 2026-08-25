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
    expect(global.fetch.mock.calls[0][0]).toContain('lifecycle=active');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer remember-token');
    expect(container.textContent).toContain('Screen Time Monitoring');
    expect(container.textContent).toContain('Parent ID');
    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('30 min');
    expect(container.textContent).toContain('Completed');
    expect(container.querySelector('button[aria-label="Print Filtered Report"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Print Student Record"]')).not.toBeNull();
    const reportToolbar = container.querySelector('.screen-time-results');
    const tableWrapper = container.querySelector('.screen-time-table-wrap');
    expect(reportToolbar).not.toBeNull();
    expect(tableWrapper).not.toBeNull();
    expect(reportToolbar).not.toBe(tableWrapper);
    expect(reportToolbar.querySelector('button[aria-label="Print Filtered Report"]')).not.toBeNull();
    const report = container.querySelector('.printable-table-report');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(Array.from(report.querySelectorAll('th')).map((header) => header.textContent)).not.toContain('Parent ID');
  });

  test('defaults to active Students and can request archived Screen Time history without changing the authorised endpoint', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    localStorage.setItem('rememberToken', 'remember-token');
    global.fetch = jest.fn(() => jsonResponse(playtimePayload));

    act(() => {
      root.render(<ScreenTimeMonitoring mode="all" />);
    });
    await waitForContent(container, 'Ava Santos');

    const viewSelect = Array.from(container.querySelectorAll('select')).find((select) => select.value === 'active' && select.textContent.includes('Archived History'));
    await act(async () => {
      viewSelect.value = 'archived';
      viewSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForContent(container, 'Ava Santos');

    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/api/playtime?') && String(url).includes('lifecycle=archived'))).toBe(true);
  });

  test('paginates the authorised Screen Time records after server filtering', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    localStorage.setItem('rememberToken', 'remember-token');
    global.fetch = jest.fn(() => jsonResponse({
      data: Array.from({ length: 10 }, (_, index) => ({
        ...playtimePayload.data[0],
        id: index + 10,
        student_name: `Student ${index + 1}`,
        game_student_id: index === 0 ? '001234' : String(100000 + index),
      })),
      pagination: { page: 1, limit: 10, total: 11, pages: 2 },
    }));

    act(() => {
      root.render(<ScreenTimeMonitoring mode="all" />);
    });
    await waitForContent(container, 'Student 1');

    expect(container.querySelectorAll('.screen-time-table tbody tr')).toHaveLength(10);
    expect(container.textContent).toContain('Page 1 of 2');
  });

  test('prepares the full authorised filtered dataset without changing the visible page', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    localStorage.setItem('rememberToken', 'remember-token');
    const allRecords = Array.from({ length: 11 }, (_, index) => ({
      ...playtimePayload.data[0],
      id: index + 1,
      student_name: `Student ${index + 1}`,
      game_student_id: String(100000 + index),
    }));
    global.fetch = jest.fn((url) => jsonResponse({
      data: String(url).includes('limit=200') ? allRecords : allRecords.slice(0, 10),
      pagination: String(url).includes('limit=200')
        ? { page: 1, limit: 200, total: 11, pages: 1 }
        : { page: 1, limit: 10, total: 11, pages: 2 },
    }));
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});

    act(() => {
      root.render(<ScreenTimeMonitoring mode="all" />);
    });
    await waitForContent(container, 'Student 1');

    await act(async () => {
      container.querySelector('button[aria-label="Print Filtered Report"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitForContent(container, 'Student 11');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelectorAll('.screen-time-table tbody tr')).toHaveLength(10);
    expect(container.querySelectorAll('.printable-table-report tbody tr')).toHaveLength(11);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('limit=200'))).toBe(true);
    expect(printSpy).toHaveBeenCalledTimes(1);
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

  test('sorts students by name and does not render Auto Save as a monitoring status', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    localStorage.setItem('rememberToken', 'remember-token');
    global.fetch = jest.fn(() => jsonResponse({
      data: [
        { ...playtimePayload.data[0], id: 6, student_name: 'Noah Santos', child_name: 'Noah Santos', status: 'Auto Saved' },
        { ...playtimePayload.data[0], id: 7, student_name: 'Ava Santos', child_name: 'Ava Santos', status: 'Playing' },
      ],
      pagination: { page: 1, limit: 20, total: 2, pages: 1 },
    }));

    act(() => {
      root.render(<ScreenTimeMonitoring mode="all" />);
    });
    await waitForContent(container, 'Noah Santos');

    expect(global.fetch.mock.calls[0][0]).toContain('sort_by=student_name');
    expect(global.fetch.mock.calls[0][0]).not.toContain('sort_order=');
    expect(container.textContent).not.toContain('Order');
    expect(container.textContent).not.toContain('Ascending');
    expect(container.textContent).not.toContain('Descending');
    const dataRows = Array.from(container.querySelectorAll('.screen-time-table tbody tr'));
    expect(dataRows.map((row) => row.children[1]?.textContent)).toEqual(['Ava Santos', 'Noah Santos']);
    expect(container.textContent).not.toContain('Auto Saved');
    expect(container.textContent).not.toContain('Auto Save');
    expect(container.textContent).toContain('Completed');
  });
});
