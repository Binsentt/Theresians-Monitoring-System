import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TeacherActivityLog from './TeacherActivityLog';

const mockNavigate = jest.fn();
const mockResolveAuthorizedSession = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./session.utils', () => ({
  resolveAuthorizedSession: (...args) => mockResolveAuthorizedSession(...args),
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div data-testid="dashboard">{main}</div>,
  MainContent: ({ children }) => <div>{children}</div>,
  TopBar: ({ children }) => <div>{children}</div>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children }) => <div>{children}</div>,
}));

jest.mock('./layout/AnalyticsSidebar', () => () => <div data-testid="sidebar">Sidebar</div>);
jest.mock('./ActivityLog', () => (props) => (
  <div data-testid="activity-log">ActivityLog user:{props.userId ?? 'none'}</div>
));
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

describe('TeacherActivityLog teacher-only route guard', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    mockResolveAuthorizedSession.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('does not redirect to login when teacher session resolves during hydration', async () => {
    mockResolveAuthorizedSession.mockReturnValue({
      id: 42,
      role: 'teacher',
      name: 'Teacher Cruz',
    });

    await act(async () => {
      root.render(<TeacherActivityLog />);
    });

    expect(mockResolveAuthorizedSession).toHaveBeenCalledWith('teacher');
    expect(mockNavigate).not.toHaveBeenCalledWith('/login');
    expect(container.textContent).toContain('ActivityLog user:42');
  });
});
