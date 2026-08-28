import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { clearStoredSession } from '../session.utils';
import '../../styles/analyticsSidebar.css';

const IconDashboard = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-17v5h6V3h-6z" />
  </svg>
);

const IconUsers = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V20h14v-3.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 2.07 1.97 3.45V20h6v-3.5c0-2.33-4.67-3.5-7-3.5z" />
  </svg>
);

const IconProgress = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 20h16v-2H4v2zm2-4h12v-2H6v2zm3-4h6V8H9v4z" />
  </svg>
);

const IconAchievers = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2L8 8H4l6 5-2 7 6-4 6 4-2-7 6-5h-4l-4-6z" />
  </svg>
);

const IconActivity = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M13 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-6-6zm1 6h5.5L14 3.5V8z" />
  </svg>
);

const IconAnnouncement = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 10v4h3l5 4V6l-5 4H4zm12.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zm-2.5-9v2.06A7.01 7.01 0 0 1 18 12a7.01 7.01 0 0 1-4 6.94V21a9 9 0 0 0 0-18z" />
  </svg>
);

const IconSettings = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19.14 12.94a7.98 7.98 0 0 0 .06-1 7.98 7.98 0 0 0-.06-1l2.03-1.58a.5.5 0 0 0 .12-.65l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a8.03 8.03 0 0 0-1.73-1l-.36-2.54A.5.5 0 0 0 14.5 2h-4a.5.5 0 0 0-.5.42l-.36 2.54a8.03 8.03 0 0 0-1.73 1l-2.39-.96a.5.5 0 0 0-.61.22L2.81 8.71a.5.5 0 0 0 .12.65L4.96 11a7.98 7.98 0 0 0 0 2l-2.03 1.58a.5.5 0 0 0-.12.65l1.92 3.32c.13.23.39.31.61.22l2.39-.96a8.03 8.03 0 0 0 1.73 1l.36 2.54c.05.28.28.48.56.48h4c.28 0 .51-.2.56-.48l.36-2.54a8.03 8.03 0 0 0 1.73-1l2.39.96c.23.09.49.01.61-.22l1.92-3.32a.5.5 0 0 0-.12-.65l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z" />
  </svg>
);

const IconChild = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-6 9v-1a4 4 0 0 1 4-4h2v-1a5 5 0 0 1 10 0v1h2a4 4 0 0 1 4 4v1H6z" />
  </svg>
);

const IconLogout = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 17v-2h4V9h-4V7h6v10h-6zm-2 4H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3v2H5v14h3v2zm8.6-5.4L15.2 14.2 17.4 12l-2.2-2.2 1.4-1.4L21.2 13l-4.6 4.6z" />
  </svg>
);

const getActiveKey = (item, activeItem, pathname) => {
  if (item.key === activeItem || item.actionKey === activeItem) return true;
  if (item.route && pathname.startsWith(item.route)) return true;
  return false;
};

