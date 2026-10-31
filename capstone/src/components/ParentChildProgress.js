import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';
import { normalizeActivityLogPayload } from './activityLog.utils';
import { isParentRole, normalizeRole } from './manageUsers.utils';
import {
  formatPercent,
  getTotalProgressNote,
  normalizeStudentProgressPayload,
  resolveCurrentDifficulty,
  safeDisplayText,
  sortStudentsByName,
} from './studentProgress.utils';
import GroundedAiAnalysis from './GroundedAiAnalysis';
import { LatestActivitySection, ScoreOverTimeSection } from './StudentProgressEvidence';
import '../styles/studentprogress.css';

export { buildScoreTimeline, formatLatestActivityScore } from './studentProgressHistory.utils';
export { ScoreTimelineTooltip } from './StudentProgressEvidence';
export default function ParentChildProgress() {
  const navigate = useNavigate();
  const [students, setStudents] = useState([]);
  const [activityLogs, setActivityLogs] = useState([]);
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [portalRole, setPortalRole] = useState('parent');
  const [parentAccountId, setParentAccountId] = useState(null);
  const [quizSessions, setQuizSessions] = useState([]);
  const [selectedChildMetrics, setSelectedChildMetrics] = useState(null);
  const [selectedChildProgress, setSelectedChildProgress] = useState(null);
  const [selectedChildAiInsight, setSelectedChildAiInsight] = useState(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightError, setInsightError] = useState('');
  const [unlinkedCount, setUnlinkedCount] = useState(0);
  const [unlinkedWarningDismissed, setUnlinkedWarningDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const childRequestVersion = useRef(0);

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
        const [childrenResult, studentsResult] = await Promise.allSettled([
          fetch(buildScopedApiUrl('/api/parent/children', 'parent'), requestOptions),
          fetch(buildScopedApiUrl('/api/students/progress', 'parent'), requestOptions),
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
    const requestVersion = ++childRequestVersion.current;
    setInsightLoading(false);
    setInsightError('');
    if (!focusStudentId || !parentAccountId) {
      setQuizSessions([]);
      setActivityLogs([]);
      setSelectedChildMetrics(null);
      setSelectedChildProgress(null);
      setSelectedChildAiInsight(null);
      setInsightError('');
      return undefined;
    }

    let active = true;
    const loadChildGameDetails = async () => {
      setQuizSessions([]);
      setActivityLogs([]);
      setSelectedChildMetrics(null);
      setSelectedChildProgress(null);
      setSelectedChildAiInsight(null);
      try {
        const requestOptions = { headers: buildAuthHeaders() };
        const readChildData = async (path) => {
          const response = await fetch(buildScopedApiUrl(path, 'parent'), requestOptions);
          if (!response.ok) throw new Error('Could not load child data');
          return response.json();
        };
        readChildData(`/api/activity-logs?limit=100&student_id=${encodeURIComponent(focusStudentId)}`)
          .then((activityPayload) => {
            if (active) setActivityLogs(normalizeActivityLogPayload(activityPayload).records);
          })
          .catch(() => {
            if (active) setActivityLogs([]);
          });
        const [quizzesResult, analyticsResult] = await Promise.allSettled([
          readChildData(`/api/parent/children/${focusStudentId}/quizzes?limit=20`),
          readChildData(`/api/student-progress/${focusStudentId}`),
        ]);
        if (!active) return;

        const quizzesPayload = quizzesResult.status === 'fulfilled' ? quizzesResult.value : null;
        const analyticsPayload = analyticsResult.status === 'fulfilled' ? analyticsResult.value : null;
        setInsightError(analyticsResult.status === 'rejected' ? 'Student analytics are currently unavailable.' : '');

        setQuizSessions(Array.isArray(analyticsPayload?.scoreHistory)
          ? analyticsPayload.scoreHistory
          : Array.isArray(quizzesPayload?.data) ? quizzesPayload.data : []);
        setSelectedChildMetrics(analyticsPayload?.metrics && typeof analyticsPayload.metrics === 'object' ? analyticsPayload.metrics : null);
        setSelectedChildProgress(analyticsPayload?.progress && typeof analyticsPayload.progress === 'object' ? analyticsPayload.progress : null);
        setSelectedChildAiInsight(analyticsPayload?.aiInsight && typeof analyticsPayload.aiInsight === 'object' ? analyticsPayload.aiInsight : null);
      } catch (err) {
        console.error('Child game result load error:', err);
        if (!active) return;
        setQuizSessions([]);
        setActivityLogs([]);
        setSelectedChildMetrics(null);
        setSelectedChildProgress(null);
        setSelectedChildAiInsight(null);
      }
    };

    loadChildGameDetails();
    return () => {
      active = false;
      if (childRequestVersion.current === requestVersion) childRequestVersion.current += 1;
    };
  }, [focusStudentId, parentAccountId, refreshToken]);

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

  const currentQuest = selectedChildMetrics?.currentQuest !== undefined
    ? selectedChildMetrics.currentQuest
    : selectedChildProgress?.current_quest;
  const currentDifficulty = resolveCurrentDifficulty({ ...selectedChildProgress, metrics: selectedChildMetrics });
  const difficultyRows = [
    { label: 'Easy', key: 'easy' },
    { label: 'Normal', key: 'medium' },
    { label: 'Difficult', key: 'hard' },
  ];

  const generateChildInsight = async () => {
    if (!focusStudentId) return;
    const requestVersion = childRequestVersion.current;
    setInsightLoading(true);
    setInsightError('');
    try {
      const response = await fetch(
        buildScopedApiUrl(`/api/student-progress/${focusStudentId}/ai-insight`, 'parent'),
        {
          method: 'POST',
          headers: { ...buildAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh: true }),
        }
      );
      const payload = await response.json();
      if (childRequestVersion.current !== requestVersion) return;
      const supportedEmptyState = ['insufficient_data', 'no_data'].includes(payload?.status);
      if (!response.ok && !supportedEmptyState) {
        setInsightError(payload?.error || 'Grounded AI Insights are unavailable right now.');
        return;
      }
      const evidenceSnapshot = payload?.evidence_snapshot;
      if (!evidenceSnapshot?.progress || !evidenceSnapshot?.metrics) {
        setInsightError('The refreshed Student Progress snapshot was incomplete.');
        return;
      }
      setSelectedChildProgress(evidenceSnapshot.progress);
      setSelectedChildMetrics(evidenceSnapshot.metrics);
      setSelectedChildAiInsight(payload);
      if (Array.isArray(evidenceSnapshot.scoreHistory)) setQuizSessions(evidenceSnapshot.scoreHistory);
    } catch (err) {
      if (childRequestVersion.current !== requestVersion) return;
      console.error('Child grounded insight request failed:', err);
      setInsightError('Grounded AI Insights are unavailable right now.');
    } finally {
      if (childRequestVersion.current === requestVersion) setInsightLoading(false);
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
                <strong>{formatPercent(selectedChildMetrics?.totalProgress, 'Not available')}</strong>
                {getTotalProgressNote(selectedChildMetrics) && <small>{getTotalProgressNote(selectedChildMetrics)}</small>}
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
                        <strong>{safeDisplayText(currentQuest, 'Not available')}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Current Difficulty</span>
                        <strong>{currentDifficulty}</strong>
                      </div>
                      <div className="child-progress-stat">
                        <span>Current Location</span>
                        <strong>{safeDisplayText(selectedChildProgress?.current_location, 'Not available')}</strong>
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
                      {[
                        { label: 'Correct Answers', key: 'correctAnswers' },
                        { label: 'Incorrect Answers', key: 'incorrectAnswers' },
                        { label: 'Completed Quests', key: 'completedQuests' },
                      ].map(({ label, key }) => (
                        <div className="child-progress-stat" key={key}>
                          <span>{label}</span>
                          <strong>{safeDisplayText(selectedChildMetrics?.[key], 'Not available')}</strong>
                        </div>
                      ))}
                    </div>

                    <div className="child-activity-panel child-difficulty-panel">
                        <div className="insights-header">
                          <h2>Difficulty Breakdown</h2>
                          <p>Accuracy from recorded question results only.</p>
                        </div>
                        <div className="child-topic-list">
                          {difficultyRows.map(({ label, key }) => (
                            <div className="child-topic-item" key={key}>
                              <strong>{label}</strong>
                              <span>{formatPercent(selectedChildMetrics?.difficultyBreakdown?.[key]?.accuracy, 'Not available')}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                    <LatestActivitySection
                      activities={selectedLogs}
                      description="Recent gameplay updates for the selected child."
                    />

                    <div className="child-score-results">
                      <ScoreOverTimeSection sessions={quizSessions} studentLabel="this child" />
                    </div>

                  </div>
                ) : (
                  <div className="fallback-note">No child progress records available yet.</div>
                )}
              </div>

              <div className="analytics-insights-panel">
                <GroundedAiAnalysis
                  aiInsight={selectedChildAiInsight}
                  error={insightError}
                  loading={insightLoading}
                  onRefresh={focusStudentId ? generateChildInsight : undefined}
                />
              </div>
            </ContentSection>

            {error && !loading && (
              <ContentSection>
                <div className="fallback-note validation-error-text">{error}</div>
              </ContentSection>
            )}
          </PageContent>
        </MainContent>
      }
    />
  );
}
