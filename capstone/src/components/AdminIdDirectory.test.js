import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminIdDirectory from './AdminIdDirectory';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div data-testid="dashboard">{main}</div>,
  MainContent: ({ children }) => <main>{children}</main>,
  TopBar: ({ children }) => <header>{children}</header>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children, title, actions }) => (
    <section>
      <h2>{title}</h2>
      {actions}
      {children}
    </section>
  ),
}));

jest.mock('./layout/AnalyticsSidebar', () => ({ activeItem }) => <div data-testid="sidebar">{activeItem}</div>);
jest.mock('./layout/DashboardLoadingShell', () => () => <div>Loading...</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const directoryPayload = {
  students: [{
    id: 20,
    student_id: '00123456',
    student_name: 'Ana Santos',
    grade_level: 'Grade 4',
    section: 'St. Anne',
    parent_name: 'Paula Santos',
    parent_relationship: 'Parent',
    status: 'Active',
    is_archived: false,
    created_at: '2025-01-02T00:00:00.000Z',
  }],
  teachers: [{
    id: 21,
    teacher_id: 'T-1001',
    teacher_name: 'Maria Cruz',
    email: 'maria@example.com',
    role: 'parent_teacher',
    status: 'Offline',
    is_archived: false,
    created_at: '2025-01-03T00:00:00.000Z',
  }],
};

const setInputValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('Admin ID Directory', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    localStorage.setItem('rememberToken', 'admin-token');
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => directoryPayload,
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('loads authoritative Student and Teacher rows with the admin-only endpoint', async () => {
    await act(async () => root.render(<AdminIdDirectory />));

    expect(global.fetch.mock.calls[0][0]).toContain('/api/admin/id-directory?archived=false');
    expect(container.textContent).toContain('00123456');
    expect(container.textContent).toContain('Paula Santos (Parent)');
    expect(container.querySelector('table[aria-label="Student ID Directory"]')).not.toBeNull();
    expect(container.querySelector('table[aria-label="Teacher ID Directory"]')).toBeNull();

    const teacherTab = Array.from(container.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === 'Teachers');
    await act(async () => teacherTab.click());

    expect(container.textContent).toContain('T-1001');
    expect(container.textContent).toContain('Parent/Teacher');
    expect(container.querySelector('table[aria-label="Teacher ID Directory"]')).not.toBeNull();
  });

  test('filters rows immediately without changing the source records', async () => {
    await act(async () => root.render(<AdminIdDirectory />));
    const idFilter = container.querySelector('[aria-label="Student ID filters"] input');

    await act(async () => setInputValue(idFilter, 'not-found'));

    expect(container.textContent).toContain('No student IDs match the current filters.');
  });

  test('refreshes from the authoritative source when the page regains focus', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => directoryPayload })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...directoryPayload, students: [{ ...directoryPayload.students[0], student_name: 'New Child' }] }),
      });
    await act(async () => root.render(<AdminIdDirectory />));

    await act(async () => window.dispatchEvent(new Event('focus')));

    expect(container.textContent).toContain('New Child');
  });

  test('uses the existing archive lifecycle slice without changing account status data', async () => {
    await act(async () => root.render(<AdminIdDirectory />));
    const archiveToggle = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Show Archived');

    await act(async () => archiveToggle.click());

    expect(global.fetch.mock.calls.at(-1)[0]).toContain('/api/admin/id-directory?archived=true');
  });

  test('redirects non-admin sessions before showing directory data', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 2, role: 'teacher' }));
    await act(async () => root.render(<AdminIdDirectory />));

    expect(mockNavigate).toHaveBeenCalledWith('/login');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