const sidebarItems = {
  admin: [
    { key: 'dashboard', label: 'Dashboard', icon: <IconDashboard />, actionKey: 'dashboard', route: '/admin-dashboard' },
    { key: 'student-progress', label: 'Student Progress', icon: <IconProgress />, route: '/admin/student-progress' },
    { key: 'manage-users', label: 'Manage Users', icon: <IconUsers />, route: '/manage-users' },
    { key: 'learning-manager', label: 'Lesson & Question Manager', icon: <IconActivity />, route: '/lesson-question-manager' },
    { key: 'announcements', label: 'Announcements', icon: <IconAnnouncement />, route: '/admin/announcements' },
    { key: 'top-achievers', label: 'Top Achievers', icon: <IconAchievers />, route: '/admin/top-achievers' },
    { key: 'screen-time', label: 'Screen Time Monitoring', icon: <IconActivity />, route: '/admin/screen-time' },
    { key: 'activity-log', label: 'Activity Log', icon: <IconActivity />, route: '/admin/activity-log' },
    { key: 'settings', label: 'Settings', icon: <IconSettings />, route: '/settings' },
    { key: 'logout', label: 'Logout', icon: <IconLogout />, actionKey: 'logout' },
  ],
  teacher: [
    { key: 'dashboard', label: 'Dashboard', icon: <IconDashboard />, actionKey: 'dashboard', route: '/teacher-dashboard' },
    { key: 'student-progress', label: 'Student Progress', icon: <IconProgress />, route: '/teacher/student-progress' },
    { key: 'learning-manager', label: 'Lesson & Question Manager', icon: <IconActivity />, route: '/lesson-question-manager' },
    { key: 'announcements', label: 'Announcements', icon: <IconAnnouncement />, route: '/teacher/announcements' },
    { key: 'top-achievers', label: 'Top Achievers', icon: <IconAchievers />, route: '/teacher/top-achievers' },
    { key: 'screen-time', label: 'Screen Time Monitoring', icon: <IconActivity />, route: '/teacher/screen-time' },
    { key: 'activity-log', label: 'Activity Log', icon: <IconActivity />, route: '/teacher/activity-log' },
    { key: 'settings', label: 'Settings', icon: <IconSettings />, route: '/settings' },
    { key: 'logout', label: 'Logout', icon: <IconLogout />, actionKey: 'logout' },
  ],
  parent: [
    { key: 'dashboard', label: 'Dashboard', icon: <IconDashboard />, actionKey: 'dashboard', route: '/parent-dashboard' },
    { key: 'child-progress', label: 'Child Progress', icon: <IconChild />, route: '/parent/child-progress' },
    { key: 'my-child-screen-time', label: 'My Child Screen Time', icon: <IconActivity />, route: '/parent/screen-time' },
    { key: 'announcements', label: 'Announcements', icon: <IconAnnouncement />, route: '/parent/announcements' },
    { key: 'activity-log', label: 'Activity Log', icon: <IconActivity />, route: '/parent/activity-log' },
    { key: 'settings', label: 'Settings', icon: <IconSettings />, route: '/settings' },
    { key: 'logout', label: 'Logout', icon: <IconLogout />, actionKey: 'logout' },
  ],
  parent_teacher: [
    { key: 'teacher-dashboard', scope: 'teacher', label: 'Teacher Dashboard', icon: <IconDashboard />, route: '/teacher-dashboard' },
    { key: 'student-progress', scope: 'teacher', label: 'Student Progress', icon: <IconProgress />, route: '/teacher/student-progress' },
    { key: 'learning-manager', scope: 'teacher', label: 'Lesson & Question Manager', icon: <IconActivity />, route: '/lesson-question-manager' },
    { key: 'teacher-announcements', scope: 'teacher', label: 'Teacher Announcements', icon: <IconAnnouncement />, route: '/teacher/announcements' },
    { key: 'top-achievers', scope: 'teacher', label: 'Top Achievers', icon: <IconAchievers />, route: '/teacher/top-achievers' },
    { key: 'teacher-screen-time', scope: 'teacher', label: 'Teacher Screen Time', icon: <IconActivity />, route: '/teacher/screen-time' },
    { key: 'teacher-activity-log', scope: 'teacher', label: 'Teacher Activity Log', icon: <IconActivity />, route: '/teacher/activity-log' },
    { key: 'parent-dashboard', scope: 'parent', label: 'Parent Dashboard', icon: <IconDashboard />, route: '/parent-dashboard' },
    { key: 'child-progress', scope: 'parent', label: 'Child Progress', icon: <IconChild />, route: '/parent/child-progress' },
    { key: 'parent-screen-time', scope: 'parent', label: 'Parent Screen Time', icon: <IconActivity />, route: '/parent/screen-time' },
    { key: 'parent-announcements', scope: 'parent', label: 'Parent Announcements', icon: <IconAnnouncement />, route: '/parent/announcements' },
    { key: 'parent-activity-log', scope: 'parent', label: 'Parent Activity', icon: <IconActivity />, route: '/parent/activity-log' },
    { key: 'settings', label: 'Settings', icon: <IconSettings />, route: '/settings' },
    { key: 'logout', label: 'Logout', icon: <IconLogout />, actionKey: 'logout' },
  ],
};

