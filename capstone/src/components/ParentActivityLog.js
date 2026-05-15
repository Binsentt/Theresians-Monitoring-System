import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import ActivityLog from './ActivityLog';
import logoImage from '../assets/images/STS_Logo.png';
import { normalizeRole } from './manageUsers.utils';
import '../styles/activitylog.css';

export default function ParentActivityLog() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      try {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (!loggedInUser || normalizeRole(loggedInUser.role) !== 'parent' || !loggedInUser.id) {
          navigate('/login');
          return;
        }

        setUser({ ...loggedInUser, role: normalizeRole(loggedInUser.role) });
        setLoading(false);
      } catch (error) {
        console.error('Error loading data:', error);
        setLoading(false);
      }
    };
    loadData();
  }, [navigate]);

  const handleSidebarSelection = (key) => {
    switch (key) {
      case 'dashboard':
        navigate('/parent-dashboard');
        break;
      case 'child-progress':
        navigate('/parent/child-progress');
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
          role="parent"
          activeItem="activity-log"
          onSelect={handleSidebarSelection}
          logoSrc={logoImage}
          portalLabel="Parent Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div>
              <h1>Activity Log</h1>
              <p>View your child's gameplay sessions and engagement metrics</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection contentClassName="activity-log-section-shell">
              <ActivityLog
                role="parent"
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
