import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AnalyticsSidebar, { getParentTeacherNavigationScope, getSidebarItemsForRole } from './AnalyticsSidebar';

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

    const parentTeacherTeacherLabels = getSidebarItemsForRole('parent_teacher', 'teacher').map((item) => item.label);
    const parentTeacherParentLabels = getSidebarItemsForRole('parent_teacher', 'parent').map((item) => item.label);
    expect(parentTeacherTeacherLabels).toContain('Teacher Screen Time');
    expect(parentTeacherParentLabels).toContain('Parent Screen Time');
  });

  test('Parent/Teacher exposes separate teacher and parent navigation scopes', () => {
    const parentScopeLabels = getSidebarItemsForRole('parent_teacher', 'parent').map((item) => item.label);
    const teacherScopeLabels = getSidebarItemsForRole('Parent/Teacher', 'teacher').map((item) => item.label);

    expect(teacherScopeLabels).toEqual([
      'Teacher Dashboard',
      'Student Progress',
      'Lesson & Question Manager',
      'Teacher Announcements',
      'Top Achievers',
      'Teacher Screen Time',
      'Teacher Activity Log',
      'Parent Dashboard',
      'Settings',
      'Logout',
    ]);
    expect(parentScopeLabels).toEqual([
      'Parent Dashboard',
      'Child Progress',
      'Parent Screen Time',
      'Parent Announcements',
      'Parent Activity',
      'Teacher Dashboard',
      'Settings',
      'Logout',
    ]);
    expect(parentScopeLabels).not.toContain('Lesson & Question Manager');
    expect(teacherScopeLabels).toContain('Lesson & Question Manager');
  });

  test('uses route-derived Parent/Teacher scope so navigation cannot retain the prior portal menu', () => {
    expect(getParentTeacherNavigationScope('/parent-dashboard')).toBe('parent');
    expect(getParentTeacherNavigationScope('/parent/child-progress')).toBe('parent');
    expect(getParentTeacherNavigationScope('/teacher-dashboard')).toBe('teacher');
    expect(getParentTeacherNavigationScope('/lesson-question-manager')).toBe('teacher');
  });

  test('pure Teacher and Parent navigation remains privilege-isolated', () => {
    const teacherRoutes = getSidebarItemsForRole('teacher').map((item) => item.route);
    const parentRoutes = getSidebarItemsForRole('parent').map((item) => item.route);

    expect(teacherRoutes).not.toContain('/parent-dashboard');
    expect(teacherRoutes).not.toContain('/parent/child-progress');
    expect(parentRoutes).not.toContain('/teacher-dashboard');
    expect(parentRoutes).not.toContain('/lesson-question-manager');
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
