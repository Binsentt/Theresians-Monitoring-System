import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AnalyticsSidebar, { getSidebarItemsForRole } from './AnalyticsSidebar';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/admin-dashboard' }),
  useNavigate: () => mockNavigate,
}));

describe('AnalyticsSidebar role items', () => {
  test('Parent/Teacher keeps every teacher module and adds only Child Progress from the parent side', () => {
    const labels = getSidebarItemsForRole('parent_teacher').map((item) => item.label);
    const routes = getSidebarItemsForRole('Parent/Teacher').map((item) => item.route);

    expect(labels).toEqual([
      'Dashboard',
      'Student Progress',
      'Lesson & Question Manager',
      'Announcements',
      'Top Achievers',
      'Activity Log',
      'Child Progress',
      'Settings',
      'Logout',
    ]);
    expect(routes).toContain('/teacher-dashboard');
    expect(routes).toContain('/parent/child-progress');
    expect(routes).not.toContain('/parent-dashboard');
    expect(routes).not.toContain('/parent/announcements');
    expect(routes).not.toContain('/parent/activity-log');
  });

  test('adds Logout as the last sidebar item after Settings for every role', () => {
    ['admin', 'teacher', 'parent', 'parent_teacher'].forEach((role) => {
      const labels = getSidebarItemsForRole(role).map((item) => item.label);
      expect(labels.slice(-2)).toEqual(['Settings', 'Logout']);
    });
  });

  test('Logout clears stored session and returns to the home page', async () => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1 }));
    localStorage.setItem('token', 'token-value');
    mockNavigate.mockReset();

    await act(async () => {
      root.render(<AnalyticsSidebar role="admin" />);
    });

    const logoutButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Logout'
    );

    expect(logoutButton).toBeTruthy();

    await act(async () => {
      logoutButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(localStorage.getItem('loggedInUser')).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