const normalizeSidebarRole = (role) => {
  const roleValue = String(role || 'admin').trim().toLowerCase();
  return ['parent/teacher', 'parent teacher', 'parent-teacher'].includes(roleValue) ? 'parent_teacher' : roleValue;
};

export const getParentTeacherNavigationScope = (pathname = '') => (
  String(pathname).startsWith('/parent') ? 'parent' : 'teacher'
);

export const getSidebarItemsForRole = (role, parentTeacherScope = 'teacher') => {
  const normalizedRole = normalizeSidebarRole(role);
  if (normalizedRole !== 'parent_teacher') {
    return sidebarItems[normalizedRole] || sidebarItems.admin;
  }

  const activeScope = parentTeacherScope === 'parent' ? 'parent' : 'teacher';
  const scopedItems = sidebarItems.parent_teacher.filter((item) => item.scope === activeScope);
  const scopeSwitch = activeScope === 'parent'
    ? { key: 'switch-to-teacher-dashboard', label: 'Teacher Dashboard', icon: <IconDashboard />, route: '/teacher-dashboard' }
    : { key: 'switch-to-parent-dashboard', label: 'Parent Dashboard', icon: <IconDashboard />, route: '/parent-dashboard' };
  const commonItems = sidebarItems.parent_teacher.filter((item) => !item.scope);

  return [...scopedItems, scopeSwitch, ...commonItems];
};

const RESPONSIVE_SIDEBAR_MAX_WIDTH = 991;

export default function AnalyticsSidebar({ role = 'admin', activeItem, onSelect, logoSrc, portalLabel = 'Portal' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= RESPONSIVE_SIDEBAR_MAX_WIDTH);

  useEffect(() => {
    const handleResize = () => {
      const nextIsMobile = window.innerWidth <= RESPONSIVE_SIDEBAR_MAX_WIDTH;
      setIsMobile(nextIsMobile);
      if (!nextIsMobile) {
        setIsOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const items = useMemo(() => {
    const parentTeacherScope = normalizeSidebarRole(role) === 'parent_teacher'
      ? getParentTeacherNavigationScope(location.pathname)
      : undefined;
    return getSidebarItemsForRole(role, parentTeacherScope);
  }, [location.pathname, role]);

  const handleClick = (item) => {
    if (item.actionKey === 'logout') {
      clearStoredSession();
      navigate('/');
      if (isMobile) {
        setIsOpen(false);
      }
      return;
    }

    if (item.route) {
      navigate(item.route);
    }
    if (item.actionKey && typeof onSelect === 'function') {
      onSelect(item.actionKey);
    }
    if (isMobile) {
      setIsOpen(false);
    }
  };

  return (
    <div className={`analytics-sidebar-root ${isOpen ? 'open' : ''}`}>
      <div className="analytics-sidebar-toggle">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          className="analytics-sidebar-hamburger"
          aria-label="Toggle navigation"
        >
          <span className="hamburger-line" />
          <span className="hamburger-line" />
          <span className="hamburger-line" />
        </button>
      </div>

      <aside className="analytics-sidebar-panel">
        <div className="analytics-sidebar-brand">
          <div className="analytics-logo-circle">
            {logoSrc ? <img src={logoSrc} alt="Brand logo" /> : <span className="logo-placeholder" />}
          </div>
          <div className="analytics-brand-text">
            <div className="analytics-brand-title">ST. THERESE</div>
            <div className="analytics-brand-subtitle">{portalLabel}</div>
          </div>
        </div>

        <nav className="analytics-sidebar-nav">
          {items.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`analytics-sidebar-item ${item.key === 'logout' ? 'logout' : ''} ${getActiveKey(item, activeItem, location.pathname) ? 'active' : ''}`}
              onClick={() => handleClick(item)}
            >
              <span className="analytics-sidebar-item-icon">{item.icon}</span>
              <span className="analytics-sidebar-item-label">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      {isMobile && isOpen && <div className="analytics-sidebar-backdrop" onClick={() => setIsOpen(false)} />}
    </div>
  );
}
