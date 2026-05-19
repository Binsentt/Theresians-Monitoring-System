import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { normalizeActivityLogPayload } from './activityLog.utils';
import { isParentRole, normalizeRole } from './manageUsers.utils';
import { normalizeStudentProgressPayload } from './studentProgress.utils';
import '../styles/studentprogress.css';

export default function ParentChildProgress() {
  const navigate = useNavigate();
  const [students, setStudents] = useState([]);
  const [activityLogs, setActivityLogs] = useState([]);
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [portalRole, setPortalRole] = useState('parent');
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
        if (!loggedInUser?.id || !isParentRole(loggedInUser.role)) {
          navigate('/login');
          return;
        }
        const parentId = loggedInUser?.id;
        setPortalRole(normalizeRole(loggedInUser?.role) === 'parent_teacher' ? 'parent_teacher' : 'parent');
        const [studentsResult, overviewResult, recommendationsResult, activityResult] = await Promise.allSettled([
          fetch(buildScopedApiUrl('/api/students/progress', 'parent', parentId)),
          fetch(buildScopedApiUrl('/api/analytics/overview', 'parent', parentId)),
          fetch(buildScopedApiUrl('/api/analytics/recommendations', 'parent', parentId)),
          fetch(buildScopedApiUrl('/api/activity-logs?limit=100', 'parent', parentId)),
        ]);

        if (studentsResult.status !== 'fulfilled' || !studentsResult.value.ok) {
          throw new Error('Could not load children progress');
        }

        const studentPayload = await studentsResult.value.json();
        const normalizedStudents = normalizeStudentProgressPayload(studentPayload);
        setStudents(normalizedStudents);
        setSelectedStudentId((current) => current || normalizedStudents[0]?.student_id || normalizedStudents[0]?.id || null);

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

        if (activityResult.status === 'fulfilled' && activityResult.value.ok) {
          const activityData = await activityResult.value.json();
          setActivityLogs(normalizeActivityLogPayload(activityData).records);
        } else {
          setActivityLogs([]);
        }
      } catch (err) {
        console.error('Load error:', err);
        setError('Analytics currently unavailable. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [navigate]);

  const focusStudent = useMemo(() => {
    if (!students.length) return null;
    return students.find((student) => String(student.student_id || student.id) === String(selectedStudentId)) || students[0];
  }, [selectedStudentId, students]);

  const logsByStudent = useMemo(() => {
    return activityLogs.reduce((groups, log) => {
      const key = String(log.student_id || '');
      if (!key) return groups;
      return {
        ...groups,
        [key]: [...(groups[key] || []), log],
      };
    }, {});
  }, [activityLogs]);

  const selectedLogs = useMemo(() => {
    const key = String(focusStudent?.student_id || focusStudent?.id || '');
    return key ? logsByStudent[key] || [] : [];
  }, [focusStudent, logsByStudent]);

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role={portalRole}
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
                  <p>Select a child to review progress, score, and latest gameplay updates separately.</p>
                </div>
                {loading ? (
                  <div className="fallback-note">Loading child analytics...</div>
                ) : focusStudent ? (
                  <div className="child-progress-detail">
                    <div className="child-progress-selector" aria-label="Select child">
                      {students.map((student) => {
                        const studentId = student.student_id || student.id;
                        return (
                          <button
                            key={studentId || student.student_name}
                            type="button"
                            className={`child-selector-card ${String(studentId) === String(focusStudent.student_id || focusStudent.id) ? 'active' : ''}`}
                            onClick={() => setSelectedStudentId(studentId)}
                          >
                            <strong>{student.student_name || 'Unknown'}</strong>
                            <span>{student.grade_level || student.grade || 'Grade N/A'}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="child-progress-stats">
                      <div className="child-progress-stat">
                        <span>Child</span>
                        <strong>{focusStudent.student_name || 'Unknown'}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Grade / Section</span>
                        <strong>{[focusStudent.grade_level || focusStudent.grade, focusStudent.section].filter(Boolean).join(' - ') || 'N/A'}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Current Quest</span>
                        <strong>{focusStudent.current_quest || 'N/A'}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Score</span>
                        <strong>{focusStudent.score ?? 0}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Accuracy</span>
                        <strong>{Number(focusStudent.performance_percentage || focusStudent.accuracy_rate || 0).toFixed(0)}%</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Progress</span>
                        <strong>{Number(focusStudent.progress_percentage || focusStudent.performance_percentage || 0).toFixed(0)}%</strong>
                      </div>
                    </div>

                    <div className="child-activity-panel">
                      <div className="insights-header">
                        <h2>Latest Activity</h2>
                        <p>Recent gameplay updates for the selected child.</p>
                      </div>
                      {selectedLogs.length === 0 ? (
                        <div className="fallback-note">No activity logs recorded for this child yet.</div>
                      ) : (
                        <div className="child-activity-list">
                          {selectedLogs.slice(0, 5).map((log) => (
                            <div key={log.id || `${log.student_id}-${log.activity_timestamp}`} className="child-activity-item">
                              <strong>{log.activity_description || 'Gameplay Session'}</strong>
                              <span>{log.current_quest || 'No active quest'} | Score {log.score ?? 0}</span>
                              <small>{log.activity_timestamp ? new Date(log.activity_timestamp).toLocaleString() : 'Timestamp unavailable'}</small>
                            </div>
                          ))}
                        </div>
                      )}
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
