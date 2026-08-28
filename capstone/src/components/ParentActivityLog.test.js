import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ParentActivityLog from './ParentActivityLog';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div data-testid="dashboard">{main}</div>,
  MainContent: ({ children }) => <div>{children}</div>,
  TopBar: ({ children }) => <div>{children}</div>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children }) => <div>{children}</div>,
}));

jest.mock('./layout/AnalyticsSidebar', () => ({ role }) => <div data-testid="sidebar">{role}</div>);
jest.mock('./ActivityLog', () => (props) => (
  <div data-testid="activity-log">ActivityLog role:{props.role} user:{props.userId}</div>
));
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

describe('ParentActivityLog parent scope access', () => {
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
  });

  test('keeps a Parent/Teacher in the parent-scoped child activity view', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 20,
      role: 'parent_teacher',
      name: 'Pat Dual',
    }));

    await act(async () => {
      root.render(<ParentActivityLog />);
    });

    expect(mockNavigate).not.toHaveBeenCalledWith('/login');
    expect(container.textContent).toContain('ActivityLog role:parent user:20');
  });
});
