import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  Layers,
  Lightbulb,
  MapPin,
  Target,
  Trophy,
  XCircle,
} from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { buildStudentProgressDetailUrl } from './analyticsEndpoints';
import { normalizeRole } from './manageUsers.utils';
import { buildAuthHeaders } from './session.utils';
import { normalizeDisplayList, safeDisplayText } from './studentProgress.utils';
import '../styles/studentprogress.css';

const toNullableNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatPercent = (value) => {
  const number = toNullableNumber(value);
  return number === null ? 'Not available' : `${number.toFixed(0)}%`;
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
  const [insightLoading, setInsightLoading] = useState(false);
  const [error, setError] = useState('');
  const [insightError, setInsightError] = useState('');
  const [userRole, setUserRole] = useState('admin');

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
    const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
    setInsightLoading(true);
    setInsightError('');
    try {
      const response = await fetch(buildInsightUrl(buildStudentProgressDetailUrl(studentId, loggedInUser?.role)), {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(),
          'Content-Type': 'application/json',
        },
      });
      const data = await response.json();
      if (data?.status === 'insufficient_data') {
        setAiInsight(data);
        return;
      }
      if (!response.ok) {
        setInsightError(data?.error || 'Grounded AI Insights are unavailable right now.');
        return;
      }
      setAiInsight(data);
    } catch (err) {
      console.error('Grounded insight request failed:', err);
      setInsightError('Grounded AI Insights are unavailable right now.');
    } finally {
      setInsightLoading(false);
    }
  };

  const difficultyRows = useMemo(() => [
    { label: 'Easy', value: toNullableNumber(metrics?.difficultyBreakdown?.easy?.accuracy), tone: 'easy' },
    { label: 'Medium', value: toNullableNumber(metrics?.difficultyBreakdown?.medium?.accuracy), tone: 'medium' },
    { label: 'Hard', value: toNullableNumber(metrics?.difficultyBreakdown?.hard?.accuracy), tone: 'hard' },
  ], [metrics]);
  const insight = aiInsight?.insight || null;
  const strengths = normalizeDisplayList(insight?.strengths);
  const weaknesses = normalizeDisplayList(insight?.weaknesses);
  const recommendations = normalizeDisplayList(insight?.recommendations);
  const studentName = safeDisplayText(progress?.student_name, 'Student analytics');
  const studentInitials = getInitials(progress?.student_name);
  const resolvedStudentId = safeDisplayText(progress?.game_student_id, 'Not linked');
  const grade = safeDisplayText(progress?.grade_level || progress?.grade, 'N/A');
  const section = safeDisplayText(progress?.section, 'Not available');
  const currentQuest = safeDisplayText(metrics?.currentQuest || progress?.current_quest, 'Not available');
  const currentDifficulty = safeDisplayText(progress?.difficulty_level || progress?.difficulty, 'Unknown');
  const currentScene = safeDisplayText(
    progress?.current_scene || progress?.currentScene || progress?.scene || progress?.current_map || progress?.currentMap,
    'Unknown'
  );
  const metricCards = [
    { label: 'Total Progress', value: formatPercent(metrics?.totalProgress), icon: Target, tone: 'blue' },
    { label: 'Accuracy', value: formatPercent(metrics?.accuracy), icon: BarChart3, tone: 'green' },
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
  const canGenerateInsight = aiInsight?.status !== 'insufficient_data';

  return (
    <div className="student-analytics-page">
      <button className="back-action student-analytics-back" onClick={() => navigate(getBackRoute())}>
        <ChevronLeft size={18} aria-hidden="true" />
        Back to Table
      </button>

      {loading ? (
        <div className="loading-state">Loading student details...</div>
      ) : error ? (
        <div className="fallback-note">{error}</div>
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
            <div className="student-profile-meta">
              <div><span>Student ID</span><strong>{resolvedStudentId}</strong></div>
              <div><span>Grade & Section</span><strong>{`${grade} - ${section}`}</strong></div>
              <div><span>Current Difficulty</span><strong>{currentDifficulty}</strong></div>
              <div><span>Current Quest</span><strong>{currentQuest}</strong></div>
            </div>
          </section>

          <section className="student-metrics-grid" aria-label="Student analytics summary">
            {metricCards.map(({ label, value, icon: Icon, tone }) => (
              <div className="student-metric-card" key={label}>
                <span className={`student-metric-icon ${tone}`}><Icon size={20} aria-hidden="true" /></span>
                <strong>{value}</strong>
                <span>{label}</span>
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
                <div><span>Current Scene</span><strong>{currentScene}</strong></div>
                <div><span>Recorded Results</span><strong>{formatCount(metrics?.validResultCount)}</strong></div>
              </div>
              <div className="student-progress-bars">
                {performanceBars.map((bar) => (
                  <div className="student-progress-row" key={bar.label}>
                    <div className="student-progress-label"><span>{bar.label}</span><strong>{formatPercent(bar.value)}</strong></div>
                    {bar.value === null ? (
                      <p className="student-data-unavailable">No authoritative value is available yet.</p>
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
                    <div className="student-progress-label"><span>{row.label}</span><strong>{formatPercent(row.value)}</strong></div>
                    {row.value === null ? (
                      <p className="student-data-unavailable">No recorded {row.label.toLowerCase()} results.</p>
                    ) : (
                      <div className="student-progress-track"><div className={`student-progress-fill ${row.tone}`} style={{ width: `${Math.max(0, Math.min(100, row.value))}%` }} /></div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="student-insights-grid">
            <div className="student-dashboard-card student-insight-card">
              <div className="student-card-heading">
                <span className="student-card-icon green"><Lightbulb size={20} aria-hidden="true" /></span>
                <div><h2>Grounded AI Insight</h2><p>Optional interpretation of the server-calculated metrics.</p></div>
              </div>
              {insight?.performance_insight ? (
                <strong className="student-insight-highlight">{insight.performance_insight}</strong>
              ) : (
                <p className="student-insight-copy">{insightMessage}</p>
              )}
              {canGenerateInsight && (
                <button type="button" className="btn btn-primary student-insight-action" onClick={generateInsight} disabled={insightLoading}>
                  {insightLoading ? 'Generating insight...' : aiInsight?.status === 'stale' ? 'Generate refreshed insight' : 'Generate grounded insight'}
                </button>
              )}
            </div>

            <div className="student-dashboard-card student-insight-list">
              <div className="student-card-heading"><span className="student-card-icon blue"><CheckCircle2 size={20} aria-hidden="true" /></span><div><h2>Strengths</h2><p>Only shown after a grounded insight is generated.</p></div></div>
              {strengths.length > 0 ? <ul>{strengths.map((item, index) => <li key={`strength-${index}`}>{item}</li>)}</ul> : <p>No grounded interpretation is available yet.</p>}
            </div>

            <div className="student-dashboard-card student-insight-list">
              <div className="student-card-heading"><span className="student-card-icon red"><AlertTriangle size={20} aria-hidden="true" /></span><div><h2>Weaknesses</h2><p>Only shown after a grounded insight is generated.</p></div></div>
              {weaknesses.length > 0 ? <ul>{weaknesses.map((item, index) => <li key={`weak-${index}`}>{item}</li>)}</ul> : <p>No grounded interpretation is available yet.</p>}
            </div>

            <div className="student-dashboard-card student-insight-list">
              <div className="student-card-heading"><span className="student-card-icon orange"><MapPin size={20} aria-hidden="true" /></span><div><h2>Recommendations</h2><p>Only shown after a grounded insight is generated.</p></div></div>
              {recommendations.length > 0 ? <ul>{recommendations.map((item, index) => <li key={`reco-${index}`}>{item}</li>)}</ul> : <p>No grounded interpretation is available yet.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
