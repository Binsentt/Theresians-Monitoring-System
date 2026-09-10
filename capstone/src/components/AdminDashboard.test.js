import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminDashboard from './AdminDashboard';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div data-testid="dashboard">{main}</div>,
  MainContent: ({ children }) => <div>{children}</div>,
  TopBar: ({ children }) => <div>{children}</div>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children, title, actions }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {actions}
      {children}
    </section>
  ),
}));

jest.mock('./layout/Grid', () => ({
  ResponsiveGrid: ({ children }) => <div>{children}</div>,
}));

jest.mock('./layout/Table', () => ({
  DataTable: ({ data = [] }) => <div data-testid="table">{data.map((row) => row.name).join('|')}</div>,
}));

jest.mock('./layout/Card', () => ({
  MetricCard: ({ label, value, footer }) => (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{footer}</small>
    </div>
  ),
  InfoCard: ({ children }) => <div>{children}</div>,
}));

jest.mock('./layout/AnalyticsSidebar', () => ({ role }) => <div data-testid="sidebar">{role}</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

describe('AdminDashboard route protection', () => {
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
      if (String(url).includes('/api/user/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 1, role: ' Admin ', name: 'Admin User' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => [],
      });
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
  });

  test('renders for authenticated admin sessions even when role casing or spacing differs', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: ' Admin ', name: 'Admin User' }));

    await act(async () => {
      root.render(<AdminDashboard />);
    });

    expect(mockNavigate).not.toHaveBeenCalledWith('/login');
    expect(container.textContent).toContain('Admin Dashboard');
  });

  test('loads the secured account summary with the existing session header', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    localStorage.setItem('rememberToken', 'admin-dashboard-token');

    await act(async () => {
      root.render(<AdminDashboard />);
    });

    const accountsRequest = global.fetch.mock.calls.find(([url]) => String(url).endsWith('/api/accounts'));
    expect(accountsRequest).toBeTruthy();
    expect(accountsRequest[1].headers.Authorization).toBe('Bearer admin-dashboard-token');
  });

  test('uses one search with paginated recent-user rows and renders durable server-session presence', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/user/')) return Promise.resolve({ ok: true, json: async () => ({ id: 1, role: 'admin' }) });
      if (String(url).includes('/api/admin/presence')) return Promise.resolve({
        ok: true,
        json: async () => ({
          online_now: { total: 3, teachers: 2, parents: 2, parent_teachers: 1 },
          freshness_ttl_seconds: 75,
        }),
      });
      return Promise.resolve({
        ok: true,
        json: async () => Array.from({ length: 11 }, (_, index) => ({
          id: index + 2,
          name: `Account ${String(index + 1).padStart(2, '0')}`,
          email: `account${index + 1}@example.com`,
          role: index % 2 ? 'teacher' : 'parent',
        })),
      });
    });

    await act(async () => root.render(<AdminDashboard />));

    expect(container.querySelectorAll('input[type="search"]')).toHaveLength(1);
    expect(container.textContent).toContain('Page 1 of 3');
    expect(container.textContent).toContain('Registered / Enabled');
    expect(container.textContent).toContain('Online Now');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('2 teachers');
    expect(container.textContent).toContain('2 parents');
    expect(container.textContent).not.toContain('Unavailable');
    expect(container.textContent).not.toContain('Account 01');
    expect(container.textContent).toContain('Account 11');

    const search = container.querySelector('input[type="search"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Account 01 parent');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('Account 01');
    expect(container.textContent).toContain('Page 1 of 1');
  });

  test('keeps an honest unavailable state when presence retrieval fails', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/user/')) return Promise.resolve({ ok: true, json: async () => ({ id: 1, role: 'admin' }) });
      if (String(url).includes('/api/admin/presence')) return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) });
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    await act(async () => root.render(<AdminDashboard />));

    expect(container.textContent).toContain('Online Now');
    expect(container.textContent).toContain('Unavailable');
    expect(container.textContent).toContain('Presence could not be retrieved');
  });
});
