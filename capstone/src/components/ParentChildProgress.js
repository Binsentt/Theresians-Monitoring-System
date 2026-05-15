import React, { useEffect, useMemo, useState } from 'react';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { normalizeStudentProgressPayload } from './studentProgress.utils';
import '../styles/studentprogress.css';

export default function ParentChildProgress() {
  const [students, setStudents] = useState([]);
  const [overview, setOverview] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      setError('');
      try {
        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
        const parentId = loggedInUser?.id;
        const [studentsResult, overviewResult, recommendationsResult] = await Promise.allSettled([
          fetch(buildScopedApiUrl('/api/students/progress', 'parent', parentId)),
          fetch(buildScopedApiUrl('/api/analytics/overview', 'parent', parentId)),
          fetch(buildScopedApiUrl('/api/analytics/recommendations', 'parent', parentId)),
        ]);

        if (studentsResult.status !== 'fulfilled' || !studentsResult.value.ok) {
          throw new Error('Could not load children progress');
        }

        const studentPayload = await studentsResult.value.json();
        setStudents(normalizeStudentProgressPayload(studentPayload));

        if (overviewResult.status === 'fulfilled' && overviewResult.value.ok) {
          const overviewData = await overviewResult.value.json();
          setOverview(overviewData);
        } else {
          setOverview(null);
        }

        if (recommendationsResult.status === 'fulfilled' && recommendationsResult.value.ok) {
          const recommendationsData = await recommendationsResult.value.json();
          setRecommendations(Array.isArray(recommendationsData.recommendations) ? recommendationsData.recommendations : []);
        } else {
          setRecommendations([]);
        }
      } catch (err) {
        console.error('Load error:', err);
        setError('Analytics currently unavailable. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  const focusStudent = useMemo(() => students[0] || null, [students]);

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role="parent"
          activeItem="child-progress"
          logoSrc={logoImage}
          portalLabel="Parent Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>Child Progress</h1>
              <p>Monitor your child's learning journey and academic performance.</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection
              title="Performance Overview"
              contentClassName="student-progress-summary-grid"
            >
              <div className="analytics-card">
                <span>Total quests</span>
                <strong>{overview?.studentCount ?? students.length}</strong>
              </div>
              <div className="analytics-card">
                <span>Average accuracy</span>
                <strong>{overview?.averageAccuracy ?? '--'}%</strong>
              </div>
              <div className="analytics-card">
                <span>Progress</span>
                <strong>{overview?.averageProgress ?? '--'}%</strong>
              </div>
              <div className="analytics-card">
                <span>Math activities</span>
                <strong>{focusStudent?.total_questions ?? '--'}</strong>
              </div>
            </ContentSection>

            <ContentSection
              title="Child Snapshot & Recommendations"
              contentClassName="student-progress-panel"
            >
              <div className="student-progress-filters-card child-progress-spotlight">
                <div className="insights-header">
                  <h2>Mathematics Progress</h2>
                  <p>A simplified overview focused on your child's current learning status.</p>
                </div>
                {loading ? (
                  <div className="fallback-note">Loading child analytics...</div>
                ) : focusStudent ? (
                  <div className="child-progress-stats">
                    <div className="child-progress-stat">
                      <span>Child</span>
                      <strong>{focusStudent.student_name || 'Unknown'}</strong>
                    </div>
                    <div className="child-progress-stat">
                      <span>Current Quest</span>
                      <strong>{focusStudent.current_quest || 'N/A'}</strong>
                    </div>
                    <div className="child-progress-stat">
                      <span>Accuracy</span>
                      <strong>{Number(focusStudent.performance_percentage || 0).toFixed(0)}%</strong>
                    </div>
                    <div className="child-progress-stat">
                      <span>Completed Quests</span>
                      <strong>{Math.min(10, Math.round((focusStudent.progress_percentage || focusStudent.performance_percentage || 0) / 10))}</strong>
                    </div>
                  </div>
                ) : (
                  <div className="fallback-note">No child progress records available yet.</div>
                )}
              </div>

              <div className="analytics-insights-panel">
                <div className="insights-header">
                  <h2>Recommendations</h2>
                  <p>Math-focused guidance based on current performance, progress, and learning insights.</p>
                </div>
                {loading ? (
                  <div className="fallback-note">Loading recommendations...</div>
                ) : recommendations.length > 0 ? (
                  <ul className="recommendation-list">
                    {recommendations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="fallback-note">No recommendations available yet.</div>
                )}
              </div>
            </ContentSection>

            {error && !loading && (
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
