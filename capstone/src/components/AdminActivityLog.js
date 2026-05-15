import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import ActivityLog from './ActivityLog';
import logoImage from '../assets/images/STS_Logo.png';
import '../styles/activitylog.css';

export default function AdminActivityLog() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      try {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (!loggedInUser || loggedInUser.role !== 'admin') {
          navigate('/login');
          return;
        }

        setUser(loggedInUser);
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
        navigate('/admin-dashboard');
        break;
      case 'student-progress':
        navigate('/admin/student-progress');
        break;
      case 'manage-users':
        navigate('/manage-users');
        break;
      case 'top-achievers':
        navigate('/admin/top-achievers');
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
          role="admin"
          activeItem="activity-log"
          onSelect={handleSidebarSelection}
          logoSrc={logoImage}
          portalLabel="Admin Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div>
              <h1>Activity Log</h1>
              <p>Monitor all student gameplay sessions and engagement metrics</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection contentClassName="activity-log-section-shell">
              <ActivityLog
                role="admin"
                limit={100}
              />
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
