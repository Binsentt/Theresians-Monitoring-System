import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/images/STS_Logo.png';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { MetricCard, InfoCard } from './layout/Card';
import { ResponsiveGrid } from './layout/Grid';
import { buildScopedApiUrl } from './analyticsEndpoints';
import '../styles/parentdashboard.css';

function AchieverCard({ name, grade, quest, score, accuracy }) {
  return (
    <div className="achiever-card">
      <div className="rank-section">
        <div className="rank-number">{grade}</div>
      </div>
      <div className="achiever-info">
        <h4>{name}</h4>
        <p>Current quest: {quest || 'N/A'}</p>
      </div>
      <div className="achiever-stats">
        <div className="stat-item">
          <div className="stat-value">{score ?? '—'}</div>
          <div className="stat-label">Score</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{accuracy !== undefined ? `${accuracy.toFixed(0)}%` : '—'}</div>
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
      if (userData.role?.toLowerCase() !== 'parent') {
        navigate('/login');
        return;
      }

      setUser(userData);
      try {
        const userResponse = await fetch(`http://localhost:5000/api/user/${userData.id}`);
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
      const parentId = loggedInUser?.id;
      const [achieversResult, overviewResult, recommendationsResult] = await Promise.allSettled([
        fetch(buildScopedApiUrl('/api/top-achievers', 'parent', parentId)),
        fetch(buildScopedApiUrl('/api/analytics/overview', 'parent', parentId)),
        fetch(buildScopedApiUrl('/api/analytics/recommendations', 'parent', parentId)),
      ]);

      if (achieversResult.status === 'fulfilled' && achieversResult.value.ok) {
        const achieversData = await achieversResult.value.json();
        setTopAchievers(Array.isArray(achieversData) ? achieversData.slice(0, 4) : []);
      } else {
        setTopAchievers([]);
      }

      if (overviewResult.status === 'fulfilled' && overviewResult.value.ok) {
        const overviewData = await overviewResult.value.json();
        setAnalyticsSummary(overviewData);
      } else {
        setAnalyticsSummary(null);
      }

      if (recommendationsResult.status === 'fulfilled' && recommendationsResult.value.ok) {
        const recommendationsData = await recommendationsResult.value.json();
        setAnalyticsRecommendations(Array.isArray(recommendationsData.recommendations) ? recommendationsData.recommendations : []);
      } else {
        setAnalyticsRecommendations([]);
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
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading Parent Portal...</p>
      </div>
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role="parent"
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
                  value={analyticsSummary?.averageAccuracy ? `${analyticsSummary.averageAccuracy}%` : '--'}
                  footer="Across current courses"
                />
                <MetricCard
                  label="Completion Rate"
                  value={analyticsSummary?.averageProgress ? `${analyticsSummary.averageProgress}%` : '--'}
                  footer="Average progress"
                />
              </ResponsiveGrid>
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
                      grade={achiever.grade_level || achiever.grade || 'Grade N/A'}
                      quest={achiever.current_quest || achiever.quest || 'N/A'}
                      score={achiever.score ?? achiever.accuracy_rate ?? '--'}
                      accuracy={achiever.accuracy_rate ?? achiever.performance_percentage ?? 0}
                    />
                  ))}
                </ResponsiveGrid>
              )}
            </ContentSection>

            <ContentSection title="Recommendations">
              {analyticsRecommendations.length > 0 ? (
                <div className="recommendations-list">
                  {analyticsRecommendations.slice(0, 4).map((rec, index) => (
                    <div key={index} className="recommendation-item">
                      {rec}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="fallback-note">No recommendations available yet.</div>
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
