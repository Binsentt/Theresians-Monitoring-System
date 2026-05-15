import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

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
import ManageUsers from './components/ManageUsers';
import HomePageScreen from './components/HomePageScreen';
import ResetPassword from './components/ResetPassword';
import LoginScreen from './components/LoginScreen';
import LessonQuestionManager from './components/LessonQuestionManager';
import SettingsScreen from './components/SettingsScreen';

import './styles/Login.css';
import './styles/homePageStyles.css';
import './styles/resetpassword.css';
import './styles/parentdashboard.css';
import './styles/teacherdashboard.css';
import './styles/admindashboard.css';
import './styles/settings.css';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePageScreen />} />
        <Route path="/login" element={<LoginScreen />} />
        
        {/* Admin Routes */}
        <Route path="/admin-dashboard" element={<AdminDashboard />} />
        <Route path="/admin/student-progress" element={<AdminStudentProgress />} />
        <Route path="/admin/student-progress/:studentId" element={<StudentAnalytics />} />
        <Route path="/admin/top-achievers" element={<AdminTopAchievers />} />
        <Route path="/admin/activity-log" element={<AdminActivityLog />} />
        
        {/* Teacher Routes */}
        <Route path="/teacher-dashboard" element={<TeacherDashboard />} />
        <Route path="/teacher/student-progress" element={<TeacherStudentProgress />} />
        <Route path="/teacher/student-progress/:studentId" element={<StudentAnalytics />} />
        <Route path="/teacher/top-achievers" element={<TeacherTopAchievers />} />
        <Route path="/teacher/activity-log" element={<TeacherActivityLog />} />
        <Route path="/lesson-question-manager" element={<LessonQuestionManager />} />
        
        {/* Parent Routes */}
        <Route path="/parent-dashboard" element={<ParentDashboard />} />
        <Route path="/parent/child-progress" element={<ParentChildProgress />} />
        <Route path="/parent/activity-log" element={<ParentActivityLog />} />
        
        {/* Common Routes */}
        <Route path="/manage-users" element={<ManageUsers />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/settings" element={<SettingsScreen />} />
        
        {/* Legacy Routes (backward compatibility) */}
        <Route path="/student-progress" element={<AdminStudentProgress />} />
        <Route path="/student-progress/:studentId" element={<StudentAnalytics />} />
      </Routes>
    </Router>
  );
}

export default App;
