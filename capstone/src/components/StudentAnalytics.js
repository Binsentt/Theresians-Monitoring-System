import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  Clock,
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
import { clampPercent, normalizeDisplayList, safeDisplayText, toFiniteNumber } from './studentProgress.utils';
import logoImage from '../assets/images/STS_Logo.png';
import '../styles/studentprogress.css';

const formatWholePercent = (value) => `${clampPercent(value, 0).toFixed(0)}%`;

const formatCount = (value) => String(Math.round(toFiniteNumber(value, 0)));

const formatPlaytime = ({ seconds, minutes }) => {
  const minuteValue = minutes !== undefined && minutes !== null && minutes !== ''
    ? Math.max(0, Math.floor(toFiniteNumber(minutes, 0)))
    : Math.max(0, Math.floor(toFiniteNumber(seconds, 0) / 60));

  if (minuteValue <= 0) return '0 min';
  if (minuteValue < 60) return `${minuteValue} min`;

  const hours = Math.floor(minuteValue / 60);
  const remaining = minuteValue % 60;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
};

const getInitials = (name) => {
  const parts = safeDisplayText(name, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  return parts.map((part) => part[0]?.toUpperCase()).join('') || 'ST';
};

export default function StudentAnalytics() {
  const { studentId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [progress, setProgress] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [userRole, setUserRole] = useState('admin');

  useEffect(() => {
    const loadDetail = async () => {
      setLoading(true);
      setError('');

      const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
      if (loggedInUser && loggedInUser.role) {
        setUserRole(normalizeRole(loggedInUser.role));
      }

      try {
        const response = await fetch(buildStudentProgressDetailUrl(studentId, loggedInUser?.role, loggedInUser?.id));
        if (!response.ok) throw new Error('Unable to load student analytics');
        const data = await response.json();
        setProgress(data.progress || null);
        setAnalysis(data.analysis || null);
      } catch (err) {
        console.error('Detail load failed:', err);
        setError('Analytics currently unavailable. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

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

  const accuracy = clampPercent(progress?.accuracy_rate, 0);
  const questCompletion = clampPercent(progress?.progress_percentage, 0);
  const difficulty = {
    easy: clampPercent(analysis?.difficultyBreakdown?.easy, 0),
    medium: clampPercent(analysis?.difficultyBreakdown?.medium, 0),
    hard: clampPercent(analysis?.difficultyBreakdown?.hard, 0),
  };
  const gameScore = toFiniteNumber(progress?.score, 0);
  const strengths = normalizeDisplayList(analysis?.strengths);
  const weaknesses = normalizeDisplayList(analysis?.weaknesses);
  const recommendations = normalizeDisplayList(analysis?.recommendations);
  const correctAnswers = toFiniteNumber(analysis?.totalCorrectAnswers ?? progress?.correct_answers, 0);
  const totalQuestions = toFiniteNumber(progress?.total_questions, 0);
  const incorrectAnswers = toFiniteNumber(analysis?.totalIncorrectAnswers, Math.max(totalQuestions - correctAnswers, 0));
  const studentName = safeDisplayText(progress?.student_name, 'Student analytics');
  const studentInitials = getInitials(progress?.student_name);
  const resolvedStudentId = safeDisplayText(progress?.student_id || progress?.id || studentId, 'N/A');
  const grade = safeDisplayText(progress?.grade_level || progress?.grade, 'N/A');
  const section = safeDisplayText(progress?.section, 'N/A');
  const currentQuest = safeDisplayText(analysis?.currentQuest || progress?.current_quest, 'N/A');
  const currentDifficulty = safeDisplayText(progress?.difficulty_level || progress?.difficulty, 'Unknown');
  const currentScene = safeDisplayText(
    progress?.current_scene || progress?.currentScene || progress?.scene || progress?.current_map || progress?.currentMap,
    'Unknown'
  );
  const completedQuests = toFiniteNumber(
    progress?.total_quests_completed ?? progress?.quests_completed,
    Math.min(10, Math.round(questCompletion / 10))
  );
  const questCompletionBar = clampPercent(completedQuests * 10, questCompletion);
  const totalPlaytime = formatPlaytime({
    seconds: progress?.total_play_time ?? progress?.duration_seconds,
    minutes: progress?.total_playtime_minutes,
  });
  const performanceInsight = accuracy >= 80 ? 'Consistently strong results' : 'Needs guided reinforcement';
  const metricCards = [
    { label: 'Total Progress', value: formatWholePercent(questCompletion), icon: Target, tone: 'blue' },
    { label: 'Accuracy', value: formatWholePercent(accuracy), icon: BarChart3, tone: 'green' },
    { label: 'Correct Answers', value: formatCount(correctAnswers), icon: CheckCircle2, tone: 'green' },
    { label: 'Incorrect Answers', value: formatCount(incorrectAnswers), icon: XCircle, tone: 'red' },
    { label: 'Completed Quests', value: formatCount(completedQuests), icon: Trophy, tone: 'orange' },
    { label: 'Total Playtime', value: totalPlaytime, icon: Clock, tone: 'blue' },
  ];
  const performanceBars = [
    { label: 'Completion', value: questCompletion, tone: 'blue' },
    { label: 'Accuracy', value: accuracy, tone: 'green' },
    { label: 'Quest Completion', value: questCompletionBar, tone: 'orange' },
  ];
  const difficultyRows = [
    { label: 'Easy', value: difficulty.easy, tone: 'easy' },
    { label: 'Medium', value: difficulty.medium, tone: 'medium' },
    { label: 'Hard', value: difficulty.hard, tone: 'hard' },
  ];

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
                <p className="subtitle">Detailed performance insights, progress metrics, and learning recommendations for this student.</p>
              </div>
            </div>
            <div className="student-profile-logo" aria-label="Saint Theresa School logo">
              <img src={logoImage} alt="Saint Theresa School logo" />
            </div>
            <div className="student-profile-meta">
              <div>
                <span>Student ID</span>
                <strong>{resolvedStudentId}</strong>
              </div>
              <div>
                <span>Grade</span>
                <strong>{grade}</strong>
              </div>
              <div>
                <span>Section</span>
                <strong>{section}</strong>
              </div>
              <div>
                <span>Current Quest</span>
                <strong>{currentQuest}</strong>
              </div>
              <div>
                <span>Difficulty</span>
                <strong>{currentDifficulty}</strong>
              </div>
              <div>
                <span>Current Scene</span>
                <strong>{currentScene}</strong>
              </div>
            </div>
          </section>

          <section className="student-metrics-grid" aria-label="Student analytics summary">
            {metricCards.map(({ label, value, icon: Icon, tone }) => (
              <div className="student-metric-card" key={label}>
                <span className={`student-metric-icon ${tone}`}>
                  <Icon size={20} aria-hidden="true" />
                </span>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </section>

          <section className="student-analytics-grid">
            <div className="student-dashboard-card student-performance-card">
              <div className="student-card-heading">
                <span className="student-card-icon blue"><Layers size={20} aria-hidden="true" /></span>
                <div>
                  <h2>Game Performance</h2>
                  <p>Current gameplay progress and learning pace.</p>
                </div>
              </div>

              <div className="student-performance-meta">
                <div>
                  <span>Current Quest</span>
                  <strong>{currentQuest}</strong>
                </div>
                <div>
                  <span>Current Difficulty</span>
                  <strong>{currentDifficulty}</strong>
                </div>
                <div>
                  <span>Current Scene</span>
                  <strong>{currentScene}</strong>
                </div>
              </div>

              <div className="student-progress-bars">
                {performanceBars.map((bar) => (
                  <div className="student-progress-row" key={bar.label}>
                    <div className="student-progress-label">
                      <span>{bar.label}</span>
                      <strong>{bar.value.toFixed(0)}%</strong>
                    </div>
                    <div className="student-progress-track">
                      <div className={`student-progress-fill ${bar.tone}`} style={{ width: `${bar.value}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="student-dashboard-card student-difficulty-card">
              <div className="student-card-heading">
                <span className="student-card-icon orange"><BookOpen size={20} aria-hidden="true" /></span>
                <div>
                  <h2>Difficulty Breakdown</h2>
                  <p>Question performance by challenge level.</p>
                </div>
              </div>

              <div className="student-difficulty-bars">
                {difficultyRows.map((row) => (
                  <div className="student-difficulty-row" key={row.label}>
                    <div className="student-progress-label">
                      <span>{row.label}</span>
                      <strong>{row.value.toFixed(0)}%</strong>
                    </div>
                    <div className="student-progress-track">
                      <div className={`student-progress-fill ${row.tone}`} style={{ width: `${row.value}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="student-insights-grid">
            <div className="student-dashboard-card student-insight-card">
              <div className="student-card-heading">
                <span className="student-card-icon green"><Lightbulb size={20} aria-hidden="true" /></span>
                <div>
                  <h2>Performance Insight</h2>
                  <p>Quick read on the student's current trend.</p>
                </div>
              </div>
              <strong className="student-insight-highlight">{performanceInsight}</strong>
              <p className="student-insight-copy">
                Score {gameScore} across {formatCount(totalQuestions)} questions, with {formatWholePercent(accuracy)} accuracy and {formatWholePercent(questCompletion)} total progress.
              </p>
            </div>

            <div className="student-dashboard-card student-insight-list">
              <div className="student-card-heading">
                <span className="student-card-icon blue"><CheckCircle2 size={20} aria-hidden="true" /></span>
                <div>
                  <h2>Strengths</h2>
                  <p>Positive learning signals.</p>
                </div>
              </div>
              {strengths.length > 0 ? (
                <ul>
                  {strengths.map((item, index) => <li key={`strength-${index}`}>{item}</li>)}
                </ul>
              ) : (
                <p>No interpretation available for this student yet.</p>
              )}
            </div>

            <div className="student-dashboard-card student-insight-list">
              <div className="student-card-heading">
                <span className="student-card-icon red"><AlertTriangle size={20} aria-hidden="true" /></span>
                <div>
                  <h2>Weaknesses</h2>
                  <p>Areas that may need support.</p>
                </div>
              </div>
              {weaknesses.length > 0 ? (
                <ul>
                  {weaknesses.map((item, index) => <li key={`weak-${index}`}>{item}</li>)}
                </ul>
              ) : (
                <p>No weak areas identified.</p>
              )}
            </div>

            <div className="student-dashboard-card student-insight-list">
              <div className="student-card-heading">
                <span className="student-card-icon orange"><MapPin size={20} aria-hidden="true" /></span>
                <div>
                  <h2>Recommendations</h2>
                  <p>Next best learning actions.</p>
                </div>
              </div>
              {recommendations.length > 0 ? (
                <ul>
                  {recommendations.map((item, index) => <li key={`reco-${index}`}>{item}</li>)}
                </ul>
              ) : (
                <p>Please try again later for recommendations.</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
