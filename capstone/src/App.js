import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';

import AdminDashboard from './components/AdminDashboard';
import AdminStudentProgress from './components/AdminStudentProgress';
import AdminTopAchievers from './components/AdminTopAchievers';
import AdminActivityLog from './components/AdminActivityLog';
import TeacherDashboard from './components/TeacherDashboard';
import TeacherStudentProgress from './components/TeacherStudentProgress';
import TeacherTopAchievers from './components/TeacherTopAchievers';
import TeacherActivityLog from './components/TeacherActivityLog';
import ParentDashboard from './components/ParentDashboard';
import ParentChildProgress from './components/ParentChildProgress';
import ParentActivityLog from './components/ParentActivityLog';
import StudentAnalytics from './components/StudentAnalytics';
import ScreenTimeMonitoring from './components/ScreenTimeMonitoring';
import ManageUsers from './components/ManageUsers';
import HomePageScreen from './components/HomePageScreen';
import ResetPassword from './components/ResetPassword';
import LoginScreen from './components/LoginScreen';
import LessonQuestionManager from './components/LessonQuestionManager';
import SettingsScreen from './components/SettingsScreen';
import AnnouncementPage from './components/AnnouncementPage';
import SessionMonitor from './components/SessionMonitor';
import InitialPasswordSetup from './components/InitialPasswordSetup';
import TemporaryPasswordExperience from './components/TemporaryPasswordExperience';
import { apiUrl } from './api';
import { buildAuthHeaders, clearStoredSession } from './components/session.utils';

import './styles/Login.css';
import './styles/homePageStyles.css';
import './styles/resetpassword.css';
import './styles/parentdashboard.css';
import './styles/teacherdashboard.css';
import './styles/admindashboard.css';
import './styles/settings.css';

function DashboardRouteGate() {
  const location = useLocation();
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let active = true;
    const validate = async () => {
      const headers = buildAuthHeaders();
      if (!headers.Authorization) {
        clearStoredSession();
        navigate('/login', { replace: true, state: { sessionExpired: true } });
        return;
      }

      try {
        const response = await fetch(apiUrl('/api/session/validate'), { headers });
        const payload = response.ok ? await response.json() : null;
        if (!response.ok || !payload?.user) {
          clearStoredSession();
          navigate('/login', { replace: true, state: { sessionExpired: true } });
          return;
        }
        localStorage.setItem('loggedInUser', JSON.stringify(payload.user));
        if (active) setAllowed(true);
      } catch (error) {
        if (active) setAllowed(false);
      }
    };

    setAllowed(false);
    validate();
    return () => {
      active = false;
    };
  }, [location.pathname, navigate]);

  return allowed ? (
    <TemporaryPasswordExperience>
      <Outlet />
    </TemporaryPasswordExperience>
  ) : <div className="route-loading" role="status">Loading...</div>;
}

function App() {
  return (
    <Router>
      <SessionMonitor />
      <Routes>
        <Route path="/" element={<HomePageScreen />} />
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/change-password" element={<Navigate to="/login" replace />} />
        <Route path="/initial-password-setup" element={<InitialPasswordSetup />} />

        <Route element={<DashboardRouteGate />}>
          {/* Admin Routes */}
          <Route path="/admin-dashboard" element={<AdminDashboard />} />
          <Route path="/admin/student-progress" element={<AdminStudentProgress />} />
          <Route path="/admin/student-progress/:studentId" element={<StudentAnalytics />} />
          <Route path="/admin/top-achievers" element={<AdminTopAchievers />} />
          <Route path="/admin/screen-time" element={<ScreenTimeMonitoring mode="all" />} />
          <Route path="/admin/activity-log" element={<AdminActivityLog />} />
          <Route path="/admin/announcements" element={<AnnouncementPage mode="admin" />} />

          {/* Teacher Routes */}
          <Route path="/teacher-dashboard" element={<TeacherDashboard />} />
          <Route path="/teacher/student-progress" element={<TeacherStudentProgress />} />
          <Route path="/teacher/student-progress/:studentId" element={<StudentAnalytics />} />
          <Route path="/teacher/top-achievers" element={<TeacherTopAchievers />} />
          <Route path="/teacher/screen-time" element={<ScreenTimeMonitoring mode="all" />} />
          <Route path="/teacher/activity-log" element={<TeacherActivityLog />} />
          <Route path="/teacher/announcements" element={<AnnouncementPage mode="teacher" />} />
          <Route path="/lesson-question-manager" element={<LessonQuestionManager />} />

          {/* Parent Routes */}
          <Route path="/parent-dashboard" element={<ParentDashboard />} />
          <Route path="/parent/child-progress" element={<ParentChildProgress />} />
          <Route path="/parent/screen-time" element={<ScreenTimeMonitoring mode="children" />} />
          <Route path="/parent/activity-log" element={<ParentActivityLog />} />
          <Route path="/parent/announcements" element={<AnnouncementPage mode="parent" />} />

          {/* Common Routes */}
          <Route path="/manage-users" element={<ManageUsers />} />
          <Route path="/settings" element={<SettingsScreen />} />

          {/* Legacy Routes (backward compatibility) */}
          <Route path="/student-progress" element={<AdminStudentProgress />} />
          <Route path="/student-progress/:studentId" element={<StudentAnalytics />} />
        </Route>
        <Route path="/reset-password" element={<ResetPassword />} />
      </Routes>
    </Router>
  );
}

export default App;
