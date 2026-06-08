import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AnalyticsSidebar, { getSidebarItemsForRole } from './AnalyticsSidebar';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/admin-dashboard' }),
  useNavigate: () => mockNavigate,
}));

const setViewportWidth = (width) => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
};

describe('AnalyticsSidebar role items', () => {
  test('adds role-specific screen time navigation entries', () => {
    expect(getSidebarItemsForRole('admin').map((item) => item.label)).toContain('Screen Time Monitoring');
    expect(getSidebarItemsForRole('teacher').map((item) => item.label)).toContain('Screen Time Monitoring');
    expect(getSidebarItemsForRole('parent').map((item) => item.label)).toContain('My Child Screen Time');

    const parentTeacherLabels = getSidebarItemsForRole('parent_teacher').map((item) => item.label);
    expect(parentTeacherLabels).toContain('Screen Time Monitoring');
    expect(parentTeacherLabels).toContain('My Child Screen Time');
  });

  test('Parent/Teacher keeps every teacher module and adds child-only parent views', () => {
    const labels = getSidebarItemsForRole('parent_teacher').map((item) => item.label);
    const routes = getSidebarItemsForRole('Parent/Teacher').map((item) => item.route);

    expect(labels).toEqual([
      'Dashboard',
      'Student Progress',
      'Lesson & Question Manager',
      'Announcements',
      'Top Achievers',
      'Screen Time Monitoring',
      'Activity Log',
      'Child Progress',
      'My Child Screen Time',
      'Settings',
      'Logout',
    ]);
    expect(routes).toContain('/teacher-dashboard');
    expect(routes).toContain('/teacher/screen-time');
    expect(routes).toContain('/parent/child-progress');
    expect(routes).toContain('/parent/screen-time');
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
    localStorage.setItem('rememberToken', 'thirty-day-token');
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
    expect(localStorage.getItem('rememberToken')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('uses tablet overlay navigation at 991px and desktop navigation at 992px', async () => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);

    setViewportWidth(991);
    await act(async () => {
      root.render(<AnalyticsSidebar role="admin" />);
    });

    const toggleButton = container.querySelector('.analytics-sidebar-hamburger');
    expect(toggleButton).toBeTruthy();

    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.analytics-sidebar-backdrop')).toBeTruthy();

    await act(async () => {
      setViewportWidth(992);
      root.render(<AnalyticsSidebar role="admin" />);
    });

    expect(container.querySelector('.analytics-sidebar-backdrop')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
