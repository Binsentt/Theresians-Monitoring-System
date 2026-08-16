import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { MetricCard, InfoCard } from './layout/Card';
import { ResponsiveGrid } from './layout/Grid';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { normalizeRole } from './manageUsers.utils';
import { buildAuthHeaders, getStoredUserSession } from './session.utils';
import { formatPercent, normalizeDisplayList, safeDisplayText, toFiniteNumber } from './studentProgress.utils';
import { apiUrl } from '../api';
import '../styles/parentdashboard.css';

function AchieverCard({ name, grade, quest, score, accuracy }) {
  return (
    <div className="achiever-card">
      <div className="rank-section">
        <div className="rank-number">{grade}</div>
      </div>
      <div className="achiever-info">
        <h4>{safeDisplayText(name, 'Student')}</h4>
        <p>Current quest: {safeDisplayText(quest, 'N/A')}</p>
      </div>
      <div className="achiever-stats">
        <div className="stat-item">
          <div className="stat-value">{safeDisplayText(score, 'N/A')}</div>
          <div className="stat-label">Score</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{formatPercent(accuracy, 'N/A')}</div>
          <div className="stat-label">Accuracy</div>
        </div>
      </div>
    </div>
  );
}

export default function ParentDashboard() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [topAchievers, setTopAchievers] = useState([]);
  const [connectedChildren, setConnectedChildren] = useState([]);
  const [analyticsSummary, setAnalyticsSummary] = useState(null);
  const [analyticsRecommendations, setAnalyticsRecommendations] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    loadUser();
    loadDashboardData();
  }, []);

  const loadUser = async () => {
    try {
      const loggedInUser = localStorage.getItem('loggedInUser');
      if (!loggedInUser) {
        navigate('/login');
        return;
      }

      const userData = JSON.parse(loggedInUser);
      if (!['parent', 'parent_teacher'].includes(normalizeRole(userData.role))) {
        navigate('/login');
        return;
      }

      setUser(userData);
      try {
        const userResponse = await fetch(apiUrl(`/api/user/${userData.id}`), {
          headers: buildAuthHeaders(),
        });
        if (userResponse.ok) {
          const freshUserData = await userResponse.json();
          delete freshUserData.password;
          setUser(freshUserData);
          localStorage.setItem('loggedInUser', JSON.stringify(freshUserData));
        }
      } catch (err) {
        console.error('Failed to refresh user data:', err);
      }
    } catch (e) {
      navigate('/login');
    } finally {
      setLoading(false);
    }
  };

  const loadDashboardData = async () => {
    setDashboardLoading(true);
    try {
      const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
      const requestOptions = { headers: buildAuthHeaders() };
      const [achieversResult, overviewResult, recommendationsResult, childrenResult] = await Promise.allSettled([
        fetch(buildScopedApiUrl('/api/top-achievers', 'parent'), requestOptions),
        fetch(buildScopedApiUrl('/api/analytics/overview', 'parent'), requestOptions),
        fetch(buildScopedApiUrl('/api/analytics/recommendations', 'parent'), requestOptions),
        fetch(buildScopedApiUrl('/api/students/progress', 'parent'), requestOptions),
      ]);

      if (achieversResult.status === 'fulfilled' && achieversResult.value.ok) {
        const achieversData = await achieversResult.value.json();
        setTopAchievers(Array.isArray(achieversData) ? achieversData.slice(0, 4) : []);
      } else {
        setTopAchievers([]);
      }

      if (overviewResult.status === 'fulfilled' && overviewResult.value.ok) {
        const overviewData = await overviewResult.value.json();
        setAnalyticsSummary(overviewData && typeof overviewData === 'object' ? overviewData : null);
      } else {
        setAnalyticsSummary(null);
      }

      if (recommendationsResult.status === 'fulfilled' && recommendationsResult.value.ok) {
        const recommendationsData = await recommendationsResult.value.json();
        setAnalyticsRecommendations(normalizeDisplayList(recommendationsData?.recommendations));
      } else {
        setAnalyticsRecommendations([]);
      }

      if (childrenResult.status === 'fulfilled' && childrenResult.value.ok) {
        const childrenData = await childrenResult.value.json();
        const children = Array.isArray(childrenData)
          ? childrenData
          : Array.isArray(childrenData?.children)
            ? childrenData.children
            : Array.isArray(childrenData?.data)
              ? childrenData.data
              : [];
        setConnectedChildren(children.slice(0, 6));
      } else {
        setConnectedChildren([]);
      }

    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      setError('Unable to load parent analytics at this time.');
    } finally {
      setDashboardLoading(false);
    }
  };

  const handleViewChildProgress = () => {
    navigate('/parent/child-progress');
  };

  if (loading) {
    const loadingRole = normalizeRole(getStoredUserSession()?.role);
    return (
      <DashboardLoadingShell
        role={loadingRole === 'parent_teacher' ? 'parent_teacher' : 'parent'}
        activeItem="dashboard"
        logoSrc={logoImage}
        portalLabel="Parent Portal"
        heading="Parent Dashboard"
        subheading="Your child's learning overview."
      />
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role={normalizeRole(user?.role) === 'parent_teacher' ? 'parent_teacher' : 'parent'}
          activeItem="dashboard"
          logoSrc={logoImage}
          portalLabel="Parent Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div>
              <h1>Parent Dashboard</h1>
              <p>Welcome back, {user?.name || 'Parent'}.</p>
            </div>
            <button type="button" className="btn-primary" onClick={handleViewChildProgress}>
              View Child Progress
            </button>
          </TopBar>

          <PageContent>
            <ContentSection title="Family Progress Overview">
              <ResponsiveGrid>
                <MetricCard
                  label="Tracked Students"
                  value={analyticsSummary?.studentCount ?? '--'}
                  footer="Children under your account"
                />
                <MetricCard
                  label="Average Accuracy"
                  value={formatPercent(analyticsSummary?.averageAccuracy)}
                  footer="Across current courses"
                />
                <MetricCard
                  label="Completion Rate"
                  value={formatPercent(analyticsSummary?.averageProgress)}
                  footer="Average progress"
                />
              </ResponsiveGrid>
            </ContentSection>

            <ContentSection title="Connected Children">
              {dashboardLoading ? (
                <div className="fallback-note">Loading connected children...</div>
              ) : connectedChildren.length === 0 ? (
                <div className="fallback-note">No game progress data available yet.</div>
              ) : (
                <ResponsiveGrid minWidth="260px">
                  {connectedChildren.map((child) => (
                    <InfoCard key={child.id || child.student_id || safeDisplayText(child.student_name, 'student')} title={safeDisplayText(child.student_name || child.name, 'Student')}>
                      <p>Current quest: {safeDisplayText(child.current_quest, 'N/A')}</p>
                      <p>Score: {toFiniteNumber(child.score, 0)}</p>
                      <p>Progress: {formatPercent(child.progress_percentage ?? child.performance_percentage, '0%')}</p>
                      <p>Latest update: {child.last_played ? new Date(child.last_played).toLocaleString() : 'Not available'}</p>
                    </InfoCard>
                  ))}
                </ResponsiveGrid>
              )}
            </ContentSection>

            <ContentSection title="Featured Student Highlights">
              {dashboardLoading ? (
                <div className="fallback-note">Loading highlights...</div>
              ) : topAchievers.length === 0 ? (
                <div className="fallback-note">No recent highlights available.</div>
              ) : (
                <ResponsiveGrid minWidth="260px">
                  {topAchievers.map((achiever) => (
                    <AchieverCard
                      key={achiever.id || achiever.student_id || achiever.student_name}
                      name={achiever.student_name || 'Student'}
                      grade={safeDisplayText(achiever.grade_level || achiever.grade, 'Grade N/A')}
                      quest={achiever.current_quest || achiever.quest || 'N/A'}
                      score={achiever.score ?? achiever.accuracy_rate ?? '--'}
                      accuracy={achiever.accuracy_rate ?? achiever.performance_percentage ?? 0}
                    />
                  ))}
                </ResponsiveGrid>
              )}
            </ContentSection>

            <ContentSection title="Child Insights">
              {analyticsRecommendations.length > 0 ? (
                <div className="recommendations-list">
                  {analyticsRecommendations.slice(0, 4).map((rec, index) => (
                    <div key={index} className="recommendation-item">
                      {rec}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="fallback-note">Open Child Progress to view child-specific metrics or request a grounded insight when enough results are available.</div>
              )}
            </ContentSection>

            <ContentSection title="Support Resources">
              <InfoCard title="Family support resources">
                <p>Keep track of your child's progress, join scheduled review sessions, and see when new learning material is available.</p>
              </InfoCard>
            </ContentSection>

            {error && (
              <ContentSection>
                <div className="fallback-note">{error}</div>
              </ContentSection>
            )}
          </PageContent>
        </MainContent>
      }
    />
  );
}
