import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import ActivityLog from './ActivityLog';
import logoImage from '../assets/images/STS_Logo.png';
import { resolveAuthorizedSession } from './session.utils';
import '../styles/activitylog.css';

export default function TeacherActivityLog() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const hydrateSession = () => {
      const savedTheme = localStorage.getItem('theme') || 'light';
      document.documentElement.setAttribute('data-theme', savedTheme);

      const authorizedUser = resolveAuthorizedSession('teacher');
      setUser(authorizedUser);
      setAuthReady(true);
    };

    hydrateSession();
  }, []);

  useEffect(() => {
    if (!authReady) return;

    if (!user) {
      navigate('/login');
      return;
    }

    setLoading(false);
  }, [authReady, navigate, user]);

  const handleSidebarSelection = (key) => {
    switch (key) {
      case 'dashboard':
        navigate('/teacher-dashboard');
        break;
      case 'student-progress':
        navigate('/teacher/student-progress');
        break;
      case 'top-achievers':
        navigate('/teacher/top-achievers');
        break;
      case 'activity-log':
        break; // Already on this page
      case 'settings':
        navigate('/settings');
        break;
      default:
        break;
    }
  };

  if (loading) {
    return (
      <div className="sts-loader-container">
        <div className="sts-spinner"></div>
        <p>Loading Activity Log...</p>
      </div>
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role="teacher"
          activeItem="activity-log"
          onSelect={handleSidebarSelection}
          logoSrc={logoImage}
          portalLabel="Teacher Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div>
              <h1>Activity Log</h1>
              <p>Monitor your students' gameplay sessions and engagement metrics</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection contentClassName="activity-log-section-shell">
              <ActivityLog
                role="teacher"
                userId={user?.id}
                limit={50}
              />
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
