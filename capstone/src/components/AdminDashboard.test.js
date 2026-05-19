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
  DataTable: ({ data = [] }) => <div data-testid="table">{data.length}</div>,
}));

jest.mock('./layout/Card', () => ({
  MetricCard: ({ label, value }) => (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
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
});
