import React, { useState, useEffect } from 'react';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { Card, MetricCard, InfoCard } from './layout/Card';
import { ResponsiveGrid } from './layout/Grid';
import logoImage from '../assets/images/STS_Logo.png';

export default function TeacherDashboard() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    setTimeout(() => {
      setUser({ name: 'Teacher', email: 'teacher@example.com' });
      setLoading(false);
    }, 800);
  }, []);

  if (loading) return <div className="loading-container"><div className="spinner"></div><p>Loading Teacher Portal...</p></div>;

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar 
          role="teacher" 
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
              <p>Welcome, {user?.name}</p>
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
                <SubjectCard title="Mathematics - Grade 9" schedule="Students: 30" prof="Quest Progress: 87%" />
                <SubjectCard title="Mathematics - Grade 10" schedule="Students: 32" prof="Quest Progress: 85%" />
                <SubjectCard title="Mathematics - Grade 11" schedule="Students: 28" prof="Quest Progress: 90%" />
                <SubjectCard title="Mathematics - Grade 12" schedule="Students: 30" prof="Quest Progress: 83%" />
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