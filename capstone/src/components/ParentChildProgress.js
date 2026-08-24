import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';
import { normalizeActivityLogPayload } from './activityLog.utils';
import { isParentRole, normalizeRole } from './manageUsers.utils';
import {
  clampPercent,
  formatPercent,
  normalizeDisplayList,
  normalizeStudentProgressPayload,
  safeDisplayText,
  sortStudentsByName,
  toFiniteNumber,
} from './studentProgress.utils';
import { LearningCycleResetAction } from './LearningCycleResetAction';
import '../styles/studentprogress.css';

export default function ParentChildProgress() {
  const navigate = useNavigate();
  const [students, setStudents] = useState([]);
  const [activityLogs, setActivityLogs] = useState([]);
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [portalRole, setPortalRole] = useState('parent');
  const [parentAccountId, setParentAccountId] = useState(null);
  const [quizSessions, setQuizSessions] = useState([]);
  const [topicCoverage, setTopicCoverage] = useState([]);
  const [selectedChildMetrics, setSelectedChildMetrics] = useState(null);
  const [selectedChildAiInsight, setSelectedChildAiInsight] = useState(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightError, setInsightError] = useState('');
  const [selectedAnalyticsReadiness, setSelectedAnalyticsReadiness] = useState(null);
  const [childDetailsLoading, setChildDetailsLoading] = useState(false);
  const [childDetailsError, setChildDetailsError] = useState('');
  const [unlinkedCount, setUnlinkedCount] = useState(0);
  const [unlinkedWarningDismissed, setUnlinkedWarningDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);

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
        const requestOptions = { headers: buildAuthHeaders() };
        setParentAccountId(parentId);
        setPortalRole(normalizeRole(loggedInUser?.role) === 'parent_teacher' ? 'parent_teacher' : 'parent');
        const [childrenResult, studentsResult, activityResult] = await Promise.allSettled([
          fetch(buildScopedApiUrl('/api/parent/children', 'parent'), requestOptions),
          fetch(buildScopedApiUrl('/api/students/progress', 'parent'), requestOptions),
          fetch(buildScopedApiUrl('/api/activity-logs?limit=100', 'parent'), requestOptions),
        ]);

        if (childrenResult.status !== 'fulfilled' || !childrenResult.value.ok) {
          throw new Error('Could not load children');
        }

        const childrenPayload = await childrenResult.value.json();
        const progressPayload = studentsResult.status === 'fulfilled' && studentsResult.value.ok
          ? await studentsResult.value.json()
          : [];
        const progressRows = normalizeStudentProgressPayload(progressPayload);
        const progressByStudentId = new Map(
          progressRows.map((student) => [String(student.student_id || student.id), student])
        );
        // Keep linked children visible even when no aggregate progress row has been created yet.
        const linkedChildren = Array.isArray(childrenPayload?.children) ? childrenPayload.children : [];
        const normalizedStudents = sortStudentsByName(linkedChildren.map((child) => {
          const studentId = child.student_id || child.id;
          const progress = progressByStudentId.get(String(studentId)) || {};
          return {
            ...progress,
            ...child,
            id: child.id || progress.id,
            student_id: studentId || progress.student_id,
            student_name: child.student_name || child.name || progress.student_name,
          };
        }));

        setStudents(normalizedStudents);
        setUnlinkedCount(Number(childrenPayload.unlinked_count || 0));
        setUnlinkedWarningDismissed(false);
        setSelectedStudentId((current) => {
          if (normalizedStudents.length === 1) {
            return normalizedStudents[0].student_id || normalizedStudents[0].id || null;
          }
          return normalizedStudents.some((student) => String(student.student_id || student.id) === String(current))
            ? current
            : null;
        });

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
  }, [navigate, refreshToken]);

  const focusStudent = useMemo(() => {
    if (!students.length) return null;
    if (!selectedStudentId && students.length > 1) return null;
    return students.find((student) => String(student.student_id || student.id) === String(selectedStudentId)) || students[0];
  }, [selectedStudentId, students]);

  const focusStudentId = focusStudent?.student_id || focusStudent?.id || null;

  useEffect(() => {
    if (!focusStudentId || !parentAccountId) {
      setQuizSessions([]);
      setTopicCoverage([]);
      setSelectedChildMetrics(null);
      setSelectedChildAiInsight(null);
      setInsightError('');
      setSelectedAnalyticsReadiness(null);
      setChildDetailsLoading(false);
      setChildDetailsError('');
      return undefined;
    }

    let active = true;
    const loadChildGameDetails = async () => {
      setChildDetailsLoading(true);
      setChildDetailsError('');
      try {
        const requestOptions = { headers: buildAuthHeaders() };
        const [quizzesResult, topicsResult, analyticsResult] = await Promise.all([
          fetch(buildScopedApiUrl(`/api/parent/children/${focusStudentId}/quizzes?limit=20`, 'parent'), requestOptions),
          fetch(buildScopedApiUrl(`/api/parent/children/${focusStudentId}/topics`, 'parent'), requestOptions),
          fetch(buildScopedApiUrl(`/api/student-progress/${focusStudentId}`, 'parent'), requestOptions),
        ]);

        if (!quizzesResult.ok || !topicsResult.ok) {
          throw new Error('Could not load child quiz details');
        }

        const [quizzesPayload, topicsPayload, analyticsPayload] = await Promise.all([
          quizzesResult.json(),
          topicsResult.json(),
          analyticsResult.ok ? analyticsResult.json() : Promise.resolve(null),
        ]);
        if (!active) return;

        setQuizSessions(Array.isArray(quizzesPayload?.data) ? quizzesPayload.data : []);
        setTopicCoverage(Array.isArray(topicsPayload) ? topicsPayload : []);
        setSelectedChildMetrics(analyticsPayload?.metrics && typeof analyticsPayload.metrics === 'object' ? analyticsPayload.metrics : null);
        setSelectedChildAiInsight(analyticsPayload?.aiInsight && typeof analyticsPayload.aiInsight === 'object' ? analyticsPayload.aiInsight : null);
        setSelectedAnalyticsReadiness(analyticsPayload?.analyticsReadiness && typeof analyticsPayload.analyticsReadiness === 'object' ? analyticsPayload.analyticsReadiness : null);
      } catch (err) {
        console.error('Child game result load error:', err);
        if (!active) return;
        setQuizSessions([]);
        setTopicCoverage([]);
        setSelectedChildMetrics(null);
        setSelectedChildAiInsight(null);
        setSelectedAnalyticsReadiness(null);
        setChildDetailsError('Quiz session details are currently unavailable.');
      } finally {
        if (active) setChildDetailsLoading(false);
      }
    };

    loadChildGameDetails();
    return () => {
      active = false;
    };
  }, [focusStudentId, parentAccountId]);

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

  const scoreTimeline = useMemo(() => {
    return quizSessions.slice().reverse().map((session, index) => ({
      label: `${session.math_topic || 'Topic'} (${session.difficulty || 'Unknown'})`,
      percentage: clampPercent(session.percentage, 0),
      quiz: index + 1,
    }));
  }, [quizSessions]);

  const selectedRecommendations = useMemo(() => (
    normalizeDisplayList(selectedChildAiInsight?.insight?.recommendations)
  ), [selectedChildAiInsight]);

  const generateChildInsight = async () => {
    if (!focusStudentId) return;
    setInsightLoading(true);
    setInsightError('');
    try {
      const response = await fetch(
        buildScopedApiUrl(`/api/student-progress/${focusStudentId}/ai-insight`, 'parent'),
        { method: 'POST', headers: { ...buildAuthHeaders(), 'Content-Type': 'application/json' } }
      );
      const payload = await response.json();
      if (payload?.status === 'insufficient_data') {
        setSelectedChildAiInsight(payload);
        return;
      }
      if (!response.ok) {
        setInsightError(payload?.error || 'Grounded AI Insights are unavailable right now.');
        return;
      }
      setSelectedChildAiInsight(payload);
    } catch (err) {
      console.error('Child grounded insight request failed:', err);
      setInsightError('Grounded AI Insights are unavailable right now.');
    } finally {
      setInsightLoading(false);
    }
  };

  const focusStudentInitials = useMemo(() => {
    const name = focusStudent?.student_name || focusStudent?.name || '';
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'ST';
  }, [focusStudent]);

  const renderChildSelector = () => (
    <div className="child-progress-selector" aria-label="Select child">
      {students.map((student) => {
        const studentId = student.student_id || student.id;
        return (
          <button
            key={studentId || student.student_name}
            type="button"
            className={`child-selector-card ${String(studentId) === String(focusStudentId) ? 'active' : ''}`}
            onClick={() => setSelectedStudentId(studentId)}
          >
            <strong>{safeDisplayText(student.student_name, 'Unknown')}</strong>
            <span>{[safeDisplayText(student.grade_level || student.grade, 'Grade N/A'), safeDisplayText(student.section, 'Not assigned')].filter(Boolean).join(' - ')}</span>
          </button>
        );
      })}
    </div>
  );

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
            {focusStudent && students.length > 1 && (
              <label className="child-dashboard-switcher">
                <span>Child</span>
                <select
                  aria-label="Switch child"
                  value={focusStudentId}
                  onChange={(event) => setSelectedStudentId(event.target.value)}
                >
                  {students.map((student) => {
                    const studentId = student.student_id || student.id;
                    return <option key={studentId} value={studentId}>{student.student_name || 'Unknown'}</option>;
                  })}
                </select>
              </label>
            )}
          </TopBar>

          <PageContent>
            {unlinkedCount > 0 && !unlinkedWarningDismissed && (
              <div className="parent-unlinked-warning" role="status">
                <p>Some game sessions could not be matched to a child profile. Please contact the school admin.</p>
                <button type="button" onClick={() => setUnlinkedWarningDismissed(true)}>Dismiss</button>
              </div>
            )}

            <ContentSection
              title="Selected Child Overview"
              contentClassName="student-progress-summary-grid"
            >
              <div className="analytics-card">
                <span>Total questions</span>
                <strong>{selectedChildMetrics?.totalQuestions ?? 'No Data'}</strong>
              </div>
              <div className="analytics-card">
                <span>Average accuracy</span>
                <strong>{formatPercent(selectedChildMetrics?.accuracy, 'No Data')}</strong>
              </div>
              <div className="analytics-card">
                <span>Total progress</span>
                <strong>{formatPercent(selectedChildMetrics?.totalProgress, 'No Data')}</strong>
              </div>
              <div className="analytics-card">
                <span>Game score</span>
                <strong>{selectedChildMetrics?.gameScore ?? 'No Data'}</strong>
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
                ) : students.length > 1 && !focusStudent ? (
                  <div className="child-selector-screen">
                    <div className="insights-header">
                      <h2>My Children</h2>
                      <p>Select a child to open an individual progress dashboard.</p>
                    </div>
                    {renderChildSelector()}
                  </div>
                ) : focusStudent ? (
                  <div className="child-progress-detail">
                    {students.length > 1 && renderChildSelector()}

                    <div className="child-profile-heading">
                      <div className="child-profile-avatar" aria-hidden="true">{focusStudentInitials}</div>
                      <div>
                        <h2>{safeDisplayText(focusStudent.student_name, 'Unknown Child')}</h2>
                        <p>{[safeDisplayText(focusStudent.grade_level || focusStudent.grade, 'Grade N/A'), safeDisplayText(focusStudent.section, 'Not assigned')].filter(Boolean).join(' - ')}</p>
                        <small>Student ID: {focusStudent.game_student_id || 'Not linked'}</small>
                      </div>
                      <LearningCycleResetAction
                        studentId={focusStudentId}
                        role="parent"
                        className="table-action-button child-reset-action"
                        onReset={() => setRefreshToken((value) => value + 1)}
                      />
                    </div>

                    <div className="child-progress-stats">
                      <div className="child-progress-stat">
                        <span>Student ID</span>
                        <strong>{focusStudent.game_student_id || 'Not linked'}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Child</span>
                        <strong>{safeDisplayText(focusStudent.student_name, 'Unknown')}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Grade / Section</span>
                        <strong>{[safeDisplayText(focusStudent.grade_level || focusStudent.grade, ''), safeDisplayText(focusStudent.section, 'Not assigned')].filter(Boolean).join(' - ') || 'Not assigned'}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Current Quest</span>
                        <strong>{safeDisplayText(focusStudent.current_quest, 'N/A')}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Score</span>
                        <strong>{selectedChildMetrics?.gameScore ?? 'Not available'}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Accuracy</span>
                        <strong>{formatPercent(selectedChildMetrics?.accuracy, 'Not available')}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Progress</span>
                        <strong>{formatPercent(selectedChildMetrics?.totalProgress, 'Not available')}</strong>
                      </div>
                    </div>

                    <div className="child-activity-panel">
                      <div className="insights-header">
                        <h2>Latest Activity</h2>
                        <p>Recent gameplay updates for the selected child.</p>
                      </div>
                      {selectedLogs.length === 0 ? (
                        <div className="fallback-note">No game progress data available yet. Progress will appear here once the student starts playing the game.</div>
                      ) : (
                        <div className="child-activity-list">
                          {selectedLogs.slice(0, 5).map((log) => (
                            <div key={log.id || `${log.student_id}-${log.activity_timestamp}`} className="child-activity-item">
                              <strong>{safeDisplayText(log.activity_description, 'Gameplay Session')}</strong>
                              <span>{safeDisplayText(log.current_quest, 'No active quest')} | Score {toFiniteNumber(log.score, 0)}</span>
                              <small>{log.activity_timestamp ? new Date(log.activity_timestamp).toLocaleString() : 'Timestamp unavailable'}</small>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="child-game-results-grid">
                      <div className="child-activity-panel child-quiz-panel">
                        <div className="insights-header">
                          <h2>Quiz Sessions</h2>
                          <p>Per-session game results for the selected child.</p>
                        </div>
                        {childDetailsLoading ? (
                          <div className="fallback-note">Loading quiz sessions...</div>
                        ) : childDetailsError ? (
                          <div className="fallback-note">{childDetailsError}</div>
                        ) : quizSessions.length === 0 ? (
                          <div className="fallback-note">No game progress data available yet. Progress will appear here once the student starts playing the game.</div>
                        ) : (
                          <div className="child-quiz-list">
                            {quizSessions.map((session) => (
                              <div key={session.id} className="child-quiz-item">
                                <strong>{safeDisplayText(session.math_topic, 'Topic unavailable')}</strong>
                                <span>{toFiniteNumber(session.score, 0)} / {toFiniteNumber(session.total_items, 0)} | {formatPercent(session.percentage, '0%')}</span>
                                <small>{safeDisplayText(session.difficulty, 'Difficulty unavailable')} | {session.played_at ? new Date(session.played_at).toLocaleString() : 'Date unavailable'}</small>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="child-activity-panel child-score-panel">
                        <div className="insights-header">
                          <h2>Score Over Time</h2>
                          <p>Recent quiz percentages by topic and difficulty.</p>
                        </div>
                        {scoreTimeline.length === 0 ? (
                          <div className="fallback-note">No game progress data available yet. Progress will appear here once the student starts playing the game.</div>
                        ) : (
                          <div className="child-score-chart">
                            <ResponsiveContainer width="100%" height={260}>
                              <BarChart data={scoreTimeline}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis dataKey="label" interval={0} angle={-24} textAnchor="end" height={96} />
                                <YAxis domain={[0, 100]} />
                                <Tooltip formatter={(value) => [`${Number(value).toFixed(0)}%`, 'Score']} />
                                <Bar dataKey="percentage" fill="#2563eb" radius={[6, 6, 0, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                      </div>

                      <div className="child-activity-panel child-topic-panel">
                        <div className="insights-header">
                          <h2>Topic Coverage</h2>
                          <p>Topics attempted and best recorded quiz scores.</p>
                        </div>
                        {topicCoverage.length === 0 ? (
                          <div className="fallback-note">No game progress data available yet. Progress will appear here once the student starts playing the game.</div>
                        ) : (
                          <div className="child-topic-list">
                            {topicCoverage.map((topic) => (
                              <div key={safeDisplayText(topic.math_topic, 'topic')} className="child-topic-item">
                                <strong>{safeDisplayText(topic.math_topic, 'Topic unavailable')}</strong>
                                <span>{toFiniteNumber(topic.times_played, 0)} played</span>
                                <small>Best score {toFiniteNumber(topic.best_score, 0)}</small>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="child-activity-panel child-ai-readiness-panel">
                        <div className="insights-header">
                          <h2>Analytics Readiness</h2>
                          <p>Child-specific learning signals prepared for future recommendation APIs.</p>
                        </div>
                        <div className="child-topic-list">
                          <div className="child-topic-item">
                            <strong>Quiz sessions</strong>
                            <span>{selectedAnalyticsReadiness?.engagement?.quizSessionCount ?? quizSessions.length} available</span>
                          </div>
                          <div className="child-topic-item">
                            <strong>Weak topic candidates</strong>
                            <span>{selectedAnalyticsReadiness?.weakTopicCandidates?.length ?? 0} detected</span>
                          </div>
                        </div>
                      </div>

                      <div className="child-activity-panel child-achievements-panel">
                        <div className="insights-header">
                          <h2>Achievements — Coming Soon</h2>
                          <p>Badges and milestones will appear here when they are available.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="fallback-note">No child progress records available yet.</div>
                )}
              </div>

              <div className="analytics-insights-panel">
                <div className="insights-header">
                  <h2>Grounded AI Insight</h2>
                  <p>Optional child-specific interpretation of the recorded gameplay metrics.</p>
                </div>
                {loading || childDetailsLoading ? (
                  <div className="fallback-note">Loading child analytics...</div>
                ) : selectedRecommendations.length > 0 ? (
                  <ul className="recommendation-list">
                    {selectedRecommendations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="fallback-note">
                    {insightError || selectedChildAiInsight?.message || 'Generate an insight only when you want an interpretation of this child’s recorded metrics.'}
                  </div>
                )}
                {selectedChildAiInsight?.status !== 'insufficient_data' && focusStudentId && (
                  <button type="button" className="btn btn-primary" onClick={generateChildInsight} disabled={insightLoading}>
                    {insightLoading ? 'Generating insight...' : selectedChildAiInsight?.status === 'stale' ? 'Generate refreshed insight' : 'Generate grounded insight'}
                  </button>
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
