import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { Card, MetricCard, InfoCard } from './layout/Card';
import { ResponsiveGrid } from './layout/Grid';
import logoImage from '../assets/images/STS_Logo.png';
import { normalizeRole } from './manageUsers.utils';
import { resolveAuthorizedSession } from './session.utils';

export default function TeacherDashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const loadData = async () => {
      try {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        const authorizedUser = resolveAuthorizedSession('teacher');
        if (!authorizedUser) {
          navigate('/login');
          return;
        }
        setUser(authorizedUser);
      } catch (err) {
        console.error('Failed to load teacher dashboard:', err);
        navigate('/login');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [navigate]);

  if (loading) return <div className="loading-container"><div className="spinner"></div><p>Loading Teacher Portal...</p></div>;
  if (!user) return null;

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar 
          role={normalizeRole(user?.role) === 'parent_teacher' ? 'parent_teacher' : 'teacher'} 
          activeItem="dashboard" 
          logoSrc={logoImage}
          portalLabel="Teacher Portal" 
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div>
              <h1>Teacher Dashboard</h1>
              <p>Welcome, {user?.name || 'Teacher'}</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection>
              <ResponsiveGrid>
                <MetricCard
                  label="QUESTS COMPLETED"
                  value="45"
                  footer="This month"
                />
                <MetricCard
                  label="STUDENTS ENGAGED"
                  value="120"
                  footer="Active learners"
                />
                <MetricCard
                  label="ACHIEVEMENTS UNLOCKED"
                  value="28"
                  footer="By students"
                />
              </ResponsiveGrid>
            </ContentSection>

            <ContentSection>
              <InfoCard title="New content available" variant="success">
                <p>Latest Mathematics content is ready for Grade 10. Review student progress and assign the next set of lessons.</p>
              </InfoCard>
            </ContentSection>

            <ContentSection title="Mathematics Subjects">
              <ResponsiveGrid minWidth="300px">
                <SubjectCard title="Mathematics - Grade 2" schedule="Students: 30" prof="Quest Progress: 87%" />
                <SubjectCard title="Mathematics - Grade 4" schedule="Students: 32" prof="Quest Progress: 85%" />
                <SubjectCard title="Mathematics - Grade 4" schedule="Students: 28" prof="Quest Progress: 90%" />
                <SubjectCard title="Mathematics - Grade 6" schedule="Students: 30" prof="Quest Progress: 83%" />
              </ResponsiveGrid>
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}

function SubjectCard({ title, schedule, prof }) {
  return (
    <Card className="subject-card">
      <div className="subject-card-header">
        <h3>{title}</h3>
        <span className="status-tag">Active</span>
      </div>
      <p className="subject-time">{schedule}</p>
      <p className="subject-prof">{prof}</p>
    </Card>
  );
}
