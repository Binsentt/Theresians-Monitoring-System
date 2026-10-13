import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  Layers,
  Target,
  Trophy,
  XCircle,
} from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { buildStudentProgressDetailUrl } from './analyticsEndpoints';
import { normalizeRole } from './manageUsers.utils';
import { buildAuthHeaders } from './session.utils';
import { getTotalProgressNote, normalizeDisplayList, resolveCurrentDifficulty, safeDisplayText } from './studentProgress.utils';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { usePreparedReportPrint } from './usePreparedReportPrint';
import GroundedAiAnalysis from './GroundedAiAnalysis';
import '../styles/studentprogress.css';

const toNullableNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatPercent = (value) => {
  const number = toNullableNumber(value);
  return number === null ? 'Not available' : `${number.toFixed(0)}%`;
};

const formatAttemptPercent = (value) => {
  const number = toNullableNumber(value);
  return number === null ? 'No attempts yet' : `${number.toFixed(0)}%`;
};

const formatCount = (value) => {
  const number = toNullableNumber(value);
  return number === null ? 'Not available' : String(Math.round(number));
};

const getInitials = (name) => {
  const parts = safeDisplayText(name, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  return parts.map((part) => part[0]?.toUpperCase()).join('') || 'ST';
};

const buildInsightUrl = (detailUrl) => {
  const [pathname, query = ''] = detailUrl.split('?');
  return `${pathname}/ai-insight${query ? `?${query}` : ''}`;
};

export default function StudentAnalytics() {
  const { studentId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [progress, setProgress] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [aiInsight, setAiInsight] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [insightLoading, setInsightLoading] = useState(false);
  const [error, setError] = useState('');
  const [insightError, setInsightError] = useState('');
  const [userRole, setUserRole] = useState('admin');
  const refreshInFlight = useRef(false);
  const { preparedRows, preparing: reportPreparing, prepareAndPrint } = usePreparedReportPrint();

  const loadDetail = async () => {
    setLoading(true);
    setError('');
    const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
    if (loggedInUser?.role) setUserRole(normalizeRole(loggedInUser.role));

    try {
      const response = await fetch(buildStudentProgressDetailUrl(studentId, loggedInUser?.role), {
        headers: buildAuthHeaders(),
      });
      if (!response.ok) throw new Error('Unable to load student analytics');
      const data = await response.json();
      setProgress(data.progress || null);
      setMetrics(data.metrics || null);
      setAiInsight(data.aiInsight || null);
    } catch (err) {
      console.error('Detail load failed:', err);
      setError('Analytics currently unavailable. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDetail();
  }, [studentId]);

  const getBackRoute = () => {
    if (location.pathname.startsWith('/teacher')) return '/teacher/student-progress';
    if (location.pathname.startsWith('/parent')) return '/parent/child-progress';
    switch (userRole) {
      case 'teacher':
      case 'parent_teacher':
        return '/teacher/student-progress';
      case 'parent':
        return '/parent/child-progress';
      default:
        return '/admin/student-progress';
    }
  };

  const generateInsight = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
    setInsightLoading(true);
    setRefreshing(true);
    setLoading(true);
    setError('');
    setInsightError('');
    try {
      const response = await fetch(buildInsightUrl(buildStudentProgressDetailUrl(studentId, loggedInUser?.role)), {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh: true }),
      });
      const data = await response.json();
      const supportedEmptyStates = ['insufficient_data', 'no_data'];
      if (!response.ok && !supportedEmptyStates.includes(data?.status)) {
        throw new Error(data?.error || 'Unable to refresh student progress.');
      }
      const { evidence_snapshot: evidenceSnapshot, ...insightState } = data || {};
      if (!evidenceSnapshot?.progress || !evidenceSnapshot?.metrics) {
        throw new Error('The refreshed Student Progress snapshot was incomplete.');
      }
      setProgress(evidenceSnapshot.progress);
      setMetrics(evidenceSnapshot.metrics);
      const nextInsightState = Object.keys(insightState).length > 0 ? insightState : data;
      setAiInsight(nextInsightState);
      setInsightError('');
    } catch (err) {
      console.error('Grounded insight request failed:', err);
      setError(err?.message || 'Unable to refresh student progress.');
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
      setLoading(false);
      setInsightLoading(false);
    }
  };

  const difficultyRows = useMemo(() => [
    { label: 'Easy', value: toNullableNumber(metrics?.difficultyBreakdown?.easy?.accuracy), tone: 'easy' },
    { label: 'Normal', value: toNullableNumber(metrics?.difficultyBreakdown?.medium?.accuracy), tone: 'medium' },
    { label: 'Difficult', value: toNullableNumber(metrics?.difficultyBreakdown?.hard?.accuracy), tone: 'hard' },
  ], [metrics]);
  const insight = aiInsight?.insight || null;
  const strengths = normalizeDisplayList(insight?.strengths);
  const weaknesses = normalizeDisplayList(insight?.weaknesses);
  const recommendations = normalizeDisplayList(insight?.recommendations);
  const studentName = safeDisplayText(progress?.student_name, 'Student analytics');
  const studentInitials = getInitials(progress?.student_name);
  const resolvedStudentId = safeDisplayText(progress?.game_student_id, 'Not linked');
  const grade = safeDisplayText(progress?.grade_level || progress?.grade, 'N/A');
  const section = safeDisplayText(progress?.section, 'Not assigned');
  const currentQuest = safeDisplayText(
    metrics?.currentQuest !== undefined ? metrics.currentQuest : progress?.current_quest,
    'Not available'
  );
  const currentDifficulty = resolveCurrentDifficulty({ ...progress, metrics });
  const currentLocation = safeDisplayText(progress?.current_location, 'Not available');
  const metricCards = [
    { label: 'Total Progress', value: formatPercent(metrics?.totalProgress), note: getTotalProgressNote(metrics), icon: Target, tone: 'blue' },
    { label: 'Accuracy', value: formatAttemptPercent(metrics?.accuracy), icon: BarChart3, tone: 'green' },
    { label: 'Correct Answers', value: formatCount(metrics?.correctAnswers), icon: CheckCircle2, tone: 'green' },
    { label: 'Incorrect Answers', value: formatCount(metrics?.incorrectAnswers), icon: XCircle, tone: 'red' },
    { label: 'Game Score', value: formatCount(metrics?.gameScore), icon: Trophy, tone: 'blue' },
    { label: 'Completed Quests', value: formatCount(metrics?.completedQuests), icon: BookOpen, tone: 'orange' },
  ];
  const performanceBars = [
    { label: 'Total Progress', value: toNullableNumber(metrics?.totalProgress), tone: 'blue' },
    { label: 'Accuracy', value: toNullableNumber(metrics?.accuracy), tone: 'green' },
    { label: 'Quest Completion', value: toNullableNumber(metrics?.questCompletionPercentage), tone: 'orange' },
  ];
  const insightMessage = insightError || aiInsight?.message || 'Generate an insight only when you want an interpretation of the recorded metrics.';
  const topicRows = useMemo(() => (Array.isArray(metrics?.topicPerformance) ? metrics.topicPerformance : [])
    .map((value) => {
      const topicId = safeDisplayText(value?.topicId ?? value?.topic_id, '');
      const topicLabel = safeDisplayText(value?.topic, '');
      const gradeLabel = safeDisplayText(value?.gradeLevel ?? value?.grade_level, '');
      const correct = toNullableNumber(value?.correctAnswers ?? value?.correct_answers);
      const attempts = toNullableNumber(value?.totalQuestions ?? value?.total_questions);
      const incorrect = attempts !== null && correct !== null ? attempts - correct : null;
      if (!topicId || !topicLabel || !gradeLabel
        || !Number.isInteger(correct) || correct < 0
        || !Number.isInteger(attempts) || attempts < 1 || correct > attempts) return null;
      return {
        topic: `${gradeLabel} ${topicLabel}`,
        correct,
        incorrect,
        attempts,
        accuracy: Number(((correct / attempts) * 100).toFixed(2)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.accuracy - right.accuracy
      || right.incorrect - left.incorrect
      || right.attempts - left.attempts
      || left.topic.localeCompare(right.topic)), [metrics]);
  const reportSummary = [
    { label: 'Correct Answers', value: formatCount(metrics?.correctAnswers) },
    { label: 'Incorrect Answers', value: formatCount(metrics?.incorrectAnswers) },
    { label: 'Total Questions', value: formatCount(metrics?.totalQuestions) },
    { label: 'Accuracy', value: formatAttemptPercent(metrics?.accuracy) },
    { label: 'Game Score', value: formatCount(metrics?.gameScore) },
    { label: 'Total Progress', value: formatPercent(metrics?.totalProgress) },
    { label: 'Completed Quests', value: formatCount(metrics?.completedQuests) },
  ];
  const analyticsPrintRows = [
    ['Student Information', 'Student Name', studentName],
    ['Student Information', 'Student ID', resolvedStudentId],
    ['Student Information', 'Grade', grade],
    ['Student Information', 'Section', section],
    ['Student Information', 'Current Quest', currentQuest],
    ['Student Information', 'Current Difficulty', currentDifficulty],
    ['Student Information', 'Current Location', currentLocation],
    ...reportSummary.map((metric) => ['Performance Summary', metric.label, metric.value]),
    ...difficultyRows.map((row) => ['Difficulty Performance', row.label, formatAttemptPercent(row.value)]),
    ...topicRows.map((row) => ['Topic Performance', row.topic, formatPercent(row.accuracy)]),
    ['Analysis', 'Performance Insight', insight?.performance_insight || insightMessage],
    ['Analysis', 'Strengths', strengths.length ? strengths.join('; ') : 'Analysis not available.'],
    ['Analysis', 'Weaknesses', weaknesses.length ? weaknesses.join('; ') : 'Analysis not available.'],
    ['Analysis', 'Recommendations', recommendations.length ? recommendations.join('; ') : 'Analysis not available.'],
  ].map(([sectionLabel, metric, value], index) => ({ id: `${sectionLabel}-${metric}-${index}`, sectionLabel, metric, value }));
  const analyticsPrintColumns = [
    { header: 'Section', value: (row) => row.sectionLabel },
    { header: 'Metric', value: (row) => row.metric },
    { header: 'Value', value: (row) => row.value },
  ];
  const sidebarRole = ['admin', 'teacher', 'parent', 'parent_teacher'].includes(userRole) ? userRole : 'admin';
  const sidebarActiveItem = sidebarRole === 'parent' ? 'child-progress' : 'student-progress';
  const portalLabel = sidebarRole === 'admin' ? 'Admin Portal' : sidebarRole === 'parent' ? 'Parent Portal' : 'Teacher Portal';

  return (
    <>
    <DashboardContainer
      sidebar={<AnalyticsSidebar role={sidebarRole} activeItem={sidebarActiveItem} logoSrc={logoImage} portalLabel={portalLabel} />}
      main={(
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>Student Analysis</h1>
              <p>Authoritative progress metrics and grounded interpretation.</p>
            </div>
          </TopBar>
          <PageContent>
    <div className="student-analytics-page no-print">
      <button className="back-action student-analytics-back" onClick={() => navigate(getBackRoute())}>
        <ChevronLeft size={18} aria-hidden="true" />
        Back to Table
      </button>

      {loading ? (
        <div className="loading-state" role="status" aria-live="polite">
          {refreshing ? 'Refreshing student progress...' : 'Loading student details...'}
        </div>
      ) : error ? (
        <div className="fallback-note validation-error-text">{error}</div>
      ) : (
        <>
          <section className="student-profile-card">
            <div className="student-profile-main">
              <div className="student-avatar" aria-hidden="true">{studentInitials}</div>
              <div className="student-profile-copy">
                <p className="crumb">Analytics / Student Details</p>
                <h1>{studentName}</h1>
                <p className="subtitle">Server-calculated gameplay metrics and optional grounded interpretation.</p>
              </div>
            </div>
            <div className="student-profile-report-actions">
              <TablePrintButton
                reportTitle="Student Analytics"
                label="Print Student Analytics"
                showPrintHeading={false}
                disabled={!progress}
                preparing={reportPreparing}
                onPrint={() => prepareAndPrint(async () => analyticsPrintRows)}
              />
            </div>
            <div className="student-profile-meta">
              <div><span>Student ID</span><strong>{resolvedStudentId}</strong></div>
              <div><span>Grade & Section</span><strong>{`${grade} - ${section}`}</strong></div>
              <div><span>Current Difficulty</span><strong>{currentDifficulty}</strong></div>
              <div><span>Current Quest</span><strong>{currentQuest}</strong></div>
            </div>
          </section>

          <section className="student-metrics-grid" aria-label="Student analytics summary">
            {metricCards.map(({ label, value, note, icon: Icon, tone }) => (
              <div className="student-metric-card" key={label}>
                <span className={`student-metric-icon ${tone}`}><Icon size={20} aria-hidden="true" /></span>
                <strong>{value}</strong>
                <span>{label}</span>
                {note && <small>{note}</small>}
              </div>
            ))}
          </section>

          <section className="student-analytics-grid">
            <div className="student-dashboard-card student-performance-card">
              <div className="student-card-heading">
                <span className="student-card-icon blue"><Layers size={20} aria-hidden="true" /></span>
                <div><h2>Game Performance</h2><p>Authoritative progress and result-history metrics.</p></div>
              </div>
              <div className="student-performance-meta">
                <div><span>Current Quest</span><strong>{currentQuest}</strong></div>
                <div><span>Current Difficulty</span><strong>{currentDifficulty}</strong></div>
                <div><span>Current Location</span><strong>{currentLocation}</strong></div>
                <div><span>Recorded Results</span><strong>{formatCount(metrics?.validResultCount)}</strong></div>
              </div>
              <div className="student-progress-bars">
                {performanceBars.map((bar) => (
                  <div className="student-progress-row" key={bar.label}>
                    <div className="student-progress-label"><span>{bar.label}</span><strong>{bar.label === 'Accuracy' ? formatAttemptPercent(bar.value) : formatPercent(bar.value)}</strong></div>
                    {bar.value === null ? (
                      <p className="student-data-unavailable">{bar.label === 'Accuracy' ? 'No attempts yet' : 'No authoritative value is available yet.'}</p>
                    ) : (
                      <div className="student-progress-track"><div className={`student-progress-fill ${bar.tone}`} style={{ width: `${Math.max(0, Math.min(100, bar.value))}%` }} /></div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="student-dashboard-card student-difficulty-card">
              <div className="student-card-heading">
                <span className="student-card-icon orange"><BookOpen size={20} aria-hidden="true" /></span>
                <div><h2>Difficulty Breakdown</h2><p>Accuracy from recorded question results only.</p></div>
              </div>
              <div className="student-difficulty-bars">
                {difficultyRows.map((row) => (
                  <div className="student-difficulty-row" key={row.label}>
                    <div className="student-progress-label"><span>{row.label}</span><strong>{formatAttemptPercent(row.value)}</strong></div>
                    {row.value === null ? (
                      <p className="student-data-unavailable">No attempts yet.</p>
                    ) : (
                      <div className="student-progress-track"><div className={`student-progress-fill ${row.tone}`} style={{ width: `${Math.max(0, Math.min(100, row.value))}%` }} /></div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="student-dashboard-card student-topic-performance" aria-labelledby="student-topic-performance-title">
            <div className="student-card-heading">
              <span className="student-card-icon blue"><Layers size={20} aria-hidden="true" /></span>
              <div>
                <h2 id="student-topic-performance-title">Topic Performance</h2>
                <p>Validated current-cycle Mathematics topics only.</p>
                <p className="student-topic-evidence-summary" aria-live="polite">
                  Topic-linked evidence: {formatCount(metrics?.topicLinkedEvidenceCount)} of {formatCount(metrics?.validResultCount)} recorded answers
                </p>
              </div>
            </div>
            {topicRows.length > 0 ? (
              <div className="student-topic-performance-table-wrap">
                <table className="student-progress-table student-topic-performance-table">
                  <thead><tr>
                    <th scope="col">Topic</th>
                    <th scope="col">Correct</th>
                    <th scope="col">Incorrect</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Accuracy</th>
                  </tr></thead>
                  <tbody>{topicRows.map((row) => (
                    <tr key={row.topic}>
                      <td>{row.topic}</td>
                      <td>{formatCount(row.correct)}</td>
                      <td>{formatCount(row.incorrect)}</td>
                      <td>{formatCount(row.attempts)}</td>
                      <td>{formatPercent(row.accuracy)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <p className="student-data-unavailable">No validated current-cycle Mathematics topic evidence is available.</p>
            )}
          </section>

          <GroundedAiAnalysis
            aiInsight={aiInsight}
            error={insightError}
            loading={insightLoading}
            onRefresh={generateInsight}
          />
        </>
      )}
    </div>
          </PageContent>
        </MainContent>
      )}
    />
    {!loading && !error && progress && (
      <PrintableTableReport
        title="Student Analytics Report"
        context={`Student: ${studentName}`}
        rows={preparedRows}
        columns={analyticsPrintColumns}
        recordCount={1}
      />
    )}
    </>
  );
}
